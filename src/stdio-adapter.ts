import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadOrgConfig } from "./config.js";
import { ensureCredentials } from "./credentials.js";
import { AgentCorpError } from "./errors.js";
import { readDaemonInfo, type DaemonInfo } from "./server.js";

export interface StdioAdapterOptions {
  role: string;
  configPath?: string | undefined;
  dbPath?: string | undefined;
  credentialsPath?: string | undefined;
  daemonFilePath?: string | undefined;
  noSpawn?: boolean | undefined;
  daemonUrl?: string | undefined;
}

export const MUTATION_TOOLS = new Set([
  "create_task",
  "send_message",
  "accept_handoff",
  "create_artifact",
  "update_task_status",
]);

export function isRetryableTransportError(err: unknown): boolean {
  if (!err) return false;
  const msg = String(err);
  if (
    msg.includes("fetch failed") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("EPIPE") ||
    msg.includes("UND_ERR")
  ) {
    return true;
  }
  if (typeof err === "object" && err !== null) {
    if (err instanceof Error && err.name === "TypeError" && err.message.includes("fetch")) return true;
    const anyErr = err as Record<string, unknown>;
    const code = anyErr.code ?? (anyErr.cause as Record<string, unknown> | undefined)?.code;
    if (
      typeof code === "string" &&
      ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"].includes(code)
    ) {
      return true;
    }
    const status = anyErr.status ?? (anyErr.cause as Record<string, unknown> | undefined)?.status;
    if (typeof status === "number" && [502, 503, 504].includes(status)) {
      return true;
    }
  }
  return false;
}

export function resolveDefaultPath(
  options: { configPath?: string | undefined; dbPath?: string | undefined },
  fileName: string,
): string {
  if (options.configPath) {
    return resolve(dirname(resolve(options.configPath)), ".agentcorp", fileName);
  }
  if (options.dbPath) {
    return resolve(dirname(resolve(options.dbPath)), fileName);
  }
  return resolve(".agentcorp", fileName);
}

function resolveCliPath(): string {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const candidateJs = resolve(currentDir, "cli.js");
    if (existsSync(candidateJs)) return candidateJs;
    const rootDistJs = resolve(currentDir, "..", "dist", "cli.js");
    if (existsSync(rootDistJs)) return rootDistJs;
  } catch {
    // Fallback if import.meta.url is unusual
  }
  const rootDist = resolve("dist/cli.js");
  if (existsSync(rootDist)) return rootDist;
  if (process.argv[1] && existsSync(process.argv[1]) && process.argv[1].endsWith(".js")) {
    return resolve(process.argv[1]);
  }
  return rootDist;
}

export async function isDaemonHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

const inFlightSpawns = new Map<string, Promise<DaemonInfo>>();

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireStartupLock(
  lockFilePath: string,
  daemonFilePath: string,
  maxWaitMs = 10000,
): Promise<(() => void) | null> {
  const start = Date.now();
  mkdirSync(dirname(lockFilePath), { recursive: true });

  while (Date.now() - start < maxWaitMs) {
    const current = readDaemonInfo(daemonFilePath);
    if (current && (await isDaemonHealthy(current.url))) {
      return null;
    }

    try {
      const fd = openSync(lockFilePath, "wx");
      const data = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
      writeFileSync(fd, data, "utf8");
      closeSync(fd);

      return () => {
        try {
          if (existsSync(lockFilePath)) {
            unlinkSync(lockFilePath);
          }
        } catch {
          // Best effort
        }
      };
    } catch (err: any) {
      if (err?.code === "EEXIST") {
        let isStale = false;
        try {
          const raw = readFileSync(lockFilePath, "utf8");
          const info = JSON.parse(raw) as { pid: number; createdAt: number };
          const age = Date.now() - (info.createdAt ?? 0);
          if (info.pid !== process.pid && (!isProcessAlive(info.pid) || age > 12000)) {
            isStale = true;
          }
        } catch {
          isStale = true;
        }

        if (isStale) {
          try {
            unlinkSync(lockFilePath);
          } catch {
            // Ignore race
          }
          continue;
        }

        await new Promise((r) => setTimeout(r, 100));
      } else {
        throw err;
      }
    }
  }

  const current = readDaemonInfo(daemonFilePath);
  if (current && (await isDaemonHealthy(current.url))) {
    return null;
  }

  throw new AgentCorpError(
    "DAEMON_SPAWN_FAILED",
    "Timed out waiting for concurrent daemon startup lock to be released.",
  );
}

export async function ensureDaemonRunning(options: {
  configPath?: string | undefined;
  dbPath?: string | undefined;
  credentialsPath?: string | undefined;
  daemonFilePath?: string | undefined;
  noSpawn?: boolean | undefined;
  port?: number | string | undefined;
}): Promise<DaemonInfo> {
  const daemonFilePath = options.daemonFilePath ?? resolveDefaultPath(options, "daemon.json");
  const existing = readDaemonInfo(daemonFilePath);
  if (existing && (await isDaemonHealthy(existing.url))) {
    return existing;
  }

  if (options.noSpawn) {
    throw new AgentCorpError(
      "DAEMON_NOT_RUNNING",
      "AgentCorp daemon is not running. Start it with 'agentcorp start' or allow auto-spawn.",
    );
  }

  const inFlight = inFlightSpawns.get(daemonFilePath);
  if (inFlight) {
    return inFlight;
  }

  const spawnPromise = (async () => {
    const lockFilePath = `${daemonFilePath}.lock`;
    const unlock = await acquireStartupLock(lockFilePath, daemonFilePath);
    if (!unlock) {
      const running = readDaemonInfo(daemonFilePath);
      if (running && (await isDaemonHealthy(running.url))) {
        return running;
      }
    }

    try {
      const afterLock = readDaemonInfo(daemonFilePath);
      if (afterLock && (await isDaemonHealthy(afterLock.url))) {
        return afterLock;
      }

      const cliPath = resolveCliPath();
      const args = [cliPath, "start", "--port", options.port !== undefined ? String(options.port) : "0"];
      if (options.configPath) args.push("--config", resolve(options.configPath));
      if (options.dbPath) args.push("--db", resolve(options.dbPath));
      if (options.daemonFilePath) args.push("--daemon-file", resolve(options.daemonFilePath));
      if (options.credentialsPath) args.push("--credentials", resolve(options.credentialsPath));

      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();

      // Wait for daemon to become healthy within 8 seconds
      const start = Date.now();
      while (Date.now() - start < 8000) {
        await new Promise((r) => setTimeout(r, 150));
        const info = readDaemonInfo(daemonFilePath);
        if (info && (await isDaemonHealthy(info.url))) {
          return info;
        }
      }

      throw new AgentCorpError(
        "DAEMON_SPAWN_FAILED",
        "Timed out waiting for AgentCorp daemon to start in the background.",
      );
    } finally {
      if (unlock) {
        unlock();
      }
    }
  })();

  inFlightSpawns.set(daemonFilePath, spawnPromise);
  try {
    return await spawnPromise;
  } finally {
    inFlightSpawns.delete(daemonFilePath);
  }
}

export class ResilientDaemonClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private currentUrl: string | null = null;

  constructor(
    readonly options: StdioAdapterOptions,
    readonly roleToken: string,
  ) {}

  get currentClient(): Client | null {
    return this.client;
  }

  async getOrConnect(): Promise<Client> {
    if (this.client) {
      return this.client;
    }
    return this.reconnect();
  }

  async reconnect(): Promise<Client> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore close errors during reconnection
      }
      this.client = null;
      this.transport = null;
    }

    let daemonUrl = this.options.daemonUrl;

    if (this.options.daemonFilePath) {
      if (existsSync(this.options.daemonFilePath)) {
        const info = readDaemonInfo(this.options.daemonFilePath);
        if (info && (await isDaemonHealthy(info.url))) {
          daemonUrl = info.url;
        }
      }
    } else if (!daemonUrl) {
      const defaultDaemonPath = resolveDefaultPath(this.options, "daemon.json");
      if (existsSync(defaultDaemonPath)) {
        const info = readDaemonInfo(defaultDaemonPath);
        if (info && (await isDaemonHealthy(info.url))) {
          daemonUrl = info.url;
        }
      }
    }

    if (!daemonUrl || !(await isDaemonHealthy(daemonUrl))) {
      const info = await ensureDaemonRunning({
        configPath: this.options.configPath,
        dbPath: this.options.dbPath,
        credentialsPath: this.options.credentialsPath,
        daemonFilePath: this.options.daemonFilePath,
        noSpawn: this.options.noSpawn,
      });
      daemonUrl = info.url;
    }

    this.currentUrl = daemonUrl;
    const transport = new StreamableHTTPClientTransport(new URL(`${daemonUrl}/mcp`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${this.roleToken}`,
        },
      },
    });

    const client = new Client({
      name: `agentcorp-proxy-${this.options.role}`,
      version: "0.1.0",
    });

    await client.connect(transport);
    this.client = client;
    this.transport = transport;
    return client;
  }

  async executeWithRetry<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    let client = await this.getOrConnect();
    try {
      return await fn(client);
    } catch (err: unknown) {
      if (!isRetryableTransportError(err)) {
        throw err;
      }
      // Reconnection with bounded exponential backoff [100ms, 250ms, 500ms, 1000ms, 2000ms]
      const backoffs = [100, 250, 500, 1000, 2000];
      let lastErr = err;
      for (const delay of backoffs) {
        await new Promise((r) => setTimeout(r, delay));
        try {
          client = await this.reconnect();
          return await fn(client);
        } catch (retryErr: unknown) {
          lastErr = retryErr;
          if (!isRetryableTransportError(retryErr)) {
            throw retryErr;
          }
        }
      }
      throw lastErr;
    }
  }

  async listTools() {
    return this.executeWithRetry((c) => c.listTools());
  }

  async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
    let callParams = params;
    if (MUTATION_TOOLS.has(params.name)) {
      const args = { ...(params.arguments ?? {}) };
      if (!args.idempotency_key) {
        args.idempotency_key = `synthetic_${randomUUID()}`;
      }
      callParams = { ...params, arguments: args };
    }
    return this.executeWithRetry((c) => c.callTool(callParams));
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore close errors
      }
      this.client = null;
      this.transport = null;
    }
  }
}

export async function createStdioProxy(options: StdioAdapterOptions): Promise<{
  server: Server;
  daemonClient: ResilientDaemonClient;
}> {
  const config = loadOrgConfig(options.configPath ?? "org.toml");
  const credPath = options.credentialsPath ?? resolveDefaultPath(options, "credentials.json");
  const creds = ensureCredentials(config, credPath);
  const roleToken = creds.roleTokens[options.role];
  if (!roleToken) {
    throw new AgentCorpError("UNKNOWN_ROLE", `Role '${options.role}' not found in credentials`);
  }

  const resilientClient = new ResilientDaemonClient(options, roleToken);
  await resilientClient.getOrConnect();

  const server = new Server(
    { name: `agentcorp-${options.role}`, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler("tools/list", async () => {
    const result = await resilientClient.listTools();
    return { tools: result.tools };
  });

  server.setRequestHandler("tools/call", async (request) => {
    const params = request.params as { name: string; arguments?: Record<string, unknown> };
    const result = await resilientClient.callTool({
      name: params.name,
      ...(params.arguments !== undefined ? { arguments: params.arguments } : {}),
    });
    return result as never;
  });

  return { server, daemonClient: resilientClient };
}

export async function runStdioAdapter(options: StdioAdapterOptions): Promise<void> {
  const { server } = await createStdioProxy(options);
  console.error(`AgentCorp stdio proxy ready: role=${options.role}`);
  await serveStdio(() => server, {
    onerror: (err) => console.error(err),
  });
}

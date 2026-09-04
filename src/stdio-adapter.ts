import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

function resolveCliPath(): string {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const candidateJs = resolve(currentDir, "cli.js");
    if (existsSync(candidateJs)) return candidateJs;
    const candidateTs = resolve(currentDir, "cli.ts");
    if (existsSync(candidateTs)) return candidateTs;
  } catch {
    // Fallback if import.meta.url is unusual
  }
  if (process.argv[1]) return resolve(process.argv[1]);
  return resolve("dist/cli.js");
}

export async function isDaemonHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function ensureDaemonRunning(options: {
  configPath?: string | undefined;
  dbPath?: string | undefined;
  daemonFilePath?: string | undefined;
  noSpawn?: boolean | undefined;
}): Promise<DaemonInfo> {
  const daemonFilePath = options.daemonFilePath ?? ".agentcorp/daemon.json";
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

  const cliPath = resolveCliPath();
  const args = [cliPath, "start"];
  if (options.configPath) args.push("--config", resolve(options.configPath));
  if (options.dbPath) args.push("--db", resolve(options.dbPath));

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  // Wait for daemon to become healthy within 6 seconds
  const start = Date.now();
  while (Date.now() - start < 6000) {
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
}

export async function createStdioProxy(options: StdioAdapterOptions): Promise<{
  server: Server;
  daemonClient: Client;
}> {
  const config = loadOrgConfig(options.configPath ?? "org.toml");
  const creds = ensureCredentials(config, options.credentialsPath ?? ".agentcorp/credentials.json");
  const roleToken = creds.roleTokens[options.role];
  if (!roleToken) {
    throw new AgentCorpError("UNKNOWN_ROLE", `Role '${options.role}' not found in credentials`);
  }

  let daemonUrl = options.daemonUrl;
  if (!daemonUrl) {
    const daemonInfo = await ensureDaemonRunning({
      configPath: options.configPath,
      dbPath: options.dbPath,
      daemonFilePath: options.daemonFilePath,
      noSpawn: options.noSpawn,
    });
    daemonUrl = daemonInfo.url;
  }

  const transport = new StreamableHTTPClientTransport(new URL(`${daemonUrl}/mcp?token=${roleToken}`));
  const daemonClient = new Client({
    name: `agentcorp-proxy-${options.role}`,
    version: "0.1.0",
  });
  await daemonClient.connect(transport);

  const server = new Server(
    { name: `agentcorp-${options.role}`, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler("tools/list", async () => {
    const result = await daemonClient.listTools();
    return { tools: result.tools };
  });

  server.setRequestHandler("tools/call", async (request) => {
    const params = request.params as { name: string; arguments?: Record<string, unknown> };
    const result = await daemonClient.callTool({
      name: params.name,
      arguments: params.arguments,
    });
    return result as never;
  });

  return { server, daemonClient };
}

export async function runStdioAdapter(options: StdioAdapterOptions): Promise<void> {
  const { server } = await createStdioProxy(options);
  console.error(`AgentCorp stdio proxy ready: role=${options.role}`);
  await serveStdio(() => server, {
    onerror: (err) => console.error(err),
  });
}

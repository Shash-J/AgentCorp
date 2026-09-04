import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { exportAuditTrail } from "./audit.js";
import { AgentCorpBroker, type BrokerDomainEvent } from "./broker.js";
import { ensureCredentials, resolveCallerFromToken, type CredentialsFile } from "./credentials.js";
import { AgentCorpDatabase } from "./database.js";
import { AgentCorpError } from "./errors.js";
import { createMcpServer } from "./mcp.js";
import type { InitialPolicy, OrgConfig } from "./types.js";

function getConsoleAsset(fileName: string): { content: string; contentType: string } | null {
  const ext = fileName.endsWith(".css")
    ? "text/css"
    : fileName.endsWith(".js")
      ? "application/javascript"
      : "text/html";
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const candidatePaths = [
      resolve(currentDir, "console", fileName),
      resolve(currentDir, "../src/console", fileName),
      resolve(currentDir, "../console", fileName),
      resolve(process.cwd(), "src/console", fileName),
      resolve(process.cwd(), "dist/console", fileName),
    ];
    for (const p of candidatePaths) {
      if (existsSync(p)) {
        return { content: readFileSync(p, "utf8"), contentType: ext };
      }
    }
  } catch {}
  return null;
}

export interface DaemonInfo {
  pid: number;
  port: number;
  host: string;
  url: string;
  startedAt: string;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  daemonFilePath?: string;
  auditOnShutdown?: boolean;
}

async function nodeRequestToWebRequest(req: IncomingMessage, url: URL): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const body = ["GET", "HEAD"].includes(req.method ?? "GET") ? null : (chunks.length > 0 ? Buffer.concat(chunks) : null);

  return new Request(url, {
    method: req.method ?? "GET",
    headers,
    body,
  });
}

async function sendWebResponseToNode(webRes: Response, res: ServerResponse): Promise<void> {
  res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
  if (webRes.body) {
    const reader = webRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}

export function readDaemonInfo(filePath = ".agentcorp/daemon.json"): DaemonInfo | null {
  const absolute = resolve(filePath);
  if (!existsSync(absolute)) return null;
  try {
    const raw = readFileSync(absolute, "utf8");
    return JSON.parse(raw) as DaemonInfo;
  } catch {
    return null;
  }
}

export class AgentCorpServer {
  readonly broker: AgentCorpBroker;
  readonly database: AgentCorpDatabase;
  readonly config: OrgConfig;
  readonly credentials: CredentialsFile;
  readonly daemonFilePath: string;
  private server: Server | null = null;
  private readonly roleHandlers = new Map<string, ReturnType<typeof createMcpHandler>>();
  private readonly sseClients = new Set<ServerResponse>();
  private readonly eventListener = (event: BrokerDomainEvent) => this.broadcastSse(event);
  private sseHeartbeatInterval: NodeJS.Timeout | null = null;
  private port = 0;
  private host = "127.0.0.1";
  private startedAt: string | null = null;
  private auditOnShutdown: boolean;

  constructor(
    broker: AgentCorpBroker,
    credentials?: CredentialsFile,
    options: ServerOptions = {},
  ) {
    this.broker = broker;
    this.database = broker.database;
    this.config = broker.config;
    this.credentials = credentials ?? ensureCredentials(this.config);
    this.daemonFilePath = resolve(options.daemonFilePath ?? ".agentcorp/daemon.json");
    this.auditOnShutdown = options.auditOnShutdown ?? true;
    if (options.port !== undefined) this.port = options.port;
    if (options.host !== undefined) this.host = options.host;
    this.broker.on("event", this.eventListener);
  }

  private broadcastSse(event: BrokerDomainEvent): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  getPort(): number {
    return this.port;
  }

  getUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  async start(): Promise<DaemonInfo> {
    if (this.server) {
      throw new AgentCorpError("SERVER_ALREADY_RUNNING", "Server is already running");
    }

    const server = createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    await new Promise<void>((resolvePromise, reject) => {
      server.on("error", reject);
      server.listen(this.port, this.host, () => {
        const addr = server.address();
        if (typeof addr === "object" && addr) {
          this.port = addr.port;
          this.host = addr.address === "::" ? "127.0.0.1" : addr.address;
        }
        resolvePromise();
      });
    });

    this.server = server;
    this.startedAt = new Date().toISOString();

    // 15-second SSE keep-alive heartbeat comment (:keep-alive\n\n)
    this.sseHeartbeatInterval = setInterval(() => {
      for (const client of this.sseClients) {
        try {
          client.write(":keep-alive\n\n");
        } catch {
          this.sseClients.delete(client);
        }
      }
    }, 15000);
    this.sseHeartbeatInterval.unref();

    const daemonInfo: DaemonInfo = {
      pid: process.pid,
      port: this.port,
      host: this.host,
      url: this.getUrl(),
      startedAt: this.startedAt,
    };

    mkdirSync(dirname(this.daemonFilePath), { recursive: true });
    writeFileSync(this.daemonFilePath, JSON.stringify(daemonInfo, null, 2), "utf8");

    return daemonInfo;
  }

  async stop(): Promise<void> {
    if (this.sseHeartbeatInterval) {
      clearInterval(this.sseHeartbeatInterval);
      this.sseHeartbeatInterval = null;
    }

    if (this.auditOnShutdown) {
      try {
        exportAuditTrail(this.broker);
      } catch {
        // Suppress audit export error during shutdown
      }
    }

    this.broker.off("event", this.eventListener);
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        // Ignore disconnect errors
      }
    }
    this.sseClients.clear();

    for (const handler of this.roleHandlers.values()) {
      try {
        await handler.close();
      } catch {
        // Ignore close errors
      }
    }
    this.roleHandlers.clear();

    if (this.server) {
      await new Promise<void>((resolvePromise) => {
        this.server!.close(() => resolvePromise());
      });
      this.server = null;
    }

    if (existsSync(this.daemonFilePath)) {
      try {
        unlinkSync(this.daemonFilePath);
      } catch {
        // Best effort
      }
    }
  }

  private getRoleHandler(roleId: string): ReturnType<typeof createMcpHandler> {
    let handler = this.roleHandlers.get(roleId);
    if (!handler) {
      handler = createMcpHandler(() => createMcpServer(this.broker, roleId, `${roleId}-daemon`));
      this.roleHandlers.set(roleId, handler);
    }
    return handler;
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${this.host}:${this.port}`}`);
      const token = this.extractToken(req);

      // CORS headers for browser console compatibility
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      // Public health check
      if (url.pathname === "/health") {
        this.sendJson(res, 200, {
          status: "ok",
          company: this.config.company.name,
          roles: this.config.roles.map((r) => r.id),
          pid: process.pid,
          startedAt: this.startedAt,
          uptimeSeconds: this.startedAt ? Math.floor((Date.now() - new Date(this.startedAt).getTime()) / 1000) : 0,
          pendingApprovals: this.broker.listPendingApprovals().length,
          schemaVersion: this.database.getSchemaVersion(),
        });
        return;
      }

      // MCP Endpoint
      if (url.pathname === "/mcp") {
        const caller = resolveCallerFromToken(token ?? "", this.credentials);
        if (!caller || caller.type !== "role") {
          this.sendJson(res, 401, {
            error: "UNAUTHORIZED",
            message: "A valid role bearer token is required to access the MCP transport",
          });
          return;
        }

        const roleHandler = this.getRoleHandler(caller.roleId);
        const webReq = await nodeRequestToWebRequest(req, url);
        const webRes = await roleHandler.fetch(webReq);
        await sendWebResponseToNode(webRes, res);
        return;
      }

      // Admin REST API
      if (url.pathname.startsWith("/api/")) {
        const caller = resolveCallerFromToken(token ?? "", this.credentials);
        if (!caller || caller.type !== "admin") {
          this.sendJson(res, 401, {
            error: "UNAUTHORIZED",
            message: "Valid admin bearer token required",
          });
          return;
        }

        await this.handleAdminApi(req, res, url);
        return;
      }

      // Console Assets (HTML, CSS, JS)
      if (url.pathname === "/" || url.pathname === "/console" || url.pathname === "/index.html") {
        const asset = getConsoleAsset("index.html");
        if (asset) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(asset.content);
          return;
        }
      }

      if (url.pathname === "/console.css") {
        const asset = getConsoleAsset("console.css");
        if (asset) {
          res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
          res.end(asset.content);
          return;
        }
      }

      if (url.pathname === "/console.js") {
        const asset = getConsoleAsset("console.js");
        if (asset) {
          res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
          res.end(asset.content);
          return;
        }
      }

      this.sendJson(res, 404, { error: "NOT_FOUND", message: "Endpoint not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendJson(res, 500, { error: "INTERNAL_ERROR", message });
    }
  }

  private async handleAdminApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write(`data: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`);
      this.sseClients.add(res);
      req.on("close", () => {
        this.sseClients.delete(res);
      });
      return;
    }

    if (path === "/api/approvals" && method === "GET") {
      this.sendJson(res, 200, this.broker.listPendingApprovals());
      return;
    }

    const approveMatch = path.match(/^\/api\/approvals\/([^/]+)\/approve$/);
    if (approveMatch && method === "POST") {
      const approvalId = approveMatch[1]!;
      const body = await this.readJsonBody<{ note?: string; payload?: unknown }>(req);
      const result = this.broker.approve(approvalId, body.note, body.payload);
      this.sendJson(res, 200, result);
      return;
    }

    const rejectMatch = path.match(/^\/api\/approvals\/([^/]+)\/reject$/);
    if (rejectMatch && method === "POST") {
      const approvalId = rejectMatch[1]!;
      const body = await this.readJsonBody<{ note?: string }>(req);
      const result = this.broker.reject(approvalId, body.note);
      this.sendJson(res, 200, result);
      return;
    }

    if (path === "/api/policies" && method === "GET") {
      this.sendJson(res, 200, this.broker.listPolicies());
      return;
    }

    if (path === "/api/policies" && method === "POST") {
      const body = await this.readJsonBody<InitialPolicy>(req);
      const result = this.broker.savePolicy(body);
      this.sendJson(res, 200, result);
      return;
    }

    const policyToggleMatch = path.match(/^\/api\/policies\/([^/]+)\/(enable|disable)$/);
    if (policyToggleMatch && method === "POST") {
      const policyId = policyToggleMatch[1]!;
      const enabled = policyToggleMatch[2] === "enable";
      const result = this.broker.setPolicyEnabled(policyId, enabled);
      this.sendJson(res, 200, result);
      return;
    }

    if (path === "/api/artifacts" && method === "GET") {
      this.sendJson(res, 200, this.database.listArtifacts(null));
      return;
    }

    const artifactMatch = path.match(/^\/api\/artifacts\/([^/]+)$/);
    if (artifactMatch && method === "GET") {
      const artifactId = artifactMatch[1]!;
      const artifact = this.database.getArtifact(artifactId, true);
      if (!artifact) {
        this.sendJson(res, 404, { error: "NOT_FOUND", message: `Artifact ${artifactId} not found` });
        return;
      }
      this.sendJson(res, 200, artifact);
      return;
    }

    if (path === "/api/audit/export" && method === "POST") {
      const body = await this.readJsonBody<{ outputDir?: string }>(req);
      const result = exportAuditTrail(this.broker, body.outputDir ?? "coord");
      this.sendJson(res, 200, {
        exported: true,
        markdownPath: result.markdownPath,
        jsonPath: result.jsonPath,
      });
      return;
    }

    if (path === "/api/tasks" && method === "GET") {
      this.sendJson(res, 200, this.database.listAllTasks());
      return;
    }

    if (path === "/api/messages" && method === "GET") {
      this.sendJson(res, 200, this.database.listAllMessages());
      return;
    }

    this.sendJson(res, 404, { error: "NOT_FOUND", message: `Unknown admin API endpoint: ${path}` });
  }

  private extractToken(req: IncomingMessage): string | undefined {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      return authHeader.slice(7).trim();
    }
    return undefined;
  }

  private async readJsonBody<T>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    if (chunks.length === 0) return {} as T;
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  }
}

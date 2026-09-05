import { existsSync, statSync, renameSync, unlinkSync, appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadOrgConfig } from "./config.js";
import { loadCredentials } from "./credentials.js";
import { AgentCorpDatabase } from "./database.js";
import { readDaemonInfo } from "./server.js";
import type { RolePresence } from "./types.js";

export interface LogRotationOptions {
  maxSizeBytes?: number;
  maxBackups?: number;
}

export class RotatingLogger {
  readonly filePath: string;
  readonly maxSizeBytes: number;
  readonly maxBackups: number;

  constructor(filePath: string, options: LogRotationOptions = {}) {
    this.filePath = resolve(filePath);
    this.maxSizeBytes = options.maxSizeBytes ?? 5 * 1024 * 1024; // 5 MB default
    this.maxBackups = options.maxBackups ?? 3;
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  write(message: string): void {
    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] ${message.trimEnd()}\n`;

    try {
      this.rotateIfNeeded();
      appendFileSync(this.filePath, formatted, "utf8");
    } catch {
      // Best-effort logging to prevent application crashes from logging issues
    }
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const stats = statSync(this.filePath);
      if (stats.size < this.maxSizeBytes) return;

      // Rotate existing backups
      const oldest = `${this.filePath}.${this.maxBackups}`;
      if (existsSync(oldest)) {
        try {
          unlinkSync(oldest);
        } catch {}
      }

      for (let i = this.maxBackups - 1; i >= 1; i--) {
        const src = `${this.filePath}.${i}`;
        const dest = `${this.filePath}.${i + 1}`;
        if (existsSync(src)) {
          try {
            renameSync(src, dest);
          } catch {}
        }
      }

      const firstBackup = `${this.filePath}.1`;
      try {
        renameSync(this.filePath, firstBackup);
      } catch {}
    } catch {}
  }
}

export function sanitizeBrokerEventForLog(evt: { type: string; timestamp?: string; data?: Record<string, unknown> }): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    type: evt.type,
    timestamp: evt.timestamp ?? new Date().toISOString(),
  };
  const data = evt.data;
  if (!data || typeof data !== "object") return meta;

  if (data.id) meta.id = data.id;
  if (data.taskId) meta.taskId = data.taskId;
  if (data.messageId) meta.messageId = data.messageId;
  if (data.artifactId) meta.artifactId = data.artifactId;
  if (data.fromRole) meta.fromRole = data.fromRole;
  if (data.toRole) meta.toRole = data.toRole;
  if (data.status) meta.status = data.status;
  if (data.approvalId) meta.approvalId = data.approvalId;
  if (data.requestedBy) meta.requestedBy = data.requestedBy;
  if (data.assignedTo) meta.assignedTo = data.assignedTo;
  if (data.title) meta.title = data.title;
  if (data.action) meta.action = data.action;

  // Redaction: Never log message payloads or artifact contents directly; only record byte sizes
  if (data.payload !== undefined) {
    try {
      meta.payloadSizeBytes = Buffer.byteLength(JSON.stringify(data.payload), "utf8");
    } catch {
      meta.payloadSizeBytes = -1;
    }
  }
  if (data.content !== undefined) {
    meta.contentSizeBytes = typeof data.content === "string" ? Buffer.byteLength(data.content, "utf8") : -1;
  }
  return meta;
}

export function recordCrashDiagnostics(
  crashLogPath: string,
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  const resolvedPath = resolve(crashLogPath);
  mkdirSync(dirname(resolvedPath), { recursive: true });

  const timestamp = new Date().toISOString();
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? (error.stack ?? "No stack trace") : "No stack trace";
  const mem = process.memoryUsage();

  const report = [
    "=".repeat(80),
    `CRASH DIAGNOSTIC REPORT: ${timestamp}`,
    `PID: ${process.pid} | Node: ${process.version} | Platform: ${process.platform} (${process.arch})`,
    `Uptime: ${process.uptime().toFixed(2)}s`,
    `Error: ${errorMessage}`,
    `Context: ${JSON.stringify(context, null, 2)}`,
    `Memory: RSS=${Math.round(mem.rss / 1024 / 1024)}MB HeapUsed=${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
    "Stack Trace:",
    errorStack,
    "=".repeat(80),
    "",
  ].join("\n");

  try {
    const logger = new RotatingLogger(resolvedPath, { maxSizeBytes: 2 * 1024 * 1024, maxBackups: 2 });
    logger.write(report);
  } catch {
    // If rotating logger fails, direct append
    try {
      appendFileSync(resolvedPath, report, "utf8");
    } catch {}
  }
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
  details?: unknown;
}

export interface DoctorReport {
  status: "ok" | "warn" | "error";
  timestamp: string;
  checks: DoctorCheck[];
  daemon?: {
    running: boolean;
    pid?: number;
    url?: string;
    uptimeSeconds?: number;
    roles?: string[];
    presence?: RolePresence[];
  };
}

export async function runDoctor(options: {
  configPath?: string;
  dbPath?: string;
  credentialsPath?: string;
  daemonFilePath?: string;
} = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const configPath = resolve(options.configPath ?? "org.toml");
  const dbPath = resolve(options.dbPath ?? ".agentcorp/agentcorp.db");
  const credsPath = resolve(options.credentialsPath ?? ".agentcorp/credentials.json");
  const daemonFilePath = resolve(options.daemonFilePath ?? ".agentcorp/daemon.json");

  // 1. Check Configuration
  let loadedConfig = null;
  if (!existsSync(configPath)) {
    checks.push({
      name: "configuration",
      status: "error",
      message: `Config file '${configPath}' does not exist. Run 'agentcorp init' to create one.`,
    });
  } else {
    try {
      loadedConfig = loadOrgConfig(configPath);
      checks.push({
        name: "configuration",
        status: "ok",
        message: `Valid org.toml: company '${loadedConfig.company.name}', ${loadedConfig.roles.length} roles defined`,
        details: {
          roles: loadedConfig.roles.map((r) => r.id),
          limits: loadedConfig.limits,
        },
      });
    } catch (err) {
      checks.push({
        name: "configuration",
        status: "error",
        message: `Failed to load '${configPath}': ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 2. Check Database & Schema
  if (!existsSync(dbPath)) {
    checks.push({
      name: "database",
      status: "warn",
      message: `Database '${dbPath}' does not exist yet (will be initialized on first run)`,
    });
  } else {
    try {
      const db = new AgentCorpDatabase(dbPath);
      const schemaVer = db.getSchemaVersion();
      const isIntegrityOk = db.checkIntegrity();
      const taskCount = db.countTasks();
      const msgCount = db.countMessages();
      db.close();

      if (!isIntegrityOk) {
        checks.push({
          name: "database",
          status: "error",
          message: `Database integrity check failed on '${dbPath}'`,
        });
      } else {
        checks.push({
          name: "database",
          status: "ok",
          message: `Database healthy: schema v${schemaVer}, ${taskCount} tasks, ${msgCount} messages`,
          details: { schemaVersion: schemaVer, taskCount, messageCount: msgCount },
        });
      }
    } catch (err) {
      checks.push({
        name: "database",
        status: "error",
        message: `Error opening database '${dbPath}': ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 3. Check Credentials
  if (!existsSync(credsPath)) {
    checks.push({
      name: "credentials",
      status: "warn",
      message: `Credentials file '${credsPath}' not found. Run 'agentcorp init' or start the daemon to generate them.`,
    });
  } else {
    try {
      const creds = loadCredentials(credsPath);
      if (!creds || !creds.adminToken) {
        checks.push({
          name: "credentials",
          status: "error",
          message: `Credentials file '${credsPath}' is invalid or missing admin token.`,
        });
      } else if (loadedConfig) {
        const missingRoles = loadedConfig.roles.filter((r) => !creds.roleTokens[r.id]);
        if (missingRoles.length > 0) {
          checks.push({
            name: "credentials",
            status: "warn",
            message: `Credentials file missing tokens for roles: ${missingRoles.map((r) => r.id).join(", ")}`,
          });
        } else {
          checks.push({
            name: "credentials",
            status: "ok",
            message: `Credentials verified for admin and ${Object.keys(creds.roleTokens).length} roles`,
          });
        }
      } else {
        checks.push({
          name: "credentials",
          status: "ok",
          message: "Credentials file readable with admin token",
        });
      }
    } catch (err) {
      checks.push({
        name: "credentials",
        status: "error",
        message: `Error reading '${credsPath}': ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 4. Check Daemon Health & Presence
  let daemonReport: DoctorReport["daemon"] = undefined;
  const daemonInfo = readDaemonInfo(daemonFilePath);
  if (daemonInfo) {
    try {
      const res = await fetch(`${daemonInfo.url}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const health = (await res.json()) as {
          status: string;
          pid: number;
          uptimeSeconds: number;
          roles: string[];
          presence?: RolePresence[];
        };
        daemonReport = {
          running: true,
          pid: health.pid,
          url: daemonInfo.url,
          uptimeSeconds: health.uptimeSeconds,
          roles: health.roles,
          ...(health.presence ? { presence: health.presence } : {}),
        };
        checks.push({
          name: "daemon",
          status: "ok",
          message: `Daemon is running at ${daemonInfo.url} (PID ${health.pid}, uptime ${health.uptimeSeconds}s)`,
          details: { roles: health.roles, presence: health.presence },
        });
      } else {
        checks.push({
          name: "daemon",
          status: "warn",
          message: `Daemon control file exists, but ${daemonInfo.url}/health returned status ${res.status}`,
        });
      }
    } catch {
      checks.push({
        name: "daemon",
        status: "warn",
        message: `Daemon control file exists (${daemonInfo.url}), but server is unreachable (stale daemon.json?)`,
      });
    }
  } else {
    checks.push({
      name: "daemon",
      status: "ok",
      message: "No background daemon running (clean state). Run 'agentcorp start' to launch it.",
    });
  }

  // 5. Check Logs and Crash History
  const daemonLogPath = resolve(".agentcorp/daemon.log");
  const crashLogPath = resolve(".agentcorp/crash.log");

  if (existsSync(crashLogPath)) {
    try {
      const stats = statSync(crashLogPath);
      if (stats.size > 0) {
        checks.push({
          name: "crash_log",
          status: "warn",
          message: `Crash log contains entries (${stats.size} bytes). Inspect '.agentcorp/crash.log' for diagnostic details.`,
        });
      }
    } catch {}
  } else {
    checks.push({
      name: "crash_log",
      status: "ok",
      message: "No fatal crashes recorded in crash.log",
    });
  }

  if (existsSync(daemonLogPath)) {
    try {
      const stats = statSync(daemonLogPath);
      checks.push({
        name: "daemon_log",
        status: "ok",
        message: `Daemon log active (${(stats.size / 1024).toFixed(1)} KB)`,
      });
    } catch {}
  }

  const hasError = checks.some((c) => c.status === "error");
  const hasWarn = checks.some((c) => c.status === "warn");
  const overallStatus = hasError ? "error" : hasWarn ? "warn" : "ok";

  return {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    checks,
    ...(daemonReport ? { daemon: daemonReport } : {}),
  };
}

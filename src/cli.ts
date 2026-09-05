#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stdin as input, stdout as outputStream } from "node:process";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { exportAuditTrail } from "./audit.js";
import { AgentCorpBroker } from "./broker.js";
import { loadOrgConfig } from "./config.js";
import { ensureCredentials, loadCredentials } from "./credentials.js";
import { AgentCorpDatabase } from "./database.js";
import { recordCrashDiagnostics, RotatingLogger, runDoctor, sanitizeBrokerEventForLog } from "./diagnostics.js";
import { AgentCorpError } from "./errors.js";
import { AgentCorpServer, readDaemonInfo, type DaemonInfo } from "./server.js";
import { ensureDaemonRunning, isDaemonHealthy, resolveDefaultPath, runStdioAdapter } from "./stdio-adapter.js";
import { AgentCorpTui } from "./tui.js";
import type { InitialPolicy, PendingApproval, PolicyRule } from "./types.js";

process.on("uncaughtException", (error) => {
  recordCrashDiagnostics(".agentcorp/crash.log", error, {
    args: process.argv,
    cwd: process.cwd(),
  });
  console.error("Fatal uncaught exception recorded in .agentcorp/crash.log");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  recordCrashDiagnostics(".agentcorp/crash.log", reason, {
    args: process.argv,
    cwd: process.cwd(),
  });
  console.error("Fatal unhandled rejection recorded in .agentcorp/crash.log");
  process.exit(1);
});

const SAMPLE_ORG = `[company]
name = "My Agent Company"

[limits]
max_request_body_bytes = 2097152
max_message_payload_bytes = 1048576
max_artifact_bytes = 5242880
default_page_size = 50
max_page_size = 200
max_audit_payload_bytes = 65536

[[roles]]
id = "architect"
display_name = "Architect"
model = "openai/codex"
interface = "mcp"
capabilities = ["propose_plan", "review", "approve_merge"]
allowed_peers = ["developer"]
artifact_visibility = ["architect", "developer"]

[[roles]]
id = "developer"
display_name = "Developer"
model = "any/mcp-capable-agent"
interface = "mcp"
capabilities = ["write_code", "run_tests", "report"]
allowed_peers = ["architect"]
artifact_visibility = ["architect", "developer"]

# Higher priority rules win. If no rule matches, human approval is required.
[[policies]]
id = "gate-critical-proposals"
subject = "message"
message_type = "proposal"
priority = 200
action = "require_human"

[[policies]]
id = "allow-read-only-status-updates"
subject = "message"
message_type = "status_update"
priority = 100
risk_tags = ["read_only"]
action = "auto_approve"

[[policies]]
id = "allow-read-only-reports"
subject = "message"
message_type = "report"
priority = 100
risk_tags = ["read_only"]
action = "auto_approve"

[[policies]]
id = "allow-progress-updates"
subject = "task"
priority = 50
to_status = "in_progress"
action = "auto_approve"

[[policies]]
id = "gate-task-completion"
subject = "task"
priority = 100
to_status = "completed"
action = "require_human"
`;

interface GlobalOptions {
  config: string;
  db: string;
  credentials?: string | undefined;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

interface DaemonHealth {
  status: "ok";
  pid: number;
  startedAt: string;
  [key: string]: unknown;
}

async function refreshDaemonInfo(
  recorded: DaemonInfo,
): Promise<{ info: DaemonInfo; health: DaemonHealth; controlFileRepaired: boolean } | null> {
  try {
    const res = await fetch(`${recorded.url}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const health = await res.json() as DaemonHealth;
    if (health.status !== "ok" || !Number.isInteger(health.pid) || !health.startedAt) return null;
    const info = { ...recorded, pid: health.pid, startedAt: health.startedAt };
    const changed = info.pid !== recorded.pid || info.startedAt !== recorded.startedAt;
    let controlFileRepaired = false;
    if (changed) {
      try {
        writeFileSync(resolve(".agentcorp/daemon.json"), JSON.stringify(info, null, 2), "utf8");
        controlFileRepaired = true;
      } catch {
        // Health remains authoritative even if the local control file cannot be repaired.
      }
    }
    return { info, health, controlFileRepaired };
  } catch {
    return null;
  }
}

async function resolveDaemonInfo(
  explicitUrl?: string,
): Promise<{ info: DaemonInfo; health: DaemonHealth; controlFileRepaired: boolean } | null> {
  const recorded = readDaemonInfo();
  if (recorded) {
    const refreshed = await refreshDaemonInfo(recorded);
    if (refreshed) return refreshed;
  }
  const candidateUrl = explicitUrl ?? "http://127.0.0.1:54321";
  try {
    const res = await fetch(`${candidateUrl}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const health = (await res.json()) as DaemonHealth;
    if (health.status !== "ok" || !Number.isInteger(health.pid) || !health.startedAt) return null;
    const parsed = new URL(candidateUrl);
    const info: DaemonInfo = {
      pid: health.pid,
      port: Number(parsed.port || 54321),
      host: parsed.hostname,
      url: candidateUrl,
      startedAt: health.startedAt,
    };
    let controlFileRepaired = false;
    try {
      writeFileSync(resolve(".agentcorp/daemon.json"), JSON.stringify(info, null, 2), "utf8");
      controlFileRepaired = true;
    } catch {
      // Best effort
    }
    return { info, health, controlFileRepaired };
  } catch {
    return null;
  }
}

function openBroker(options: GlobalOptions): { broker: AgentCorpBroker; db: AgentCorpDatabase } {
  const config = loadOrgConfig(options.config);
  const db = new AgentCorpDatabase(options.db, {
    ...(config.limits?.default_page_size !== undefined ? { defaultPageSize: config.limits.default_page_size } : {}),
    ...(config.limits?.max_page_size !== undefined ? { maxPageSize: config.limits.max_page_size } : {}),
  });
  return { broker: new AgentCorpBroker(config, db), db };
}

async function getAdminClient(options: GlobalOptions) {
  const live = await resolveDaemonInfo();
  if (live) {
    const credPath = options.credentials ?? resolveDefaultPath({ configPath: options.config, dbPath: options.db }, "credentials.json");
    const creds = loadCredentials(credPath);
    const adminToken = creds?.adminToken;
    if (adminToken) {
      const headers = {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      };
      return {
        isDaemon: true,
        listApprovals: async () =>
          (await (await fetch(`${live.info.url}/api/approvals`, { headers })).json()) as PendingApproval[],
        approve: async (id: string, note?: string, payload?: unknown) =>
          await (
            await fetch(`${live.info.url}/api/approvals/${id}/approve`, {
              method: "POST",
              headers,
              body: JSON.stringify({ note, payload }),
            })
          ).json(),
        reject: async (id: string, note?: string) =>
          await (
            await fetch(`${live.info.url}/api/approvals/${id}/reject`, {
              method: "POST",
              headers,
              body: JSON.stringify({ note }),
            })
          ).json(),
        listPolicies: async () =>
          (await (await fetch(`${live.info.url}/api/policies`, { headers })).json()) as PolicyRule[],
        savePolicy: async (rule: unknown) =>
          await (
            await fetch(`${live.info.url}/api/policies`, {
              method: "POST",
              headers,
              body: JSON.stringify(rule),
            })
          ).json(),
        setPolicyEnabled: async (id: string, enabled: boolean) =>
          await (
            await fetch(`${live.info.url}/api/policies/${id}/${enabled ? "enable" : "disable"}`, {
              method: "POST",
              headers,
            })
          ).json(),
        prune: async (olderThanDays: number, dryRun?: boolean, deleteArtifacts?: boolean) =>
          await (
            await fetch(`${live.info.url}/api/maintenance/prune`, {
              method: "POST",
              headers,
              body: JSON.stringify({ olderThanDays, dryRun, deleteArtifacts }),
            })
          ).json(),
        compact: async () =>
          await (
            await fetch(`${live.info.url}/api/maintenance/compact`, {
              method: "POST",
              headers,
            })
          ).json(),
        close: () => {},
      };
    }
  }

  const { broker, db } = openBroker(options);
  return {
    isDaemon: false,
    listApprovals: async () => broker.listPendingApprovals(),
    approve: async (id: string, note?: string, payload?: unknown) => broker.approve(id, note, payload),
    reject: async (id: string, note?: string) => broker.reject(id, note),
    listPolicies: async () => broker.listPolicies(),
    savePolicy: async (rule: unknown) => broker.savePolicy(rule as never),
    setPolicyEnabled: async (id: string, enabled: boolean) => broker.setPolicyEnabled(id, enabled),
    prune: async (olderThanDays: number, dryRun?: boolean, deleteArtifacts?: boolean) =>
      broker.prune({ olderThanDays, dryRun, deleteArtifacts }),
    compact: async () =>
      broker.checkpointAndCompact(),
    close: () => db.close(),
  };
}

function openInBrowser(url: string): void {
  const plat = process.platform;
  try {
    if (plat === "win32") {
      spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (plat === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Best-effort browser launch
  }
}

async function getTui(options: GlobalOptions): Promise<{ tui: AgentCorpTui; close: () => void }> {
  const live = await resolveDaemonInfo();
  if (live) {
    const creds = loadCredentials();
    return {
      tui: new AgentCorpTui({
        daemonUrl: live.info.url,
        adminToken: creds?.adminToken,
      }),
      close: () => {},
    };
  }

  const { broker, db } = openBroker(options);
  return {
    tui: new AgentCorpTui({ broker }),
    close: () => db.close(),
  };
}

const program = new Command()
  .name("agentcorp")
  .description("Coordinate role-based AI agent teams over MCP")
  .version("0.1.0-alpha.1")
  .option("--config <path>", "organization configuration", "org.toml")
  .option("--db <path>", "SQLite broker database", ".agentcorp/agentcorp.db")
  .option("--credentials <path>", "credentials file path");

program
  .command("init")
  .description("Create starter org.toml and initialize credentials")
  .option("--force", "overwrite an existing org.toml")
  .action((options: { force?: boolean }) => {
    const target = resolve(program.opts<GlobalOptions>().config);
    if (existsSync(target) && !options.force) {
      throw new AgentCorpError("CONFIG_EXISTS", `${target} already exists; use --force to replace it`);
    }
    writeFileSync(target, SAMPLE_ORG, "utf8");
    const config = loadOrgConfig(target);
    const creds = ensureCredentials(config);
    output({
      created: target,
      credentials: ".agentcorp/credentials.json",
      roles: Object.keys(creds.roleTokens),
    });
  });

program
  .command("validate")
  .description("Validate org.toml and its role graph")
  .action(() => {
    const config = loadOrgConfig(program.opts<GlobalOptions>().config);
    output({ valid: true, company: config.company.name, roles: config.roles.map((role) => role.id) });
  });

program
  .command("start")
  .description("Start the central local broker daemon")
  .option("--port <number>", "HTTP port to listen on", "54321")
  .option("--host <string>", "Host address to bind to", "127.0.0.1")
  .option("--daemon", "Run detached in the background")
  .option("--daemon-file <path>", "path to daemon.json control file")
  .action(async (options: { port: string; host: string; daemon?: boolean; daemonFile?: string }) => {
    const gOpts = program.opts<GlobalOptions>();
    if (options.daemon) {
      const targetUrl = `http://${options.host}:${options.port}`;
      const live = await resolveDaemonInfo(targetUrl);
      if (live) {
        output({ startedInBackground: false, alreadyRunning: true, ...live.info });
        return;
      }
      const recorded = readDaemonInfo(options.daemonFile);
      if (recorded && (await isDaemonHealthy(recorded.url))) {
        output({
          startedInBackground: false,
          alreadyRunning: true,
          ...recorded,
          identityVerified: false,
          message: "Daemon is healthy but predates live identity reporting; restart it before relying on PID control",
        });
        return;
      }
      const args = [
        resolve(process.argv[1] ?? "dist/cli.js"),
        "start",
        "--port",
        options.port,
        "--host",
        options.host,
        "--config",
        resolve(gOpts.config),
        "--db",
        resolve(gOpts.db),
      ];
      if (options.daemonFile) {
        args.push("--daemon-file", resolve(options.daemonFile));
      }
      if (gOpts.credentials) {
        args.push("--credentials", resolve(gOpts.credentials));
      }
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: process.env,
      });
      child.unref();
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
        const spawnedLive = await resolveDaemonInfo(targetUrl);
        if (spawnedLive) {
          output({ startedInBackground: true, ...spawnedLive.info });
          return;
        }
      }
      throw new AgentCorpError(
        "DAEMON_SPAWN_FAILED",
        `Background daemon process ${child.pid ?? "unknown"} did not become healthy within 6 seconds`,
      );
    }

    const { broker } = openBroker(gOpts);
    const credPath = gOpts.credentials ?? resolveDefaultPath({ configPath: gOpts.config, dbPath: gOpts.db }, "credentials.json");
    const creds = ensureCredentials(broker.config, credPath);
    const targetDaemonFile = options.daemonFile
      ? resolve(options.daemonFile)
      : resolveDefaultPath({ configPath: gOpts.config, dbPath: gOpts.db }, "daemon.json");
    const server = new AgentCorpServer(broker, creds, {
      port: parseInt(options.port, 10),
      host: options.host,
      daemonFilePath: targetDaemonFile,
    });

    const daemonLogDir = dirname(targetDaemonFile);
    const daemonLogger = new RotatingLogger(resolve(daemonLogDir, "daemon.log"));
    daemonLogger.write(`AgentCorp daemon starting on ${options.host}:${options.port} (PID: ${process.pid}, config: ${gOpts.config}, db: ${gOpts.db})`);
    broker.on("event", (evt) => {
      const sanitized = sanitizeBrokerEventForLog(evt);
      daemonLogger.write(`[event:${evt.type}] ${JSON.stringify(sanitized)}`);
    });

    const info = await server.start();
    daemonLogger.write(`AgentCorp daemon listening at ${info.url}`);
    console.error(`AgentCorp Daemon started at ${info.url} (PID: ${info.pid})`);
    output({
      status: "running",
      ...info,
      adminToken: creds.adminToken,
      roles: Object.keys(creds.roleTokens),
    });

    const shutdown = async () => {
      console.error("\nShutting down AgentCorp daemon...");
      daemonLogger.write(`AgentCorp daemon shut down cleanly (PID: ${process.pid})`);
      await server.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  });

program
  .command("stop")
  .description("Stop the running central local broker daemon")
  .action(async () => {
    const live = await resolveDaemonInfo();
    if (!live) {
      const info = readDaemonInfo();
      const healthyLegacyDaemon = info ? await isDaemonHealthy(info.url) : false;
      output({
        stopped: false,
        message: healthyLegacyDaemon
          ? "Daemon is healthy but does not report a verifiable PID; refusing unsafe process termination"
          : "No running daemon recorded",
        recordedPid: info?.pid,
      });
      return;
    }
    try {
      process.kill(live.info.pid, "SIGTERM");
      output({ stopped: true, pid: live.info.pid, controlFileRepaired: live.controlFileRepaired });
    } catch (err) {
      output({ stopped: false, message: String(err) });
    }
  });

program
  .command("status")
  .description("Check daemon status and health")
  .action(async () => {
    const live = await resolveDaemonInfo();
    if (!live) {
      const info = readDaemonInfo();
      const healthyLegacyDaemon = info ? await isDaemonHealthy(info.url) : false;
      output({
        status: healthyLegacyDaemon ? "running" : "stopped",
        ...(info ?? {}),
        identityVerified: false,
      });
      return;
    }
    output({
      status: "running",
      ...live.info,
      health: live.health,
      controlFileRepaired: live.controlFileRepaired,
    });
  });

program
  .command("doctor")
  .description("Perform comprehensive self-healing and observability diagnostics")
  .action(async () => {
    const gOpts = program.opts<GlobalOptions>();
    const report = await runDoctor({
      configPath: gOpts.config,
      dbPath: gOpts.db,
    });
    output(report);
  });

program
  .command("mcp")
  .description("Run a role-bound AgentCorp MCP server over stdio (proxies to central daemon)")
  .requiredOption("--role <id>", "role identity for this connection")
  .option("--no-spawn", "do not auto-start daemon if it is not running")
  .option("--daemon-url <url>", "explicit daemon URL to connect to")
  .action(async (options: { role: string; spawn?: boolean; daemonUrl?: string }) => {
    const gOpts = program.opts<GlobalOptions>();
    await runStdioAdapter({
      role: options.role,
      configPath: gOpts.config,
      dbPath: gOpts.db,
      credentialsPath: gOpts.credentials,
      noSpawn: options.spawn === false,
      daemonUrl: options.daemonUrl,
    });
  });

program
  .command("console")
  .description("Launch terminal-native human console or open web dashboard")
  .option("--browser", "Open the modern web dashboard in your default browser")
  .option("--web", "Alias for --browser")
  .action(async (options: { browser?: boolean; web?: boolean }) => {
    const gOpts = program.opts<GlobalOptions>();
    if (options.browser || options.web) {
      const daemon = await ensureDaemonRunning({
        configPath: gOpts.config,
        dbPath: gOpts.db,
      });
      const consoleUrl = `${daemon.url}/console`;
      console.log(`\nOpening Web Dashboard at: ${consoleUrl}\n`);
      openInBrowser(consoleUrl);
      return;
    }

    const { tui, close } = await getTui(gOpts);
    try {
      const summary = await tui.runDashboard();
      if (summary.pendingCount > 0) {
        const rl = createInterface({ input, output: outputStream });
        try {
          const answer = (await rl.question(" Review pending approvals now? [Y/n] ")).trim().toLowerCase();
          if (answer === "" || answer === "y" || answer === "yes") {
            console.log("");
            await tui.runReview();
          }
        } finally {
          rl.close();
        }
      }
    } finally {
      close();
    }
  });

program
  .command("review")
  .description("Interactive terminal-native approval review (alias for 'agentcorp approvals review')")
  .action(async () => {
    const { tui, close } = await getTui(program.opts<GlobalOptions>());
    try {
      await tui.runReview();
    } finally {
      close();
    }
  });

const approvals = program.command("approvals").description("Human approval console commands");

approvals
  .command("review")
  .description("Interactive terminal-native human approval review loop")
  .action(async () => {
    const { tui, close } = await getTui(program.opts<GlobalOptions>());
    try {
      await tui.runReview();
    } finally {
      close();
    }
  });

approvals
  .command("list")
  .description("List pending approvals")
  .action(async () => {
    const admin = await getAdminClient(program.opts<GlobalOptions>());
    try {
      output(await admin.listApprovals());
    } finally {
      admin.close();
    }
  });

approvals
  .command("approve")
  .description("Approve a pending message or task transition")
  .argument("<approval-id>")
  .option("--note <text>", "decision note")
  .option("--payload <json>", "edited message payload as JSON")
  .action(async (approvalId: string, options: { note?: string; payload?: string }) => {
    const admin = await getAdminClient(program.opts<GlobalOptions>());
    try {
      const payload = options.payload === undefined ? undefined : JSON.parse(options.payload) as unknown;
      output(await admin.approve(approvalId, options.note, payload));
    } finally {
      admin.close();
    }
  });

approvals
  .command("reject")
  .description("Reject a pending message or task transition")
  .argument("<approval-id>")
  .option("--note <text>", "decision note")
  .action(async (approvalId: string, options: { note?: string }) => {
    const admin = await getAdminClient(program.opts<GlobalOptions>());
    try {
      output(await admin.reject(approvalId, options.note));
    } finally {
      admin.close();
    }
  });

const policies = program.command("policies").description("Manage runtime approval policies");

policies
  .command("list")
  .description("List approval policies")
  .action(async () => {
    const admin = await getAdminClient(program.opts<GlobalOptions>());
    try {
      output(await admin.listPolicies());
    } finally {
      admin.close();
    }
  });

policies
  .command("set")
  .description("Create or replace a policy from a JSON object")
  .argument("<json>", "policy JSON")
  .action(async (raw: string) => {
    const admin = await getAdminClient(program.opts<GlobalOptions>());
    try {
      output(await admin.savePolicy(JSON.parse(raw) as InitialPolicy));
    } finally {
      admin.close();
    }
  });

policies
  .command("enable")
  .description("Enable a policy")
  .argument("<policy-id>")
  .action(async (policyId: string) => {
    const admin = await getAdminClient(program.opts<GlobalOptions>());
    try {
      output(await admin.setPolicyEnabled(policyId, true));
    } finally {
      admin.close();
    }
  });

policies
  .command("disable")
  .description("Disable a policy without deleting its history")
  .argument("<policy-id>")
  .action(async (policyId: string) => {
    const admin = await getAdminClient(program.opts<GlobalOptions>());
    try {
      output(await admin.setPolicyEnabled(policyId, false));
    } finally {
      admin.close();
    }
  });

const audit = program.command("audit").description("Audit export commands");

audit
  .command("export")
  .description("Export human-readable Markdown and JSON audit trail to /coord")
  .option("--out <dir>", "output directory", "coord")
  .option("--limit <number>", "limit exported entries per category")
  .option("--since <iso-date>", "only export entries created/updated since ISO timestamp")
  .action((options: { out: string; limit?: string; since?: string }) => {
    const { broker, db } = openBroker(program.opts<GlobalOptions>());
    try {
      const result = exportAuditTrail(broker, options.out, {
        limit: options.limit ? parseInt(options.limit, 10) : undefined,
        since: options.since,
      });
      output({
        exported: true,
        markdownPath: result.markdownPath,
        jsonPath: result.jsonPath,
      });
    } finally {
      db.close();
    }
  });

program
  .command("prune")
  .description("Prune resolved history older than specified days (defaults to dry-run)")
  .option("--older-than <days>", "age in days of resolved tasks/messages to prune", "30")
  .option("--execute", "perform live deletion (defaults to safe simulation without deleting)")
  .option("--delete-artifacts", "delete associated artifacts instead of detaching them")
  .option("--compact", "run WAL checkpoint and VACUUM after pruning")
  .action(async (options: { olderThan: string; execute?: boolean; deleteArtifacts?: boolean; compact?: boolean }) => {
    const admin = await getAdminClient(program.opts<GlobalOptions>());
    try {
      const olderThanDays = parseInt(options.olderThan, 10);
      const dryRun = !options.execute;
      const pruneResult = await admin.prune(olderThanDays, dryRun, options.deleteArtifacts);
      let compactResult: unknown = undefined;
      if (options.compact && !dryRun) {
        compactResult = await admin.compact();
      }
      output({
        ...pruneResult,
        ...(dryRun ? { notice: "Dry run completed safely without deleting data. Pass --execute to delete records." } : {}),
        ...(compactResult ? { compact: compactResult } : {}),
      });
    } finally {
      admin.close();
    }
  });

program
  .command("compact")
  .description("Run SQLite WAL checkpoint (TRUNCATE) and VACUUM to reclaim disk space")
  .action(async () => {
    const admin = await getAdminClient(program.opts<GlobalOptions>());
    try {
      output(await admin.compact());
    } finally {
      admin.close();
    }
  });

program.parseAsync().catch((error: unknown) => {
  const code = error instanceof AgentCorpError ? error.code : "UNEXPECTED_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: code, message })}\n`);
  process.exitCode = 1;
});

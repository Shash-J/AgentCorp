import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentCorpDatabase } from "../src/database.js";
import { ensureCredentials } from "../src/credentials.js";
import { RotatingLogger } from "../src/diagnostics.js";
import { readDaemonInfo } from "../src/server.js";
import { createStdioProxy, isDaemonHealthy } from "../src/stdio-adapter.js";
import { OrgConfigSchema } from "../src/types.js";

describe("E2E Chaos & Self-Healing: Mid-Session Child Process Daemon Kill & Recovery", () => {
  let tempDir: string;
  let dbPath: string;
  let configPath: string;
  let credPath: string;
  let daemonFilePath: string;
  let logPath: string;
  let config: ReturnType<typeof OrgConfigSchema.parse>;
  const activeChildren: ChildProcess[] = [];
  const activePids: number[] = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentcorp-chaos-test-"));
    dbPath = join(tempDir, "chaos.db");
    configPath = join(tempDir, "org.toml");
    credPath = join(tempDir, "credentials.json");
    daemonFilePath = join(tempDir, "daemon.json");
    logPath = join(tempDir, "daemon.log");

    config = OrgConfigSchema.parse({
      company: { name: "Chaos Corp" },
      limits: {
        max_request_body_bytes: 2097152,
        max_message_payload_bytes: 1048576,
        max_artifact_bytes: 5242880,
        max_audit_payload_bytes: 65536,
      },
      roles: [
        {
          id: "architect",
          interface: "mcp",
          capabilities: ["propose_plan"],
          allowed_peers: ["developer"],
          artifact_visibility: ["architect", "developer"],
        },
        {
          id: "developer",
          interface: "mcp",
          capabilities: ["write_code"],
          allowed_peers: ["architect"],
          artifact_visibility: ["architect", "developer"],
        },
      ],
      policies: [],
    });

    writeFileSync(
      configPath,
      `[company]\nname = "Chaos Corp"\n\n[limits]\nmax_audit_payload_bytes = 65536\n\n[[roles]]\nid = "architect"\nallowed_peers = ["developer"]\ncapabilities = ["propose_plan"]\nartifact_visibility = ["architect", "developer"]\n\n[[roles]]\nid = "developer"\nallowed_peers = ["architect"]\ncapabilities = ["write_code"]\nartifact_visibility = ["architect", "developer"]\n`,
      "utf8",
    );

    ensureCredentials(config, credPath);
  });

  afterEach(() => {
    for (const child of activeChildren) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    activeChildren.length = 0;

    for (const pid of activePids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    activePids.length = 0;

    // Check daemon file for any auto-spawned PID and kill it
    try {
      if (existsSync(daemonFilePath)) {
        const info = readDaemonInfo(daemonFilePath);
        if (info?.pid) {
          try {
            process.kill(info.pid, "SIGKILL");
          } catch {}
        }
      }
    } catch {}

    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("survives true OS process kill mid-session, auto-recovers through proxy auto-spawn, and guarantees zero duplicate mutations", async () => {
    const logger = new RotatingLogger(logPath, { maxSizeBytes: 5000, maxBackups: 2 });
    logger.write("Test started: spawning real child process Daemon 1");

    const cliPath = resolve("dist/cli.js");

    // 1. Spawn Daemon 1 as an independent child process on an ephemeral port (port 0)
    const child1 = spawn(
      process.execPath,
      [
        cliPath,
        "start",
        "--port",
        "0",
        "--config",
        configPath,
        "--db",
        dbPath,
        "--daemon-file",
        daemonFilePath,
        "--credentials",
        credPath,
      ],
      { stdio: "ignore" },
    );
    activeChildren.push(child1);
    if (child1.pid) activePids.push(child1.pid);

    // Wait for Daemon 1 to become healthy
    const startDeadline = Date.now() + 6000;
    let daemon1Info: ReturnType<typeof readDaemonInfo> = null;
    while (Date.now() < startDeadline) {
      await new Promise((r) => setTimeout(r, 100));
      if (existsSync(daemonFilePath)) {
        const info = readDaemonInfo(daemonFilePath);
        if (info && (await isDaemonHealthy(info.url))) {
          daemon1Info = info;
          break;
        }
      }
    }

    expect(daemon1Info).not.toBeNull();
    expect(daemon1Info?.port).toBeGreaterThan(0);
    logger.write(`Daemon 1 healthy at ${daemon1Info?.url} (PID: ${daemon1Info?.pid})`);

    // 2. Connect stdio proxy client to Daemon 1 with auto-spawn enabled
    const { server: proxyServer, daemonClient } = await createStdioProxy({
      role: "developer",
      configPath,
      dbPath,
      credentialsPath: credPath,
      daemonFilePath,
      noSpawn: false, // Auto-spawn enabled
    });

    const mcpClient = new Client({ name: "ide-agent", version: "1.0.0" });
    const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
    await proxyServer.connect(sTransport);
    await mcpClient.connect(cTransport);

    let initialTaskId = "";
    let initialMessageId = "";
    let initialArtifactId = "";

    try {
      // Verify initial whoami & work queue
      const whoamiRes = await mcpClient.callTool({ name: "whoami", arguments: {} });
      expect(whoamiRes.isError).not.toBe(true);

      const queueRes = await mcpClient.callTool({ name: "get_work_queue", arguments: {} });
      expect(queueRes.isError).not.toBe(true);

      // Perform mutations with idempotency keys
      const taskRes = await mcpClient.callTool({
        name: "create_task",
        arguments: {
          title: "Critical Resilience Task",
          description: "Must survive OS kill",
          assigned_to: "architect",
          idempotency_key: "chaos-task-001",
        },
      });
      expect(taskRes.isError).not.toBe(true);
      const taskData = JSON.parse((taskRes.content as Array<{ text: string }>)[0]!.text) as { taskId: string };
      initialTaskId = taskData.taskId;
      expect(initialTaskId).toMatch(/^task_/);

      const msgRes = await mcpClient.callTool({
        name: "send_message",
        arguments: {
          to_role: "architect",
          type: "status_update",
          task_id: initialTaskId,
          payload: { progress: 50 },
          idempotency_key: "chaos-msg-001",
        },
      });
      expect(msgRes.isError).not.toBe(true);
      const msgData = JSON.parse((msgRes.content as Array<{ text: string }>)[0]!.text) as { messageId: string };
      initialMessageId = msgData.messageId;

      const artRes = await mcpClient.callTool({
        name: "create_artifact",
        arguments: {
          type: "diff",
          name: "patch.diff",
          content: "+ added true child process kill test",
          related_task_id: initialTaskId,
          idempotency_key: "chaos-art-001",
        },
      });
      expect(artRes.isError).not.toBe(true);
      const artData = JSON.parse((artRes.content as Array<{ text: string }>)[0]!.text) as { artifactId: string };
      initialArtifactId = artData.artifactId;

      // 3. CHAOS EVENT: Hard-kill the child process mid-session!
      const originalPid = daemon1Info!.pid;
      logger.write(`Terminating child process PID ${originalPid} mid-session...`);
      try {
        process.kill(originalPid, "SIGKILL");
      } catch {}
      try {
        child1.kill("SIGKILL");
      } catch {}

      // Verify the process is genuinely dead and endpoint is unreachable
      await new Promise((r) => setTimeout(r, 200));
      expect(await isDaemonHealthy(daemon1Info!.url)).toBe(false);
      logger.write(`Verified Daemon 1 at PID ${originalPid} is dead.`);

      // 4. RECOVERY: Issue a request through the SAME mcpClient during outage!
      // The resilient proxy detects transport failure and auto-spawns a replacement daemon
      logger.write("Calling tool during outage to trigger auto-spawn recovery...");
      const postRecoveryWhoami = await mcpClient.callTool({ name: "whoami", arguments: {} });
      expect(postRecoveryWhoami.isError).not.toBe(true);
      const whoamiContent = (postRecoveryWhoami.content as Array<{ text: string }>)[0]!.text;
      expect(whoamiContent).toContain("developer");

      // Verify a new daemon process was started
      const newDaemonInfo = readDaemonInfo(daemonFilePath);
      expect(newDaemonInfo).not.toBeNull();
      if (newDaemonInfo?.pid) {
        activePids.push(newDaemonInfo.pid);
        expect(newDaemonInfo.pid).not.toBe(originalPid);
      }

      // 5. REPLAY MUTATION WITH SAME IDEMPOTENCY KEY: Guarantees zero duplicate state
      const replayedTask = await mcpClient.callTool({
        name: "create_task",
        arguments: {
          title: "Critical Resilience Task",
          description: "Must survive OS kill",
          assigned_to: "architect",
          idempotency_key: "chaos-task-001",
        },
      });
      expect(replayedTask.isError).not.toBe(true);
      const replayedTaskData = JSON.parse((replayedTask.content as Array<{ text: string }>)[0]!.text) as { taskId: string };
      expect(replayedTaskData.taskId).toBe(initialTaskId);

      const replayedMsg = await mcpClient.callTool({
        name: "send_message",
        arguments: {
          to_role: "architect",
          type: "status_update",
          task_id: initialTaskId,
          payload: { progress: 50 },
          idempotency_key: "chaos-msg-001",
        },
      });
      expect(replayedMsg.isError).not.toBe(true);
      const replayedMsgData = JSON.parse((replayedMsg.content as Array<{ text: string }>)[0]!.text) as { messageId: string };
      expect(replayedMsgData.messageId).toBe(initialMessageId);

      const replayedArt = await mcpClient.callTool({
        name: "create_artifact",
        arguments: {
          type: "diff",
          name: "patch.diff",
          content: "+ added true child process kill test",
          related_task_id: initialTaskId,
          idempotency_key: "chaos-art-001",
        },
      });
      expect(replayedArt.isError).not.toBe(true);
      const replayedArtData = JSON.parse((replayedArt.content as Array<{ text: string }>)[0]!.text) as { artifactId: string };
      expect(replayedArtData.artifactId).toBe(initialArtifactId);

      // Verify exact count in SQLite database
      const dbVerify = new AgentCorpDatabase(dbPath);
      try {
        expect(dbVerify.countTasks()).toBe(1);
        expect(dbVerify.countMessages()).toBe(1);
        expect(dbVerify.countArtifacts()).toBe(1);
      } finally {
        dbVerify.close();
      }
    } finally {
      await mcpClient.close();
      await proxyServer.close();
      await daemonClient.close();
    }
  }, 15000);

  it("AC-RLY-06: isolated concurrent daemons run on dynamic ports without port collision", async () => {
    const tempDir2 = mkdtempSync(join(tmpdir(), "agentcorp-proj2-"));
    const configPath2 = join(tempDir2, "org.toml");
    const dbPath2 = join(tempDir2, "agentcorp.db");
    const credPath2 = join(tempDir2, "credentials.json");
    const daemonFilePath2 = join(tempDir2, "daemon.json");

    try {
      writeFileSync(
        configPath2,
        `[company]\nname = "Project 2"\n\n[[roles]]\nid = "developer"\nallowed_peers = []\ncapabilities = ["code"]\nartifact_visibility = ["developer"]\n`,
        "utf8",
      );
      ensureCredentials(config, credPath2);

      const cliPath = resolve("dist/cli.js");

      // Spawn Daemon A on ephemeral port (port 0)
      const childA = spawn(
        process.execPath,
        [cliPath, "start", "--port", "0", "--config", configPath, "--db", dbPath, "--daemon-file", daemonFilePath, "--credentials", credPath],
        { stdio: "ignore" },
      );
      activeChildren.push(childA);
      if (childA.pid) activePids.push(childA.pid);

      // Spawn Daemon B on ephemeral port (port 0)
      const childB = spawn(
        process.execPath,
        [cliPath, "start", "--port", "0", "--config", configPath2, "--db", dbPath2, "--daemon-file", daemonFilePath2, "--credentials", credPath2],
        { stdio: "ignore" },
      );
      activeChildren.push(childB);
      if (childB.pid) activePids.push(childB.pid);

      // Wait for both to be healthy
      const deadline = Date.now() + 6000;
      let infoA: ReturnType<typeof readDaemonInfo> = null;
      let infoB: ReturnType<typeof readDaemonInfo> = null;
      while (Date.now() < deadline && (!infoA || !infoB)) {
        await new Promise((r) => setTimeout(r, 100));
        if (!infoA && existsSync(daemonFilePath)) {
          const iA = readDaemonInfo(daemonFilePath);
          if (iA && (await isDaemonHealthy(iA.url))) infoA = iA;
        }
        if (!infoB && existsSync(daemonFilePath2)) {
          const iB = readDaemonInfo(daemonFilePath2);
          if (iB && (await isDaemonHealthy(iB.url))) infoB = iB;
        }
      }

      expect(infoA).not.toBeNull();
      expect(infoB).not.toBeNull();
      expect(infoA?.port).toBeGreaterThan(0);
      expect(infoB?.port).toBeGreaterThan(0);
      // Ports and URLs must be distinct
      expect(infoA?.port).not.toBe(infoB?.port);
      expect(infoA?.url).not.toBe(infoB?.url);
    } finally {
      try {
        if (existsSync(daemonFilePath2)) {
          const info = readDaemonInfo(daemonFilePath2);
          if (info?.pid) {
            try {
              process.kill(info.pid, "SIGKILL");
            } catch {}
          }
        }
      } catch {}
      try {
        rmSync(tempDir2, { recursive: true, force: true });
      } catch {}
    }
  }, 15000);
});

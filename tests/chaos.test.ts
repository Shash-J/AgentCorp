import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentCorpBroker } from "../src/broker.js";
import { ensureCredentials } from "../src/credentials.js";
import { AgentCorpDatabase } from "../src/database.js";
import { RotatingLogger } from "../src/diagnostics.js";
import { AgentCorpServer } from "../src/server.js";
import { createStdioProxy } from "../src/stdio-adapter.js";
import { OrgConfigSchema } from "../src/types.js";

describe("E2E Chaos & Self-Healing: Mid-Session Daemon Crash, Recovery & Idempotency", () => {
  let tempDir: string;
  let dbPath: string;
  let configPath: string;
  let credPath: string;
  let daemonFilePath: string;
  let logPath: string;
  let config: ReturnType<typeof OrgConfigSchema.parse>;

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
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup on Windows if file handle release is asynchronous
    }
  });

  it("survives mid-session daemon crash, reconnects proxy, guarantees zero duplicate mutation via idempotency, and preserves durable state", async () => {
    const logger = new RotatingLogger(logPath, { maxSizeBytes: 5000, maxBackups: 2 });
    logger.write("Test started: initializing Daemon 1");

    // Initialize Database 1 (disk-backed)
    const db1 = new AgentCorpDatabase(dbPath);
    const broker1 = new AgentCorpBroker(config, db1);
    const creds = ensureCredentials(config, credPath);

    const server1 = new AgentCorpServer(broker1, creds, {
      port: 0,
      host: "127.0.0.1",
      daemonFilePath,
      auditOnShutdown: false,
    });
    const daemon1Info = await server1.start();
    logger.write(`Daemon 1 started at ${daemon1Info.url} (PID: ${daemon1Info.pid})`);

    // Connect stdio proxy client to Daemon 1
    const { server: proxyServer, daemonClient } = await createStdioProxy({
      role: "developer",
      configPath,
      credentialsPath: credPath,
      daemonFilePath,
      noSpawn: true,
    });

    const mcpClient = new Client({ name: "ide-agent", version: "1.0.0" });
    const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
    await proxyServer.connect(sTransport);
    await mcpClient.connect(cTransport);

    let initialTaskId = "";
    let initialMessageId = "";
    let initialArtifactId = "";

    try {
      // 1. Verify initial whoami & presence
      const whoamiRes = await mcpClient.callTool({ name: "whoami", arguments: {} });
      expect(whoamiRes.isError).not.toBe(true);

      const queueRes = await mcpClient.callTool({ name: "get_work_queue", arguments: {} });
      expect(queueRes.isError).not.toBe(true);
      const queueText = (queueRes.content as Array<{ text: string }>)[0]!.text;
      const queueData = JSON.parse(queueText) as { presence?: Array<{ roleId: string; status: string }> };
      expect(queueData.presence).toBeDefined();
      const devPresence = queueData.presence?.find((p) => p.roleId === "developer");
      expect(devPresence?.status).toBe("online");

      // 2. Perform idempotent mutations
      const taskRes = await mcpClient.callTool({
        name: "create_task",
        arguments: {
          title: "Critical Refactor",
          description: "Must survive crash",
          assigned_to: "architect",
          idempotency_key: "task-key-001",
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
          idempotency_key: "msg-key-001",
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
          content: "+ added resilience test",
          related_task_id: initialTaskId,
          idempotency_key: "art-key-001",
        },
      });
      expect(artRes.isError).not.toBe(true);
      const artData = JSON.parse((artRes.content as Array<{ text: string }>)[0]!.text) as { artifactId: string };
      initialArtifactId = artData.artifactId;

      // Verify get_operation tool
      const opRes = await mcpClient.callTool({
        name: "get_operation",
        arguments: { idempotency_key: "task-key-001" },
      });
      expect(opRes.isError).not.toBe(true);
      const opData = JSON.parse((opRes.content as Array<{ text: string }>)[0]!.text) as {
        found: boolean;
        operation?: { responseJson: string };
      };
      expect(opData.found).toBe(true);
      expect(opData.operation?.responseJson).toContain(initialTaskId);

      // Verify counts in DB1 before crash
      expect(db1.countTasks()).toBe(1);
      expect(db1.countMessages()).toBe(1);
      expect(db1.countArtifacts()).toBe(1);

      // 3. CHAOS EVENT: Kill Daemon 1 mid-session!
      logger.write("Killing Daemon 1 mid-session...");
      await server1.stop();
      db1.close();
      logger.write("Daemon 1 stopped.");

      // 4. RECOVERY: Start Daemon 2 on a new port using the same DB
      const db2 = new AgentCorpDatabase(dbPath);
      const broker2 = new AgentCorpBroker(config, db2);
      const server2 = new AgentCorpServer(broker2, creds, {
        port: 0,
        host: "127.0.0.1",
        daemonFilePath,
        auditOnShutdown: false,
      });
      const daemon2Info = await server2.start();
      logger.write(`Daemon 2 restarted at ${daemon2Info.url} (PID: ${daemon2Info.pid})`);

      // 5. Verify the existing stdio client seamlessly reconnects to Daemon 2
      const postCrashWhoami = await mcpClient.callTool({ name: "whoami", arguments: {} });
      expect(postCrashWhoami.isError).not.toBe(true);
      const postWhoamiText = (postCrashWhoami.content as Array<{ text: string }>)[0]!.text;
      expect(postWhoamiText).toContain("developer");

      // 6. REPLAY MUTATION WITH SAME IDEMPOTENCY KEY: Zero duplicate creation
      const replayedTask = await mcpClient.callTool({
        name: "create_task",
        arguments: {
          title: "Critical Refactor",
          description: "Must survive crash",
          assigned_to: "architect",
          idempotency_key: "task-key-001", // SAME KEY
        },
      });
      expect(replayedTask.isError).not.toBe(true);
      const replayedTaskData = JSON.parse((replayedTask.content as Array<{ text: string }>)[0]!.text) as { taskId: string };
      // Must return the exact original taskId
      expect(replayedTaskData.taskId).toBe(initialTaskId);

      const replayedMsg = await mcpClient.callTool({
        name: "send_message",
        arguments: {
          to_role: "architect",
          type: "status_update",
          task_id: initialTaskId,
          payload: { progress: 50 },
          idempotency_key: "msg-key-001", // SAME KEY
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
          content: "+ added resilience test",
          related_task_id: initialTaskId,
          idempotency_key: "art-key-001", // SAME KEY
        },
      });
      expect(replayedArt.isError).not.toBe(true);
      const replayedArtData = JSON.parse((replayedArt.content as Array<{ text: string }>)[0]!.text) as { artifactId: string };
      expect(replayedArtData.artifactId).toBe(initialArtifactId);

      // Verify ZERO DUPLICATE ROWS created in Database 2
      expect(db2.countTasks()).toBe(1);
      expect(db2.countMessages()).toBe(1);
      expect(db2.countArtifacts()).toBe(1);

      // Verify operation lookup still works on Daemon 2
      const postOpRes = await mcpClient.callTool({
        name: "get_operation",
        arguments: { idempotency_key: "task-key-001" },
      });
      expect(postOpRes.isError).not.toBe(true);
      const postOpData = JSON.parse((postOpRes.content as Array<{ text: string }>)[0]!.text) as {
        found: boolean;
        operation?: { responseJson: string };
      };
      expect(postOpData.found).toBe(true);
      expect(postOpData.operation?.responseJson).toContain(initialTaskId);

      // Verify presence in Daemon 2
      const presenceList = db2.listRolePresence();
      const devPres = presenceList.find((p) => p.roleId === "developer");
      expect(devPres?.status).toBe("online");
      expect(devPres?.lastSeenAt).toBeDefined();

      await server2.stop();
      db2.close();
    } finally {
      await mcpClient.close();
      await proxyServer.close();
      await daemonClient.close();
    }
  });
});

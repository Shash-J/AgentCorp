import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { AgentCorpDatabase } from "../src/database.js";
import { AgentCorpBroker } from "../src/broker.js";
import { ensureDaemonRunning, isDaemonHealthy, createStdioProxy } from "../src/stdio-adapter.js";
import { type OrgConfig } from "../src/types.js";

const TEST_ROOT = resolve(".agentcorp-test-r3");

const testConfig: OrgConfig = {
  company: {
    name: "Reliability R3 Test Corp",
    mission: "Adversarial reliability verification round 3",
  },
  roles: [
    {
      id: "developer",
      title: "Software Engineer",
      capabilities: ["code", "test"],
      allowed_peers: ["architect"],
      artifact_visibility: ["developer", "architect"],
    },
    {
      id: "architect",
      title: "Systems Architect",
      capabilities: ["design", "review"],
      allowed_peers: ["developer"],
      artifact_visibility: ["developer", "architect"],
    },
  ],
  policies: [],
};

async function killProcess(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited
  }
  const start = Date.now();
  while (Date.now() - start < 3000) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      break;
    }
  }
}

describe("Codex Round 3 Reliability Blockers (AC-RLY-R3-01 and AC-RLY-R3-02)", () => {
  beforeAll(() => {
    try {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    } catch {
      // Ignored
    }
    mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  // AC-RLY-R3-01: Auto-spawn when MCP host working directory != config project directory.
  // Child daemon must write daemon.json, logs, and db into the project directory, not caller cwd.
  describe("AC-RLY-R3-01: Working Directory Isolation During Daemon Auto-Spawn", () => {
    it("spawns daemon and writes daemon.json, daemon.log, and db into project directory when host cwd differs", async () => {
      const projectDir = resolve(TEST_ROOT, "isolated_project");
      mkdirSync(projectDir, { recursive: true });

      const configPath = resolve(projectDir, "org.toml");
      writeFileSync(
        configPath,
        `
[company]
name = "Isolated Project Corp"
mission = "Cwd isolation verification"

[[roles]]
id = "developer"
title = "Software Engineer"
capabilities = ["code", "test"]
allowed_peers = ["architect"]
artifact_visibility = ["developer", "architect"]

[[roles]]
id = "architect"
title = "Systems Architect"
capabilities = ["design", "review"]
allowed_peers = ["developer"]
artifact_visibility = ["developer", "architect"]
`,
        "utf8",
      );

      // Verify that caller working directory differs from the target project directory
      expect(process.cwd()).not.toBe(projectDir);

      // Caller only specifies configPath (does NOT specify daemonFilePath, dbPath, or credentialsPath)
      const daemonInfo = await ensureDaemonRunning({
        configPath,
        port: 0,
      });

      expect(daemonInfo.pid).toBeGreaterThan(0);
      expect(await isDaemonHealthy(daemonInfo.url)).toBe(true);

      const expectedDaemonJson = resolve(projectDir, ".agentcorp", "daemon.json");
      const expectedDaemonLog = resolve(projectDir, ".agentcorp", "daemon.log");
      const expectedDb = resolve(projectDir, ".agentcorp", "agentcorp.db");
      const expectedCredentials = resolve(projectDir, ".agentcorp", "credentials.json");

      // Verify all assets exist in projectDir/.agentcorp
      expect(existsSync(expectedDaemonJson)).toBe(true);
      expect(existsSync(expectedDaemonLog)).toBe(true);
      expect(existsSync(expectedDb)).toBe(true);
      expect(existsSync(expectedCredentials)).toBe(true);

      // Verify that stdio proxy can connect to this auto-spawned daemon
      const { server: proxyServer, daemonClient } = await createStdioProxy({
        role: "developer",
        configPath,
        noSpawn: true,
      });

      const client = new Client({ name: "test-client", version: "1.0.0" });
      const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();

      await proxyServer.connect(sTransport);
      await client.connect(cTransport);

      try {
        const tools = await client.listTools();
        const names = tools.tools.map((t) => t.name);
        expect(names).toContain("whoami");
        expect(names).toContain("send_message");

        const whoamiRes = await client.callTool({ name: "whoami", arguments: {} });
        expect(whoamiRes.isError).toBeFalsy();
        const text = whoamiRes.content[0]!.type === "text" ? whoamiRes.content[0].text : "";
        expect(text).toContain("Isolated Project Corp");
        expect(text).toContain("developer");
      } finally {
        await client.close();
        await proxyServer.close();
        await daemonClient.close();
        await killProcess(daemonInfo.pid);
      }
    });
  });

  // AC-RLY-R3-02: Bounded audit queries must not select edited_payload or inflate heap.
  describe("AC-RLY-R3-02: Memory Isolation for Bounded Audit Queries", () => {
    it("omits edited_payload from SQL projection in getAuditApprovals with and without maxPayloadBytes", () => {
      const caseDir = resolve(TEST_ROOT, "case_rly_02_audit");
      mkdirSync(caseDir, { recursive: true });
      const dbPath = resolve(caseDir, "audit_memory_test.db");
      const db = new AgentCorpDatabase(dbPath);

      // Insert an approval directly with a massive 2 MB edited_payload
      const largePayload = "X".repeat(2_000_000);
      const normalContext = JSON.stringify({ reason: "Important task execution" });
      const largeContext = JSON.stringify({ reason: "Y".repeat(100_000) });

      const now = new Date().toISOString();

      db.db
        .prepare(
          `INSERT INTO approvals (
            approval_id, subject, subject_id, requested_by, status, context, created_at, edited_payload
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("appr-1", "task", "task-1", "developer", "pending", normalContext, now, largePayload);

      db.db
        .prepare(
          `INSERT INTO approvals (
            approval_id, subject, subject_id, requested_by, status, context, created_at, edited_payload
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("appr-2", "task", "task-2", "developer", "pending", largeContext, now, largePayload);

      // 1. Query with maxPayloadBytes: context should be truncated, and edited_payload should not exist
      const boundedApprovals = db.getAuditApprovals({ maxPayloadBytes: 512 });
      expect(boundedApprovals.length).toBe(2);

      for (const appr of boundedApprovals) {
        expect((appr as any).edited_payload).toBeUndefined();
        expect((appr as any).editedPayload).toBeUndefined();
      }

      const truncatedAppr = boundedApprovals.find((a) => a.approvalId === "appr-2")!;
      const contextObj = truncatedAppr.context as { _truncated: boolean; byteLength: number; preview: string };
      expect(contextObj._truncated).toBe(true);
      expect(contextObj.byteLength).toBeGreaterThan(100_000);
      expect(Buffer.byteLength(contextObj.preview, "utf8")).toBeLessThanOrEqual(512);

      // 2. Query without maxPayloadBytes: full context returned, but edited_payload is STILL omitted
      const unboundedApprovals = db.getAuditApprovals();
      expect(unboundedApprovals.length).toBe(2);

      for (const appr of unboundedApprovals) {
        expect((appr as any).edited_payload).toBeUndefined();
        expect((appr as any).editedPayload).toBeUndefined();
      }

      db.close();
    });

    it("bounds large task descriptions at the SQL layer with maxPayloadBytes in getAuditTasks", () => {
      const caseDir = resolve(TEST_ROOT, "case_rly_02_task_audit");
      mkdirSync(caseDir, { recursive: true });
      const dbPath = resolve(caseDir, "task_audit_test.db");
      const db = new AgentCorpDatabase(dbPath);

      const largeDescription = "D".repeat(500_000);
      const now = new Date().toISOString();

      db.db
        .prepare(
          `INSERT INTO tasks (
            task_id, title, description, created_by, assigned_to, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("task-large-1", "Large Task", largeDescription, "developer", "architect", "pending", now, now);

      // Bounded query
      const boundedTasks = db.getAuditTasks({ maxPayloadBytes: 256 });
      expect(boundedTasks.length).toBe(1);
      const task = boundedTasks[0]!;
      expect(task.description).toBeDefined();
      expect(Buffer.byteLength(task.description!, "utf8")).toBeLessThanOrEqual(256);

      // Unbounded query
      const unboundedTasks = db.getAuditTasks();
      expect(unboundedTasks.length).toBe(1);
      expect(unboundedTasks[0]!.description).toBe(largeDescription);

      db.close();
    });
  });
});

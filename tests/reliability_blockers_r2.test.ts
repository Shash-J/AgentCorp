import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { AgentCorpDatabase } from "../src/database.js";
import { AgentCorpBroker } from "../src/broker.js";
import { ensureDaemonRunning, isDaemonHealthy } from "../src/stdio-adapter.js";
import { type OrgConfig } from "../src/types.js";

const TEST_ROOT = resolve(".agentcorp-test-r2");

const testConfig: OrgConfig = {
  company: {
    name: "Reliability R2 Test Corp",
    mission: "Adversarial reliability verification",
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

describe("Codex Round 2 Reliability Blockers (AC-RLY-R2-01 through AC-RLY-R2-05)", () => {
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

  // AC-RLY-R2-01: Same-role concurrent requests must not duplicate.
  // Authoritative check under write lock + non-replacing insert.
  describe("AC-RLY-R2-01: Concurrent Idempotent Requests", () => {
    it("deduplicates simultaneous concurrent requests with the same key under write lock", async () => {
      const caseDir = resolve(TEST_ROOT, "case_rly_01_a");
      mkdirSync(caseDir, { recursive: true });
      const dbPath = resolve(caseDir, "idempotent_race.db");
      const db1 = new AgentCorpDatabase(dbPath);
      const db2 = new AgentCorpDatabase(dbPath);
      const broker1 = new AgentCorpBroker(testConfig, db1);
      const broker2 = new AgentCorpBroker(testConfig, db2);

      const idempotencyKey = "concurrent-key-1";
      const taskInput = {
        title: "Concurrent Task",
        description: "Must be created only once",
        idempotencyKey,
      };

      // Fire two concurrent createTask requests simultaneously across two independent DB connections
      const [res1, res2] = await Promise.all([
        Promise.resolve().then(() => broker1.createTask("developer", taskInput)),
        Promise.resolve().then(() => broker2.createTask("developer", taskInput)),
      ]);

      // Both callers must receive identical task record
      expect(res1.taskId).toBe(res2.taskId);
      expect(res1.title).toBe(taskInput.title);

      // Total tasks in DB must be exactly 1
      expect(db1.countTasks()).toBe(1);

      db1.close();
      db2.close();
    });

    it("prevents duplication across worker threads sharing the same database", async () => {
      const caseDir = resolve(TEST_ROOT, "case_rly_01_b");
      mkdirSync(caseDir, { recursive: true });
      const dbPath = resolve(caseDir, "worker_race.db");

      // Initialize database schema
      const initDb = new AgentCorpDatabase(dbPath);
      initDb.close();

      const dbUrl = pathToFileURL(resolve("dist/database.js")).href;
      const brokerUrl = pathToFileURL(resolve("dist/broker.js")).href;

      const workerScript = `
        import { parentPort, workerData } from 'node:worker_threads';
        import { AgentCorpDatabase } from '${dbUrl}';
        import { AgentCorpBroker } from '${brokerUrl}';

        const { dbPath, config, key } = workerData;
        try {
          const db = new AgentCorpDatabase(dbPath);
          const broker = new AgentCorpBroker(config, db);

          const task = broker.createTask("developer", {
            title: "Worker Thread Task",
            description: "Testing cross-thread write-lock idempotency",
            idempotencyKey: key,
          });
          db.close();
          parentPort.postMessage({ success: true, taskId: task.taskId });
        } catch (err) {
          parentPort.postMessage({ success: false, error: (err && (err.stack || err.message)) || String(err) });
        }
      `;

      const scriptPath = resolve(caseDir, "worker.mjs");
      writeFileSync(scriptPath, workerScript, "utf8");

      const key = "worker-thread-key-shared";

      const runWorker = () =>
        new Promise<{ success: boolean; taskId?: string; error?: string }>((resolvePromise) => {
          const w = new Worker(scriptPath, {
            workerData: { dbPath, config: testConfig, key },
          });
          w.on("message", resolvePromise);
          w.on("error", (err) => resolvePromise({ success: false, error: err.message }));
        });

      // Run two worker threads concurrently
      const [w1, w2] = await Promise.all([runWorker(), runWorker()]);

      expect(w1.error).toBeUndefined();
      expect(w2.error).toBeUndefined();
      expect(w1.success).toBe(true);
      expect(w2.success).toBe(true);
      expect(w1.taskId).toBe(w2.taskId);

      const verifyDb = new AgentCorpDatabase(dbPath);
      expect(verifyDb.countTasks()).toBe(1);
      verifyDb.close();
    });
  });

  // AC-RLY-R2-02: Simultaneous proxies for one project spawn exactly one daemon.
  describe("AC-RLY-R2-02: Cross-Process Startup Ownership Lock", () => {
    it("spawns exactly one daemon process when multiple proxies start concurrently for the same project", async () => {
      const caseDir = resolve(TEST_ROOT, "case_rly_02_a");
      mkdirSync(caseDir, { recursive: true });
      const dbPath = resolve(caseDir, "single_daemon.db");
      const daemonFilePath = resolve(caseDir, "daemon.json");
      const configPath = resolve(caseDir, "org.toml");

      writeFileSync(
        configPath,
        `
[company]
name = "Single Daemon Corp"
mission = "One daemon rule"

[[roles]]
id = "developer"
title = "Dev"
capabilities = ["code"]
allowed_peers = ["architect"]
artifact_visibility = ["developer", "architect"]

[[roles]]
id = "architect"
title = "Arch"
capabilities = ["review"]
allowed_peers = ["developer"]
artifact_visibility = ["developer", "architect"]
`,
        "utf8",
      );

      // Concurrently invoke ensureDaemonRunning twice
      const [d1, d2] = await Promise.all([
        ensureDaemonRunning({
          configPath,
          dbPath,
          daemonFilePath,
          port: 0,
        }),
        ensureDaemonRunning({
          configPath,
          dbPath,
          daemonFilePath,
          port: 0,
        }),
      ]);

      // Both returned DaemonInfos must be identical (same PID and URL)
      expect(d1.pid).toBe(d2.pid);
      expect(d1.port).toBe(d2.port);
      expect(d1.url).toBe(d2.url);

      // Verify health on the single running daemon
      expect(await isDaemonHealthy(d1.url)).toBe(true);

      // Cleanup: terminate the spawned daemon
      await killProcess(d1.pid);
    });

    it("recovers from a stale startup lock if the locking process died", async () => {
      const caseDir = resolve(TEST_ROOT, "case_rly_02_b");
      mkdirSync(caseDir, { recursive: true });
      const daemonFilePath = resolve(caseDir, "stale_daemon.json");
      const lockFilePath = `${daemonFilePath}.lock`;
      const configPath = resolve(caseDir, "org.toml");
      const dbPath = resolve(caseDir, "stale_daemon.db");

      writeFileSync(
        configPath,
        `
[company]
name = "Stale Corp"
mission = "Test"

[[roles]]
id = "developer"
title = "Dev"
capabilities = ["code"]
allowed_peers = ["architect"]
artifact_visibility = ["developer", "architect"]

[[roles]]
id = "architect"
title = "Arch"
capabilities = ["review"]
allowed_peers = ["developer"]
artifact_visibility = ["developer", "architect"]
`,
        "utf8",
      );

      // Simulate a stale lock from a dead PID
      writeFileSync(
        lockFilePath,
        JSON.stringify({ pid: 99999999, createdAt: Date.now() - 20000 }),
        "utf8",
      );

      const info = await ensureDaemonRunning({
        configPath,
        dbPath,
        daemonFilePath,
        port: 0,
      });

      expect(info.pid).toBeGreaterThan(0);
      expect(await isDaemonHealthy(info.url)).toBe(true);

      // Stale lock was recovered and cleaned up
      expect(existsSync(lockFilePath)).toBe(false);

      await killProcess(info.pid);
    });
  });

  // AC-RLY-R2-03: max_audit_payload_bytes UTF-8/BLOB byte-aware extraction & approval context bounding.
  describe("AC-RLY-R2-03: Byte-Aware Audit Extraction & Approval Bounding", () => {
    it("strictly bounds multibyte UTF-8 messages by byte count rather than character count", () => {
      const caseDir = resolve(TEST_ROOT, "case_rly_03_a");
      mkdirSync(caseDir, { recursive: true });
      const dbPath = resolve(caseDir, "multibyte_audit.db");
      const db = new AgentCorpDatabase(dbPath);
      const broker = new AgentCorpBroker(testConfig, db);

      // 4-byte UTF-8 emoji: 🚀 is 4 bytes, but 1 character.
      // 30,000 emojis = 30,000 characters, but 120,000 bytes!
      const largeEmojiString = "🚀".repeat(30000);
      const actualByteLength = Buffer.byteLength(largeEmojiString, "utf8");
      expect(actualByteLength).toBe(120000);

      broker.sendMessage("developer", {
        toRole: "architect",
        type: "status_update",
        payload: { text: largeEmojiString },
      });

      // Export audit with maxPayloadBytes = 65,536 (64 KB)
      const auditMessages = db.getAuditMessages({ maxPayloadBytes: 65536 });
      expect(auditMessages.length).toBe(1);

      const audited = auditMessages[0]!;
      expect(audited.payload).toBeDefined();

      const payloadObj = audited.payload as { _truncated: boolean; byteLength: number; preview: string };
      expect(payloadObj._truncated).toBe(true);
      expect(payloadObj.byteLength).toBeGreaterThan(65536);
      expect(payloadObj.preview.length).toBeLessThanOrEqual(512);

      db.close();
    });

    it("bounds large approval context in audit export", () => {
      const caseDir = resolve(TEST_ROOT, "case_rly_03_b");
      mkdirSync(caseDir, { recursive: true });
      const dbPath = resolve(caseDir, "approval_audit.db");
      const db = new AgentCorpDatabase(dbPath);

      // Create an approval record with a 200 KB context
      const largeContext = {
        data: "X".repeat(200000),
      };
      const contextStr = JSON.stringify(largeContext);
      const fullByteLen = Buffer.byteLength(contextStr, "utf8");

      db.db.prepare(`
        INSERT INTO approvals (approval_id, subject, subject_id, requested_by, status, context, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        "apr_large_test",
        "message",
        "msg_test",
        "developer",
        "pending",
        contextStr,
        new Date().toISOString(),
      );

      // Audit with maxPayloadBytes = 512
      const auditApprovals = db.getAuditApprovals({ maxPayloadBytes: 512 });
      expect(auditApprovals.length).toBe(1);

      const approval = auditApprovals[0]!;
      const contextObj = approval.context as { _truncated: boolean; byteLength: number; preview: string };
      expect(contextObj._truncated).toBe(true);
      expect(contextObj.byteLength).toBe(fullByteLen);
      expect(Buffer.byteLength(contextObj.preview, "utf8")).toBeLessThanOrEqual(512);

      db.close();
    });
  });

  // AC-RLY-R2-04: transactionDepth only increments after successful BEGIN IMMEDIATE.
  describe("AC-RLY-R2-04: Transaction Depth Recovery on BEGIN Failure", () => {
    it("recovers depth to 0 when BEGIN IMMEDIATE fails, ensuring subsequent transactions are atomic", () => {
      const caseDir = resolve(TEST_ROOT, "case_rly_04");
      mkdirSync(caseDir, { recursive: true });
      const dbPath = resolve(caseDir, "depth_recovery.db");
      const db = new AgentCorpDatabase(dbPath);

      // Acquire an exclusive write lock on a raw second connection to force SQLITE_BUSY
      const rawDb2 = new AgentCorpDatabase(dbPath);
      rawDb2.db.exec("BEGIN EXCLUSIVE");

      // Try transaction on db with a 50ms busy timeout to trigger failure
      db.db.exec("PRAGMA busy_timeout = 50");
      let beginFailed = false;
      try {
        db.transaction(() => {
          // Should not reach here
        });
      } catch {
        beginFailed = true;
      }
      expect(beginFailed).toBe(true);

      // Release lock on second connection
      rawDb2.db.exec("COMMIT");
      rawDb2.close();

      // Subsequent transaction on db must now succeed as a real outer transaction (not falsely nested)
      let executed = false;
      const result = db.transaction(() => {
        executed = true;
        return "atomic_success";
      });

      expect(executed).toBe(true);
      expect(result).toBe("atomic_success");

      db.close();
    });
  });

  // AC-RLY-R2-05: Authenticated caller activity only touches caller presence.
  describe("AC-RLY-R2-05: Non-Calling Role Presence Isolation", () => {
    it("ensures sender activity does not refresh recipient or peer presence", () => {
      const caseDir = resolve(TEST_ROOT, "case_rly_05");
      mkdirSync(caseDir, { recursive: true });
      const dbPath = resolve(caseDir, "presence_isolation.db");
      const db = new AgentCorpDatabase(dbPath);
      const broker = new AgentCorpBroker(testConfig, db);

      // Register both roles
      broker.registerRole("developer", "dev-agent-1", ["code", "test"]);
      broker.registerRole("architect", "arch-agent-1", ["design", "review"]);

      // Set architect lastSeenAt to 10 minutes ago
      const tenMinutesAgo = new Date(Date.now() - 600000).toISOString();
      db.touchRolePresence("architect", tenMinutesAgo);

      const initialPresence = db.listRolePresence();
      const archBefore = initialPresence.find((p) => p.roleId === "architect")!;
      expect(archBefore.lastSeenAt).toBe(tenMinutesAgo);
      expect(archBefore.status).toBe("offline");

      // Developer creates a task assigned to architect
      const task = broker.createTask("developer", {
        title: "Test Assignment",
        assignedTo: "architect",
      });

      // Developer sends a message to architect
      broker.sendMessage("developer", {
        toRole: "architect",
        type: "question",
        taskId: task.taskId,
        payload: { text: "Review request" },
      });

      // Developer creates an artifact visible to architect
      broker.createArtifact("developer", {
        type: "spec",
        name: "Feature Spec",
        content: "Draft architecture",
        visibleToRoles: ["developer", "architect"],
        relatedTaskId: task.taskId,
      });

      // Check presence: Developer must be online, Architect must STILL be offline at tenMinutesAgo!
      const presenceAfter = db.listRolePresence();
      const devAfter = presenceAfter.find((p) => p.roleId === "developer")!;
      const archAfter = presenceAfter.find((p) => p.roleId === "architect")!;

      expect(devAfter.status).toBe("online");
      expect(archAfter.status).toBe("offline");
      expect(archAfter.lastSeenAt).toBe(tenMinutesAgo);
      expect(archAfter.lastActiveAt).toBe(tenMinutesAgo);

      db.close();
    });
  });
});

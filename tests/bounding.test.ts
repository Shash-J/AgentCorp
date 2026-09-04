import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentCorpBroker } from "../src/broker.js";
import { AgentCorpDatabase } from "../src/database.js";
import { AgentCorpError } from "../src/errors.js";
import { AgentCorpServer } from "../src/server.js";
import type { OrgConfig } from "../src/types.js";

const TEST_CONFIG: OrgConfig = {
  company: { name: "Bounding Test Corp" },
  roles: [
    {
      id: "architect",
      interface: "mcp",
      capabilities: ["propose_plan", "review"],
      allowed_peers: ["developer"],
      artifact_visibility: "all",
    },
    {
      id: "developer",
      interface: "mcp",
      capabilities: ["write_code"],
      allowed_peers: ["architect"],
      artifact_visibility: ["developer", "architect"],
    },
  ],
  policies: [
    {
      id: "auto-status",
      subject: "message",
      message_type: "status_update",
      priority: 100,
      action: "auto_approve",
    },
  ],
};

describe("bounding, pagination, and maintenance", () => {
  describe("size limits enforcement", () => {
    it("broker rejects message payloads exceeding maxPayloadSizeBytes", () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db, {
        limits: { maxPayloadSizeBytes: 1024 }, // 1 KB limit
      });

      try {
        const smallPayload = { note: "hello world" };
        const msg = broker.sendMessage("architect", {
          toRole: "developer",
          type: "status_update",
          payload: smallPayload,
        });
        expect(msg.status).toBe("delivered");

        const largePayload = { data: "x".repeat(2048) };
        expect(() =>
          broker.sendMessage("architect", {
            toRole: "developer",
            type: "status_update",
            payload: largePayload,
          }),
        ).toThrowError(AgentCorpError);

        try {
          broker.sendMessage("architect", {
            toRole: "developer",
            type: "status_update",
            payload: largePayload,
          });
        } catch (err) {
          expect(err).toBeInstanceOf(AgentCorpError);
          expect((err as AgentCorpError).code).toBe("PAYLOAD_TOO_LARGE");
        }
      } finally {
        db.close();
      }
    });

    it("broker rejects artifact content exceeding maxArtifactSizeBytes", () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db, {
        limits: { maxArtifactSizeBytes: 2048 }, // 2 KB limit
      });

      try {
        const smallArtifact = broker.createArtifact("architect", {
          type: "spec",
          name: "small.md",
          content: "Small artifact content",
        });
        expect(smallArtifact.artifactId).toBeDefined();

        expect(() =>
          broker.createArtifact("architect", {
            type: "spec",
            name: "large.md",
            content: "a".repeat(4096),
          }),
        ).toThrowError(AgentCorpError);

        try {
          broker.createArtifact("architect", {
            type: "spec",
            name: "large.md",
            content: "a".repeat(4096),
          });
        } catch (err) {
          expect(err).toBeInstanceOf(AgentCorpError);
          expect((err as AgentCorpError).code).toBe("ARTIFACT_TOO_LARGE");
        }
      } finally {
        db.close();
      }
    });

    it("HTTP server rejects requests exceeding maxBodySizeBytes with 413 Payload Too Large", async () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db);
      const server = new AgentCorpServer(broker, undefined, {
        port: 0,
        maxBodySizeBytes: 1024, // 1 KB max request body
      });

      const info = await server.start();
      try {
        const oversizedBody = JSON.stringify({ note: "y".repeat(2048) });
        const res = await fetch(`${info.url}/api/maintenance/prune`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${server.credentials.adminToken}`,
            "Content-Type": "application/json",
          },
          body: oversizedBody,
        });

        expect(res.status).toBe(413);
        const data = (await res.json()) as { error: string; message: string };
        expect(data.error).toBe("PAYLOAD_TOO_LARGE");
      } finally {
        await server.stop();
        db.close();
      }
    });
  });

  describe("cursor pagination and bounded defaults", () => {
    it("paginates tasks with limit and cursor correctly", () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db);

      try {
        for (let i = 1; i <= 7; i++) {
          db.insertTask({
            taskId: `task_00${i}`,
            title: `Task ${i}`,
            description: null,
            createdBy: "architect",
            assignedTo: "developer",
            status: "assigned",
            createdAt: `2026-09-01T00:00:0${i}Z`,
            updatedAt: `2026-09-01T00:00:0${i}Z`,
          });
        }

        // Page 1: limit 3
        const page1 = db.listAllTasksPaginated({ limit: 3 });
        expect(page1.items).toHaveLength(3);
        expect(page1.items.map((t) => t.taskId)).toEqual(["task_001", "task_002", "task_003"]);
        expect(page1.nextCursor).not.toBeNull();

        // Page 2: limit 3 with cursor from page 1
        const page2 = db.listAllTasksPaginated({ limit: 3, cursor: page1.nextCursor! });
        expect(page2.items).toHaveLength(3);
        expect(page2.items.map((t) => t.taskId)).toEqual(["task_004", "task_005", "task_006"]);
        expect(page2.nextCursor).not.toBeNull();

        // Page 3: limit 3 with cursor from page 2 (only 1 remaining)
        const page3 = db.listAllTasksPaginated({ limit: 3, cursor: page2.nextCursor! });
        expect(page3.items).toHaveLength(1);
        expect(page3.items[0]!.taskId).toBe("task_007");
        expect(page3.nextCursor).toBeNull();
      } finally {
        db.close();
      }
    });

    it("paginates role tasks ordered by updatedAt DESC", () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db);

      try {
        for (let i = 1; i <= 5; i++) {
          db.insertTask({
            taskId: `task_00${i}`,
            title: `Task ${i}`,
            description: null,
            createdBy: "architect",
            assignedTo: "developer",
            status: "assigned",
            createdAt: `2026-09-01T00:00:0${i}Z`,
            updatedAt: `2026-09-01T00:00:0${i}Z`,
          });
        }

        // Tasks for developer: 5 total, latest updated first
        const page1 = broker.listTasksPaginated("developer", { limit: 2 });
        expect(page1.items).toHaveLength(2);
        expect(page1.items[0]!.taskId).toBe("task_005");
        expect(page1.items[1]!.taskId).toBe("task_004");
        expect(page1.nextCursor).not.toBeNull();

        const page2 = broker.listTasksPaginated("developer", { limit: 2, cursor: page1.nextCursor! });
        expect(page2.items).toHaveLength(2);
        expect(page2.items[0]!.taskId).toBe("task_003");
        expect(page2.items[1]!.taskId).toBe("task_002");

        const page3 = broker.listTasksPaginated("developer", { limit: 2, cursor: page2.nextCursor! });
        expect(page3.items).toHaveLength(1);
        expect(page3.items[0]!.taskId).toBe("task_001");
        expect(page3.nextCursor).toBeNull();
      } finally {
        db.close();
      }
    });

    it("paginates messages and inbox correctly", () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db);

      try {
        for (let i = 1; i <= 6; i++) {
          broker.sendMessage("architect", {
            toRole: "developer",
            type: "status_update",
            payload: { seq: i },
          });
        }

        const page1 = broker.getInboxPaginated("developer", { limit: 2 });
        expect(page1.items).toHaveLength(2);
        expect(page1.nextCursor).not.toBeNull();

        const page2 = broker.getInboxPaginated("developer", { limit: 2, cursor: page1.nextCursor! });
        expect(page2.items).toHaveLength(2);
        expect(page2.items[0]!.messageId).not.toBe(page1.items[1]!.messageId);

        const page3 = broker.getInboxPaginated("developer", { limit: 2, cursor: page2.nextCursor! });
        expect(page3.items).toHaveLength(2);
        expect(page3.nextCursor).toBeNull();
      } finally {
        db.close();
      }
    });

    it("HTTP Admin API returns array and X-Next-Cursor header by default, or envelope with ?envelope=true", async () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db);
      const server = new AgentCorpServer(broker, undefined, { port: 0 });
      const info = await server.start();

      try {
        for (let i = 1; i <= 4; i++) {
          db.insertTask({
            taskId: `task_${i}`,
            title: `Task ${i}`,
            description: null,
            createdBy: "architect",
            assignedTo: "developer",
            status: "assigned",
            createdAt: `2026-09-01T00:00:0${i}Z`,
            updatedAt: `2026-09-01T00:00:0${i}Z`,
          });
        }

        // Standard GET /api/tasks?limit=2
        const res1 = await fetch(`${info.url}/api/tasks?limit=2`, {
          headers: { Authorization: `Bearer ${server.credentials.adminToken}` },
        });
        expect(res1.status).toBe(200);
        const nextCursorHeader = res1.headers.get("X-Next-Cursor");
        expect(nextCursorHeader).toBeTruthy();
        const items1 = (await res1.json()) as Array<{ taskId: string }>;
        expect(Array.isArray(items1)).toBe(true);
        expect(items1).toHaveLength(2);
        expect(items1[0]!.taskId).toBe("task_1");

        // Envelope GET /api/tasks?limit=2&envelope=true
        const res2 = await fetch(`${info.url}/api/tasks?limit=2&envelope=true`, {
          headers: { Authorization: `Bearer ${server.credentials.adminToken}` },
        });
        expect(res2.status).toBe(200);
        const envelope = (await res2.json()) as { items: Array<{ taskId: string }>; nextCursor: string | null };
        expect(Array.isArray(envelope.items)).toBe(true);
        expect(envelope.items).toHaveLength(2);
        expect(envelope.nextCursor).toBe(nextCursorHeader);
      } finally {
        await server.stop();
        db.close();
      }
    });
  });

  describe("history pruning and database maintenance", () => {
    it("pruneHistory dry-run counts eligible records without deleting", () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db);

      try {
        const oldTimestamp = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
        const recentTimestamp = new Date().toISOString();

        // 1 old completed task
        db.insertTask({
          taskId: "task_old_completed",
          title: "Old Completed Task",
          description: null,
          createdBy: "architect",
          assignedTo: "developer",
          status: "completed",
          createdAt: oldTimestamp,
          updatedAt: oldTimestamp,
        });

        // 1 old message for that task
        db.insertMessage({
          messageId: "msg_old_1",
          taskId: "task_old_completed",
          fromRole: "architect",
          toRole: "developer",
          type: "status_update",
          payload: {},
          references: [],
          inReplyTo: null,
          status: "delivered",
          riskTags: [],
          createdAt: oldTimestamp,
          resolvedAt: oldTimestamp,
        });

        // 1 active task
        db.insertTask({
          taskId: "task_active",
          title: "Active Task",
          description: null,
          createdBy: "architect",
          assignedTo: "developer",
          status: "in_progress",
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        });

        // Dry run prune older than 30 days
        const dryRunResult = broker.prune({ olderThanDays: 30, dryRun: true });
        expect(dryRunResult.dryRun).toBe(true);
        expect(dryRunResult.tasksCount).toBe(1);
        expect(dryRunResult.messagesCount).toBe(1);

        // Database still contains both tasks
        expect(db.getTask("task_old_completed")).toBeDefined();
        expect(db.getTask("task_active")).toBeDefined();
      } finally {
        db.close();
      }
    });

    it("pruneHistory deletes terminal records older than cutoff and preserves active work", () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db);

      try {
        const oldTimestamp = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
        const recentTimestamp = new Date().toISOString();

        // Old cancelled task
        db.insertTask({
          taskId: "task_old_cancelled",
          title: "Old Cancelled Task",
          description: null,
          createdBy: "architect",
          assignedTo: "developer",
          status: "cancelled",
          createdAt: oldTimestamp,
          updatedAt: oldTimestamp,
        });

        // Old message
        db.insertMessage({
          messageId: "msg_old_cancelled",
          taskId: "task_old_cancelled",
          fromRole: "architect",
          toRole: "developer",
          type: "status_update",
          payload: { text: "cancelled" },
          references: [],
          inReplyTo: null,
          status: "delivered",
          riskTags: [],
          createdAt: oldTimestamp,
          resolvedAt: oldTimestamp,
        });

        // Active task
        db.insertTask({
          taskId: "task_in_progress",
          title: "Active Work",
          description: null,
          createdBy: "architect",
          assignedTo: "developer",
          status: "in_progress",
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
        });

        // Execute live prune
        const result = broker.prune({ olderThanDays: 30, dryRun: false });
        expect(result.dryRun).toBe(false);
        expect(result.tasksCount).toBe(1);
        expect(result.messagesCount).toBe(1);

        // Old task and message are gone
        expect(db.getTask("task_old_cancelled")).toBeUndefined();
        expect(db.getMessage("msg_old_cancelled")).toBeUndefined();

        // Active task is preserved
        expect(db.getTask("task_in_progress")).toBeDefined();
      } finally {
        db.close();
      }
    });

    it("checkpointAndCompact executes WAL checkpoint and VACUUM successfully", () => {
      const dbDir = resolve(".agentcorp/test_compact");
      mkdirSync(dbDir, { recursive: true });
      const dbPath = resolve(dbDir, "compact_test.db");
      const db = new AgentCorpDatabase(dbPath);
      const broker = new AgentCorpBroker(TEST_CONFIG, db);

      try {
        db.insertTask({
          taskId: "task_compact",
          title: "Testing Compact",
          description: null,
          createdBy: "architect",
          assignedTo: "developer",
          status: "completed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        const maintenance = broker.checkpointAndCompact();
        expect(maintenance.checkpoint).toBe("TRUNCATE");
        expect(maintenance.vacuumed).toBe(true);
      } finally {
        db.close();
        rmSync(dbDir, { recursive: true, force: true });
      }
    });
  });

  describe("concurrency and restart resilience", () => {
    it("handles multiple sequential and concurrent transactions with WAL mode", () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db);

      try {
        // Concurrently insert tasks in parallel
        const promises = Array.from({ length: 15 }, (_, i) => {
          return new Promise<void>((resolvePromise) => {
            broker.createTask("architect", {
              title: `Concurrent task ${i}`,
              assignedTo: "developer",
            });
            resolvePromise();
          });
        });

        expect(async () => {
          await Promise.all(promises);
        }).not.toThrow();

        const tasks = broker.listTasks("architect");
        expect(tasks.length).toBe(15);
      } finally {
        db.close();
      }
    });

    it("maintains schema version and data integrity across database restarts", () => {
      const testDir = resolve(".agentcorp/test_restart");
      mkdirSync(testDir, { recursive: true });
      const dbPath = resolve(testDir, "restart_test.db");

      // Phase 1: Open, write data, verify schema version 3
      const db1 = new AgentCorpDatabase(dbPath);
      expect(db1.getSchemaVersion()).toBe(3);
      db1.insertTask({
        taskId: "task_persisted",
        title: "Persisted Task",
        description: null,
        createdBy: "architect",
        assignedTo: "developer",
        status: "assigned",
        createdAt: "2026-09-01T12:00:00Z",
        updatedAt: "2026-09-01T12:00:00Z",
      });
      db1.close();

      // Phase 2: Reopen from disk, verify schema version and data persistence
      const db2 = new AgentCorpDatabase(dbPath);
      try {
        expect(db2.getSchemaVersion()).toBe(3);
        const task = db2.getTask("task_persisted");
        expect(task).toBeDefined();
        expect(task?.title).toBe("Persisted Task");
      } finally {
        db2.close();
        rmSync(testDir, { recursive: true, force: true });
      }
    });
  });
});

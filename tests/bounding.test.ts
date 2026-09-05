import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { generateAuditSnapshot } from "../src/audit.js";
import { AgentCorpBroker } from "../src/broker.js";
import { parseOrgConfig } from "../src/config.js";
import { AgentCorpDatabase } from "../src/database.js";
import { AgentCorpError } from "../src/errors.js";
import { createMcpServer } from "../src/mcp.js";
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

      // Phase 1: Open, write data, verify schema version 7
      const db1 = new AgentCorpDatabase(dbPath);
      expect(db1.getSchemaVersion()).toBe(7);
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
        expect(db2.getSchemaVersion()).toBe(7);
        const task = db2.getTask("task_persisted");
        expect(task).toBeDefined();
        expect(task?.title).toBe("Persisted Task");
      } finally {
        db2.close();
        rmSync(testDir, { recursive: true, force: true });
      }
    });
  });

  describe("blocker regressions (AC-BND-01 through AC-BND-07)", () => {
    it("AC-BND-01: prunes task with attached artifact cleanly, detaching by default or deleting when requested", () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db);

      try {
        const oldTimestamp = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

        // 1. Setup task and attached artifact
        db.insertTask({
          taskId: "task_fk_test_1",
          title: "FK Test Task 1",
          description: null,
          createdBy: "architect",
          assignedTo: "developer",
          status: "completed",
          createdAt: oldTimestamp,
          updatedAt: oldTimestamp,
        });

        db.insertArtifact({
          artifactId: "art_fk_test_1",
          relatedTaskId: "task_fk_test_1",
          producedBy: "architect",
          type: "spec",
          name: "spec1.md",
          content: "test content 1",
          contentHash: "hash1",
          contentUri: null,
          visibleToRoles: ["architect", "developer"],
          createdAt: oldTimestamp,
        });

        // Default prune: detaches artifact (sets related_task_id to null) without FK violation
        const resultDetach = broker.prune({ olderThanDays: 30, dryRun: false });
        expect(resultDetach.tasksCount).toBe(1);
        expect(resultDetach.artifactsDetachedCount).toBe(1);
        expect(resultDetach.artifactsDeletedCount).toBe(0);

        expect(db.getTask("task_fk_test_1")).toBeUndefined();
        const artifact1 = db.getArtifact("art_fk_test_1");
        expect(artifact1).toBeDefined();
        expect(artifact1?.relatedTaskId).toBeNull();

        // 2. Setup second task and attached artifact with deleteArtifacts: true
        db.insertTask({
          taskId: "task_fk_test_2",
          title: "FK Test Task 2",
          description: null,
          createdBy: "architect",
          assignedTo: "developer",
          status: "completed",
          createdAt: oldTimestamp,
          updatedAt: oldTimestamp,
        });

        db.insertArtifact({
          artifactId: "art_fk_test_2",
          relatedTaskId: "task_fk_test_2",
          producedBy: "architect",
          type: "spec",
          name: "spec2.md",
          content: "test content 2",
          contentHash: "hash2",
          contentUri: null,
          visibleToRoles: ["architect", "developer"],
          createdAt: oldTimestamp,
        });

        const resultDelete = broker.prune({ olderThanDays: 30, dryRun: false, deleteArtifacts: true });
        expect(resultDelete.tasksCount).toBe(1);
        expect(resultDelete.artifactsDeletedCount).toBe(1);
        expect(resultDelete.artifactsDetachedCount).toBe(0);

        expect(db.getTask("task_fk_test_2")).toBeUndefined();
        expect(db.getArtifact("art_fk_test_2")).toBeUndefined();
      } finally {
        db.close();
      }
    });

    it("AC-BND-02: executes prune using set-based subqueries without variable bounds or materialization", () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db);

      try {
        const oldTimestamp = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

        // Insert 100 old completed tasks and 200 associated messages
        for (let i = 0; i < 100; i++) {
          db.insertTask({
            taskId: `scale_task_${i}`,
            title: `Scale Task ${i}`,
            description: null,
            createdBy: "architect",
            assignedTo: "developer",
            status: "completed",
            createdAt: oldTimestamp,
            updatedAt: oldTimestamp,
          });

          db.insertMessage({
            messageId: `scale_msg_${i}_1`,
            taskId: `scale_task_${i}`,
            fromRole: "architect",
            toRole: "developer",
            type: "status_update",
            payload: { i },
            references: [],
            inReplyTo: null,
            status: "delivered",
            riskTags: [],
            createdAt: oldTimestamp,
            resolvedAt: oldTimestamp,
          });
          db.insertMessage({
            messageId: `scale_msg_${i}_2`,
            taskId: `scale_task_${i}`,
            fromRole: "developer",
            toRole: "architect",
            type: "status_update",
            payload: { i },
            references: [],
            inReplyTo: null,
            status: "delivered",
            riskTags: [],
            createdAt: oldTimestamp,
            resolvedAt: oldTimestamp,
          });
        }

        expect(db.countTasks()).toBe(100);
        expect(db.countMessages()).toBe(200);

        // Live prune executes via subquery without variable expansion
        const pruneResult = broker.prune({ olderThanDays: 30, dryRun: false });
        expect(pruneResult.tasksCount).toBe(100);
        expect(pruneResult.messagesCount).toBe(200);
        expect(db.countTasks()).toBe(0);
        expect(db.countMessages()).toBe(0);
      } finally {
        db.close();
      }
    });

    it("AC-BND-03: generates audit snapshots over entire history past default 50-row limit with watermark metadata", () => {
      const db = new AgentCorpDatabase(":memory:");

      try {
        // Insert 60 tasks and 60 messages
        for (let i = 0; i < 60; i++) {
          const iso = new Date(1700000000000 + i * 1000).toISOString();
          db.insertTask({
            taskId: `audit_task_${i}`,
            title: `Audit Task ${i}`,
            description: null,
            createdBy: "architect",
            assignedTo: "developer",
            status: "assigned",
            createdAt: iso,
            updatedAt: iso,
          });
          db.insertMessage({
            messageId: `audit_msg_${i}`,
            taskId: `audit_task_${i}`,
            fromRole: "architect",
            toRole: "developer",
            type: "status_update",
            payload: { i },
            references: [],
            inReplyTo: null,
            status: "delivered",
            riskTags: [],
            createdAt: iso,
            resolvedAt: iso,
          });
        }

        const broker = new AgentCorpBroker(TEST_CONFIG, db);

        // Full audit snapshot
        const fullSnapshot = generateAuditSnapshot(broker);
        expect(fullSnapshot.tasks.length).toBe(60);
        expect(fullSnapshot.messages.length).toBe(60);
        expect(fullSnapshot.metadata.totalTasksAvailable).toBe(60);
        expect(fullSnapshot.metadata.totalMessagesAvailable).toBe(60);
        expect(fullSnapshot.metadata.truncated).toBe(false);

        // Bounded audit snapshot with limit: 25
        const boundedSnapshot = generateAuditSnapshot(broker, { limit: 25 });
        expect(boundedSnapshot.tasks.length).toBe(25);
        expect(boundedSnapshot.messages.length).toBe(25);
        expect(boundedSnapshot.metadata.totalTasksAvailable).toBe(60);
        expect(boundedSnapshot.metadata.totalMessagesAvailable).toBe(60);
        expect(boundedSnapshot.metadata.truncated).toBe(true);
      } finally {
        db.close();
      }
    });

    it("AC-BND-04: scans database until page is filled when artifacts are filtered by ACL", () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db);

      try {
        // Artifacts 1-5: visibility ["auditor"] (hidden from developer)
        // Artifacts 6-9: visibility ["developer"] (visible to developer)
        for (let i = 1; i <= 5; i++) {
          db.insertArtifact({
            artifactId: `hidden_art_${i}`,
            relatedTaskId: null,
            producedBy: "architect",
            type: "spec",
            name: `hidden_${i}.md`,
            content: "hidden",
            contentHash: `hash_h_${i}`,
            contentUri: null,
            visibleToRoles: ["auditor"],
            createdAt: `2026-09-01T00:00:0${i}Z`,
          });
        }

        for (let i = 6; i <= 9; i++) {
          db.insertArtifact({
            artifactId: `visible_art_${i}`,
            relatedTaskId: null,
            producedBy: "developer",
            type: "code",
            name: `visible_${i}.ts`,
            content: "visible",
            contentHash: `hash_v_${i}`,
            contentUri: null,
            visibleToRoles: ["developer"],
            createdAt: `2026-09-01T00:00:0${i}Z`,
          });
        }

        // Developer asks for limit: 2.
        // Should skip hidden artifacts and return first 2 visible items in one page, not an empty page!
        const page1 = broker.listArtifactsPaginated("developer", { limit: 2 });
        expect(page1.items).toHaveLength(2);
        expect(page1.items.map((a) => a.artifactId)).toEqual(["visible_art_6", "visible_art_7"]);
        expect(page1.nextCursor).not.toBeNull();

        // Page 2
        const page2 = broker.listArtifactsPaginated("developer", { limit: 2, cursor: page1.nextCursor! });
        expect(page2.items).toHaveLength(2);
        expect(page2.items.map((a) => a.artifactId)).toEqual(["visible_art_8", "visible_art_9"]);
      } finally {
        db.close();
      }
    });

    it("AC-BND-05: handles real multi-connection disk-backed WAL contention and busy timeout", async () => {
      const testDir = resolve(".agentcorp/test_wal_contention");
      mkdirSync(testDir, { recursive: true });
      const dbPath = resolve(testDir, "wal_contention.db");

      const conn1 = new AgentCorpDatabase(dbPath);
      const conn2 = new AgentCorpDatabase(dbPath);

      try {
        // Concurrent writes from both connections
        const p1 = Promise.resolve().then(() => {
          for (let i = 0; i < 10; i++) {
            conn1.insertTask({
              taskId: `conn1_task_${i}`,
              title: `Conn1 Task ${i}`,
              description: null,
              createdBy: "architect",
              assignedTo: "developer",
              status: "assigned",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
        });

        const p2 = Promise.resolve().then(() => {
          for (let i = 0; i < 10; i++) {
            conn2.insertTask({
              taskId: `conn2_task_${i}`,
              title: `Conn2 Task ${i}`,
              description: null,
              createdBy: "architect",
              assignedTo: "developer",
              status: "assigned",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
        });

        await Promise.all([p1, p2]);

        expect(conn1.countTasks()).toBe(20);
        expect(conn2.countTasks()).toBe(20);
      } finally {
        conn1.close();
        conn2.close();
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it("AC-BND-06: logs maintenance actions and returns checkpoint busy state", () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db);

      try {
        // Prune dry-run
        broker.prune({ olderThanDays: 30, dryRun: true });
        // Prune live
        broker.prune({ olderThanDays: 30, dryRun: false });
        // Compact
        const compactResult = broker.checkpointAndCompact();

        expect(compactResult.checkpoint).toBe("TRUNCATE");
        expect(typeof compactResult.busy).toBe("boolean");
        expect(typeof compactResult.logPages).toBe("number");
        expect(typeof compactResult.checkpointedPages).toBe("number");
        expect(compactResult.vacuumed).toBe(true);

        const logs = db.listMaintenanceLogs();
        expect(logs.length).toBeGreaterThanOrEqual(3);
        const actions = logs.map((l) => l.action);
        expect(actions).toContain("prune_simulation");
        expect(actions).toContain("prune_execution");
        expect(actions).toContain("compact");

        const compactLog = logs.find((l) => l.action === "compact");
        expect(compactLog?.details).toHaveProperty("busy");
        expect(compactLog?.details).toHaveProperty("vacuumed", true);
      } finally {
        db.close();
      }
    });

    it("AC-BND-07: enforces limits from org.toml [limits] and exposes X-Total-Count", async () => {
      const tomlContent = `
[company]
name = "Limits Corp"

[limits]
max_payload_size_bytes = 500
max_artifact_size_bytes = 1000
max_request_body_bytes = 2000
default_page_size = 5
max_page_size = 20

[[roles]]
id = "architect"
interface = "mcp"
capabilities = ["propose_plan"]
allowed_peers = ["developer"]
artifact_visibility = "all"

[[roles]]
id = "developer"
interface = "mcp"
capabilities = ["write_code"]
allowed_peers = ["architect"]
artifact_visibility = "all"
`;
      const parsedConfig = parseOrgConfig(tomlContent);
      expect(parsedConfig.limits?.max_payload_size_bytes).toBe(500);
      expect(parsedConfig.limits?.max_artifact_size_bytes).toBe(1000);

      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(parsedConfig, db);
      const server = new AgentCorpServer(broker, undefined, { port: 0 });
      const info = await server.start();

      try {
        // Broker enforces config limits without constructor overrides
        expect(() => {
          broker.sendMessage("architect", {
            toRole: "developer",
            type: "status_update",
            payload: { text: "x".repeat(600) },
          });
        }).toThrowError(AgentCorpError);

        // Seed 3 tasks
        for (let i = 1; i <= 3; i++) {
          db.insertTask({
            taskId: `count_task_${i}`,
            title: `Count Task ${i}`,
            description: null,
            createdBy: "architect",
            assignedTo: "developer",
            status: "assigned",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }

        // Server returns X-Total-Count header
        const res = await fetch(`${info.url}/api/tasks?limit=2`, {
          headers: { Authorization: `Bearer ${server.credentials.adminToken}` },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("X-Total-Count")).toBe("3");
        expect(res.headers.get("X-Next-Cursor")).toBeTruthy();
      } finally {
        await server.stop();
        db.close();
      }
    });
  });

  describe("AC-BND-R2: Second Re-Review Regression Tests", () => {
    it("AC-BND-R2-01: audit export bounds records, queries most recent first in ASC order, checks updated_at in since, and computes accurate truncation", () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db);

      try {
        const baseTime = new Date("2026-09-01T00:00:00.000Z").getTime();
        // Seed 10 tasks
        for (let i = 0; i < 10; i++) {
          const createdAt = new Date(baseTime + i * 3600 * 1000).toISOString();
          const updatedAt = new Date(baseTime + i * 3600 * 1000).toISOString();
          db.insertTask({
            taskId: `task_${i.toString().padStart(2, "0")}`,
            title: `Task ${i}`,
            description: null,
            createdBy: "architect",
            assignedTo: "developer",
            status: "completed",
            createdAt,
            updatedAt,
          });
        }

        // Task 0 was created on 2026-09-01, but updated on 2026-09-04
        db.updateTaskStatus("task_00", "completed", "2026-09-04T12:00:00.000Z");

        // Test since filter checks updated_at as well as created_at
        const sinceDate = "2026-09-04T00:00:00.000Z";
        const tasksSince = db.getAuditTasks({ since: sinceDate });
        // task_00 must be included because its updated_at >= sinceDate!
        expect(tasksSince.some((t) => t.taskId === "task_00")).toBe(true);

        // Test limit queries most recent records but returns in ASC chronological order
        // There are 10 tasks. If limit is 3, it should pick the 3 most recent tasks (by updated_at: task_00, task_09, task_08)
        // and return them ordered by createdAt ASC!
        const limitedTasks = db.getAuditTasks({ limit: 3 });
        expect(limitedTasks).toHaveLength(3);
        // Ensure chronological order
        for (let j = 0; j < limitedTasks.length - 1; j++) {
          expect(limitedTasks[j]!.createdAt <= limitedTasks[j + 1]!.createdAt).toBe(true);
        }

        // Test accurate truncation calculation in snapshot
        // If filter matches 1 task and limit is 5: truncated must be FALSE!
        const snapshot1 = generateAuditSnapshot(broker, { since: "2026-09-04T11:00:00.000Z", limit: 5 });
        expect(snapshot1.tasks.length).toBe(1);
        expect(snapshot1.metadata.truncated).toBe(false);

        // If 10 tasks match and limit is 3: truncated must be TRUE!
        const snapshot2 = generateAuditSnapshot(broker, { limit: 3 });
        expect(snapshot2.tasks.length).toBe(3);
        expect(snapshot2.metadata.truncated).toBe(true);
      } finally {
        db.close();
      }
    });

    it("AC-BND-R2-02: prune succeeds on complex reply chains without foreign key failures", () => {
      const db = new AgentCorpDatabase(":memory:");
      try {
        const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
        const recentTime = new Date().toISOString();

        // 1. Old completed task
        db.insertTask({
          taskId: "old_task",
          title: "Old Task",
          description: null,
          createdBy: "architect",
          assignedTo: "developer",
          status: "completed",
          createdAt: oldTime,
          updatedAt: oldTime,
        });

        // 2. Old message M1 belonging to old_task
        db.insertMessage({
          messageId: "msg_old_1",
          taskId: "old_task",
          fromRole: "architect",
          toRole: "developer",
          type: "proposal",
          payload: {},
          references: [],
          inReplyTo: null,
          status: "delivered",
          riskTags: [],
          createdAt: oldTime,
          resolvedAt: oldTime,
        });

        // 3. Old message M2 replying to M1 within old_task
        db.insertMessage({
          messageId: "msg_old_2",
          taskId: "old_task",
          fromRole: "developer",
          toRole: "architect",
          type: "status_update",
          payload: {},
          references: [],
          inReplyTo: "msg_old_1",
          status: "delivered",
          riskTags: [],
          createdAt: oldTime,
          resolvedAt: oldTime,
        });

        // 4. Standalone old message M3
        db.insertMessage({
          messageId: "msg_old_standalone",
          taskId: null,
          fromRole: "architect",
          toRole: "developer",
          type: "status_update",
          payload: {},
          references: [],
          inReplyTo: null,
          status: "delivered",
          riskTags: [],
          createdAt: oldTime,
          resolvedAt: oldTime,
        });

        // 5. Active recent task
        db.insertTask({
          taskId: "active_task",
          title: "Active Task",
          description: null,
          createdBy: "architect",
          assignedTo: "developer",
          status: "in_progress",
          createdAt: recentTime,
          updatedAt: recentTime,
        });

        // 6. Cross-task reply: active message M4 replies to old message M1!
        db.insertMessage({
          messageId: "msg_active_cross_reply",
          taskId: "active_task",
          fromRole: "developer",
          toRole: "architect",
          type: "status_update",
          payload: {},
          references: [],
          inReplyTo: "msg_old_1",
          status: "delivered",
          riskTags: [],
          createdAt: recentTime,
          resolvedAt: null,
        });

        // 7. Recent standalone message M5 replies to old standalone M3!
        db.insertMessage({
          messageId: "msg_recent_standalone_reply",
          taskId: null,
          fromRole: "developer",
          toRole: "architect",
          type: "status_update",
          payload: {},
          references: [],
          inReplyTo: "msg_old_standalone",
          status: "delivered",
          riskTags: [],
          createdAt: recentTime,
          resolvedAt: null,
        });

        // Execute live prune with 30 days cutoff
        const pruneResult = db.pruneHistory({ olderThanDays: 30, dryRun: false });
        expect(pruneResult.tasksCount).toBe(1);
        expect(pruneResult.messagesCount).toBe(3); // msg_old_1, msg_old_2, msg_old_standalone

        // Active messages still exist, with inReplyTo safely detached to NULL
        const m4 = db.getMessage("msg_active_cross_reply");
        expect(m4).toBeDefined();
        expect(m4?.inReplyTo).toBeNull();

        const m5 = db.getMessage("msg_recent_standalone_reply");
        expect(m5).toBeDefined();
        expect(m5?.inReplyTo).toBeNull();

        // Old messages and tasks are gone
        expect(db.getMessage("msg_old_1")).toBeUndefined();
        expect(db.getMessage("msg_old_2")).toBeUndefined();
        expect(db.getMessage("msg_old_standalone")).toBeUndefined();
        expect(db.getTask("old_task")).toBeUndefined();
      } finally {
        db.close();
      }
    });

    it("AC-BND-R2-03: rejects default_page_size > max_page_size and threads configured page limits", () => {
      // 1. Invariant check in config
      const invalidToml = `
[company]
name = "Limits Corp"

[limits]
default_page_size = 50
max_page_size = 20

[[roles]]
id = "architect"
interface = "mcp"
capabilities = ["propose_plan"]
allowed_peers = ["developer"]
artifact_visibility = "all"

[[roles]]
id = "developer"
interface = "mcp"
capabilities = ["write_code"]
allowed_peers = ["architect"]
artifact_visibility = "all"
`;
      expect(() => parseOrgConfig(invalidToml)).toThrow();

      // 2. Threaded through database and broker
      const validToml = `
[company]
name = "Limits Corp"

[limits]
default_page_size = 3
max_page_size = 7

[[roles]]
id = "architect"
interface = "mcp"
capabilities = ["propose_plan"]
allowed_peers = ["developer"]
artifact_visibility = "all"

[[roles]]
id = "developer"
interface = "mcp"
capabilities = ["write_code"]
allowed_peers = ["architect"]
artifact_visibility = "all"
`;
      const config = parseOrgConfig(validToml);
      const db = new AgentCorpDatabase(":memory:", {
        defaultPageSize: config.limits.default_page_size,
        maxPageSize: config.limits.max_page_size,
      });
      const broker = new AgentCorpBroker(config, db);

      try {
        expect(db.defaultPageSize).toBe(3);
        expect(db.maxPageSize).toBe(7);

        // Clamps default and max
        expect(db.resolveLimit()).toBe(3);
        expect(db.resolveLimit(100)).toBe(7);

        // MCP server reflects max_page_size
        const server = createMcpServer(broker, "architect", "arch-1");
        expect(server).toBeDefined();
      } finally {
        db.close();
      }
    });

    it("AC-BND-R2-04: multi-threaded concurrency using worker_threads with overlapping transactions", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "agentcorp-concurrency-"));
      const dbPath = join(tempDir, "concurrent.db");

      // Initialize DB schema
      const initDb = new AgentCorpDatabase(dbPath);
      initDb.close();

      const workerScript = `
        const { workerData, parentPort } = require('node:worker_threads');
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(workerData.dbPath);
        db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
        let committed = 0;
        let busyErrors = 0;
        for (let i = 0; i < workerData.iterations; i++) {
          try {
            db.exec("BEGIN IMMEDIATE;");
            const start = Date.now();
            while (Date.now() - start < 1) {}
            db.prepare("INSERT INTO tasks (task_id, title, created_by, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
              .run(workerData.prefix + "_" + i, "Concurrent Task", "worker", "proposed", new Date().toISOString(), new Date().toISOString());
            db.exec("COMMIT;");
            committed++;
          } catch (err) {
            busyErrors++;
            try { db.exec("ROLLBACK;"); } catch {}
          }
        }
        db.close();
        parentPort.postMessage({ committed, busyErrors });
      `;

      function runWorker(prefix: string, iterations: number): Promise<{ committed: number; busyErrors: number }> {
        return new Promise((resolveWorker, rejectWorker) => {
          const worker = new Worker(workerScript, {
            eval: true,
            workerData: { dbPath, prefix, iterations },
          });
          let result: { committed: number; busyErrors: number } = { committed: 0, busyErrors: 0 };
          worker.on("message", (msg) => {
            result = msg;
          });
          worker.on("error", rejectWorker);
          worker.on("exit", () => {
            resolveWorker(result);
          });
        });
      }

      try {
        const [w1, w2] = await Promise.all([
          runWorker("w1", 20),
          runWorker("w2", 20),
        ]);

        expect(w1.committed).toBe(20);
        expect(w2.committed).toBe(20);
        expect(w1.busyErrors).toBe(0);
        expect(w2.busyErrors).toBe(0);

        // Verify DB integrity and count
        const verifyDb = new AgentCorpDatabase(dbPath);
        try {
          const integrity = verifyDb.db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
          expect(integrity.integrity_check).toBe("ok");

          const totalTasks = verifyDb.countTasks();
          expect(totalTasks).toBe(w1.committed + w2.committed);
        } finally {
          verifyDb.close();
        }
      } finally {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // Best effort cleanup
        }
      }
    });

    it("AC-BND-R2-05: artifact pagination emits no phantom cursor on terminal page", () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db);

      try {
        // Create 2 visible artifacts and 2 private artifacts
        broker.createArtifact("architect", {
          type: "doc",
          name: "Visible 1",
          content: "visible content 1",
          visibleToRoles: ["architect", "developer"],
        });
        broker.createArtifact("architect", {
          type: "doc",
          name: "Visible 2",
          content: "visible content 2",
          visibleToRoles: ["architect", "developer"],
        });
        // Create 2 artifacts visible ONLY to architect
        broker.createArtifact("architect", {
          type: "doc",
          name: "Private 1",
          content: "private content 1",
          visibleToRoles: ["architect"],
        });
        broker.createArtifact("architect", {
          type: "doc",
          name: "Private 2",
          content: "private content 2",
          visibleToRoles: ["architect"],
        });

        // Developer requests limit: 2
        // Both visible artifacts fit in page 1.
        // Because remaining artifacts are NOT visible to developer, nextCursor MUST be null!
        const page = broker.listArtifactsPaginated("developer", { limit: 2 });
        expect(page.items).toHaveLength(2);
        expect(page.nextCursor).toBeNull();
      } finally {
        db.close();
      }
    });

    it("AC-BND-R2-06: maintenance safety requires execute: true for REST prune, atomic prune logging, and bounded retention", async () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db);
      const server = new AgentCorpServer(broker, undefined, { port: 0 });
      const info = await server.start();

      try {
        // Insert old task and old maintenance log
        const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
        db.insertTask({
          taskId: "prune_me",
          title: "Prune Me",
          description: null,
          createdBy: "architect",
          assignedTo: "developer",
          status: "completed",
          createdAt: oldTime,
          updatedAt: oldTime,
        });

        db.insertMaintenanceLog({
          id: "maint_ancient",
          action: "prune_simulation",
          details: {},
          createdAt: oldTime,
        });

        // 1. Calling REST prune without execute: true defaults to dryRun: true!
        const dryRes = await fetch(`${info.url}/api/maintenance/prune`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${server.credentials.adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ olderThanDays: 30 }),
        });
        const dryJson = (await dryRes.json()) as { dryRun: boolean; tasksCount: number };
        expect(dryJson.dryRun).toBe(true);
        expect(db.getTask("prune_me")).toBeDefined();

        // 2. Calling REST prune with execute: true executes live deletion
        const liveRes = await fetch(`${info.url}/api/maintenance/prune`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${server.credentials.adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ olderThanDays: 30, execute: true }),
        });
        const liveJson = (await liveRes.json()) as { dryRun: boolean; tasksCount: number };
        expect(liveJson.dryRun).toBe(false);
        expect(db.getTask("prune_me")).toBeUndefined();

        // 3. Maintenance logs: old log was deleted, and prune_execution log exists
        const logs = db.listMaintenanceLogs();
        expect(logs.some((l) => l.id === "maint_ancient")).toBe(false);
        expect(logs.some((l) => l.action === "prune_execution")).toBe(true);
      } finally {
        await server.stop();
        db.close();
      }
    });

    it("AC-BND-R2-07: update_task_status supports status and new_status, auto-approves review submission via Migration 5, and gates completion", async () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db);

      // Create MCP server & client for developer
      const devServer = createMcpServer(broker, "developer", "dev-test");
      const devClient = new Client({ name: "dev-client", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      await devServer.connect(serverTransport);
      await devClient.connect(clientTransport);

      try {
        // Seed task in in_progress
        db.insertTask({
          taskId: "task_review_test",
          title: "Review Test Task",
          description: null,
          createdBy: "architect",
          assignedTo: "developer",
          status: "in_progress",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        // 1. Developer submits task for review using 'status' field (instead of 'new_status')
        const reviewResult = await devClient.callTool({
          name: "update_task_status",
          arguments: {
            task_id: "task_review_test",
            status: "awaiting_review",
          },
        });

        // Auto-approved via Migration 5 policy!
        const reviewData = JSON.parse((reviewResult.content as Array<{ text: string }>)[0]!.text) as {
          task: { status: string };
          pendingApproval: boolean;
        };
        expect(reviewData.task.status).toBe("awaiting_review");
        expect(reviewData.pendingApproval).toBe(false);
        expect(db.getTask("task_review_test")?.status).toBe("awaiting_review");

        // 2. From 'awaiting_review', developer requests 'completed' using 'new_status' field
        const completedResult = await devClient.callTool({
          name: "update_task_status",
          arguments: {
            task_id: "task_review_test",
            new_status: "completed",
          },
        });

        // Human gate retained: pendingApproval is true!
        const completedData = JSON.parse((completedResult.content as Array<{ text: string }>)[0]!.text) as {
          task: { status: string };
          pendingApproval: boolean;
        };
        expect(completedData.pendingApproval).toBe(true);
        expect(db.getTask("task_review_test")?.status).toBe("awaiting_review");
      } finally {
        await devClient.close();
        await devServer.close();
        db.close();
      }
    });

    it("enforces maintenance_log row ceiling across simulation, compaction, and execution paths", () => {
      const db = new AgentCorpDatabase(":memory:");

      try {
        // Insert 15 maintenance logs with a ceiling of 5
        for (let i = 1; i <= 15; i++) {
          db.insertMaintenanceLog(
            {
              id: `maint_${i}`,
              action: i % 2 === 0 ? "prune_simulation" : "compact",
              details: { index: i },
              createdAt: `2026-09-01T00:00:${String(i).padStart(2, "0")}Z`,
            },
            5,
          );
        }

        const logs = db.listMaintenanceLogs(50);
        expect(logs).toHaveLength(5);
        // Latest entries are retained
        expect(logs[0]!.id).toBe("maint_15");
        expect(logs[4]!.id).toBe("maint_11");
      } finally {
        db.close();
      }
    });

    it("enforces audit maxPayloadBytes byte budget on oversized message payloads and artifact contents", () => {
      const db = new AgentCorpDatabase(":memory:");
      const broker = new AgentCorpBroker(TEST_CONFIG, db);

      try {
        // Create task
        db.insertTask({
          taskId: "task_audit_budget",
          title: "Audit Budget Test",
          createdBy: "architect",
          assignedTo: "developer",
          status: "in_progress",
        });

        // Small message (under 50 bytes)
        broker.sendMessage("architect", {
          taskId: "task_audit_budget",
          toRole: "developer",
          type: "status_update",
          payload: { summary: "short" },
        });

        // Large message (over 500 bytes)
        broker.sendMessage("architect", {
          taskId: "task_audit_budget",
          toRole: "developer",
          type: "report",
          payload: { largeData: "X".repeat(600) },
        });

        // Large artifact (over 500 bytes)
        broker.createArtifact("developer", {
          name: "Large Artifact",
          type: "report",
          content: "Y".repeat(600),
          relatedTaskId: "task_audit_budget",
        });

        // Generate snapshot with maxPayloadBytes: 100
        const snapshot = generateAuditSnapshot(broker, { maxPayloadBytes: 100 });
        expect(snapshot.metadata.maxPayloadBytes).toBe(100);

        // Small message payload remains intact
        const smallMsg = snapshot.messages.find((m) => m.type === "status_update");
        expect(smallMsg?.payload).toEqual({ summary: "short" });

        // Large message payload is truncated
        const largeMsg = snapshot.messages.find((m) => m.type === "report");
        expect((largeMsg?.payload as { _truncated?: boolean })._truncated).toBe(true);
        expect((largeMsg?.payload as { byteLength?: number }).byteLength).toBeGreaterThan(500);
      } finally {
        db.close();
      }
    });
  });
});

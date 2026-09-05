import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentCorpBroker } from "../src/broker.js";
import { AgentCorpDatabase } from "../src/database.js";
import { sanitizeBrokerEventForLog } from "../src/diagnostics.js";
import { AgentCorpError } from "../src/errors.js";
import {
  isRetryableTransportError,
  MUTATION_TOOLS,
} from "../src/stdio-adapter.js";
import { OrgConfigSchema } from "../src/types.js";

describe("Codex Reliability Blockers: AC-RLY-01 through AC-RLY-09", () => {
  const testConfig = OrgConfigSchema.parse({
    company: { name: "Reliability Test Corp" },
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

  // AC-RLY-01: Composite Uniqueness on (role_id, key)
  it("AC-RLY-01: prevents key collisions across distinct roles using composite primary key (role_id, key)", () => {
    const db = new AgentCorpDatabase(":memory:");
    try {
      const sharedKey = "shared-idempotency-key-100";

      // Role A saves an operation
      db.saveIdempotency({
        key: sharedKey,
        roleId: "developer",
        operation: "createTask",
        requestHash: "hash-dev",
        responseJson: JSON.stringify({ taskId: "task_dev_1" }),
        createdAt: new Date().toISOString(),
      });

      // Role B saves with the SAME key string but different role
      db.saveIdempotency({
        key: sharedKey,
        roleId: "architect",
        operation: "createTask",
        requestHash: "hash-arch",
        responseJson: JSON.stringify({ taskId: "task_arch_2" }),
        createdAt: new Date().toISOString(),
      });

      // Both records must exist and remain distinct
      const devRecord = db.getIdempotency(sharedKey, "developer");
      const archRecord = db.getIdempotency(sharedKey, "architect");

      expect(devRecord).toBeDefined();
      expect(archRecord).toBeDefined();
      expect(devRecord?.roleId).toBe("developer");
      expect(archRecord?.roleId).toBe("architect");
      expect(JSON.parse(devRecord!.responseJson).taskId).toBe("task_dev_1");
      expect(JSON.parse(archRecord!.responseJson).taskId).toBe("task_arch_2");
    } finally {
      db.close();
    }
  });

  // AC-RLY-02: Reject Mismatched Operation or Request Hash on Idempotent Replay
  it("AC-RLY-02: throws IDEMPOTENCY_CONFLICT when key is reused with a different operation or payload", () => {
    const db = new AgentCorpDatabase(":memory:");
    const broker = new AgentCorpBroker(testConfig, db);

    try {
      const key = "key-reused-001";

      // 1. Initial createTask call
      const task1 = broker.createTask("developer", {
        title: "Initial Title",
        idempotencyKey: key,
      });
      expect(task1.taskId).toMatch(/^task_/);

      // 2. Replay with SAME key and SAME operation/payload -> succeeds, returns cached task
      const replaySame = broker.createTask("developer", {
        title: "Initial Title",
        idempotencyKey: key,
      });
      expect(replaySame.taskId).toBe(task1.taskId);

      // 3. Replay with SAME key but DIFFERENT operation (sendMessage) -> must throw IDEMPOTENCY_CONFLICT
      expect(() => {
        broker.sendMessage("developer", {
          toRole: "architect",
          type: "status_update",
          payload: { info: "test" },
          idempotencyKey: key,
        });
      }).toThrowError(AgentCorpError);

      try {
        broker.sendMessage("developer", {
          toRole: "architect",
          type: "status_update",
          payload: { info: "test" },
          idempotencyKey: key,
        });
      } catch (err: unknown) {
        expect(err instanceof AgentCorpError).toBe(true);
        expect((err as AgentCorpError).code).toBe("IDEMPOTENCY_CONFLICT");
      }

      // 4. Replay with SAME key, SAME operation, but DIFFERENT payload -> must throw IDEMPOTENCY_CONFLICT
      try {
        broker.createTask("developer", {
          title: "Different Title",
          idempotencyKey: key,
        });
        expect.unreachable("Should have thrown IDEMPOTENCY_CONFLICT");
      } catch (err: unknown) {
        expect(err instanceof AgentCorpError).toBe(true);
        expect((err as AgentCorpError).code).toBe("IDEMPOTENCY_CONFLICT");
      }
    } finally {
      db.close();
    }
  });

  // AC-RLY-03: Atomic Mutation and Idempotency Key Persistence
  it("AC-RLY-03: rolls back business mutation if idempotency key persistence fails", () => {
    const db = new AgentCorpDatabase(":memory:");
    const broker = new AgentCorpBroker(testConfig, db);

    try {
      // Mock db.saveIdempotency to throw an error (simulating disk error or constraint crash)
      const originalSave = db.saveIdempotency.bind(db);
      db.saveIdempotency = () => {
        throw new Error("Simulated disk error during saveIdempotency");
      };

      expect(() => {
        broker.createTask("developer", {
          title: "Doomed Task",
          idempotencyKey: "doomed-key-01",
        });
      }).toThrowError(/Simulated disk error/);

      // Restore saveIdempotency
      db.saveIdempotency = originalSave;

      // Because it ran in an atomic transaction, the task must NOT have been persisted
      expect(db.countTasks()).toBe(0);
      expect(db.getIdempotency("doomed-key-01", "developer")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  // AC-RLY-04: Transport Retry Scope & Mutation Tools
  it("AC-RLY-04: classifies retryable transport failures vs non-retryable domain errors", () => {
    // Retryable transport errors
    expect(isRetryableTransportError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableTransportError(new Error("connect ECONNREFUSED 127.0.0.1:54321"))).toBe(true);
    expect(isRetryableTransportError(new Error("read ECONNRESET"))).toBe(true);
    expect(isRetryableTransportError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isRetryableTransportError({ status: 502 })).toBe(true);
    expect(isRetryableTransportError({ status: 503 })).toBe(true);
    expect(isRetryableTransportError({ status: 504 })).toBe(true);

    // Non-retryable domain / client errors
    expect(isRetryableTransportError(new AgentCorpError("IDEMPOTENCY_CONFLICT", "conflict"))).toBe(false);
    expect(isRetryableTransportError(new AgentCorpError("PERMISSION_DENIED", "denied"))).toBe(false);
    expect(isRetryableTransportError(new Error("Invalid status transition"))).toBe(false);
    expect(isRetryableTransportError({ status: 400 })).toBe(false);
    expect(isRetryableTransportError({ status: 401 })).toBe(false);
    expect(isRetryableTransportError({ status: 403 })).toBe(false);
    expect(isRetryableTransportError({ status: 404 })).toBe(false);

    // Mutation tools set contains all mutation operations
    expect(MUTATION_TOOLS.has("create_task")).toBe(true);
    expect(MUTATION_TOOLS.has("send_message")).toBe(true);
    expect(MUTATION_TOOLS.has("accept_handoff")).toBe(true);
    expect(MUTATION_TOOLS.has("create_artifact")).toBe(true);
    expect(MUTATION_TOOLS.has("update_task_status")).toBe(true);
    expect(MUTATION_TOOLS.has("whoami")).toBe(false);
    expect(MUTATION_TOOLS.has("get_work_queue")).toBe(false);
  });

  // AC-RLY-07: Daemon Logger Redaction
  it("AC-RLY-07: sanitizes broker events for daemon logs, omitting sensitive message payloads and artifact bodies", () => {
    // 1. Message event with sensitive payload
    const sensitivePayload = {
      apiKey: "sk-proj-secret-123456789",
      secretReport: "CONFIDENTIAL USER REVENUE DATA",
      nested: { token: "super_secret_token" },
    };

    const sanitizedMessageEvent = sanitizeBrokerEventForLog({
      type: "message_sent",
      timestamp: "2026-09-05T12:00:00Z",
      data: {
        messageId: "msg_secret_1",
        taskId: "task_1",
        fromRole: "developer",
        toRole: "architect",
        payload: sensitivePayload,
      },
    });

    const serializedLog = JSON.stringify(sanitizedMessageEvent);

    // Metadata is retained
    expect(sanitizedMessageEvent.type).toBe("message_sent");
    expect(sanitizedMessageEvent.messageId).toBe("msg_secret_1");
    expect(sanitizedMessageEvent.fromRole).toBe("developer");
    expect(sanitizedMessageEvent.toRole).toBe("architect");
    expect(sanitizedMessageEvent.payloadSizeBytes).toBeGreaterThan(50);

    // Sensitive content must NEVER appear in the serialized log
    expect(serializedLog).not.toContain("sk-proj-secret-123456789");
    expect(serializedLog).not.toContain("CONFIDENTIAL USER REVENUE DATA");
    expect(serializedLog).not.toContain("super_secret_token");

    // 2. Artifact event with large / sensitive content
    const sensitiveDiff = "diff --git a/keys.env +SECRET_KEY=password123";
    const sanitizedArtifactEvent = sanitizeBrokerEventForLog({
      type: "artifact_created",
      timestamp: "2026-09-05T12:00:00Z",
      data: {
        artifactId: "art_sensitive_1",
        taskId: "task_1",
        name: "keys.env",
        content: sensitiveDiff,
      },
    });

    const serializedArtifactLog = JSON.stringify(sanitizedArtifactEvent);
    expect(sanitizedArtifactEvent.artifactId).toBe("art_sensitive_1");
    expect(sanitizedArtifactEvent.contentSizeBytes).toBe(Buffer.byteLength(sensitiveDiff));
    expect(serializedArtifactLog).not.toContain("password123");
  });

  // AC-RLY-08: SQL-Level Bounded Payload Extraction in Audit Export
  it("AC-RLY-08: bounds payload extraction at the SQLite query level using SUBSTR and LENGTH", () => {
    const db = new AgentCorpDatabase(":memory:");
    try {
      // Create an oversized payload (200 KB)
      const bigPayloadString = "A".repeat(200 * 1024);
      const bigContentString = "B".repeat(200 * 1024);

      db.insertMessage({
        messageId: "msg_oversized_1",
        taskId: null,
        fromRole: "developer",
        toRole: "architect",
        type: "report",
        payload: { bigData: bigPayloadString },
        references: [],
        inReplyTo: null,
        status: "delivered",
        riskTags: ["read_only"],
        createdAt: "2026-09-05T10:00:00Z",
        resolvedAt: null,
      });

      db.insertArtifact({
        artifactId: "art_oversized_1",
        type: "report",
        name: "big_report.txt",
        content: bigContentString,
        contentHash: "hash-big",
        visibleToRoles: "all",
        producedBy: "developer",
        relatedTaskId: null,
        createdAt: "2026-09-05T10:00:00Z",
      });

      // Query audit messages with maxPayloadBytes = 512
      const auditMessages = db.getAuditMessages({ maxPayloadBytes: 512 });
      expect(auditMessages.length).toBe(1);

      const msg = auditMessages[0]!;
      const payloadObj = msg.payload as { _truncated?: boolean; byteLength?: number; preview?: string };
      expect(payloadObj._truncated).toBe(true);
      expect(payloadObj.byteLength).toBeGreaterThan(200000);
      expect(payloadObj.preview?.length).toBeLessThanOrEqual(300);

      // Query audit artifacts with maxPayloadBytes = 512
      const auditArtifacts = db.getAuditArtifacts({ maxPayloadBytes: 512 });
      expect(auditArtifacts.length).toBe(1);
      const art = auditArtifacts[0]!;
      expect(art.content?.length).toBeLessThanOrEqual(300);
      expect(art.content).toContain("[truncated]");
    } finally {
      db.close();
    }
  });

  // AC-RLY-09: Activity Freshness Semantics & Connection Indicators
  it("AC-RLY-09: accurately reports activityFreshness and status based on last activity timestamps", () => {
    const db = new AgentCorpDatabase(":memory:");
    try {
      const nowMs = Date.now();

      // 1. Fresh role (active 10 seconds ago)
      db.touchRolePresence("role_fresh", new Date(nowMs - 10000).toISOString());

      // 2. Idle role (active 2 minutes ago)
      db.touchRolePresence("role_idle", new Date(nowMs - 120000).toISOString());

      // 3. Stale role (active 10 minutes ago)
      db.touchRolePresence("role_stale", new Date(nowMs - 600000).toISOString());

      const presenceList = db.listRolePresence();

      const fresh = presenceList.find((p) => p.roleId === "role_fresh");
      const idle = presenceList.find((p) => p.roleId === "role_idle");
      const stale = presenceList.find((p) => p.roleId === "role_stale");

      expect(fresh?.status).toBe("online");
      expect(fresh?.activityFreshness).toBe("fresh");
      expect(fresh?.lastActiveAt).toBeDefined();

      expect(idle?.status).toBe("idle");
      expect(idle?.activityFreshness).toBe("idle");

      expect(stale?.status).toBe("offline");
      expect(stale?.activityFreshness).toBe("stale");
    } finally {
      db.close();
    }
  });
});

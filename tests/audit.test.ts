import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportAuditTrail, generateAuditSnapshot } from "../src/audit.js";
import { AgentCorpBroker } from "../src/broker.js";
import { AgentCorpDatabase } from "../src/database.js";
import { OrgConfigSchema } from "../src/types.js";

describe("audit", () => {
  let tempDir: string;
  let db: AgentCorpDatabase;
  let broker: AgentCorpBroker;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentcorp-audit-test-"));
    db = new AgentCorpDatabase(":memory:");
    const config = OrgConfigSchema.parse({
      company: { name: "Audit Test Corp" },
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
    broker = new AgentCorpBroker(config, db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exports audit snapshot to markdown and json", () => {
    // Populate some data
    broker.registerRole("architect", "agent-arch-1", ["propose_plan"]);
    const task = broker.createTask("architect", {
      title: "Design System",
      description: "Initial design of the system",
      assignedTo: "developer",
    });

    const msg = broker.sendMessage("architect", {
      toRole: "developer",
      type: "proposal",
      payload: { spec: "Spec v1" },
      taskId: task.taskId,
    });

    broker.createArtifact("architect", {
      name: "spec.md",
      type: "spec_doc",
      content: "# Architecture",
      relatedTaskId: task.taskId,
    });

    const { markdownPath, jsonPath, snapshot } = exportAuditTrail(broker, tempDir);

    expect(existsSync(markdownPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(true);

    const mdContent = readFileSync(markdownPath, "utf8");
    expect(mdContent).toContain("AgentCorp Audit Log — Audit Test Corp");
    expect(mdContent).toContain("Design System");
    expect(mdContent).toContain("agent-arch-1");
    expect(mdContent).toContain("spec.md");

    const jsonContent = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(jsonContent.company).toBe("Audit Test Corp");
    expect(jsonContent.tasks.length).toBe(1);
    expect(jsonContent.messages.length).toBe(1);
    expect(jsonContent.approvals.length).toBe(1);
    expect(jsonContent.artifacts.length).toBe(1);
    expect(jsonContent.metadata.rowLimitTruncated).toBe(false);
    expect(jsonContent.metadata.fieldClippingActive).toBe(false);
  });

  it("distinguishes row-limit truncation from field-level clipping in metadata and markdown", () => {
    // 1. Create a task with oversized description and message with oversized payload
    const longDesc = "D".repeat(2000);
    const longPayload = { data: "M".repeat(3000) };

    const task = broker.createTask("architect", {
      title: "Clipped Task",
      description: longDesc,
    });

    broker.sendMessage("architect", {
      toRole: "developer",
      type: "proposal",
      payload: longPayload,
      taskId: task.taskId,
    });

    // Test A: Field clipping active, but row limit not truncated
    const clippedSnapshot = generateAuditSnapshot(broker, {
      limit: 100,
      maxPayloadBytes: 256,
    });

    expect(clippedSnapshot.metadata.rowLimitTruncated).toBe(false);
    expect(clippedSnapshot.metadata.truncated).toBe(false);
    expect(clippedSnapshot.metadata.fieldClippingActive).toBe(true);
    expect(clippedSnapshot.metadata.fieldClippedRecordsCount?.tasks).toBe(1);
    expect(clippedSnapshot.metadata.fieldClippedRecordsCount?.messages).toBe(1);
    expect(clippedSnapshot.tasks[0]?.description).toContain("... [truncated]");

    const { markdownPath } = exportAuditTrail(broker, tempDir, {
      limit: 100,
      maxPayloadBytes: 256,
    });
    const md = readFileSync(markdownPath, "utf8");
    expect(md).toContain("**Row Limit Truncated:** `No`");
    expect(md).toContain("**Field Clipping Active:** `Yes`");

    // Test B: Row limit truncated, no field clipping
    // Create 3 extra tasks to exceed limit: 2
    broker.createTask("architect", { title: "Extra Task 1" });
    broker.createTask("architect", { title: "Extra Task 2" });
    broker.createTask("architect", { title: "Extra Task 3" });

    const rowTruncatedSnapshot = generateAuditSnapshot(broker, {
      limit: 2,
      maxPayloadBytes: 50000,
    });

    expect(rowTruncatedSnapshot.metadata.rowLimitTruncated).toBe(true);
    expect(rowTruncatedSnapshot.metadata.truncated).toBe(true);
    expect(rowTruncatedSnapshot.metadata.fieldClippingActive).toBe(false);
  });

  it("preserves UTF-8 boundaries and does not infer clipping from marker-like content", () => {
    const budget = 64;
    const emoji = "\u{1F680}";
    const clippedTask = broker.createTask("architect", {
      title: "Unicode task",
      description: emoji.repeat(100),
    });
    const literalMarkerTask = broker.createTask("architect", {
      title: "Literal marker task",
      description: "This text legitimately ends with... [truncated]",
    });
    broker.sendMessage("architect", {
      toRole: "developer",
      type: "report",
      payload: { text: emoji.repeat(100) },
      taskId: clippedTask.taskId,
    });
    const artifact = broker.createArtifact("architect", {
      name: "unicode.txt",
      type: "evidence",
      content: emoji.repeat(100),
      relatedTaskId: clippedTask.taskId,
    });

    const snapshot = generateAuditSnapshot(broker, {
      limit: 100,
      maxPayloadBytes: budget,
    });
    const auditedTask = snapshot.tasks.find((task) => task.taskId === clippedTask.taskId)!;
    const literalTask = snapshot.tasks.find((task) => task.taskId === literalMarkerTask.taskId)!;
    const auditedMessage = snapshot.messages.find((message) => message.taskId === clippedTask.taskId)!;
    const auditedArtifact = snapshot.artifacts.find((item) => item.artifactId === artifact.artifactId)!;
    const messagePreview = (auditedMessage.payload as { preview: string }).preview;

    expect(auditedTask.descriptionClipped).toBe(true);
    expect(auditedTask.descriptionByteLength).toBe(Buffer.byteLength(emoji.repeat(100), "utf8"));
    expect(Buffer.byteLength(auditedTask.description!, "utf8")).toBeLessThanOrEqual(budget);
    expect(auditedTask.description).not.toContain("\uFFFD");
    expect(literalTask.descriptionClipped).toBeUndefined();
    expect(messagePreview).not.toContain("\uFFFD");
    expect(Buffer.byteLength(messagePreview, "utf8")).toBeLessThanOrEqual(budget);
    expect(auditedArtifact.contentClipped).toBe(true);
    expect(auditedArtifact.contentByteLength).toBe(Buffer.byteLength(emoji.repeat(100), "utf8"));
    expect(auditedArtifact.content).not.toContain("\uFFFD");
    expect(Buffer.byteLength(auditedArtifact.content!, "utf8")).toBeLessThanOrEqual(budget);
    expect(snapshot.metadata.fieldClippedRecordsCount?.tasks).toBe(1);
    expect(snapshot.metadata.fieldClippedRecordsCount?.messages).toBe(1);
    expect(snapshot.metadata.fieldClippedRecordsCount?.artifacts).toBe(1);
  });
});

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
  });
});

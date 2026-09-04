import { afterEach, describe, expect, it } from "vitest";
import { AgentCorpBroker } from "../src/broker.js";
import { AgentCorpDatabase } from "../src/database.js";
import { AgentCorpError } from "../src/errors.js";
import { OrgConfigSchema, type OrgConfig } from "../src/types.js";

function config(policies: unknown[] = []): OrgConfig {
  return OrgConfigSchema.parse({
    company: { name: "Test Corp" },
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
      {
        id: "observer",
        interface: "mcp",
        capabilities: [],
        allowed_peers: [],
        artifact_visibility: ["observer"],
      },
    ],
    policies,
  });
}

describe("AgentCorpBroker", () => {
  const databases: AgentCorpDatabase[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  function broker(policies: unknown[] = []): AgentCorpBroker {
    const database = new AgentCorpDatabase(":memory:");
    databases.push(database);
    let sequence = 0;
    return new AgentCorpBroker(config(policies), database, {
      now: () => new Date("2026-08-20T00:00:00.000Z"),
      id: (prefix) => `${prefix}_${++sequence}`,
    });
  }

  it("fails closed and hides a message until a human approves it", () => {
    const instance = broker();
    const message = instance.sendMessage("architect", {
      toRole: "developer",
      type: "proposal",
      payload: { plan: "Build the broker" },
    });

    expect(message.status).toBe("pending_approval");
    expect(instance.getInbox("developer")).toEqual([]);

    const [approval] = instance.listPendingApprovals();
    expect(approval?.subjectId).toBe(message.messageId);
    instance.approve(approval!.approvalId, "Looks good");

    expect(instance.getInbox("developer")).toMatchObject([
      { messageId: message.messageId, status: "delivered" },
    ]);
  });

  it("auto-approves only when a matching rule exists", () => {
    const instance = broker([{
      id: "read-only",
      subject: "message",
      priority: 100,
      risk_tags: ["read_only"],
      action: "auto_approve",
    }]);

    const delivered = instance.sendMessage("architect", {
      toRole: "developer",
      type: "question",
      payload: { question: "What tests failed?" },
      riskTags: ["read_only"],
    });
    const gated = instance.sendMessage("architect", {
      toRole: "developer",
      type: "proposal",
      payload: { command: "merge" },
      riskTags: ["writes_main"],
    });

    expect(delivered.status).toBe("delivered");
    expect(gated.status).toBe("pending_approval");
  });

  it("rejects communication outside the configured role graph", () => {
    const instance = broker();

    expect(() => instance.sendMessage("architect", {
      toRole: "observer",
      type: "question",
      payload: {},
    })).toThrowError(AgentCorpError);
  });

  it("enforces artifact visibility at read time", () => {
    const instance = broker();
    const artifact = instance.createArtifact("developer", {
      type: "test_report",
      name: "unit-tests.json",
      content: "{\"passed\": 12}",
    });

    expect(instance.getArtifact("architect", artifact.artifactId).content).toContain("12");
    expect(() => instance.getArtifact("observer", artifact.artifactId))
      .toThrowError(/cannot access artifact/i);
  });

  it("holds a gated task transition until approval", () => {
    const instance = broker([{
      id: "start-work",
      subject: "task",
      priority: 10,
      to_status: "in_progress",
      action: "auto_approve",
    }]);
    const task = instance.createTask("architect", {
      title: "Implement broker",
      assignedTo: "developer",
    });

    const started = instance.updateTaskStatus("developer", task.taskId, "in_progress");
    expect(started.pendingApproval).toBe(false);

    const review = instance.updateTaskStatus("developer", task.taskId, "awaiting_review");
    expect(review.pendingApproval).toBe(true);
    expect(review.task.status).toBe("in_progress");

    const [approval] = instance.listPendingApprovals();
    instance.approve(approval!.approvalId);
    expect(instance.listTasks("developer")[0]?.status).toBe("awaiting_review");
  });

  it("does not allow a connection to escalate configured capabilities", () => {
    const instance = broker();
    expect(() => instance.registerRole("developer", "dev-1", ["approve_merge"]))
      .toThrowError(/undeclared capabilities/i);
  });

  it("updates approval policies at runtime", () => {
    const instance = broker();
    const policy = instance.savePolicy({
      id: "reports",
      subject: "message",
      priority: 20,
      message_type: "report",
      action: "auto_approve",
    });
    expect(policy.enabled).toBe(true);

    const delivered = instance.sendMessage("developer", {
      toRole: "architect",
      type: "report",
      payload: { result: "done" },
    });
    expect(delivered.status).toBe("delivered");

    instance.setPolicyEnabled("reports", false);
    const gated = instance.sendMessage("developer", {
      toRole: "architect",
      type: "report",
      payload: { result: "another" },
    });
    expect(gated.status).toBe("pending_approval");
  });
});

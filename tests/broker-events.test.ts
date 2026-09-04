import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentCorpBroker, type BrokerDomainEvent } from "../src/broker.js";
import { AgentCorpDatabase } from "../src/database.js";
import { OrgConfigSchema } from "../src/types.js";

describe("Broker Events", () => {
  let db: AgentCorpDatabase;
  let broker: AgentCorpBroker;

  beforeEach(() => {
    db = new AgentCorpDatabase(":memory:");
    const config = OrgConfigSchema.parse({
      company: { name: "Events Test Corp" },
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
  });

  it("emits events on task creation, message submission, and approval resolution", () => {
    const events: BrokerDomainEvent[] = [];
    broker.on("event", (evt) => events.push(evt));

    // 1. Task created
    const task = broker.createTask("architect", { title: "Implement Auth" });
    expect(events.map((e) => e.type)).toContain("task_created");

    // 2. Message sent (pending approval)
    const msg = broker.sendMessage("architect", {
      toRole: "developer",
      type: "proposal",
      payload: { spec: "JWT" },
      taskId: task.taskId,
    });
    expect(events.map((e) => e.type)).toContain("message_created");
    expect(events.map((e) => e.type)).toContain("approval_created");

    // 3. Approval resolved
    const [approval] = broker.listPendingApprovals();
    expect(approval).toBeDefined();
    broker.approve(approval!.approvalId, "Looks great");
    expect(events.map((e) => e.type)).toContain("approval_resolved");
    expect(events.map((e) => e.type)).toContain("message_status_changed");
  });
});

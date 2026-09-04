import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentCorpBroker } from "../src/broker.js";
import { AgentCorpDatabase } from "../src/database.js";
import { AgentCorpTui } from "../src/tui.js";
import { OrgConfigSchema } from "../src/types.js";

describe("AgentCorpTui", () => {
  let db: AgentCorpDatabase;
  let broker: AgentCorpBroker;
  let tui: AgentCorpTui;

  beforeEach(() => {
    db = new AgentCorpDatabase(":memory:");
    const config = OrgConfigSchema.parse({
      company: { name: "TUI Test Corp" },
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
    tui = new AgentCorpTui({ broker });
  });

  afterEach(() => {
    db.close();
  });

  it("prints header without throwing", () => {
    expect(() => tui.printHeader()).not.toThrow();
  });

  it("renders status dashboard with clean state", async () => {
    await expect(tui.runDashboard()).resolves.not.toThrow();
  });

  it("displays pending approvals accurately in dashboard", async () => {
    broker.sendMessage("architect", {
      toRole: "developer",
      type: "proposal",
      payload: { feature: "TUI Review" },
    });

    const pending = broker.listPendingApprovals();
    expect(pending.length).toBe(1);

    await expect(tui.runDashboard()).resolves.not.toThrow();
  });

  it("fails explicitly when daemon returns HTTP error or is unreachable (AC-001)", async () => {
    // Port 59999 has no running daemon
    const badTui = new AgentCorpTui({
      daemonUrl: "http://127.0.0.1:59999",
      adminToken: "invalid-token",
    });

    await expect(badTui.fetchApprovals()).rejects.toThrow();
  });

  it("stores full message payload and metadata in approval context (AC-002)", () => {
    const task = broker.createTask("architect", { title: "Approval Test", assignedTo: "developer" });

    broker.sendMessage("architect", {
      toRole: "developer",
      type: "proposal",
      payload: { feature: "Secure Approval", riskLevel: "high" },
      taskId: task.taskId,
    });

    const pending = broker.listPendingApprovals();
    expect(pending.length).toBe(1);
    const item = pending[0]!;
    expect(item.subject).toBe("message");
    expect(item.requestedBy).toBe("architect");

    const ctx = item.context as Record<string, unknown>;
    expect(ctx.toRole).toBe("developer");
    expect(ctx.type).toBe("proposal");
    expect(ctx.payload).toEqual({ feature: "Secure Approval", riskLevel: "high" });
    expect(ctx.taskId).toBe(task.taskId);
  });
});

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCorpBroker } from "../src/broker.js";
import { AgentCorpDatabase } from "../src/database.js";
import { createMcpServer } from "../src/mcp.js";
import { OrgConfigSchema } from "../src/types.js";

describe("AgentCorp MCP server", () => {
  const databases: AgentCorpDatabase[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it("discovers tools and exchanges an approved message across two role connections", async () => {
    const database = new AgentCorpDatabase(":memory:");
    databases.push(database);
    const config = OrgConfigSchema.parse({
      company: { name: "Protocol Test" },
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
      policies: [{
        id: "start-work",
        subject: "task",
        to_status: "in_progress",
        priority: 50,
        action: "auto_approve",
      }],
    });
    const broker = new AgentCorpBroker(config, database);
    const architectServer = createMcpServer(broker, "architect", "architect-test");
    const developerServer = createMcpServer(broker, "developer", "developer-test");
    const architectClient = new Client({ name: "architect-client", version: "0.0.0" });
    const developerClient = new Client({ name: "developer-client", version: "0.0.0" });
    const [architectClientTransport, architectServerTransport] = InMemoryTransport.createLinkedPair();
    const [developerClientTransport, developerServerTransport] = InMemoryTransport.createLinkedPair();

    await architectServer.connect(architectServerTransport);
    await developerServer.connect(developerServerTransport);
    await architectClient.connect(architectClientTransport);
    await developerClient.connect(developerClientTransport);

    try {
      const tools = await architectClient.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);
      expect(toolNames).toHaveLength(14);
      expect(toolNames).toEqual(expect.arrayContaining([
        "register_role",
        "whoami",
        "create_task",
        "list_tasks",
        "get_work_queue",
        "update_task_status",
        "send_message",
        "get_inbox",
        "acknowledge_message",
        "accept_handoff",
        "get_thread",
        "create_artifact",
        "list_artifacts",
        "get_artifact",
      ]));

      const created = await architectClient.callTool({
        name: "create_task",
        arguments: {
          title: "Protocol handoff test",
          description: "Verify the complete approved-handoff loop",
          assigned_to: "developer",
        },
      });
      const task = JSON.parse(
        created.content[0]!.type === "text" ? created.content[0].text : "null",
      ) as { taskId: string; status: string };
      expect(task.status).toBe("proposed");

      const hiddenTasks = await developerClient.callTool({ name: "list_tasks", arguments: {} });
      expect(JSON.parse(hiddenTasks.content[0]!.type === "text" ? hiddenTasks.content[0].text : "null"))
        .toEqual([]);

      const sent = await architectClient.callTool({
        name: "send_message",
        arguments: {
          to_role: "developer",
          type: "proposal",
          payload: { plan: "Protocol test" },
          task_id: task.taskId,
        },
      });
      expect(sent.isError).not.toBe(true);

      const hidden = await developerClient.callTool({ name: "get_inbox", arguments: {} });
      expect(JSON.parse(hidden.content[0]!.type === "text" ? hidden.content[0].text : "null"))
        .toEqual([]);

      const [approval] = broker.listPendingApprovals();
      broker.approve(approval!.approvalId);

      const delivered = await developerClient.callTool({ name: "get_inbox", arguments: {} });
      const inbox = JSON.parse(
        delivered.content[0]!.type === "text" ? delivered.content[0].text : "null",
      ) as Array<{ messageId: string; fromRole: string; status: string }>;
      expect(inbox).toMatchObject([{ fromRole: "architect", status: "delivered" }]);

      const work = await developerClient.callTool({ name: "get_work_queue", arguments: {} });
      const queue = JSON.parse(
        work.content[0]!.type === "text" ? work.content[0].text : "null",
      ) as { nextActions: Array<{ kind: string; messageId: string; taskId: string }> };
      expect(queue.nextActions[0]).toMatchObject({
        kind: "accept_handoff",
        messageId: inbox[0]!.messageId,
        taskId: task.taskId,
      });

      const accepted = await developerClient.callTool({
        name: "accept_handoff",
        arguments: { message_id: inbox[0]!.messageId },
      });
      const acceptance = JSON.parse(
        accepted.content[0]!.type === "text" ? accepted.content[0].text : "null",
      ) as { message: { status: string }; task: { status: string }; pendingApproval: boolean };
      expect(acceptance).toMatchObject({
        message: { status: "acknowledged" },
        task: { status: "in_progress" },
        pendingApproval: false,
      });
    } finally {
      await architectClient.close();
      await developerClient.close();
      await architectServer.close();
      await developerServer.close();
    }
  });
});

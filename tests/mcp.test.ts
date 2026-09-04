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
      policies: [],
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
      expect(toolNames).toHaveLength(12);
      expect(toolNames).toEqual(expect.arrayContaining([
        "register_role",
        "whoami",
        "create_task",
        "list_tasks",
        "update_task_status",
        "send_message",
        "get_inbox",
        "acknowledge_message",
        "get_thread",
        "create_artifact",
        "list_artifacts",
        "get_artifact",
      ]));

      const sent = await architectClient.callTool({
        name: "send_message",
        arguments: {
          to_role: "developer",
          type: "proposal",
          payload: { plan: "Protocol test" },
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
      ) as Array<{ fromRole: string; status: string }>;
      expect(inbox).toMatchObject([{ fromRole: "architect", status: "delivered" }]);
    } finally {
      await architectClient.close();
      await developerClient.close();
      await architectServer.close();
      await developerServer.close();
    }
  });
});

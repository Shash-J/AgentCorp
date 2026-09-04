import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentCorpBroker } from "../src/broker.js";
import { ensureCredentials, type CredentialsFile } from "../src/credentials.js";
import { AgentCorpDatabase } from "../src/database.js";
import { AgentCorpServer } from "../src/server.js";
import { OrgConfigSchema } from "../src/types.js";

describe("AgentCorpServer", () => {
  let tempDir: string;
  let db: AgentCorpDatabase;
  let broker: AgentCorpBroker;
  let creds: CredentialsFile;
  let server: AgentCorpServer;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "agentcorp-server-test-"));
    db = new AgentCorpDatabase(":memory:");
    const config = OrgConfigSchema.parse({
      company: { name: "Server Test Corp" },
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
    creds = ensureCredentials(config, join(tempDir, "credentials.json"));
    server = new AgentCorpServer(broker, creds, {
      port: 0,
      host: "127.0.0.1",
      daemonFilePath: join(tempDir, "daemon.json"),
      auditOnShutdown: false,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("serves health endpoint without authentication", async () => {
    const res = await fetch(`${server.getUrl()}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; company: string; roles: string[] };
    expect(body.status).toBe("ok");
    expect(body.company).toBe("Server Test Corp");
    expect(body.roles).toEqual(["architect", "developer"]);
  });

  it("rejects unauthenticated MCP connection", async () => {
    const res = await fetch(`${server.getUrl()}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects unauthorized admin API requests", async () => {
    const res = await fetch(`${server.getUrl()}/api/approvals`);
    expect(res.status).toBe(401);
  });

  it("rejects query string tokens on Admin API endpoints with 401 (AC-003)", async () => {
    const res = await fetch(`${server.getUrl()}/api/approvals?token=${creds.adminToken}`);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("UNAUTHORIZED");
  });

  it("rejects query string tokens on MCP endpoint with 401 (AC-003)", async () => {
    const res = await fetch(`${server.getUrl()}/mcp?token=${creds.roleTokens.architect}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("UNAUTHORIZED");
  });

  it("accepts valid Authorization Bearer headers on Admin API (AC-003)", async () => {
    const res = await fetch(`${server.getUrl()}/api/approvals`, {
      headers: { Authorization: `Bearer ${creds.adminToken}` },
    });
    expect(res.status).toBe(200);
  });

  it("exchanges approved message between two agents over Streamable HTTP and Admin API", async () => {
    const archTransport = new StreamableHTTPClientTransport(
      new URL(`${server.getUrl()}/mcp`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${creds.roleTokens.architect}` },
        },
      },
    );
    const devTransport = new StreamableHTTPClientTransport(
      new URL(`${server.getUrl()}/mcp`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${creds.roleTokens.developer}` },
        },
      },
    );

    const archClient = new Client({ name: "arch-client", version: "1.0.0" });
    const devClient = new Client({ name: "dev-client", version: "1.0.0" });

    await archClient.connect(archTransport);
    await devClient.connect(devTransport);

    try {
      // 1. Architect sends proposal
      const sendRes = await archClient.callTool({
        name: "send_message",
        arguments: {
          to_role: "developer",
          type: "proposal",
          payload: { spec: "Daemon protocol v1" },
        },
      });
      expect(sendRes.isError).not.toBe(true);

      // 2. Developer inbox is empty (held for approval)
      const hidden = await devClient.callTool({ name: "get_inbox", arguments: {} });
      const hiddenInbox = JSON.parse(
        hidden.content[0]!.type === "text" ? hidden.content[0].text : "null",
      );
      expect(hiddenInbox).toEqual([]);

      // 3. Admin lists pending approvals via REST API
      const approvalsRes = await fetch(`${server.getUrl()}/api/approvals`, {
        headers: { Authorization: `Bearer ${creds.adminToken}` },
      });
      expect(approvalsRes.status).toBe(200);
      const pendingApprovals = await approvalsRes.json() as Array<{ approvalId: string }>;
      expect(pendingApprovals.length).toBe(1);

      // 4. Admin approves via REST API
      const approvalId = pendingApprovals[0]!.approvalId;
      const approveRes = await fetch(`${server.getUrl()}/api/approvals/${approvalId}/approve`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ note: "Approved by test" }),
      });
      expect(approveRes.status).toBe(200);

      // 5. Developer inbox now contains the delivered message!
      const delivered = await devClient.callTool({ name: "get_inbox", arguments: {} });
      const deliveredInbox = JSON.parse(
        delivered.content[0]!.type === "text" ? delivered.content[0].text : "null",
      ) as Array<{ fromRole: string; status: string }>;
      expect(deliveredInbox).toMatchObject([{ fromRole: "architect", status: "delivered" }]);
    } finally {
      await archClient.close();
      await devClient.close();
    }
  });
});

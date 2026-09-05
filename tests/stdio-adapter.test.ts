import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentCorpBroker } from "../src/broker.js";
import { ensureCredentials, type CredentialsFile } from "../src/credentials.js";
import { AgentCorpDatabase } from "../src/database.js";
import { AgentCorpError } from "../src/errors.js";
import { AgentCorpServer } from "../src/server.js";
import { createStdioProxy } from "../src/stdio-adapter.js";
import { OrgConfigSchema } from "../src/types.js";

describe("stdio-adapter", () => {
  let tempDir: string;
  let db: AgentCorpDatabase;
  let broker: AgentCorpBroker;
  let creds: CredentialsFile;
  let server: AgentCorpServer;
  let configPath: string;
  let credPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "agentcorp-stdio-test-"));
    db = new AgentCorpDatabase(":memory:");
    const config = OrgConfigSchema.parse({
      company: { name: "Adapter Test Corp" },
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
    configPath = join(tempDir, "org.toml");
    writeFileSync(
      configPath,
      `[company]\nname = "Adapter Test Corp"\n\n[[roles]]\nid = "architect"\nallowed_peers = ["developer"]\nartifact_visibility = ["architect", "developer"]\ncapabilities = ["propose_plan"]\n\n[[roles]]\nid = "developer"\nallowed_peers = ["architect"]\nartifact_visibility = ["architect", "developer"]\ncapabilities = ["write_code"]\n`,
      "utf8",
    );

    credPath = join(tempDir, "credentials.json");
    broker = new AgentCorpBroker(config, db);
    creds = ensureCredentials(config, credPath);

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

  it("proxies tools and tool calls to the central daemon", async () => {
    const { server: proxyServer, daemonClient } = await createStdioProxy({
      role: "architect",
      daemonUrl: server.getUrl(),
      configPath,
      credentialsPath: credPath,
    });

    const client = new Client({ name: "ide-agent", version: "1.0.0" });
    const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();

    await proxyServer.connect(sTransport);
    await client.connect(cTransport);

    try {
      const tools = await client.listTools();
      const toolNames = tools.tools.map((t) => t.name);
      expect(toolNames).toContain("whoami");
      expect(toolNames).toContain("send_message");
      expect(toolNames).toContain("get_inbox");

      const whoamiRes = await client.callTool({ name: "whoami", arguments: {} });
      expect(whoamiRes.isError).not.toBe(true);
      const text = whoamiRes.content[0]?.type === "text" ? whoamiRes.content[0].text : "";
      expect(text).toContain("Adapter Test Corp");
      expect(text).toContain("architect");
    } finally {
      await client.close();
      await proxyServer.close();
      await daemonClient.close();
    }
  });

  it("throws DAEMON_NOT_RUNNING when noSpawn is true and daemon is unreachable", async () => {
    await expect(
      createStdioProxy({
        role: "architect",
        configPath,
        credentialsPath: credPath,
        daemonFilePath: join(tempDir, "missing-daemon.json"),
        noSpawn: true,
      }),
    ).rejects.toThrowError(AgentCorpError);
  });
});

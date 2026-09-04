import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentCorpBroker } from "../src/broker.js";
import { ensureCredentials, type CredentialsFile } from "../src/credentials.js";
import { AgentCorpDatabase } from "../src/database.js";
import { AgentCorpServer } from "../src/server.js";
import { OrgConfigSchema } from "../src/types.js";

describe("Console Server & SSE", () => {
  let tempDir: string;
  let db: AgentCorpDatabase;
  let broker: AgentCorpBroker;
  let creds: CredentialsFile;
  let server: AgentCorpServer;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "agentcorp-console-test-"));
    db = new AgentCorpDatabase(":memory:");
    const config = OrgConfigSchema.parse({
      company: { name: "Console Test Corp" },
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

  it("serves the single-page console application", async () => {
    const htmlRes = await fetch(`${server.getUrl()}/`);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("content-type")).toContain("text/html");
    const html = await htmlRes.text();
    expect(html).toContain("AgentCorp");
    expect(html).toContain("Pending Approvals");

    const cssRes = await fetch(`${server.getUrl()}/console.css`);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-type")).toContain("text/css");

    const jsRes = await fetch(`${server.getUrl()}/console.js`);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("content-type")).toContain("application/javascript");
  });

  it("streams real-time events over SSE", async () => {
    const sseUrl = `${server.getUrl()}/api/events?token=${creds.adminToken}`;
    const controller = new AbortController();

    const response = await fetch(sseUrl, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    // 1. Initial connection event
    const firstChunk = await reader.read();
    const firstText = decoder.decode(firstChunk.value);
    expect(firstText).toContain("connected");

    // 2. Trigger broker event in the background
    setTimeout(() => {
      broker.createTask("architect", { title: "SSE Verified Task" });
    }, 50);

    // 3. Receive the broadcasted domain event
    const secondChunk = await reader.read();
    const secondText = decoder.decode(secondChunk.value);
    expect(secondText).toContain("task_created");
    expect(secondText).toContain("SSE Verified Task");

    controller.abort();
  });

  it("exposes artifacts REST endpoints for console inspection", async () => {
    broker.createArtifact("architect", {
      name: "spec.json",
      type: "json",
      content: '{"ok":true}',
    });

    const listRes = await fetch(`${server.getUrl()}/api/artifacts`, {
      headers: { Authorization: `Bearer ${creds.adminToken}` },
    });
    expect(listRes.status).toBe(200);
    const artifacts = await listRes.json() as Array<{ artifactId: string; name: string }>;
    expect(artifacts.length).toBe(1);
    expect(artifacts[0]!.name).toBe("spec.json");

    const detailRes = await fetch(`${server.getUrl()}/api/artifacts/${artifacts[0]!.artifactId}`, {
      headers: { Authorization: `Bearer ${creds.adminToken}` },
    });
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json() as { content: string };
    expect(detail.content).toBe('{"ok":true}');
  });
});

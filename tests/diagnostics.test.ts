import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordCrashDiagnostics, RotatingLogger, runDoctor } from "../src/diagnostics.js";
import { AgentCorpDatabase } from "../src/database.js";
import { ensureCredentials } from "../src/credentials.js";
import { OrgConfigSchema } from "../src/types.js";

describe("Diagnostics, Log Rotation, and Doctor", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentcorp-diag-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("RotatingLogger", () => {
    it("writes messages with ISO timestamps", () => {
      const logFile = join(tempDir, "test.log");
      const logger = new RotatingLogger(logFile, { maxSizeBytes: 1024, maxBackups: 2 });
      logger.write("First log line");
      logger.write("Second log line");

      expect(existsSync(logFile)).toBe(true);
      const content = readFileSync(logFile, "utf8");
      expect(content).toContain("First log line");
      expect(content).toContain("Second log line");
      expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("rotates log files when exceeding maxSizeBytes and bounds backups to maxBackups", () => {
      const logFile = join(tempDir, "rotate.log");
      // Small byte threshold: 100 bytes
      const logger = new RotatingLogger(logFile, { maxSizeBytes: 100, maxBackups: 2 });

      // Write enough lines to cause multiple rotations
      for (let i = 0; i < 20; i++) {
        logger.write(`Log line payload chunk number ${i} with extra padding bytes to exceed limit`);
      }

      expect(existsSync(logFile)).toBe(true);
      expect(existsSync(`${logFile}.1`)).toBe(true);
      expect(existsSync(`${logFile}.2`)).toBe(true);
      // Backups must not exceed maxBackups (2)
      expect(existsSync(`${logFile}.3`)).toBe(false);

      // Active file size must remain bounded
      const stats = statSync(logFile);
      expect(stats.size).toBeLessThan(1000);
    });
  });

  describe("recordCrashDiagnostics", () => {
    it("writes formatted crash diagnostics with system metrics", () => {
      const crashLog = join(tempDir, "crash.log");
      const error = new Error("Simulated fatal explosion");

      recordCrashDiagnostics(crashLog, error, {
        component: "broker-test",
        pid: 9999,
      });

      expect(existsSync(crashLog)).toBe(true);
      const content = readFileSync(crashLog, "utf8");
      expect(content).toContain("CRASH DIAGNOSTIC REPORT");
      expect(content).toContain("Simulated fatal explosion");
      expect(content).toContain("broker-test");
      expect(content).toContain("Stack Trace:");
      expect(content).toContain("Memory: RSS=");
    });
  });

  describe("runDoctor", () => {
    it("reports healthy diagnostics on valid config and database", async () => {
      const configPath = join(tempDir, "org.toml");
      const dbPath = join(tempDir, "doctor.db");
      const credsPath = join(tempDir, "credentials.json");

      writeFileSync(
        configPath,
        `[company]\nname = "Doctor Test Corp"\n\n[[roles]]\nid = "architect"\nallowed_peers = ["developer"]\ncapabilities = ["propose_plan"]\nartifact_visibility = ["architect", "developer"]\n\n[[roles]]\nid = "developer"\nallowed_peers = ["architect"]\ncapabilities = ["write_code"]\nartifact_visibility = ["architect", "developer"]\n`,
        "utf8",
      );

      const config = OrgConfigSchema.parse({
        company: { name: "Doctor Test Corp" },
        roles: [
          { id: "architect", interface: "mcp", capabilities: ["propose_plan"], allowed_peers: ["developer"], artifact_visibility: ["architect", "developer"] },
          { id: "developer", interface: "mcp", capabilities: ["write_code"], allowed_peers: ["architect"], artifact_visibility: ["architect", "developer"] },
        ],
        policies: [],
      });
      ensureCredentials(config, credsPath);

      const db = new AgentCorpDatabase(dbPath);
      db.close();

      const report = await runDoctor({
        configPath,
        dbPath,
        credentialsPath: credsPath,
        daemonFilePath: join(tempDir, "missing-daemon.json"),
      });

      expect(report.status).toBe("ok");
      expect(report.checks.length).toBeGreaterThanOrEqual(5);
      const configCheck = report.checks.find((c) => c.name === "configuration");
      expect(configCheck?.status).toBe("ok");
      expect(configCheck?.message).toContain("Doctor Test Corp");

      const dbCheck = report.checks.find((c) => c.name === "database");
      expect(dbCheck?.status).toBe("ok");
      expect(dbCheck?.message).toContain("Database healthy");

      const credsCheck = report.checks.find((c) => c.name === "credentials");
      expect(credsCheck?.status).toBe("ok");
    });

    it("reports error when config file is missing", async () => {
      const report = await runDoctor({
        configPath: join(tempDir, "nonexistent.toml"),
        dbPath: join(tempDir, "test.db"),
      });

      expect(report.status).toBe("error");
      const configCheck = report.checks.find((c) => c.name === "configuration");
      expect(configCheck?.status).toBe("error");
      expect(configCheck?.message).toContain("does not exist");
    });
  });
});

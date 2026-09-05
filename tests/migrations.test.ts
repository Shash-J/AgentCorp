import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AgentCorpDatabase } from "../src/database.js";
import { AgentCorpError } from "../src/errors.js";
import {
  getCurrentSchemaVersion,
  MIGRATIONS,
  runMigrations,
} from "../src/migrations.js";

describe("migrations", () => {
  it("applies migrations in order to a fresh database", () => {
    const rawDb = new DatabaseSync(":memory:");
    try {
      expect(getCurrentSchemaVersion(rawDb)).toBe(0);
      const result = runMigrations(rawDb);
      expect(result.applied).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(result.currentVersion).toBe(7);
      expect(getCurrentSchemaVersion(rawDb)).toBe(7);

      // Re-running migrations is idempotent
      const rerun = runMigrations(rawDb);
      expect(rerun.applied).toEqual([]);
      expect(rerun.currentVersion).toBe(7);
    } finally {
      rawDb.close();
    }
  });

  it("fails if database has an unsupported future schema version", () => {
    const rawDb = new DatabaseSync(":memory:");
    try {
      runMigrations(rawDb);
      // Manually simulate a future version
      rawDb.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(999, "future_migration", new Date().toISOString());

      expect(() => runMigrations(rawDb)).toThrowError(AgentCorpError);
    } finally {
      rawDb.close();
    }
  });

  it("initializes schema properly via AgentCorpDatabase", () => {
    const db = new AgentCorpDatabase(":memory:");
    try {
      expect(db.getSchemaVersion()).toBe(7);
      expect(db.listAllTasks()).toEqual([]);
      expect(db.listAllMessages()).toEqual([]);
      expect(db.listAllApprovals()).toEqual([]);
      expect(db.listAllRoleBindings()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("successfully upgrades legacy v0.1 schema_migrations missing name column (AC-004)", () => {
    const rawDb = new DatabaseSync(":memory:");
    try {
      // Simulate legacy v0.1 table created without 'name' column
      rawDb.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        ) STRICT;
      `);

      // Run migrations; ensureMigrationTable must detect missing name column and alter it safely
      const result = runMigrations(rawDb);
      expect(result.applied).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(result.currentVersion).toBe(7);

      const cols = rawDb.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "name")).toBe(true);
    } finally {
      rawDb.close();
    }
  });

  it("migration 2 tightens default policies and replaces legacy untyped rule (AC-005)", () => {
    const rawDb = new DatabaseSync(":memory:");
    try {
      // Run migration 1
      MIGRATIONS[0]!.up(rawDb);
      // Seed legacy untyped rule
      rawDb.prepare(`
        INSERT INTO policies (policy_id, subject, priority, action, enabled, created_at, updated_at)
        VALUES ('allow-read-only-messages', 'message', 100, 'auto_approve', 1, '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z')
      `).run();

      // Run migration 2
      MIGRATIONS[1]!.up(rawDb);

      const policies = rawDb.prepare("SELECT policy_id, message_type, priority, action FROM policies").all() as Array<{
        policy_id: string;
        message_type: string | null;
        priority: number;
        action: string;
      }>;

      // Legacy untyped rule is deleted
      expect(policies.some((p) => p.policy_id === "allow-read-only-messages")).toBe(false);
      // Gating rule exists
      const proposalRule = policies.find((p) => p.policy_id === "gate-critical-proposals");
      expect(proposalRule).toBeDefined();
      expect(proposalRule?.action).toBe("require_human");
      expect(proposalRule?.priority).toBe(200);
      expect(proposalRule?.message_type).toBe("proposal");
    } finally {
      rawDb.close();
    }
  });

  it("migration 3 creates pagination and performance indexes", () => {
    const rawDb = new DatabaseSync(":memory:");
    try {
      MIGRATIONS[0]!.up(rawDb);
      MIGRATIONS[1]!.up(rawDb);
      MIGRATIONS[2]!.up(rawDb);

      const indexes = rawDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain("idx_tasks_updated_at");
      expect(indexNames).toContain("idx_tasks_created_at");
      expect(indexNames).toContain("idx_messages_created_at");
      expect(indexNames).toContain("idx_artifacts_created_at");
    } finally {
      rawDb.close();
    }
  });

  it("migration 4 creates maintenance_log table and index (AC-BND-06)", () => {
    const rawDb = new DatabaseSync(":memory:");
    try {
      MIGRATIONS[0]!.up(rawDb);
      MIGRATIONS[1]!.up(rawDb);
      MIGRATIONS[2]!.up(rawDb);
      MIGRATIONS[3]!.up(rawDb);

      const tables = rawDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toContain("maintenance_log");

      const indexes = rawDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
      expect(indexes.map((i) => i.name)).toContain("idx_maintenance_log_created_at");
    } finally {
      rawDb.close();
    }
  });

  it("migration 5 creates auto-approve policy for review submission (AC-BND-R2-07)", () => {
    const rawDb = new DatabaseSync(":memory:");
    try {
      MIGRATIONS[0]!.up(rawDb);
      MIGRATIONS[1]!.up(rawDb);
      MIGRATIONS[2]!.up(rawDb);
      MIGRATIONS[3]!.up(rawDb);
      MIGRATIONS[4]!.up(rawDb);

      const policy = rawDb.prepare(
        "SELECT * FROM policies WHERE policy_id = 'auto-approve-review-submission'",
      ).get() as Record<string, unknown> | undefined;

      expect(policy).toBeDefined();
      expect(policy?.subject).toBe("task");
      expect(policy?.from_status).toBe("in_progress");
      expect(policy?.to_status).toBe("awaiting_review");
      expect(policy?.action).toBe("auto_approve");
      expect(policy?.priority).toBe(150);
    } finally {
      rawDb.close();
    }
  });

  it("migration 6 creates idempotency_keys table and adds last_seen_at column to role_bindings", () => {
    const rawDb = new DatabaseSync(":memory:");
    try {
      MIGRATIONS[0]!.up(rawDb);
      MIGRATIONS[1]!.up(rawDb);
      MIGRATIONS[2]!.up(rawDb);
      MIGRATIONS[3]!.up(rawDb);
      MIGRATIONS[4]!.up(rawDb);
      MIGRATIONS[5]!.up(rawDb);

      const tables = rawDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toContain("idempotency_keys");

      const indexes = rawDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
      expect(indexes.map((i) => i.name)).toContain("idx_idempotency_role");

      const cols = rawDb.prepare("PRAGMA table_info(role_bindings)").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("last_seen_at");
    } finally {
      rawDb.close();
    }
  });
});


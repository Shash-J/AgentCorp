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
      expect(result.applied).toEqual([1]);
      expect(result.currentVersion).toBe(1);
      expect(getCurrentSchemaVersion(rawDb)).toBe(1);

      // Re-running migrations is idempotent
      const rerun = runMigrations(rawDb);
      expect(rerun.applied).toEqual([]);
      expect(rerun.currentVersion).toBe(1);
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
      expect(db.getSchemaVersion()).toBe(1);
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
      expect(result.applied).toEqual([1]);
      expect(result.currentVersion).toBe(1);

      const cols = rawDb.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "name")).toBe(true);
    } finally {
      rawDb.close();
    }
  });
});

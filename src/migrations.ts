import { DatabaseSync } from "node:sqlite";
import { AgentCorpError } from "./errors.js";

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS role_bindings (
          role_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          capabilities TEXT NOT NULL,
          connected_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS tasks (
          task_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          created_by TEXT NOT NULL,
          assigned_to TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS messages (
          message_id TEXT PRIMARY KEY,
          task_id TEXT REFERENCES tasks(task_id),
          from_role TEXT NOT NULL,
          to_role TEXT NOT NULL,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          references_json TEXT NOT NULL,
          in_reply_to TEXT REFERENCES messages(message_id),
          status TEXT NOT NULL,
          risk_tags TEXT NOT NULL,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        ) STRICT;

        CREATE TABLE IF NOT EXISTS message_events (
          event_id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(message_id),
          status TEXT NOT NULL,
          actor TEXT NOT NULL,
          note TEXT,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS artifacts (
          artifact_id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          name TEXT NOT NULL,
          produced_by TEXT NOT NULL,
          content TEXT,
          content_uri TEXT,
          content_hash TEXT NOT NULL,
          visible_to_roles TEXT NOT NULL,
          related_task_id TEXT REFERENCES tasks(task_id),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS policies (
          policy_id TEXT PRIMARY KEY,
          subject TEXT NOT NULL,
          priority INTEGER NOT NULL,
          from_role TEXT,
          to_role TEXT,
          message_type TEXT,
          risk_tags TEXT,
          from_status TEXT,
          to_status TEXT,
          action TEXT NOT NULL,
          delegate_role TEXT,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS approvals (
          approval_id TEXT PRIMARY KEY,
          subject TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          requested_by TEXT NOT NULL,
          status TEXT NOT NULL,
          context TEXT NOT NULL,
          created_at TEXT NOT NULL,
          decided_at TEXT,
          decision_note TEXT,
          edited_payload TEXT
        ) STRICT;

        CREATE TABLE IF NOT EXISTS task_transitions (
          transition_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          from_status TEXT NOT NULL,
          to_status TEXT NOT NULL,
          requested_by TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(to_role, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(related_task_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);
      `);
    },
  },
  {
    version: 2,
    name: "tighten_default_policies",
    up: (db: DatabaseSync) => {
      const legacy = db.prepare("SELECT * FROM policies WHERE policy_id = 'allow-read-only-messages' AND message_type IS NULL").get();
      if (legacy) {
        db.prepare("DELETE FROM policies WHERE policy_id = 'allow-read-only-messages' AND message_type IS NULL").run();
        const now = new Date().toISOString();
        const insert = db.prepare(`
          INSERT OR IGNORE INTO policies (policy_id, subject, priority, message_type, risk_tags, action, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insert.run("gate-critical-proposals", "message", 200, "proposal", null, "require_human", 1, now, now);
        insert.run("allow-read-only-status-updates", "message", 100, "status_update", JSON.stringify(["read_only"]), "auto_approve", 1, now, now);
        insert.run("allow-read-only-reports", "message", 100, "report", JSON.stringify(["read_only"]), "auto_approve", 1, now, now);
      }
    },
  },
  {
    version: 3,
    name: "add_pagination_indexes",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at, task_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at, task_id);
        CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at, message_id);
        CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at, artifact_id);
      `);
    },
  },
  {
    version: 4,
    name: "add_maintenance_log",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS maintenance_log (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          details_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_maintenance_log_created_at ON maintenance_log(created_at, id);
      `);
    },
  },
  {
    version: 5,
    name: "add_submission_auto_approve_policy",
    up: (db: DatabaseSync) => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT OR IGNORE INTO policies (
          policy_id, subject, priority, from_status, to_status, action, enabled, created_at, updated_at
        ) VALUES (
          'auto-approve-review-submission', 'task', 150, 'in_progress', 'awaiting_review', 'auto_approve', 1, ?, ?
        )
      `).run(now, now);
    },
  },
];

export function ensureMigrationTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'legacy',
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  // Handle legacy v0.1 databases where schema_migrations was created without the 'name' column
  const cols = db.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>;
  const hasName = cols.some((col) => col.name === "name");
  if (!hasName) {
    db.exec("ALTER TABLE schema_migrations ADD COLUMN name TEXT NOT NULL DEFAULT 'legacy'");
  }
}

export function getCurrentSchemaVersion(db: DatabaseSync): number {
  ensureMigrationTable(db);
  const row = db.prepare("SELECT MAX(version) AS max_version FROM schema_migrations").get() as
    | { max_version: number | null }
    | undefined;
  return row?.max_version ?? 0;
}

export function runMigrations(db: DatabaseSync): { applied: number[]; currentVersion: number } {
  ensureMigrationTable(db);
  const current = getCurrentSchemaVersion(db);
  const maxAvailable = MIGRATIONS.length > 0 ? Math.max(...MIGRATIONS.map((m) => m.version)) : 0;
  if (current > maxAvailable) {
    throw new AgentCorpError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `Database schema version ${current} is higher than maximum supported version ${maxAvailable}`,
    );
  }

  const applied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (migration.version > current) {
      db.exec("BEGIN IMMEDIATE");
      try {
        migration.up(db);
        db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, new Date().toISOString());
        db.exec("COMMIT");
        applied.push(migration.version);
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  return { applied, currentVersion: getCurrentSchemaVersion(db) };
}

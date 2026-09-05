import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getCurrentSchemaVersion, runMigrations } from "./migrations.js";
import type {
  ArtifactRecord,
  AuditArtifactRecord,
  AuditExportOptions,
  AuditTaskRecord,
  IdempotencyRecord,
  InitialPolicy,
  MaintenanceLogRecord,
  MessageRecord,
  PaginatedResult,
  PaginationOptions,
  PendingApproval,
  PolicyRule,
  PruneOptions,
  PruneResult,
  RolePresence,
  TaskRecord,
} from "./types.js";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_AUDIT_LIMIT = 500;
export const MAX_AUDIT_LIMIT = 5000;
export const MAX_MAINTENANCE_LOG_ENTRIES = 1000;

export interface DatabaseOptions {
  defaultPageSize?: number | undefined;
  maxPageSize?: number | undefined;
}

export function encodeCursor(timestamp: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: timestamp, id })).toString("base64url");
}

export function decodeCursor(cursor?: string): { timestamp?: string | undefined; id?: string | undefined } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, cursor.includes("-") || cursor.includes("_") ? "base64url" : "base64").toString("utf8");
    const parsed = JSON.parse(raw) as { t?: string; id?: string };
    if (parsed && (parsed.t || parsed.id)) {
      return { timestamp: parsed.t, id: parsed.id };
    }
  } catch {}
  if (cursor.includes("T") && cursor.includes("Z")) {
    return { timestamp: cursor };
  }
  return { id: cursor };
}

export function parseLimit(limit?: number, defaultLimit = DEFAULT_PAGE_LIMIT, maxLimit = MAX_PAGE_LIMIT): number {
  if (limit === undefined || limit === null || Number.isNaN(limit)) return defaultLimit;
  return Math.min(Math.max(1, Math.floor(limit)), maxLimit);
}

type Row = Record<string, unknown>;

const AUDIT_TRUNCATION_MARKER = "... [truncated]";
const MAX_AUDIT_PREVIEW_BYTES = 256;

function auditPreviewPrefixBytes(totalBudget: number): number {
  return Math.max(0, totalBudget - Buffer.byteLength(AUDIT_TRUNCATION_MARKER, "utf8"));
}

function decodeUtf8Prefix(value: unknown, maxBytes: number): string {
  if (maxBytes <= 0 || value === null || value === undefined) return "";
  const bytes = value instanceof Uint8Array
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : Buffer.from(String(value), "utf8");
  let end = Math.min(maxBytes, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      end--;
    }
  }
  return "";
}

function formatAuditPreview(value: unknown, totalBudget: number): string {
  if (totalBudget <= 0) return "";
  const markerBytes = Buffer.from(AUDIT_TRUNCATION_MARKER, "utf8");
  if (totalBudget <= markerBytes.byteLength) {
    return markerBytes.subarray(0, totalBudget).toString("utf8");
  }
  return decodeUtf8Prefix(value, auditPreviewPrefixBytes(totalBudget)) + AUDIT_TRUNCATION_MARKER;
}

function json<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function mapMessage(row: Row): MessageRecord {
  return {
    messageId: String(row.message_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    fromRole: String(row.from_role),
    toRole: String(row.to_role),
    type: String(row.type) as MessageRecord["type"],
    payload: json(row.payload),
    references: json<string[]>(row.references ?? row.references_json ?? "[]"),
    inReplyTo: row.in_reply_to === null ? null : String(row.in_reply_to),
    status: String(row.status) as MessageRecord["status"],
    riskTags: json<string[]>(row.risk_tags ?? "[]"),
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
  };
}

function mapTask(row: Row): TaskRecord {
  return {
    taskId: String(row.task_id),
    title: String(row.title),
    description: row.description === null ? null : String(row.description),
    createdBy: String(row.created_by),
    assignedTo: row.assigned_to === null ? null : String(row.assigned_to),
    status: String(row.status) as TaskRecord["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapArtifact(row: Row, includeContent: boolean): ArtifactRecord {
  const record: ArtifactRecord = {
    artifactId: String(row.artifact_id),
    type: String(row.type),
    name: String(row.name),
    producedBy: String(row.produced_by),
    contentHash: String(row.content_hash),
    visibleToRoles: row.visible_to_roles === "all" ? "all" : json<string[]>(row.visible_to_roles),
    relatedTaskId: row.related_task_id === null ? null : String(row.related_task_id),
    createdAt: String(row.created_at),
  };
  if (includeContent && row.content !== null) record.content = String(row.content);
  if (includeContent && row.content_uri !== null) record.contentUri = String(row.content_uri);
  return record;
}

function mapPolicy(row: Row): PolicyRule {
  const optional = <T>(key: string): T | undefined =>
    row[key] === null || row[key] === undefined ? undefined : (String(row[key]) as T);
  return {
    id: String(row.policy_id),
    subject: String(row.subject) as PolicyRule["subject"],
    priority: Number(row.priority),
    action: String(row.action) as PolicyRule["action"],
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(optional<string>("from_role") ? { from_role: optional<string>("from_role") } : {}),
    ...(optional<string>("to_role") ? { to_role: optional<string>("to_role") } : {}),
    ...(optional<PolicyRule["message_type"]>("message_type")
      ? { message_type: optional<PolicyRule["message_type"]>("message_type") }
      : {}),
    ...(row.risk_tags === null ? {} : { risk_tags: json<string[]>(row.risk_tags) }),
    ...(optional<PolicyRule["from_status"]>("from_status")
      ? { from_status: optional<PolicyRule["from_status"]>("from_status") }
      : {}),
    ...(optional<PolicyRule["to_status"]>("to_status")
      ? { to_status: optional<PolicyRule["to_status"]>("to_status") }
      : {}),
    ...(optional<string>("delegate_role")
      ? { delegate_role: optional<string>("delegate_role") }
      : {}),
  } as PolicyRule;
}

function mapApproval(row: Row): PendingApproval {
  return {
    approvalId: String(row.approval_id),
    subject: String(row.subject) as PendingApproval["subject"],
    subjectId: String(row.subject_id),
    requestedBy: String(row.requested_by),
    status: String(row.status) as PendingApproval["status"],
    context: json(row.context),
    createdAt: String(row.created_at),
    decidedAt: row.decided_at === null ? null : String(row.decided_at),
    decisionNote: row.decision_note === null ? null : String(row.decision_note),
  };
}

export class AgentCorpDatabase {
  readonly db: DatabaseSync;
  readonly defaultPageSize: number;
  readonly maxPageSize: number;

  constructor(path = ".agentcorp/agentcorp.db", options: DatabaseOptions = {}) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_LIMIT;
    this.maxPageSize = options.maxPageSize ?? MAX_PAGE_LIMIT;
    this.db = new DatabaseSync(path);
    try {
      // Install the busy handler before journal-mode negotiation or migrations;
      // either operation can require a lock when another process opens the same DB.
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  resolveLimit(limit?: number): number {
    return parseLimit(limit, this.defaultPageSize, this.maxPageSize);
  }

  close(): void {
    this.db.close();
  }

  private transactionDepth = 0;

  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) {
      this.transactionDepth++;
      try {
        return operation();
      } finally {
        this.transactionDepth--;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Suppress rollback error if already rolled back
      }
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  getSchemaVersion(): number {
    return getCurrentSchemaVersion(this.db);
  }

  private migrate(): void {
    runMigrations(this.db);
  }

  countPolicies(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM policies").get() as Row).count);
  }

  insertPolicy(rule: PolicyRule): void {
    this.db.prepare(`
      INSERT INTO policies (
        policy_id, subject, priority, from_role, to_role, message_type, risk_tags,
        from_status, to_status, action, delegate_role, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rule.id, rule.subject, rule.priority, rule.from_role ?? null, rule.to_role ?? null,
      rule.message_type ?? null, rule.risk_tags ? JSON.stringify(rule.risk_tags) : null,
      rule.from_status ?? null, rule.to_status ?? null, rule.action, rule.delegate_role ?? null,
      rule.enabled ? 1 : 0, rule.createdAt, rule.updatedAt,
    );
  }

  upsertPolicy(rule: PolicyRule): void {
    this.db.prepare(`
      INSERT INTO policies (
        policy_id, subject, priority, from_role, to_role, message_type, risk_tags,
        from_status, to_status, action, delegate_role, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(policy_id) DO UPDATE SET
        subject = excluded.subject,
        priority = excluded.priority,
        from_role = excluded.from_role,
        to_role = excluded.to_role,
        message_type = excluded.message_type,
        risk_tags = excluded.risk_tags,
        from_status = excluded.from_status,
        to_status = excluded.to_status,
        action = excluded.action,
        delegate_role = excluded.delegate_role,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(
      rule.id, rule.subject, rule.priority, rule.from_role ?? null, rule.to_role ?? null,
      rule.message_type ?? null, rule.risk_tags ? JSON.stringify(rule.risk_tags) : null,
      rule.from_status ?? null, rule.to_status ?? null, rule.action, rule.delegate_role ?? null,
      rule.enabled ? 1 : 0, rule.createdAt, rule.updatedAt,
    );
  }

  getPolicy(policyId: string): PolicyRule | undefined {
    const row = this.db.prepare("SELECT * FROM policies WHERE policy_id = ?").get(policyId) as Row | undefined;
    return row ? mapPolicy(row) : undefined;
  }

  setPolicyEnabled(policyId: string, enabled: boolean, updatedAt: string): void {
    this.db.prepare("UPDATE policies SET enabled = ?, updated_at = ? WHERE policy_id = ?")
      .run(enabled ? 1 : 0, updatedAt, policyId);
  }

  listPolicies(): PolicyRule[] {
    return (this.db.prepare("SELECT * FROM policies ORDER BY priority DESC, created_at ASC").all() as Row[])
      .map(mapPolicy);
  }

  bindRole(roleId: string, agentId: string, capabilities: string[], connectedAt: string): void {
    const cols = (this.db.prepare("PRAGMA table_info(role_bindings)").all() as Array<{ name: string }>).map((c) => c.name);
    const hasLastSeen = cols.includes("last_seen_at");
    if (hasLastSeen) {
      this.db.prepare(`
        INSERT INTO role_bindings (role_id, agent_id, capabilities, connected_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(role_id) DO UPDATE SET
          agent_id = excluded.agent_id,
          capabilities = excluded.capabilities,
          connected_at = excluded.connected_at,
          last_seen_at = excluded.last_seen_at
      `).run(roleId, agentId, JSON.stringify(capabilities), connectedAt, connectedAt);
    } else {
      this.db.prepare(`
        INSERT INTO role_bindings (role_id, agent_id, capabilities, connected_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(role_id) DO UPDATE SET
          agent_id = excluded.agent_id,
          capabilities = excluded.capabilities,
          connected_at = excluded.connected_at
      `).run(roleId, agentId, JSON.stringify(capabilities), connectedAt);
    }
  }

  touchRolePresence(roleId: string, timestamp: string = new Date().toISOString()): void {
    const cols = (this.db.prepare("PRAGMA table_info(role_bindings)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("last_seen_at")) return;
    const existing = this.db.prepare("SELECT role_id FROM role_bindings WHERE role_id = ?").get(roleId);
    if (existing) {
      this.db.prepare(`
        UPDATE role_bindings
        SET last_seen_at = ?
        WHERE role_id = ?
      `).run(timestamp, roleId);
    } else {
      this.db.prepare(`
        INSERT INTO role_bindings (role_id, agent_id, capabilities, connected_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(roleId, `${roleId}-session`, "[]", timestamp, timestamp);
    }
  }

  listRolePresence(): RolePresence[] {
    const cols = (this.db.prepare("PRAGMA table_info(role_bindings)").all() as Array<{ name: string }>).map((c) => c.name);
    const hasLastSeen = cols.includes("last_seen_at");
    const query = hasLastSeen
      ? "SELECT role_id, agent_id, connected_at, last_seen_at FROM role_bindings ORDER BY role_id ASC"
      : "SELECT role_id, agent_id, connected_at FROM role_bindings ORDER BY role_id ASC";

    const rows = this.db.prepare(query).all() as Array<{
      role_id: string;
      agent_id: string;
      connected_at: string;
      last_seen_at?: string | null;
    }>;
    const nowMs = Date.now();
    return rows.map((r) => {
      const lastSeenStr = r.last_seen_at ?? r.connected_at;
      const lastSeenMs = lastSeenStr ? new Date(lastSeenStr).getTime() : nowMs;
      const diffMs = nowMs - lastSeenMs;
      let status: "online" | "idle" | "offline" = "online";
      let activityFreshness: "fresh" | "idle" | "stale" = "fresh";
      if (diffMs > 300000) { // > 5 minutes
        status = "offline";
        activityFreshness = "stale";
      } else if (diffMs > 60000) { // > 1 minute
        status = "idle";
        activityFreshness = "idle";
      }
      return {
        roleId: r.role_id,
        agentId: r.agent_id,
        connectedAt: r.connected_at,
        lastSeenAt: lastSeenStr,
        lastActiveAt: lastSeenStr,
        status,
        activityFreshness,
      };
    });
  }

  saveIdempotency(record: IdempotencyRecord): void {
    this.db.prepare(`
      INSERT INTO idempotency_keys (role_id, key, operation, request_hash, response_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      record.roleId,
      record.key,
      record.operation,
      record.requestHash ?? null,
      record.responseJson,
      record.createdAt,
    );
  }

  getIdempotency(key: string, roleId: string): IdempotencyRecord | undefined {
    const row = this.db.prepare(`
      SELECT role_id, key, operation, request_hash, response_json, created_at
      FROM idempotency_keys
      WHERE role_id = ? AND key = ?
    `).get(roleId, key) as
      | {
          role_id: string;
          key: string;
          operation: string;
          request_hash?: string | null;
          response_json: string;
          created_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      key: row.key,
      roleId: row.role_id,
      operation: row.operation,
      requestHash: row.request_hash ?? undefined,
      responseJson: row.response_json,
      createdAt: row.created_at,
    };
  }

  insertTask(task: TaskRecord): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO tasks (task_id, title, description, created_by, assigned_to, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.taskId,
      task.title,
      task.description ?? null,
      task.createdBy,
      task.assignedTo ?? null,
      task.status,
      task.createdAt ?? now,
      task.updatedAt ?? now,
    );
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Row | undefined;
    return row ? mapTask(row) : undefined;
  }

  listTasksForRolePaginated(roleId: string, options?: PaginationOptions): PaginatedResult<TaskRecord> {
    const limit = this.resolveLimit(options?.limit);
    let cursorTime: string | null = null;
    let cursorId: string | null = null;
    const decoded = decodeCursor(options?.cursor);
    if (decoded) {
      if (decoded.timestamp) {
        cursorTime = decoded.timestamp;
        cursorId = decoded.id ?? "";
      } else if (decoded.id) {
        const row = this.db.prepare("SELECT updated_at FROM tasks WHERE task_id = ?").get(decoded.id) as Row | undefined;
        if (row) {
          cursorTime = String(row.updated_at);
          cursorId = decoded.id;
        }
      }
    }

    const rows = (cursorTime !== null && cursorId !== null)
      ? (this.db.prepare(`
          SELECT DISTINCT t.* FROM tasks t
          LEFT JOIN messages m ON m.task_id = t.task_id
          WHERE (t.created_by = ?
            OR (t.assigned_to = ? AND t.status <> 'proposed')
            OR m.from_role = ?
            OR (m.to_role = ? AND m.status IN ('approved', 'delivered', 'acknowledged')))
            AND (t.updated_at < ? OR (t.updated_at = ? AND t.task_id < ?))
          ORDER BY t.updated_at DESC, t.task_id DESC
          LIMIT ?
        `).all(roleId, roleId, roleId, roleId, cursorTime, cursorTime, cursorId, limit + 1) as Row[])
      : (this.db.prepare(`
          SELECT DISTINCT t.* FROM tasks t
          LEFT JOIN messages m ON m.task_id = t.task_id
          WHERE t.created_by = ?
            OR (t.assigned_to = ? AND t.status <> 'proposed')
            OR m.from_role = ?
            OR (m.to_role = ? AND m.status IN ('approved', 'delivered', 'acknowledged'))
          ORDER BY t.updated_at DESC, t.task_id DESC
          LIMIT ?
        `).all(roleId, roleId, roleId, roleId, limit + 1) as Row[]);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(mapTask);
    const last = items[items.length - 1];
    const nextCursor = (hasMore && last) ? encodeCursor(last.updatedAt, last.taskId) : null;

    return { items, nextCursor };
  }

  listTasksForRole(roleId: string, options?: PaginationOptions): TaskRecord[] {
    return this.listTasksForRolePaginated(roleId, options).items;
  }

  updateTaskStatus(taskId: string, status: string, updatedAt: string): void {
    this.db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?")
      .run(status, updatedAt, taskId);
  }

  insertTransition(transition: {
    id: string; taskId: string; fromStatus: string; toStatus: string;
    requestedBy: string; status: string; createdAt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO task_transitions (
        transition_id, task_id, from_status, to_status, requested_by, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      transition.id, transition.taskId, transition.fromStatus, transition.toStatus,
      transition.requestedBy, transition.status, transition.createdAt,
    );
  }

  getTransition(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM task_transitions WHERE transition_id = ?").get(id) as Row | undefined;
  }

  resolveTransition(id: string, status: string, resolvedAt: string): void {
    this.db.prepare("UPDATE task_transitions SET status = ?, resolved_at = ? WHERE transition_id = ?")
      .run(status, resolvedAt, id);
  }

  hasPendingTransition(taskId: string, toStatus: string, requestedBy: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS found
      FROM task_transitions
      WHERE task_id = ? AND to_status = ? AND requested_by = ? AND status = 'pending'
      LIMIT 1
    `).get(taskId, toStatus, requestedBy) as Row | undefined;
    return row !== undefined;
  }

  insertMessage(message: MessageRecord): void {
    this.db.prepare(`
      INSERT INTO messages (
        message_id, task_id, from_role, to_role, type, payload, references_json,
        in_reply_to, status, risk_tags, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.messageId, message.taskId, message.fromRole, message.toRole, message.type,
      JSON.stringify(message.payload), JSON.stringify(message.references), message.inReplyTo,
      message.status, JSON.stringify(message.riskTags), message.createdAt, message.resolvedAt,
    );
  }

  getMessage(messageId: string): MessageRecord | undefined {
    const row = this.db.prepare(`
      SELECT message_id, task_id, from_role, to_role, type, payload,
             references_json AS "references", in_reply_to, status, risk_tags, created_at, resolved_at
      FROM messages WHERE message_id = ?
    `).get(messageId) as Row | undefined;
    return row ? mapMessage(row) : undefined;
  }

  listInboxPaginated(roleId: string, options?: PaginationOptions): PaginatedResult<MessageRecord> {
    const limit = this.resolveLimit(options?.limit);
    let cursorTime: string | null = null;
    let cursorId: string | null = null;
    const decoded = decodeCursor(options?.cursor);
    if (decoded) {
      if (decoded.timestamp) {
        cursorTime = decoded.timestamp;
        cursorId = decoded.id ?? "";
      } else if (decoded.id) {
        const row = this.db.prepare("SELECT created_at FROM messages WHERE message_id = ?").get(decoded.id) as Row | undefined;
        if (row) {
          cursorTime = String(row.created_at);
          cursorId = decoded.id;
        }
      }
    }

    const rows = (cursorTime !== null && cursorId !== null)
      ? (this.db.prepare(`
          SELECT message_id, task_id, from_role, to_role, type, payload,
                 references_json AS "references", in_reply_to, status, risk_tags, created_at, resolved_at
          FROM messages
          WHERE to_role = ? AND status IN ('approved', 'delivered')
            AND (created_at > ? OR (created_at = ? AND message_id > ?))
          ORDER BY created_at ASC, message_id ASC
          LIMIT ?
        `).all(roleId, cursorTime, cursorTime, cursorId, limit + 1) as Row[])
      : (this.db.prepare(`
          SELECT message_id, task_id, from_role, to_role, type, payload,
                 references_json AS "references", in_reply_to, status, risk_tags, created_at, resolved_at
          FROM messages
          WHERE to_role = ? AND status IN ('approved', 'delivered')
          ORDER BY created_at ASC, message_id ASC
          LIMIT ?
        `).all(roleId, limit + 1) as Row[]);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(mapMessage);
    const last = items[items.length - 1];
    const nextCursor = (hasMore && last) ? encodeCursor(last.createdAt, last.messageId) : null;

    return { items, nextCursor };
  }

  listInbox(roleId: string, options?: PaginationOptions): MessageRecord[] {
    return this.listInboxPaginated(roleId, options).items;
  }

  listThreadPaginated(taskId: string, roleId: string, options?: PaginationOptions): PaginatedResult<MessageRecord> {
    const limit = this.resolveLimit(options?.limit);
    let cursorTime: string | null = null;
    let cursorId: string | null = null;
    const decoded = decodeCursor(options?.cursor);
    if (decoded) {
      if (decoded.timestamp) {
        cursorTime = decoded.timestamp;
        cursorId = decoded.id ?? "";
      } else if (decoded.id) {
        const row = this.db.prepare("SELECT created_at FROM messages WHERE message_id = ?").get(decoded.id) as Row | undefined;
        if (row) {
          cursorTime = String(row.created_at);
          cursorId = decoded.id;
        }
      }
    }

    const rows = (cursorTime !== null && cursorId !== null)
      ? (this.db.prepare(`
          SELECT message_id, task_id, from_role, to_role, type, payload,
                 references_json AS "references", in_reply_to, status, risk_tags, created_at, resolved_at
          FROM messages
          WHERE task_id = ? AND (from_role = ? OR to_role = ?)
            AND (from_role = ? OR status IN ('approved', 'delivered', 'acknowledged'))
            AND (created_at > ? OR (created_at = ? AND message_id > ?))
          ORDER BY created_at ASC, message_id ASC
          LIMIT ?
        `).all(taskId, roleId, roleId, roleId, cursorTime, cursorTime, cursorId, limit + 1) as Row[])
      : (this.db.prepare(`
          SELECT message_id, task_id, from_role, to_role, type, payload,
                 references_json AS "references", in_reply_to, status, risk_tags, created_at, resolved_at
          FROM messages
          WHERE task_id = ? AND (from_role = ? OR to_role = ?)
            AND (from_role = ? OR status IN ('approved', 'delivered', 'acknowledged'))
          ORDER BY created_at ASC, message_id ASC
          LIMIT ?
        `).all(taskId, roleId, roleId, roleId, limit + 1) as Row[]);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(mapMessage);
    const last = items[items.length - 1];
    const nextCursor = (hasMore && last) ? encodeCursor(last.createdAt, last.messageId) : null;

    return { items, nextCursor };
  }

  listThread(taskId: string, roleId: string, options?: PaginationOptions): MessageRecord[] {
    return this.listThreadPaginated(taskId, roleId, options).items;
  }

  updateMessage(messageId: string, status: string, resolvedAt: string | null, payload?: unknown): void {
    if (payload === undefined) {
      this.db.prepare("UPDATE messages SET status = ?, resolved_at = ? WHERE message_id = ?")
        .run(status, resolvedAt, messageId);
    } else {
      this.db.prepare("UPDATE messages SET status = ?, resolved_at = ?, payload = ? WHERE message_id = ?")
        .run(status, resolvedAt, JSON.stringify(payload), messageId);
    }
  }

  insertMessageEvent(event: {
    id: string; messageId: string; status: string; actor: string; note: string | null; createdAt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO message_events (event_id, message_id, status, actor, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(event.id, event.messageId, event.status, event.actor, event.note, event.createdAt);
  }

  insertArtifact(artifact: ArtifactRecord): void {
    this.db.prepare(`
      INSERT INTO artifacts (
        artifact_id, type, name, produced_by, content, content_uri, content_hash,
        visible_to_roles, related_task_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.artifactId, artifact.type, artifact.name, artifact.producedBy,
      artifact.content ?? null, artifact.contentUri ?? null, artifact.contentHash,
      artifact.visibleToRoles === "all" ? "all" : JSON.stringify(artifact.visibleToRoles),
      artifact.relatedTaskId, artifact.createdAt,
    );
  }

  getArtifact(artifactId: string, includeContent = true): ArtifactRecord | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE artifact_id = ?").get(artifactId) as Row | undefined;
    return row ? mapArtifact(row, includeContent) : undefined;
  }

  listArtifactsPaginated(taskId: string | null, options?: PaginationOptions): PaginatedResult<ArtifactRecord> {
    const limit = this.resolveLimit(options?.limit);
    let cursorTime: string | null = null;
    let cursorId: string | null = null;
    const decoded = decodeCursor(options?.cursor);
    if (decoded) {
      if (decoded.timestamp) {
        cursorTime = decoded.timestamp;
        cursorId = decoded.id ?? "";
      } else if (decoded.id) {
        const row = this.db.prepare("SELECT created_at FROM artifacts WHERE artifact_id = ?").get(decoded.id) as Row | undefined;
        if (row) {
          cursorTime = String(row.created_at);
          cursorId = decoded.id;
        }
      }
    }

    let rows: Row[];
    if (taskId) {
      rows = (cursorTime !== null && cursorId !== null)
        ? (this.db.prepare(`
            SELECT * FROM artifacts
            WHERE related_task_id = ?
              AND (created_at > ? OR (created_at = ? AND artifact_id > ?))
            ORDER BY created_at ASC, artifact_id ASC
            LIMIT ?
          `).all(taskId, cursorTime, cursorTime, cursorId, limit + 1) as Row[])
        : (this.db.prepare(`
            SELECT * FROM artifacts
            WHERE related_task_id = ?
            ORDER BY created_at ASC, artifact_id ASC
            LIMIT ?
          `).all(taskId, limit + 1) as Row[]);
    } else {
      rows = (cursorTime !== null && cursorId !== null)
        ? (this.db.prepare(`
            SELECT * FROM artifacts
            WHERE (created_at > ? OR (created_at = ? AND artifact_id > ?))
            ORDER BY created_at ASC, artifact_id ASC
            LIMIT ?
          `).all(cursorTime, cursorTime, cursorId, limit + 1) as Row[])
        : (this.db.prepare(`
            SELECT * FROM artifacts
            ORDER BY created_at ASC, artifact_id ASC
            LIMIT ?
          `).all(limit + 1) as Row[]);
    }

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map((row) => mapArtifact(row, false));
    const last = items[items.length - 1];
    const nextCursor = (hasMore && last) ? encodeCursor(last.createdAt, last.artifactId) : null;

    return { items, nextCursor };
  }

  listArtifacts(taskId: string | null, options?: PaginationOptions): ArtifactRecord[] {
    return this.listArtifactsPaginated(taskId, options).items;
  }

  insertApproval(approval: PendingApproval): void {
    this.db.prepare(`
      INSERT INTO approvals (
        approval_id, subject, subject_id, requested_by, status, context,
        created_at, decided_at, decision_note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      approval.approvalId, approval.subject, approval.subjectId, approval.requestedBy,
      approval.status, JSON.stringify(approval.context), approval.createdAt,
      approval.decidedAt, approval.decisionNote,
    );
  }

  getApproval(approvalId: string): PendingApproval | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId) as Row | undefined;
    return row ? mapApproval(row) : undefined;
  }

  listPendingApprovalsPaginated(options?: PaginationOptions): PaginatedResult<PendingApproval> {
    const limit = this.resolveLimit(options?.limit);
    let cursorTime: string | null = null;
    let cursorId: string | null = null;
    const decoded = decodeCursor(options?.cursor);
    if (decoded) {
      if (decoded.timestamp) {
        cursorTime = decoded.timestamp;
        cursorId = decoded.id ?? "";
      } else if (decoded.id) {
        const row = this.db.prepare("SELECT created_at FROM approvals WHERE approval_id = ?").get(decoded.id) as Row | undefined;
        if (row) {
          cursorTime = String(row.created_at);
          cursorId = decoded.id;
        }
      }
    }

    const rows = (cursorTime !== null && cursorId !== null)
      ? (this.db.prepare(`
          SELECT * FROM approvals
          WHERE status = 'pending'
            AND (created_at > ? OR (created_at = ? AND approval_id > ?))
          ORDER BY created_at ASC, approval_id ASC
          LIMIT ?
        `).all(cursorTime, cursorTime, cursorId, limit + 1) as Row[])
      : (this.db.prepare(`
          SELECT * FROM approvals
          WHERE status = 'pending'
          ORDER BY created_at ASC, approval_id ASC
          LIMIT ?
        `).all(limit + 1) as Row[]);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(mapApproval);
    const last = items[items.length - 1];
    const nextCursor = (hasMore && last) ? encodeCursor(last.createdAt, last.approvalId) : null;

    return { items, nextCursor };
  }

  listPendingApprovals(options?: PaginationOptions): PendingApproval[] {
    return this.listPendingApprovalsPaginated(options).items;
  }

  resolveApproval(
    approvalId: string,
    status: "approved" | "rejected",
    decidedAt: string,
    note: string | null,
    editedPayload?: unknown,
  ): void {
    this.db.prepare(`
      UPDATE approvals
      SET status = ?, decided_at = ?, decision_note = ?, edited_payload = ?
      WHERE approval_id = ?
    `).run(
      status, decidedAt, note, editedPayload === undefined ? null : JSON.stringify(editedPayload), approvalId,
    );
  }

  listAllTasksPaginated(options?: PaginationOptions): PaginatedResult<TaskRecord> {
    const limit = this.resolveLimit(options?.limit);
    let cursorTime: string | null = null;
    let cursorId: string | null = null;
    const decoded = decodeCursor(options?.cursor);
    if (decoded) {
      if (decoded.timestamp) {
        cursorTime = decoded.timestamp;
        cursorId = decoded.id ?? "";
      } else if (decoded.id) {
        const row = this.db.prepare("SELECT created_at FROM tasks WHERE task_id = ?").get(decoded.id) as Row | undefined;
        if (row) {
          cursorTime = String(row.created_at);
          cursorId = decoded.id;
        }
      }
    }

    const rows = (cursorTime !== null && cursorId !== null)
      ? (this.db.prepare(`
          SELECT * FROM tasks
          WHERE (created_at > ? OR (created_at = ? AND task_id > ?))
          ORDER BY created_at ASC, task_id ASC
          LIMIT ?
        `).all(cursorTime, cursorTime, cursorId, limit + 1) as Row[])
      : (this.db.prepare(`
          SELECT * FROM tasks
          ORDER BY created_at ASC, task_id ASC
          LIMIT ?
        `).all(limit + 1) as Row[]);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(mapTask);
    const last = items[items.length - 1];
    const nextCursor = (hasMore && last) ? encodeCursor(last.createdAt, last.taskId) : null;

    return { items, nextCursor };
  }

  listAllTasks(options?: PaginationOptions): TaskRecord[] {
    return this.listAllTasksPaginated(options).items;
  }

  listAllMessagesPaginated(options?: PaginationOptions): PaginatedResult<MessageRecord> {
    const limit = this.resolveLimit(options?.limit);
    let cursorTime: string | null = null;
    let cursorId: string | null = null;
    const decoded = decodeCursor(options?.cursor);
    if (decoded) {
      if (decoded.timestamp) {
        cursorTime = decoded.timestamp;
        cursorId = decoded.id ?? "";
      } else if (decoded.id) {
        const row = this.db.prepare("SELECT created_at FROM messages WHERE message_id = ?").get(decoded.id) as Row | undefined;
        if (row) {
          cursorTime = String(row.created_at);
          cursorId = decoded.id;
        }
      }
    }

    const rows = (cursorTime !== null && cursorId !== null)
      ? (this.db.prepare(`
          SELECT message_id, task_id, from_role, to_role, type, payload,
                 references_json AS "references", in_reply_to, status, risk_tags, created_at, resolved_at
          FROM messages
          WHERE (created_at > ? OR (created_at = ? AND message_id > ?))
          ORDER BY created_at ASC, message_id ASC
          LIMIT ?
        `).all(cursorTime, cursorTime, cursorId, limit + 1) as Row[])
      : (this.db.prepare(`
          SELECT message_id, task_id, from_role, to_role, type, payload,
                 references_json AS "references", in_reply_to, status, risk_tags, created_at, resolved_at
          FROM messages
          ORDER BY created_at ASC, message_id ASC
          LIMIT ?
        `).all(limit + 1) as Row[]);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(mapMessage);
    const last = items[items.length - 1];
    const nextCursor = (hasMore && last) ? encodeCursor(last.createdAt, last.messageId) : null;

    return { items, nextCursor };
  }

  listAllMessages(options?: PaginationOptions): MessageRecord[] {
    return this.listAllMessagesPaginated(options).items;
  }

  listAllApprovalsPaginated(options?: PaginationOptions): PaginatedResult<PendingApproval> {
    const limit = this.resolveLimit(options?.limit);
    let cursorTime: string | null = null;
    let cursorId: string | null = null;
    const decoded = decodeCursor(options?.cursor);
    if (decoded) {
      if (decoded.timestamp) {
        cursorTime = decoded.timestamp;
        cursorId = decoded.id ?? "";
      } else if (decoded.id) {
        const row = this.db.prepare("SELECT created_at FROM approvals WHERE approval_id = ?").get(decoded.id) as Row | undefined;
        if (row) {
          cursorTime = String(row.created_at);
          cursorId = decoded.id;
        }
      }
    }

    const rows = (cursorTime !== null && cursorId !== null)
      ? (this.db.prepare(`
          SELECT * FROM approvals
          WHERE (created_at > ? OR (created_at = ? AND approval_id > ?))
          ORDER BY created_at ASC, approval_id ASC
          LIMIT ?
        `).all(cursorTime, cursorTime, cursorId, limit + 1) as Row[])
      : (this.db.prepare(`
          SELECT * FROM approvals
          ORDER BY created_at ASC, approval_id ASC
          LIMIT ?
        `).all(limit + 1) as Row[]);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(mapApproval);
    const last = items[items.length - 1];
    const nextCursor = (hasMore && last) ? encodeCursor(last.createdAt, last.approvalId) : null;

    return { items, nextCursor };
  }

  listAllApprovals(options?: PaginationOptions): PendingApproval[] {
    return this.listAllApprovalsPaginated(options).items;
  }

  listAllRoleBindings(): Array<{ roleId: string; agentId: string; capabilities: string[]; connectedAt: string }> {
    return (this.db.prepare("SELECT * FROM role_bindings ORDER BY connected_at ASC").all() as Row[]).map((row) => ({
      roleId: String(row.role_id),
      agentId: String(row.agent_id),
      capabilities: json<string[]>(row.capabilities),
      connectedAt: String(row.connected_at),
    }));
  }

  pruneHistory(options: PruneOptions): PruneResult {
    const olderThanDays = Math.max(0, options.olderThanDays);
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const dryRun = options.dryRun ?? false;
    const deleteArtifacts = options.deleteArtifacts ?? false;

    // Count eligible tasks
    const eligibleTasksRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
    `).get(cutoff) as { count: number };
    const tasksCount = Number(eligibleTasksRow.count);

    // Count artifacts associated with eligible tasks
    const eligibleArtifactsRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM artifacts
      WHERE related_task_id IN (
        SELECT task_id FROM tasks
        WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
      )
    `).get(cutoff) as { count: number };
    const artifactsCount = Number(eligibleArtifactsRow.count);
    const artifactsDeletedCount = deleteArtifacts ? artifactsCount : 0;
    const artifactsDetachedCount = deleteArtifacts ? 0 : artifactsCount;

    // Count messages belonging to eligible tasks OR resolved standalone messages older than cutoff
    const eligibleMessagesRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE task_id IN (
        SELECT task_id FROM tasks
        WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
      ) OR (task_id IS NULL AND resolved_at IS NOT NULL AND resolved_at < ?)
    `).get(cutoff, cutoff) as { count: number };
    const messagesCount = Number(eligibleMessagesRow.count);

    // Count message events
    const eligibleEventsRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM message_events
      WHERE message_id IN (
        SELECT message_id FROM messages
        WHERE task_id IN (
          SELECT task_id FROM tasks
          WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
        ) OR (task_id IS NULL AND resolved_at IS NOT NULL AND resolved_at < ?)
      )
    `).get(cutoff, cutoff) as { count: number };
    const messageEventsCount = Number(eligibleEventsRow.count);

    // Count task transitions
    const eligibleTransitionsRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM task_transitions
      WHERE task_id IN (
        SELECT task_id FROM tasks
        WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
      )
    `).get(cutoff) as { count: number };
    const taskTransitionsCount = Number(eligibleTransitionsRow.count);

    // Count approvals
    const eligibleApprovalsRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM approvals
      WHERE (status IN ('approved', 'rejected') AND decided_at IS NOT NULL AND decided_at < ?)
         OR (subject = 'task' AND subject_id IN (
              SELECT task_id FROM tasks
              WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
            ))
    `).get(cutoff, cutoff) as { count: number };
    const approvalsCount = Number(eligibleApprovalsRow.count);

    const result: PruneResult = {
      dryRun,
      cutoffDate: cutoff,
      tasksCount,
      messagesCount,
      messageEventsCount,
      taskTransitionsCount,
      approvalsCount,
      artifactsDetachedCount,
      artifactsDeletedCount,
    };

    if (!dryRun) {
      this.transaction(() => {
        // 1. Handle artifacts: either delete or detach to avoid foreign key failure
        if (deleteArtifacts) {
          this.db.prepare(`
            DELETE FROM artifacts
            WHERE related_task_id IN (
              SELECT task_id FROM tasks
              WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
            )
          `).run(cutoff);
        } else {
          this.db.prepare(`
            UPDATE artifacts
            SET related_task_id = NULL
            WHERE related_task_id IN (
              SELECT task_id FROM tasks
              WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
            )
          `).run(cutoff);
        }

        // 2. Detach in_reply_to references on any message that replies to a message about to be deleted
        this.db.prepare(`
          UPDATE messages
          SET in_reply_to = NULL
          WHERE in_reply_to IN (
            SELECT message_id FROM messages
            WHERE task_id IN (
              SELECT task_id FROM tasks
              WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
            ) OR (task_id IS NULL AND resolved_at IS NOT NULL AND resolved_at < ?)
          )
        `).run(cutoff, cutoff);

        // 3. Delete message events
        this.db.prepare(`
          DELETE FROM message_events
          WHERE message_id IN (
            SELECT message_id FROM messages
            WHERE task_id IN (
              SELECT task_id FROM tasks
              WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
            ) OR (task_id IS NULL AND resolved_at IS NOT NULL AND resolved_at < ?)
          )
        `).run(cutoff, cutoff);

        // 4. Delete messages
        this.db.prepare(`
          DELETE FROM messages
          WHERE task_id IN (
            SELECT task_id FROM tasks
            WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
          ) OR (task_id IS NULL AND resolved_at IS NOT NULL AND resolved_at < ?)
        `).run(cutoff, cutoff);

        // 5. Delete task transitions
        this.db.prepare(`
          DELETE FROM task_transitions
          WHERE task_id IN (
            SELECT task_id FROM tasks
            WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
          )
        `).run(cutoff);

        // 6. Delete approvals
        this.db.prepare(`
          DELETE FROM approvals
          WHERE (status IN ('approved', 'rejected') AND decided_at IS NOT NULL AND decided_at < ?)
             OR (subject = 'task' AND subject_id IN (
                  SELECT task_id FROM tasks
                  WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
                ))
        `).run(cutoff, cutoff);

        // 7. Delete tasks
        this.db.prepare(`
          DELETE FROM tasks
          WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
        `).run(cutoff);

        // 8. Bounded maintenance log retention
        this.db.prepare(`
          DELETE FROM maintenance_log
          WHERE created_at < ?
        `).run(cutoff);

        // 8b. Clean up expired idempotency keys
        const tables = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
        if (tables.includes("idempotency_keys")) {
          this.db.prepare(`
            DELETE FROM idempotency_keys
            WHERE created_at < ?
          `).run(cutoff);
        }

        // 9. Persist prune execution log inside transaction
        this.insertMaintenanceLog({
          id: `maint_${randomUUID()}`,
          action: "prune_execution",
          details: result,
          createdAt: new Date().toISOString(),
        });
      });
    } else {
      this.insertMaintenanceLog({
        id: `maint_${randomUUID()}`,
        action: "prune_simulation",
        details: result,
        createdAt: new Date().toISOString(),
      });
    }

    return result;
  }

  checkpointAndCompact(): {
    checkpoint: string;
    busy: boolean;
    logPages: number;
    checkpointedPages: number;
    vacuumed: boolean;
  } {
    const row = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      | { busy?: number; log?: number; checkpointed?: number }
      | undefined;
    const busy = (row?.busy ?? 0) !== 0;
    const logPages = row?.log ?? 0;
    const checkpointedPages = row?.checkpointed ?? 0;
    this.db.exec("VACUUM;");
    const result = {
      checkpoint: "TRUNCATE",
      busy,
      logPages,
      checkpointedPages,
      vacuumed: true,
    };
    this.insertMaintenanceLog({
      id: `maint_${randomUUID()}`,
      action: "compact",
      details: result,
      createdAt: new Date().toISOString(),
    });
    return result;
  }

  checkIntegrity(): boolean {
    const row = this.db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    return row?.integrity_check === "ok";
  }

  insertMaintenanceLog(record: MaintenanceLogRecord, maxEntries = MAX_MAINTENANCE_LOG_ENTRIES): void {
    this.db.prepare(`
      INSERT INTO maintenance_log (id, action, details_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(record.id, record.action, JSON.stringify(record.details), record.createdAt);

    // Enforce row ceiling across all maintenance paths (prune execution, simulation, compact)
    this.db.prepare(`
      DELETE FROM maintenance_log
      WHERE id NOT IN (
        SELECT id FROM maintenance_log ORDER BY created_at DESC, id DESC LIMIT ?
      )
    `).run(maxEntries);
  }

  listMaintenanceLogs(limit = 50): MaintenanceLogRecord[] {
    const rows = this.db.prepare(`
      SELECT id, action, details_json, created_at
      FROM maintenance_log
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Array<{ id: string; action: string; details_json: string; created_at: string }>;
    return rows.map((r) => ({
      id: String(r.id),
      action: r.action as "prune" | "compact",
      details: json(r.details_json),
      createdAt: String(r.created_at),
    }));
  }

  countTasks(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM tasks").get() as { count: number };
    return Number(row.count);
  }

  countMessages(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
    return Number(row.count);
  }

  countApprovals(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM approvals").get() as { count: number };
    return Number(row.count);
  }

  countArtifacts(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM artifacts").get() as { count: number };
    return Number(row.count);
  }

  countAuditTasks(options?: AuditExportOptions): number {
    let query = "SELECT COUNT(*) as count FROM tasks";
    const params: Array<string | number> = [];
    if (options?.since) {
      query += " WHERE (created_at >= ? OR updated_at >= ?)";
      params.push(options.since, options.since);
    }
    const row = this.db.prepare(query).get(...params) as { count: number };
    return Number(row.count);
  }

  countAuditMessages(options?: AuditExportOptions): number {
    let query = "SELECT COUNT(*) as count FROM messages";
    const params: Array<string | number> = [];
    if (options?.since) {
      query += " WHERE created_at >= ?";
      params.push(options.since);
    }
    const row = this.db.prepare(query).get(...params) as { count: number };
    return Number(row.count);
  }

  countAuditApprovals(options?: AuditExportOptions): number {
    let query = "SELECT COUNT(*) as count FROM approvals";
    const params: Array<string | number> = [];
    if (options?.since) {
      query += " WHERE created_at >= ?";
      params.push(options.since);
    }
    const row = this.db.prepare(query).get(...params) as { count: number };
    return Number(row.count);
  }

  countAuditArtifacts(options?: AuditExportOptions): number {
    let query = "SELECT COUNT(*) as count FROM artifacts";
    const params: Array<string | number> = [];
    if (options?.since) {
      query += " WHERE created_at >= ?";
      params.push(options.since);
    }
    const row = this.db.prepare(query).get(...params) as { count: number };
    return Number(row.count);
  }

  getAuditTasks(options?: AuditExportOptions): AuditTaskRecord[] {
    const limit = parseLimit(options?.limit, DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT);
    const maxBytes = options?.maxPayloadBytes;
    const params: Array<string | number> = [];
    let query: string;
    if (maxBytes !== undefined && maxBytes > 0) {
      query = `SELECT 
        task_id, title,
        CASE 
          WHEN description IS NOT NULL AND OCTET_LENGTH(description) > ? THEN NULL
          ELSE description 
        END AS description,
        CASE
          WHEN description IS NOT NULL AND OCTET_LENGTH(description) > ? THEN SUBSTR(CAST(description AS BLOB), 1, ?)
          ELSE NULL
        END AS description_preview,
        CASE WHEN description IS NOT NULL THEN OCTET_LENGTH(description) ELSE NULL END AS description_full_length,
        created_by, assigned_to, status, created_at, updated_at
      FROM tasks`;
      params.push(maxBytes, maxBytes, auditPreviewPrefixBytes(maxBytes));
    } else {
      query = "SELECT *, CASE WHEN description IS NOT NULL THEN OCTET_LENGTH(description) ELSE NULL END AS description_full_length FROM tasks";
    }

    if (options?.since) {
      query += " WHERE (created_at >= ? OR updated_at >= ?)";
      params.push(options.since, options.since);
    }
    query += " ORDER BY updated_at DESC, task_id DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(query).all(...params) as Row[];
    const items = rows.map((r) => {
      const fullLen = typeof r.description_full_length === "number" ? r.description_full_length : 0;
      const base = mapTask(r);
      if (maxBytes !== undefined && maxBytes > 0 && fullLen > maxBytes) {
        return {
          ...base,
          description: formatAuditPreview(r.description_preview, maxBytes),
          descriptionClipped: true,
          descriptionByteLength: fullLen,
        };
      }
      return base;
    });
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId));
    return items;
  }

  getAuditMessages(options?: AuditExportOptions): MessageRecord[] {
    const limit = parseLimit(options?.limit, DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT);
    const maxBytes = options?.maxPayloadBytes;
    const params: Array<string | number> = [];
    
    let query: string;
    if (maxBytes !== undefined && maxBytes > 0) {
      const previewBudget = Math.min(MAX_AUDIT_PREVIEW_BYTES, maxBytes);
      query = `SELECT 
        message_id, task_id, from_role, to_role, type,
        CASE 
          WHEN OCTET_LENGTH(payload) > ? THEN NULL
          ELSE payload 
        END AS payload,
        CASE
          WHEN OCTET_LENGTH(payload) > ? THEN SUBSTR(CAST(payload AS BLOB), 1, ?)
          ELSE NULL
        END AS payload_preview,
        OCTET_LENGTH(payload) AS payload_full_length,
        references_json, in_reply_to, status, risk_tags, created_at, resolved_at
      FROM messages`;
      params.push(maxBytes, maxBytes, auditPreviewPrefixBytes(previewBudget));
    } else {
      query = "SELECT *, OCTET_LENGTH(payload) AS payload_full_length FROM messages";
    }

    if (options?.since) {
      query += " WHERE created_at >= ?";
      params.push(options.since);
    }
    query += " ORDER BY created_at DESC, message_id DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(query).all(...params) as Row[];
    const items = rows.map((r) => {
      const fullLen = typeof r.payload_full_length === "number" ? r.payload_full_length : 0;
      if (maxBytes !== undefined && maxBytes > 0 && fullLen > maxBytes) {
        return {
          messageId: r.message_id as string,
          taskId: (r.task_id as string | null) ?? null,
          fromRole: r.from_role as string,
          toRole: r.to_role as string,
          type: r.type as MessageRecord["type"],
          payload: {
            _truncated: true,
            byteLength: fullLen,
            preview: formatAuditPreview(r.payload_preview, Math.min(MAX_AUDIT_PREVIEW_BYTES, maxBytes)),
          },
          references: JSON.parse((r.references_json as string | null) ?? "[]") as string[],
          inReplyTo: (r.in_reply_to as string | null) ?? null,
          status: r.status as MessageRecord["status"],
          riskTags: JSON.parse((r.risk_tags as string | null) ?? "[]") as string[],
          createdAt: r.created_at as string,
          resolvedAt: (r.resolved_at as string | null) ?? null,
        };
      }
      return mapMessage(r);
    });
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId));
    return items;
  }

  getAuditApprovals(options?: AuditExportOptions): PendingApproval[] {
    const limit = parseLimit(options?.limit, DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT);
    const maxBytes = options?.maxPayloadBytes;
    const params: Array<string | number> = [];
    
    let query: string;
    if (maxBytes !== undefined && maxBytes > 0) {
      const previewBudget = Math.min(MAX_AUDIT_PREVIEW_BYTES, maxBytes);
      query = `SELECT 
        approval_id, subject, subject_id, requested_by, status,
        CASE 
          WHEN context IS NOT NULL AND OCTET_LENGTH(context) > ? THEN NULL
          ELSE context 
        END AS context,
        CASE
          WHEN context IS NOT NULL AND OCTET_LENGTH(context) > ? THEN SUBSTR(CAST(context AS BLOB), 1, ?)
          ELSE NULL
        END AS context_preview,
        CASE WHEN context IS NOT NULL THEN OCTET_LENGTH(context) ELSE NULL END AS context_full_length,
        created_at, decided_at, decision_note
      FROM approvals`;
      params.push(maxBytes, maxBytes, auditPreviewPrefixBytes(previewBudget));
    } else {
      query = `SELECT 
        approval_id, subject, subject_id, requested_by, status,
        context,
        CASE WHEN context IS NOT NULL THEN OCTET_LENGTH(context) ELSE NULL END AS context_full_length,
        created_at, decided_at, decision_note
      FROM approvals`;
    }

    if (options?.since) {
      query += " WHERE created_at >= ?";
      params.push(options.since);
    }
    query += " ORDER BY created_at DESC, approval_id DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(query).all(...params) as Row[];
    const items = rows.map((r) => {
      const fullLen = typeof r.context_full_length === "number" ? r.context_full_length : 0;
      if (maxBytes !== undefined && maxBytes > 0 && fullLen > maxBytes) {
        return {
          approvalId: String(r.approval_id),
          subject: String(r.subject) as PendingApproval["subject"],
          subjectId: String(r.subject_id),
          requestedBy: String(r.requested_by),
          status: String(r.status) as PendingApproval["status"],
          context: {
            _truncated: true,
            byteLength: fullLen,
            preview: formatAuditPreview(r.context_preview, Math.min(MAX_AUDIT_PREVIEW_BYTES, maxBytes)),
          },
          createdAt: String(r.created_at),
          decidedAt: r.decided_at ? String(r.decided_at) : null,
          decisionNote: r.decision_note ? String(r.decision_note) : null,
        };
      }
      return mapApproval(r);
    });
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.approvalId.localeCompare(b.approvalId));
    return items;
  }

  getAuditArtifacts(options?: AuditExportOptions): AuditArtifactRecord[] {
    const limit = parseLimit(options?.limit, DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT);
    const maxBytes = options?.maxPayloadBytes;
    const params: Array<string | number> = [];

    let query: string;
    if (maxBytes !== undefined && maxBytes > 0) {
      const previewBudget = Math.min(MAX_AUDIT_PREVIEW_BYTES, maxBytes);
      query = `SELECT
        artifact_id, type, name, produced_by, content_hash,
        CASE
          WHEN content IS NOT NULL AND OCTET_LENGTH(content) > ? THEN NULL
          ELSE content
        END AS content,
        CASE
          WHEN content IS NOT NULL AND OCTET_LENGTH(content) > ? THEN SUBSTR(CAST(content AS BLOB), 1, ?)
          ELSE NULL
        END AS content_preview,
        CASE WHEN content IS NOT NULL THEN OCTET_LENGTH(content) ELSE NULL END AS content_full_length,
        content_uri, visible_to_roles, related_task_id, created_at
      FROM artifacts`;
      params.push(maxBytes, maxBytes, auditPreviewPrefixBytes(previewBudget));
    } else {
      query = "SELECT *, CASE WHEN content IS NOT NULL THEN OCTET_LENGTH(content) ELSE NULL END AS content_full_length FROM artifacts";
    }

    if (options?.since) {
      query += " WHERE created_at >= ?";
      params.push(options.since);
    }
    query += " ORDER BY created_at DESC, artifact_id DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(query).all(...params) as Row[];
    const items = rows.map((r) => {
      const fullLen = typeof r.content_full_length === "number" ? r.content_full_length : 0;
      if (maxBytes !== undefined && maxBytes > 0 && fullLen > maxBytes) {
        const item = mapArtifact(r, false);
        return {
          ...item,
          content: formatAuditPreview(r.content_preview, Math.min(MAX_AUDIT_PREVIEW_BYTES, maxBytes)),
          contentClipped: true,
          contentByteLength: fullLen,
        };
      }
      return mapArtifact(r, false);
    });
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.artifactId.localeCompare(b.artifactId));
    return items;
  }
}

export function policyFromConfig(
  rule: InitialPolicy,
  id: string,
  timestamp: string,
): PolicyRule {
  return {
    ...rule,
    id,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

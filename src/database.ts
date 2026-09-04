import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getCurrentSchemaVersion, runMigrations } from "./migrations.js";
import type {
  ArtifactRecord,
  InitialPolicy,
  MessageRecord,
  PaginatedResult,
  PaginationOptions,
  PendingApproval,
  PolicyRule,
  PruneOptions,
  PruneResult,
  TaskRecord,
} from "./types.js";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

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

function parseLimit(limit?: number): number {
  if (limit === undefined || limit === null || Number.isNaN(limit)) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE_LIMIT);
}

type Row = Record<string, unknown>;

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
    references: json<string[]>(row.references),
    inReplyTo: row.in_reply_to === null ? null : String(row.in_reply_to),
    status: String(row.status) as MessageRecord["status"],
    riskTags: json<string[]>(row.risk_tags),
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

  constructor(path = ".agentcorp/agentcorp.db") {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
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
    this.db.prepare(`
      INSERT INTO role_bindings (role_id, agent_id, capabilities, connected_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(role_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        capabilities = excluded.capabilities,
        connected_at = excluded.connected_at
    `).run(roleId, agentId, JSON.stringify(capabilities), connectedAt);
  }

  insertTask(task: TaskRecord): void {
    this.db.prepare(`
      INSERT INTO tasks (task_id, title, description, created_by, assigned_to, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.taskId, task.title, task.description, task.createdBy, task.assignedTo,
      task.status, task.createdAt, task.updatedAt,
    );
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Row | undefined;
    return row ? mapTask(row) : undefined;
  }

  listTasksForRolePaginated(roleId: string, options?: PaginationOptions): PaginatedResult<TaskRecord> {
    const limit = parseLimit(options?.limit);
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
    const limit = parseLimit(options?.limit);
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
    const limit = parseLimit(options?.limit);
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
    const limit = parseLimit(options?.limit);
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
    const limit = parseLimit(options?.limit);
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
    const limit = parseLimit(options?.limit);
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
    const limit = parseLimit(options?.limit);
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
    const limit = parseLimit(options?.limit);
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

    // Terminal tasks older than cutoff
    const eligibleTasks = this.db.prepare(`
      SELECT task_id FROM tasks
      WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
    `).all(cutoff) as Array<{ task_id: string }>;
    const taskIds = eligibleTasks.map((r) => String(r.task_id));

    // Messages belonging to those tasks OR resolved standalone messages older than cutoff
    let messageIds: string[] = [];
    if (taskIds.length > 0) {
      const placeholders = taskIds.map(() => "?").join(",");
      const msgs = this.db.prepare(`
        SELECT message_id FROM messages
        WHERE task_id IN (${placeholders})
           OR (task_id IS NULL AND resolved_at IS NOT NULL AND resolved_at < ?)
      `).all(...taskIds, cutoff) as Array<{ message_id: string }>;
      messageIds = msgs.map((r) => String(r.message_id));
    } else {
      const msgs = this.db.prepare(`
        SELECT message_id FROM messages
        WHERE task_id IS NULL AND resolved_at IS NOT NULL AND resolved_at < ?
      `).all(cutoff) as Array<{ message_id: string }>;
      messageIds = msgs.map((r) => String(r.message_id));
    }

    // Message events for those messages
    let eventCount = 0;
    if (messageIds.length > 0) {
      const placeholders = messageIds.map(() => "?").join(",");
      const res = this.db.prepare(`
        SELECT COUNT(*) as count FROM message_events WHERE message_id IN (${placeholders})
      `).get(...messageIds) as { count: number };
      eventCount = Number(res.count);
    }

    // Task transitions for eligible tasks
    let transitionCount = 0;
    if (taskIds.length > 0) {
      const placeholders = taskIds.map(() => "?").join(",");
      const res = this.db.prepare(`
        SELECT COUNT(*) as count FROM task_transitions WHERE task_id IN (${placeholders})
      `).get(...taskIds) as { count: number };
      transitionCount = Number(res.count);
    }

    // Resolved approvals older than cutoff
    const eligibleApprovals = this.db.prepare(`
      SELECT approval_id FROM approvals
      WHERE status IN ('approved', 'rejected') AND decided_at IS NOT NULL AND decided_at < ?
    `).all(cutoff) as Array<{ approval_id: string }>;
    const approvalCount = eligibleApprovals.length;

    const result: PruneResult = {
      dryRun,
      cutoffDate: cutoff,
      tasksCount: taskIds.length,
      messagesCount: messageIds.length,
      messageEventsCount: eventCount,
      taskTransitionsCount: transitionCount,
      approvalsCount: approvalCount,
    };

    if (!dryRun) {
      this.transaction(() => {
        if (messageIds.length > 0) {
          const placeholders = messageIds.map(() => "?").join(",");
          this.db.prepare(`DELETE FROM message_events WHERE message_id IN (${placeholders})`).run(...messageIds);
          this.db.prepare(`DELETE FROM messages WHERE message_id IN (${placeholders})`).run(...messageIds);
        }
        if (taskIds.length > 0) {
          const placeholders = taskIds.map(() => "?").join(",");
          this.db.prepare(`DELETE FROM task_transitions WHERE task_id IN (${placeholders})`).run(...taskIds);
          this.db.prepare(`DELETE FROM tasks WHERE task_id IN (${placeholders})`).run(...taskIds);
        }
        if (eligibleApprovals.length > 0) {
          const placeholders = eligibleApprovals.map(() => "?").join(",");
          const approvalIds = eligibleApprovals.map((r) => String(r.approval_id));
          this.db.prepare(`DELETE FROM approvals WHERE approval_id IN (${placeholders})`).run(...approvalIds);
        }
      });
    }

    return result;
  }

  checkpointAndCompact(): { checkpoint: string; vacuumed: boolean } {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    this.db.exec("VACUUM;");
    return { checkpoint: "TRUNCATE", vacuumed: true };
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

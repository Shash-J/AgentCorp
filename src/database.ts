import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getCurrentSchemaVersion, runMigrations } from "./migrations.js";
import type {
  ArtifactRecord,
  InitialPolicy,
  MessageRecord,
  PendingApproval,
  PolicyRule,
  TaskRecord,
} from "./types.js";

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

  listTasksForRole(roleId: string): TaskRecord[] {
    return (this.db.prepare(`
      SELECT DISTINCT t.* FROM tasks t
      LEFT JOIN messages m ON m.task_id = t.task_id
      WHERE t.created_by = ? OR t.assigned_to = ? OR m.from_role = ? OR m.to_role = ?
      ORDER BY t.updated_at DESC
    `).all(roleId, roleId, roleId, roleId) as Row[]).map(mapTask);
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

  listInbox(roleId: string): MessageRecord[] {
    return (this.db.prepare(`
      SELECT message_id, task_id, from_role, to_role, type, payload,
             references_json AS "references", in_reply_to, status, risk_tags, created_at, resolved_at
      FROM messages
      WHERE to_role = ? AND status IN ('approved', 'delivered')
      ORDER BY created_at ASC
    `).all(roleId) as Row[]).map(mapMessage);
  }

  listThread(taskId: string, roleId: string): MessageRecord[] {
    return (this.db.prepare(`
      SELECT message_id, task_id, from_role, to_role, type, payload,
             references_json AS "references", in_reply_to, status, risk_tags, created_at, resolved_at
      FROM messages
      WHERE task_id = ? AND (from_role = ? OR to_role = ?)
        AND (from_role = ? OR status IN ('approved', 'delivered', 'acknowledged'))
      ORDER BY created_at ASC
    `).all(taskId, roleId, roleId, roleId) as Row[]).map(mapMessage);
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

  listArtifacts(taskId: string | null): ArtifactRecord[] {
    const rows = taskId
      ? this.db.prepare("SELECT * FROM artifacts WHERE related_task_id = ? ORDER BY created_at ASC").all(taskId)
      : this.db.prepare("SELECT * FROM artifacts ORDER BY created_at ASC").all();
    return (rows as Row[]).map((row) => mapArtifact(row, false));
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

  listPendingApprovals(): PendingApproval[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC").all() as Row[])
      .map(mapApproval);
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

  listAllTasks(): TaskRecord[] {
    return (this.db.prepare("SELECT * FROM tasks ORDER BY created_at ASC").all() as Row[]).map(mapTask);
  }

  listAllMessages(): MessageRecord[] {
    return (this.db.prepare(`
      SELECT message_id, task_id, from_role, to_role, type, payload,
             references_json AS "references", in_reply_to, status, risk_tags, created_at, resolved_at
      FROM messages
      ORDER BY created_at ASC
    `).all() as Row[]).map(mapMessage);
  }

  listAllApprovals(): PendingApproval[] {
    return (this.db.prepare("SELECT * FROM approvals ORDER BY created_at ASC").all() as Row[]).map(mapApproval);
  }

  listAllRoleBindings(): Array<{ roleId: string; agentId: string; capabilities: string[]; connectedAt: string }> {
    return (this.db.prepare("SELECT * FROM role_bindings ORDER BY connected_at ASC").all() as Row[]).map((row) => ({
      roleId: String(row.role_id),
      agentId: String(row.agent_id),
      capabilities: json<string[]>(row.capabilities),
      connectedAt: String(row.connected_at),
    }));
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

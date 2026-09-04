import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { AgentCorpDatabase, policyFromConfig } from "./database.js";
import { AgentCorpError, invariant } from "./errors.js";
import { evaluatePolicy } from "./policy.js";
import {
  MessageTypeSchema,
  InitialPolicySchema,
  TaskStatusSchema,
  type ArtifactRecord,
  type InitialPolicy,
  type MessageRecord,
  type MessageType,
  type OrgConfig,
  type PendingApproval,
  type PolicyRule,
  type RoleDefinition,
  type TaskRecord,
  type TaskStatus,
} from "./types.js";

export type BrokerEventType =
  | "message_created"
  | "message_status_changed"
  | "task_created"
  | "task_status_changed"
  | "approval_created"
  | "approval_resolved"
  | "policy_saved"
  | "policy_toggled"
  | "artifact_created"
  | "role_registered";

export interface BrokerDomainEvent {
  type: BrokerEventType;
  data: unknown;
  timestamp: string;
}

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  proposed: ["assigned", "cancelled"],
  assigned: ["in_progress", "cancelled"],
  in_progress: ["blocked", "awaiting_review", "failed", "cancelled"],
  blocked: ["in_progress", "failed", "cancelled"],
  awaiting_review: ["in_progress", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export interface SendMessageInput {
  toRole: string;
  type: MessageType;
  payload: unknown;
  taskId?: string;
  references?: string[];
  riskTags?: string[];
  inReplyTo?: string;
}

export interface CreateArtifactInput {
  type: string;
  name: string;
  content?: string;
  contentUri?: string;
  visibleToRoles?: "all" | string[];
  relatedTaskId?: string;
}

export interface BrokerOptions {
  now?: () => Date;
  id?: (prefix: string) => string;
}

export class AgentCorpBroker extends EventEmitter {
  readonly config: OrgConfig;
  readonly database: AgentCorpDatabase;
  private readonly roles: Map<string, RoleDefinition>;
  private readonly now: () => Date;
  private readonly id: (prefix: string) => string;

  constructor(config: OrgConfig, database: AgentCorpDatabase, options: BrokerOptions = {}) {
    super();
    this.config = config;
    this.database = database;
    this.roles = new Map(config.roles.map((role) => [role.id, role]));
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.seedPolicies();
  }

  private emitDomainEvent(type: BrokerEventType, data: unknown): void {
    const event: BrokerDomainEvent = {
      type,
      data,
      timestamp: this.timestamp(),
    };
    this.emit("event", event);
    this.emit(type, event);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private role(roleId: string): RoleDefinition {
    const role = this.roles.get(roleId);
    invariant(role, "UNKNOWN_ROLE", `Unknown role: ${roleId}`);
    return role;
  }

  private seedPolicies(): void {
    if (this.database.countPolicies() > 0) return;
    const timestamp = this.timestamp();
    this.database.transaction(() => {
      for (const initial of this.config.policies) {
        const rule = policyFromConfig(initial, initial.id ?? this.id("pol"), timestamp);
        if (rule.action === "delegate_to_role") {
          throw new AgentCorpError(
            "UNSUPPORTED_POLICY",
            `Policy ${rule.id} uses delegate_to_role, which is reserved for a future release`,
          );
        }
        this.database.insertPolicy(rule);
      }
    });
  }

  getRole(roleId: string): RoleDefinition {
    return this.role(roleId);
  }

  registerRole(roleId: string, agentId: string, declaredCapabilities: string[]): RoleDefinition {
    const role = this.role(roleId);
    const undeclared = declaredCapabilities.filter((capability) => !role.capabilities.includes(capability));
    invariant(
      undeclared.length === 0,
      "CAPABILITY_ESCALATION",
      `Role ${roleId} cannot claim undeclared capabilities: ${undeclared.join(", ")}`,
    );
    this.database.bindRole(roleId, agentId, declaredCapabilities, this.timestamp());
    this.emitDomainEvent("role_registered", { roleId, agentId, capabilities: declaredCapabilities });
    return role;
  }

  createTask(
    callerRole: string,
    input: { title: string; description?: string; assignedTo?: string },
  ): TaskRecord {
    this.role(callerRole);
    if (input.assignedTo) {
      this.assertRoute(callerRole, input.assignedTo);
    }
    const timestamp = this.timestamp();
    const task: TaskRecord = {
      taskId: this.id("task"),
      title: input.title,
      description: input.description ?? null,
      createdBy: callerRole,
      assignedTo: input.assignedTo ?? null,
      status: input.assignedTo ? "assigned" : "proposed",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.database.insertTask(task);
    this.emitDomainEvent("task_created", task);
    return task;
  }

  listTasks(callerRole: string): TaskRecord[] {
    this.role(callerRole);
    return this.database.listTasksForRole(callerRole);
  }

  sendMessage(callerRole: string, input: SendMessageInput): MessageRecord {
    this.assertRoute(callerRole, input.toRole);
    MessageTypeSchema.parse(input.type);
    const references = input.references ?? [];
    const riskTags = [...new Set(input.riskTags ?? [])].sort();

    if (input.taskId) {
      const task = this.database.getTask(input.taskId);
      invariant(task, "TASK_NOT_FOUND", `Task not found: ${input.taskId}`);
      this.assertTaskParticipant(task, callerRole);
    }
    if (input.inReplyTo) {
      const parent = this.database.getMessage(input.inReplyTo);
      invariant(parent, "MESSAGE_NOT_FOUND", `Reply target not found: ${input.inReplyTo}`);
      invariant(
        parent.taskId === (input.taskId ?? null),
        "INVALID_REPLY",
        "Reply target must belong to the same task",
      );
    }
    for (const artifactId of references) {
      const artifact = this.database.getArtifact(artifactId, false);
      invariant(artifact, "ARTIFACT_NOT_FOUND", `Artifact not found: ${artifactId}`);
      this.assertArtifactVisible(artifact, callerRole);
      this.assertArtifactVisible(artifact, input.toRole);
    }

    const decision = evaluatePolicy(this.database.listPolicies(), {
      subject: "message",
      fromRole: callerRole,
      toRole: input.toRole,
      messageType: input.type,
      riskTags,
    });
    invariant(
      decision.action !== "delegate_to_role",
      "UNSUPPORTED_POLICY",
      "delegate_to_role policies are not implemented in v0",
    );

    const timestamp = this.timestamp();
    const status = decision.action === "auto_approve" ? "delivered" : "pending_approval";
    const message: MessageRecord = {
      messageId: this.id("msg"),
      taskId: input.taskId ?? null,
      fromRole: callerRole,
      toRole: input.toRole,
      type: input.type,
      payload: input.payload,
      references,
      inReplyTo: input.inReplyTo ?? null,
      status,
      riskTags,
      createdAt: timestamp,
      resolvedAt: status === "delivered" ? timestamp : null,
    };

    let approvalId: string | undefined;
    this.database.transaction(() => {
      this.database.insertMessage(message);
      this.database.insertMessageEvent({
        id: this.id("evt"),
        messageId: message.messageId,
        status,
        actor: decision.action === "auto_approve" ? "policy_engine" : callerRole,
        note: decision.matchedRuleId ? `Matched policy ${decision.matchedRuleId}` : "Default fail-closed policy",
        createdAt: timestamp,
      });
      if (status === "pending_approval") {
        approvalId = this.id("apr");
        this.database.insertApproval({
          approvalId,
          subject: "message",
          subjectId: message.messageId,
          requestedBy: callerRole,
          status: "pending",
          context: {
            fromRole: callerRole,
            toRole: input.toRole,
            type: input.type,
            payload: input.payload,
            taskId: input.taskId ?? null,
            references,
            riskTags,
            matchedRuleId: decision.matchedRuleId,
          },
          createdAt: timestamp,
          decidedAt: null,
          decisionNote: null,
        });
      }
    });

    this.emitDomainEvent("message_created", message);
    if (status === "pending_approval" && approvalId) {
      this.emitDomainEvent("approval_created", {
        approvalId,
        subject: "message",
        subjectId: message.messageId,
        requestedBy: callerRole,
      });
    }

    return message;
  }

  getInbox(callerRole: string): MessageRecord[] {
    this.role(callerRole);
    return this.database.listInbox(callerRole);
  }

  acknowledgeMessage(callerRole: string, messageId: string): MessageRecord {
    const message = this.database.getMessage(messageId);
    invariant(message, "MESSAGE_NOT_FOUND", `Message not found: ${messageId}`);
    invariant(message.toRole === callerRole, "FORBIDDEN", "Only the recipient can acknowledge a message");
    invariant(
      message.status === "delivered" || message.status === "approved",
      "INVALID_MESSAGE_STATE",
      `Cannot acknowledge a message in ${message.status} state`,
    );
    const timestamp = this.timestamp();
    this.database.transaction(() => {
      this.database.updateMessage(messageId, "acknowledged", timestamp);
      this.database.insertMessageEvent({
        id: this.id("evt"), messageId, status: "acknowledged", actor: callerRole,
        note: null, createdAt: timestamp,
      });
    });
    this.emitDomainEvent("message_status_changed", { messageId, status: "acknowledged", role: callerRole });
    return this.database.getMessage(messageId)!;
  }

  getThread(callerRole: string, taskId: string): MessageRecord[] {
    this.role(callerRole);
    const task = this.database.getTask(taskId);
    invariant(task, "TASK_NOT_FOUND", `Task not found: ${taskId}`);
    this.assertTaskParticipant(task, callerRole);
    return this.database.listThread(taskId, callerRole);
  }

  createArtifact(callerRole: string, input: CreateArtifactInput): ArtifactRecord {
    const role = this.role(callerRole);
    invariant(
      (input.content === undefined) !== (input.contentUri === undefined),
      "INVALID_ARTIFACT",
      "Provide exactly one of content or contentUri",
    );
    if (input.relatedTaskId) {
      const task = this.database.getTask(input.relatedTaskId);
      invariant(task, "TASK_NOT_FOUND", `Task not found: ${input.relatedTaskId}`);
      this.assertTaskParticipant(task, callerRole);
    }

    const visibility = input.visibleToRoles ?? role.artifact_visibility;
    if (visibility !== "all") {
      for (const roleId of visibility) this.role(roleId);
      invariant(
        visibility.includes(callerRole),
        "INVALID_VISIBILITY",
        "The producing role must retain visibility to its artifact",
      );
    }
    const contentValue = input.content ?? input.contentUri!;
    const artifact: ArtifactRecord = {
      artifactId: this.id("art"),
      type: input.type,
      name: input.name,
      producedBy: callerRole,
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.contentUri === undefined ? {} : { contentUri: input.contentUri }),
      contentHash: createHash("sha256").update(contentValue).digest("hex"),
      visibleToRoles: visibility,
      relatedTaskId: input.relatedTaskId ?? null,
      createdAt: this.timestamp(),
    };
    this.database.insertArtifact(artifact);
    this.emitDomainEvent("artifact_created", artifact);
    return artifact;
  }

  listArtifacts(callerRole: string, taskId?: string): ArtifactRecord[] {
    this.role(callerRole);
    if (taskId) {
      const task = this.database.getTask(taskId);
      invariant(task, "TASK_NOT_FOUND", `Task not found: ${taskId}`);
      this.assertTaskParticipant(task, callerRole);
    }
    return this.database.listArtifacts(taskId ?? null)
      .filter((artifact) => this.canSeeArtifact(artifact, callerRole));
  }

  getArtifact(callerRole: string, artifactId: string): ArtifactRecord {
    this.role(callerRole);
    const artifact = this.database.getArtifact(artifactId, true);
    invariant(artifact, "ARTIFACT_NOT_FOUND", `Artifact not found: ${artifactId}`);
    this.assertArtifactVisible(artifact, callerRole);
    return artifact;
  }

  updateTaskStatus(
    callerRole: string,
    taskId: string,
    requestedStatus: TaskStatus,
    riskTags: string[] = [],
  ): { task: TaskRecord; pendingApproval: boolean } {
    this.role(callerRole);
    const task = this.database.getTask(taskId);
    invariant(task, "TASK_NOT_FOUND", `Task not found: ${taskId}`);
    this.assertTaskParticipant(task, callerRole);
    const toStatus = TaskStatusSchema.parse(requestedStatus);
    invariant(
      TASK_TRANSITIONS[task.status].includes(toStatus),
      "INVALID_TASK_TRANSITION",
      `Task cannot transition from ${task.status} to ${toStatus}`,
    );

    const decision = evaluatePolicy(this.database.listPolicies(), {
      subject: "task",
      fromRole: callerRole,
      ...(task.assignedTo ? { toRole: task.assignedTo } : {}),
      fromStatus: task.status,
      toStatus,
      riskTags: [...new Set(riskTags)].sort(),
    });
    invariant(
      decision.action !== "delegate_to_role",
      "UNSUPPORTED_POLICY",
      "delegate_to_role policies are not implemented in v0",
    );

    const timestamp = this.timestamp();
    if (decision.action === "auto_approve") {
      this.database.updateTaskStatus(taskId, toStatus, timestamp);
      const updated = this.database.getTask(taskId)!;
      this.emitDomainEvent("task_status_changed", { taskId, status: toStatus, task: updated });
      return { task: updated, pendingApproval: false };
    }

    const transitionId = this.id("trn");
    const approvalId = this.id("apr");
    this.database.transaction(() => {
      this.database.insertTransition({
        id: transitionId,
        taskId,
        fromStatus: task.status,
        toStatus,
        requestedBy: callerRole,
        status: "pending",
        createdAt: timestamp,
      });
      this.database.insertApproval({
        approvalId,
        subject: "task",
        subjectId: transitionId,
        requestedBy: callerRole,
        status: "pending",
        context: { taskId, fromStatus: task.status, toStatus, matchedRuleId: decision.matchedRuleId },
        createdAt: timestamp,
        decidedAt: null,
        decisionNote: null,
      });
    });

    this.emitDomainEvent("approval_created", {
      approvalId,
      subject: "task",
      subjectId: transitionId,
      taskId,
      fromStatus: task.status,
      toStatus,
    });

    return { task, pendingApproval: true };
  }

  listPendingApprovals(): PendingApproval[] {
    return this.database.listPendingApprovals();
  }

  approve(approvalId: string, note?: string, editedPayload?: unknown): PendingApproval {
    const approval = this.database.getApproval(approvalId);
    invariant(approval, "APPROVAL_NOT_FOUND", `Approval not found: ${approvalId}`);
    invariant(approval.status === "pending", "APPROVAL_RESOLVED", "Approval has already been resolved");
    const timestamp = this.timestamp();

    this.database.transaction(() => {
      if (approval.subject === "message") {
        const message = this.database.getMessage(approval.subjectId);
        invariant(message, "MESSAGE_NOT_FOUND", `Message not found: ${approval.subjectId}`);
        invariant(message.status === "pending_approval", "INVALID_MESSAGE_STATE", "Message is not pending approval");
        if (editedPayload !== undefined) {
          this.database.updateMessage(message.messageId, "edited", null, editedPayload);
          this.database.insertMessageEvent({
            id: this.id("evt"), messageId: message.messageId, status: "edited", actor: "human",
            note: note ?? null, createdAt: timestamp,
          });
        }
        this.database.updateMessage(message.messageId, "delivered", timestamp, editedPayload);
        this.database.insertMessageEvent({
          id: this.id("evt"), messageId: message.messageId, status: "delivered", actor: "human",
          note: note ?? null, createdAt: timestamp,
        });
      } else {
        invariant(editedPayload === undefined, "INVALID_APPROVAL_EDIT", "Task transitions cannot edit message payloads");
        const transition = this.database.getTransition(approval.subjectId);
        invariant(transition, "TRANSITION_NOT_FOUND", `Transition not found: ${approval.subjectId}`);
        const task = this.database.getTask(String(transition.task_id));
        invariant(task, "TASK_NOT_FOUND", `Task not found: ${String(transition.task_id)}`);
        invariant(
          task.status === String(transition.from_status),
          "STALE_TRANSITION",
          `Task state changed from ${String(transition.from_status)} to ${task.status} while approval was pending`,
        );
        this.database.updateTaskStatus(task.taskId, String(transition.to_status), timestamp);
        this.database.resolveTransition(approval.subjectId, "approved", timestamp);
      }
      this.database.resolveApproval(approvalId, "approved", timestamp, note ?? null, editedPayload);
    });

    this.emitDomainEvent("approval_resolved", { approvalId, status: "approved", subject: approval.subject });
    if (approval.subject === "message") {
      this.emitDomainEvent("message_status_changed", { messageId: approval.subjectId, status: "delivered" });
    } else {
      this.emitDomainEvent("task_status_changed", { transitionId: approval.subjectId, status: "approved" });
    }

    return this.database.getApproval(approvalId)!;
  }

  reject(approvalId: string, note?: string): PendingApproval {
    const approval = this.database.getApproval(approvalId);
    invariant(approval, "APPROVAL_NOT_FOUND", `Approval not found: ${approvalId}`);
    invariant(approval.status === "pending", "APPROVAL_RESOLVED", "Approval has already been resolved");
    const timestamp = this.timestamp();
    this.database.transaction(() => {
      if (approval.subject === "message") {
        const message = this.database.getMessage(approval.subjectId);
        invariant(message, "MESSAGE_NOT_FOUND", `Message not found: ${approval.subjectId}`);
        this.database.updateMessage(message.messageId, "rejected", timestamp);
        this.database.insertMessageEvent({
          id: this.id("evt"), messageId: message.messageId, status: "rejected", actor: "human",
          note: note ?? null, createdAt: timestamp,
        });
      } else {
        this.database.resolveTransition(approval.subjectId, "rejected", timestamp);
      }
      this.database.resolveApproval(approvalId, "rejected", timestamp, note ?? null);
    });

    this.emitDomainEvent("approval_resolved", { approvalId, status: "rejected", subject: approval.subject });
    if (approval.subject === "message") {
      this.emitDomainEvent("message_status_changed", { messageId: approval.subjectId, status: "rejected" });
    }

    return this.database.getApproval(approvalId)!;
  }

  listPolicies(): PolicyRule[] {
    return this.database.listPolicies();
  }

  savePolicy(input: InitialPolicy): PolicyRule {
    const parsed = InitialPolicySchema.parse(input);
    invariant(
      parsed.action !== "delegate_to_role",
      "UNSUPPORTED_POLICY",
      "delegate_to_role policies are not implemented in v0",
    );
    if (parsed.from_role) this.role(parsed.from_role);
    if (parsed.to_role) this.role(parsed.to_role);
    if (parsed.delegate_role) this.role(parsed.delegate_role);

    const timestamp = this.timestamp();
    const id = parsed.id ?? this.id("pol");
    const existing = this.database.getPolicy(id);
    const policy: PolicyRule = {
      ...parsed,
      id,
      enabled: existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.database.upsertPolicy(policy);
    this.emitDomainEvent("policy_saved", policy);
    return policy;
  }

  setPolicyEnabled(policyId: string, enabled: boolean): PolicyRule {
    const policy = this.database.getPolicy(policyId);
    invariant(policy, "POLICY_NOT_FOUND", `Policy not found: ${policyId}`);
    this.database.setPolicyEnabled(policyId, enabled, this.timestamp());
    const updated = this.database.getPolicy(policyId)!;
    this.emitDomainEvent("policy_toggled", { policyId, enabled, policy: updated });
    return updated;
  }

  private assertRoute(fromRole: string, toRole: string): void {
    const sender = this.role(fromRole);
    this.role(toRole);
    invariant(
      sender.allowed_peers.includes(toRole),
      "ROUTE_FORBIDDEN",
      `Role ${fromRole} is not allowed to send to ${toRole}`,
    );
  }

  private assertTaskParticipant(task: TaskRecord, roleId: string): void {
    const involved = task.createdBy === roleId || task.assignedTo === roleId ||
      this.database.listThread(task.taskId, roleId).length > 0;
    invariant(involved, "FORBIDDEN", `Role ${roleId} is not a participant in task ${task.taskId}`);
  }

  private canSeeArtifact(artifact: ArtifactRecord, roleId: string): boolean {
    return artifact.visibleToRoles === "all" || artifact.visibleToRoles.includes(roleId);
  }

  private assertArtifactVisible(artifact: ArtifactRecord, roleId: string): void {
    invariant(
      this.canSeeArtifact(artifact, roleId),
      "ARTIFACT_FORBIDDEN",
      `Role ${roleId} cannot access artifact ${artifact.artifactId}`,
    );
  }
}

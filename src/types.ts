import { z } from "zod";

export const MessageTypeSchema = z.enum([
  "proposal",
  "question",
  "answer",
  "report",
  "review",
  "verdict",
  "status_update",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const MessageStatusSchema = z.enum([
  "draft",
  "pending_approval",
  "approved",
  "edited",
  "rejected",
  "delivered",
  "acknowledged",
]);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const TaskStatusSchema = z.enum([
  "proposed",
  "assigned",
  "in_progress",
  "blocked",
  "awaiting_review",
  "completed",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const PolicyActionSchema = z.enum([
  "auto_approve",
  "require_human",
  "delegate_to_role",
]);
export type PolicyAction = z.infer<typeof PolicyActionSchema>;

export const PolicySubjectSchema = z.enum(["message", "task"]);
export type PolicySubject = z.infer<typeof PolicySubjectSchema>;

export const RoleSchema = z.object({
  id: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/),
  display_name: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  interface: z.literal("mcp").default("mcp"),
  capabilities: z.array(z.string().min(1)).default([]),
  allowed_peers: z.array(z.string().min(1)).default([]),
  artifact_visibility: z.union([z.literal("all"), z.array(z.string().min(1))]),
});
export type RoleDefinition = z.infer<typeof RoleSchema>;

export const InitialPolicySchema = z.object({
  id: z.string().min(1).optional(),
  subject: PolicySubjectSchema,
  priority: z.number().int().default(0),
  from_role: z.string().min(1).optional(),
  to_role: z.string().min(1).optional(),
  message_type: MessageTypeSchema.optional(),
  risk_tags: z.array(z.string().min(1)).optional(),
  from_status: TaskStatusSchema.optional(),
  to_status: TaskStatusSchema.optional(),
  action: PolicyActionSchema,
  delegate_role: z.string().min(1).optional(),
});
export type InitialPolicy = z.infer<typeof InitialPolicySchema>;

export const LimitsConfigSchema = z
  .object({
    max_request_body_bytes: z.number().int().positive().optional(),
    max_message_payload_bytes: z.number().int().positive().optional(),
    max_artifact_bytes: z.number().int().positive().optional(),
    max_payload_size_bytes: z.number().int().positive().optional(),
    max_artifact_size_bytes: z.number().int().positive().optional(),
    default_page_size: z.number().int().positive().optional(),
    max_page_size: z.number().int().positive().optional(),
    max_audit_payload_bytes: z.number().int().positive().optional(),
  })
  .refine(
    (data) => {
      if (data.default_page_size && data.max_page_size) {
        return data.default_page_size <= data.max_page_size;
      }
      return true;
    },
    {
      message: "default_page_size cannot be greater than max_page_size",
      path: ["default_page_size"],
    },
  );
export type LimitsConfig = z.infer<typeof LimitsConfigSchema>;
export const DEFAULT_MAX_AUDIT_PAYLOAD_BYTES = 65536; // 64 KB

/**
 * RolePresence tracks agent connectivity and activity freshness.
 * Note: lastSeenAt / lastActiveAt reflects when the role last performed an action (activity freshness),
 * whereas status ("online" | "idle" | "offline") and activityFreshness ("fresh" | "idle" | "stale")
 * provide temporal indicators for collaboration visibility.
 */
export interface RolePresence {
  roleId: string;
  agentId?: string | undefined;
  lastSeenAt?: string | undefined;
  lastActiveAt?: string | undefined;
  connectedAt?: string | undefined;
  status: "online" | "idle" | "offline";
  activityFreshness?: "fresh" | "idle" | "stale" | undefined;
}

export interface IdempotencyRecord {
  key: string;
  roleId: string;
  operation: string;
  requestHash?: string | undefined;
  responseJson: string;
  createdAt: string;
}

export const OrgConfigSchema = z.object({
  company: z.object({ name: z.string().min(1) }),
  roles: z.array(RoleSchema).min(1),
  policies: z.array(InitialPolicySchema).default([]),
  limits: LimitsConfigSchema.optional(),
});
export type OrgConfig = z.infer<typeof OrgConfigSchema>;

export interface MessageRecord {
  messageId: string;
  taskId: string | null;
  fromRole: string;
  toRole: string;
  type: MessageType;
  payload: unknown;
  references: string[];
  inReplyTo: string | null;
  status: MessageStatus;
  riskTags: string[];
  createdAt: string;
  resolvedAt: string | null;
}

export interface TaskRecord {
  taskId: string;
  title: string;
  description: string | null;
  createdBy: string;
  assignedTo: string | null;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export type WorkQueueActionKind =
  | "accept_handoff"
  | "acknowledge_message"
  | "start_task"
  | "continue_task"
  | "resolve_blocker"
  | "send_proposal"
  | "review_task";

export interface WorkQueueAction {
  kind: WorkQueueActionKind;
  priority: number;
  reason: string;
  messageId?: string;
  taskId?: string;
  suggestedTool?: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface RoleWorkQueue {
  roleId: string;
  generatedAt: string;
  summary: {
    unreadMessages: number;
    activeTasks: number;
    blockedTasks: number;
  };
  unreadMessages: MessageRecord[];
  activeTasks: TaskRecord[];
  nextActions: WorkQueueAction[];
  presence?: RolePresence[] | undefined;
}

export interface ArtifactRecord {
  artifactId: string;
  type: string;
  name: string;
  producedBy: string;
  content?: string;
  contentUri?: string;
  contentHash: string;
  visibleToRoles: "all" | string[];
  relatedTaskId: string | null;
  createdAt: string;
}

export interface PolicyRule extends InitialPolicy {
  id: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PendingApproval {
  approvalId: string;
  subject: PolicySubject;
  subjectId: string;
  requestedBy: string;
  status: "pending" | "approved" | "rejected";
  context: unknown;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface PaginationOptions {
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  total?: number | undefined;
}

export interface BrokerLimits {
  maxPayloadSizeBytes?: number | undefined;
  maxArtifactSizeBytes?: number | undefined;
}

export interface PruneOptions {
  olderThanDays: number;
  dryRun?: boolean | undefined;
  deleteArtifacts?: boolean | undefined;
}

export interface PruneResult {
  dryRun: boolean;
  cutoffDate: string;
  tasksCount: number;
  messagesCount: number;
  messageEventsCount: number;
  taskTransitionsCount: number;
  approvalsCount: number;
  artifactsDetachedCount: number;
  artifactsDeletedCount: number;
}

export interface MaintenanceLogRecord {
  id: string;
  action: "prune" | "prune_simulation" | "prune_execution" | "compact";
  details: unknown;
  createdAt: string;
}

export interface AuditExportOptions {
  limit?: number | undefined;
  since?: string | undefined;
  maxPayloadBytes?: number | undefined;
}

export interface AuditSnapshotMetadata {
  generatedAt: string;
  since?: string | undefined;
  limit?: number | undefined;
  maxPayloadBytes?: number | undefined;
  totalTasksAvailable: number;
  totalMessagesAvailable: number;
  totalApprovalsAvailable: number;
  totalArtifactsAvailable: number;
  matchingTasksCount?: number | undefined;
  matchingMessagesCount?: number | undefined;
  matchingApprovalsCount?: number | undefined;
  matchingArtifactsCount?: number | undefined;
  truncated: boolean;
}

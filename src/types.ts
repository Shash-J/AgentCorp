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

export const OrgConfigSchema = z.object({
  company: z.object({ name: z.string().min(1) }),
  roles: z.array(RoleSchema).min(1),
  policies: z.array(InitialPolicySchema).default([]),
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

import type { MessageType, PolicyAction, PolicyRule, TaskStatus } from "./types.js";

export interface MessagePolicyContext {
  subject: "message";
  fromRole: string;
  toRole: string;
  messageType: MessageType;
  riskTags: string[];
}

export interface TaskPolicyContext {
  subject: "task";
  fromRole: string;
  toRole?: string;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  riskTags: string[];
}

export interface PolicyDecision {
  action: PolicyAction;
  matchedRuleId: string | null;
  delegateRole?: string;
}

export function evaluatePolicy(
  rules: PolicyRule[],
  context: MessagePolicyContext | TaskPolicyContext,
): PolicyDecision {
  for (const rule of rules) {
    if (!rule.enabled || rule.subject !== context.subject) continue;
    if (rule.from_role && rule.from_role !== context.fromRole) continue;
    if (rule.to_role && rule.to_role !== context.toRole) continue;
    if (rule.risk_tags?.some((tag) => !context.riskTags.includes(tag))) continue;

    if (context.subject === "message") {
      if (rule.message_type && rule.message_type !== context.messageType) continue;
      if (rule.from_status || rule.to_status) continue;
    } else {
      if (rule.from_status && rule.from_status !== context.fromStatus) continue;
      if (rule.to_status && rule.to_status !== context.toStatus) continue;
      if (rule.message_type) continue;
    }

    return {
      action: rule.action,
      matchedRuleId: rule.id,
      ...(rule.delegate_role ? { delegateRole: rule.delegate_role } : {}),
    };
  }

  return { action: "require_human", matchedRuleId: null };
}

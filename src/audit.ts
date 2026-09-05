import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentCorpBroker } from "./broker.js";
import type {
  ArtifactRecord,
  AuditExportOptions,
  AuditSnapshotMetadata,
  MessageRecord,
  PendingApproval,
  TaskRecord,
} from "./types.js";

export interface AuditSnapshot {
  exportedAt: string;
  company: string;
  metadata: AuditSnapshotMetadata;
  roles: Array<{
    id: string;
    model?: string | undefined;
    capabilities: string[];
    allowedPeers: string[];
    boundAgent?: string | undefined;
  }>;
  tasks: TaskRecord[];
  messages: MessageRecord[];
  approvals: PendingApproval[];
  artifacts: ArtifactRecord[];
}

export function generateAuditSnapshot(
  broker: AgentCorpBroker,
  options: AuditExportOptions = {},
): AuditSnapshot {
  const db = broker.database;
  const boundRoles = new Map(
    db.listAllRoleBindings().map((b) => [b.roleId, b.agentId]),
  );

  const roles = broker.config.roles.map((role) => ({
    id: role.id,
    model: role.model,
    capabilities: role.capabilities,
    allowedPeers: role.allowed_peers,
    boundAgent: boundRoles.get(role.id),
  }));

  const totalTasksAvailable = db.countTasks();
  const totalMessagesAvailable = db.countMessages();
  const totalApprovalsAvailable = db.countApprovals();
  const totalArtifactsAvailable = db.countArtifacts();

  const tasks = db.getAuditTasks(options);
  const messages = db.getAuditMessages(options);
  const approvals = db.getAuditApprovals(options);
  const artifacts = db.getAuditArtifacts(options);

  const truncated = Boolean(options.limit !== undefined && options.limit > 0 && (
    tasks.length < totalTasksAvailable ||
    messages.length < totalMessagesAvailable ||
    approvals.length < totalApprovalsAvailable ||
    artifacts.length < totalArtifactsAvailable
  ));

  const metadata: AuditSnapshotMetadata = {
    generatedAt: new Date().toISOString(),
    ...(options.since ? { since: options.since } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    totalTasksAvailable,
    totalMessagesAvailable,
    totalApprovalsAvailable,
    totalArtifactsAvailable,
    truncated,
  };

  return {
    exportedAt: metadata.generatedAt,
    company: broker.config.company.name,
    metadata,
    roles,
    tasks,
    messages,
    approvals,
    artifacts,
  };
}

export function formatAuditMarkdown(snapshot: AuditSnapshot): string {
  const lines: string[] = [];

  lines.push(`# AgentCorp Audit Log — ${snapshot.company}`);
  lines.push(`\n**Exported At:** \`${snapshot.exportedAt}\``);
  if (snapshot.metadata?.since) {
    lines.push(`**Since:** \`${snapshot.metadata.since}\``);
  }
  if (snapshot.metadata?.limit !== undefined) {
    lines.push(`**Record Limit:** \`${snapshot.metadata.limit}\``);
  }
  lines.push(`**Truncated:** \`${snapshot.metadata?.truncated ? "Yes" : "No"}\`\n`);

  lines.push("## Active Roles & Bindings\n");
  lines.push("| Role ID | Bound Agent | Allowed Peers | Capabilities |");
  lines.push("| --- | --- | --- | --- |");
  for (const role of snapshot.roles) {
    lines.push(
      `| \`${role.id}\` | ${role.boundAgent ? `\`${role.boundAgent}\`` : "*unbound*"} | ${role.allowedPeers.map((p) => `\`${p}\``).join(", ") || "*none*"} | ${role.capabilities.join(", ") || "*none*"} |`,
    );
  }
  lines.push("");

  lines.push("## Tasks & Lifecycle\n");
  if (snapshot.tasks.length === 0) {
    lines.push("*No tasks recorded.* \n");
  } else {
    for (const task of snapshot.tasks) {
      lines.push(`### Task: ${task.title} (\`${task.taskId}\`)`);
      lines.push(`- **Status:** \`${task.status}\``);
      lines.push(`- **Created By:** \`${task.createdBy}\` | **Assigned To:** \`${task.assignedTo ?? "unassigned"}\``);
      lines.push(`- **Created At:** ${task.createdAt} | **Updated At:** ${task.updatedAt}`);
      if (task.description) {
        lines.push(`- **Description:** ${task.description}`);
      }

      const taskMessages = snapshot.messages.filter((m) => m.taskId === task.taskId);
      if (taskMessages.length > 0) {
        lines.push("\n**Message Thread:**\n");
        lines.push("| Time | From → To | Type | Status | Payload / Summary |");
        lines.push("| --- | --- | --- | --- | --- |");
        for (const msg of taskMessages) {
          const payloadStr = typeof msg.payload === "string"
            ? msg.payload
            : JSON.stringify(msg.payload);
          const sanitizedPayload = payloadStr.replace(/\|/g, "\\|").replace(/\n/g, " ");
          lines.push(
            `| ${msg.createdAt} | \`${msg.fromRole}\` → \`${msg.toRole}\` | \`${msg.type}\` | \`${msg.status}\` | ${sanitizedPayload} |`,
          );
        }
      }
      lines.push("");
    }
  }

  const outOfBandMessages = snapshot.messages.filter((m) => !m.taskId);
  if (outOfBandMessages.length > 0) {
    lines.push("## Direct / Out-of-Band Messages\n");
    lines.push("| Time | From → To | Type | Status | Payload |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const msg of outOfBandMessages) {
      const payloadStr = typeof msg.payload === "string"
        ? msg.payload
        : JSON.stringify(msg.payload);
      lines.push(
        `| ${msg.createdAt} | \`${msg.fromRole}\` → \`${msg.toRole}\` | \`${msg.type}\` | \`${msg.status}\` | ${payloadStr} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Approvals\n");
  if (snapshot.approvals.length === 0) {
    lines.push("*No approvals recorded.* \n");
  } else {
    lines.push("| Approval ID | Subject | Subject ID | Requested By | Status | Decided At | Note |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const app of snapshot.approvals) {
      lines.push(
        `| \`${app.approvalId}\` | \`${app.subject}\` | \`${app.subjectId}\` | \`${app.requestedBy}\` | \`${app.status}\` | ${app.decidedAt ?? "*pending*"} | ${app.decisionNote ?? "-"} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Artifacts Catalog\n");
  if (snapshot.artifacts.length === 0) {
    lines.push("*No artifacts recorded.* \n");
  } else {
    lines.push("| Artifact ID | Name | Type | Produced By | Visibility | Hash |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const art of snapshot.artifacts) {
      const vis = art.visibleToRoles === "all" ? "all" : art.visibleToRoles.join(", ");
      lines.push(
        `| \`${art.artifactId}\` | ${art.name} | \`${art.type}\` | \`${art.producedBy}\` | \`${vis}\` | \`${art.contentHash.slice(0, 12)}...\` |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function exportAuditTrail(
  broker: AgentCorpBroker,
  outputDir = "coord",
  options: AuditExportOptions = {},
): { markdownPath: string; jsonPath: string; snapshot: AuditSnapshot } {
  const absoluteDir = resolve(outputDir);
  mkdirSync(absoluteDir, { recursive: true });

  const snapshot = generateAuditSnapshot(broker, options);
  const markdown = formatAuditMarkdown(snapshot);

  const markdownPath = resolve(absoluteDir, "audit.md");
  const jsonPath = resolve(absoluteDir, "audit.json");

  writeFileSync(markdownPath, markdown, "utf8");
  writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), "utf8");

  return { markdownPath, jsonPath, snapshot };
}

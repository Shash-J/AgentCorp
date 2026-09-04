import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { AgentCorpBroker } from "./broker.js";
import { AgentCorpError } from "./errors.js";
import { MessageTypeSchema, TaskStatusSchema } from "./types.js";

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function failure(error: unknown) {
  const known = error instanceof AgentCorpError;
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: JSON.stringify({ error: known ? error.code : "INTERNAL_ERROR", message }),
    }],
  };
}

function guarded<T>(operation: () => T) {
  try {
    return result(operation());
  } catch (error) {
    return failure(error);
  }
}

export function createMcpServer(
  broker: AgentCorpBroker,
  callerRole: string,
  agentId: string,
): McpServer {
  const role = broker.getRole(callerRole);
  const server = new McpServer({ name: "agentcorp", version: "0.1.0" });

  server.registerTool(
    "register_role",
    {
      title: "Register this agent connection",
      description: "Bind this role-scoped MCP connection to an agent instance. Capabilities may only be reduced, never escalated.",
      inputSchema: z.object({
        capabilities: z.array(z.string()).optional(),
      }),
    },
    ({ capabilities }) => guarded(() => broker.registerRole(
      callerRole,
      agentId,
      capabilities ?? role.capabilities,
    )),
  );

  server.registerTool(
    "whoami",
    {
      title: "Inspect the bound AgentCorp role",
      description: "Return the immutable role identity and permissions for this MCP connection.",
      inputSchema: z.object({}),
    },
    () => guarded(() => ({ role, agentId, company: broker.config.company.name })),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create a coordinated task",
      description: "Create a task, optionally assigning it to an allowed peer role.",
      inputSchema: z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        assigned_to: z.string().optional(),
      }),
    },
    (input) => guarded(() => broker.createTask(callerRole, {
      title: input.title,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.assigned_to === undefined ? {} : { assignedTo: input.assigned_to }),
    })),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List visible tasks",
      description: "List tasks in which the bound role participates.",
      inputSchema: z.object({}),
    },
    () => guarded(() => broker.listTasks(callerRole)),
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a typed agent message",
      description: "Submit a typed message through route validation and the approval policy engine.",
      inputSchema: z.object({
        to_role: z.string().min(1),
        type: MessageTypeSchema,
        payload: z.unknown(),
        task_id: z.string().optional(),
        references: z.array(z.string()).default([]),
        risk_tags: z.array(z.string()).default([]),
        in_reply_to: z.string().optional(),
      }),
    },
    (input) => guarded(() => broker.sendMessage(callerRole, {
      toRole: input.to_role,
      type: input.type,
      payload: input.payload,
      references: input.references,
      riskTags: input.risk_tags,
      ...(input.task_id === undefined ? {} : { taskId: input.task_id }),
      ...(input.in_reply_to === undefined ? {} : { inReplyTo: input.in_reply_to }),
    })),
  );

  server.registerTool(
    "get_inbox",
    {
      title: "Read delivered messages",
      description: "Return only approved or delivered messages addressed to the bound role.",
      inputSchema: z.object({}),
    },
    () => guarded(() => broker.getInbox(callerRole)),
  );

  server.registerTool(
    "acknowledge_message",
    {
      title: "Acknowledge a message",
      description: "Mark a delivered message as acknowledged by its recipient.",
      inputSchema: z.object({ message_id: z.string().min(1) }),
    },
    ({ message_id }) => guarded(() => broker.acknowledgeMessage(callerRole, message_id)),
  );

  server.registerTool(
    "get_thread",
    {
      title: "Read a task thread",
      description: "Return the task message history visible to the bound role.",
      inputSchema: z.object({ task_id: z.string().min(1) }),
    },
    ({ task_id }) => guarded(() => broker.getThread(callerRole, task_id)),
  );

  server.registerTool(
    "create_artifact",
    {
      title: "Create an access-controlled artifact",
      description: "Store content or a content URI with role-scoped visibility.",
      inputSchema: z.object({
        type: z.string().min(1),
        name: z.string().min(1),
        content: z.string().optional(),
        content_uri: z.string().optional(),
        visible_to_roles: z.union([z.literal("all"), z.array(z.string())]).optional(),
        related_task_id: z.string().optional(),
      }),
    },
    (input) => guarded(() => broker.createArtifact(callerRole, {
      type: input.type,
      name: input.name,
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.content_uri === undefined ? {} : { contentUri: input.content_uri }),
      ...(input.visible_to_roles === undefined ? {} : { visibleToRoles: input.visible_to_roles }),
      ...(input.related_task_id === undefined ? {} : { relatedTaskId: input.related_task_id }),
    })),
  );

  server.registerTool(
    "list_artifacts",
    {
      title: "List visible artifacts",
      description: "List artifact metadata after applying the bound role's visibility rules.",
      inputSchema: z.object({ task_id: z.string().optional() }),
    },
    ({ task_id }) => guarded(() => broker.listArtifacts(callerRole, task_id)),
  );

  server.registerTool(
    "get_artifact",
    {
      title: "Read a visible artifact",
      description: "Retrieve artifact content after a server-side role visibility check.",
      inputSchema: z.object({ artifact_id: z.string().min(1) }),
    },
    ({ artifact_id }) => guarded(() => broker.getArtifact(callerRole, artifact_id)),
  );

  server.registerTool(
    "update_task_status",
    {
      title: "Request a task state transition",
      description: "Validate a lifecycle transition and route it through the approval policy engine.",
      inputSchema: z.object({
        task_id: z.string().min(1),
        new_status: TaskStatusSchema,
        risk_tags: z.array(z.string()).default([]),
      }),
    },
    ({ task_id, new_status, risk_tags }) => guarded(() =>
      broker.updateTaskStatus(callerRole, task_id, new_status, risk_tags)),
  );

  return server;
}

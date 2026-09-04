# MCP Tools Reference

AgentCorp exposes 14 coordination tools over the Model Context Protocol (MCP). Every tool call executes within the authenticated role context of the connection, meaning caller identity (`fromRole`, `producedBy`, `callerRole`) is enforced server-side and cannot be spoofed.

---

## 1. Identity & Registration

### `whoami`
Inspect the bound AgentCorp role and connection identity.

* **Inputs**: None (`{}`)
* **Returns**:
  ```json
  {
    "role": {
      "id": "developer",
      "display_name": "Developer",
      "model": "any/mcp-capable-agent",
      "interface": "mcp",
      "capabilities": ["write_code", "run_tests", "report"],
      "allowed_peers": ["architect"],
      "artifact_visibility": ["architect", "developer"]
    },
    "agentId": "developer-daemon",
    "company": "My Agent Company"
  }
  ```

### `register_role`
Optionally bind this role-scoped MCP connection to an agent instance with restricted capabilities. Capabilities may only be reduced, never escalated beyond `org.toml`.

* **Inputs**:
  * `capabilities` *(array of strings, optional)*: Subscribed capability subset.
* **Returns**: Updated role definition record.

---

## 2. Task Management

### `create_task`
Creates a new coordinated task in the broker.

* **Inputs**:
  * `title` *(string, required)*: Brief summary of the task.
  * `description` *(string, optional)*: Detailed task requirements, constraints, or acceptance criteria.
  * `assigned_to` *(string, optional)*: Intended assignee role (must be an allowed peer). The task remains `proposed` and hidden from that role until a linked proposal is approved.
* **Returns**:
  ```json
  {
    "taskId": "tsk_01h8x...",
    "title": "Implement auth header hardening",
    "description": "Enforce Bearer authorization headers and remove query params",
    "createdBy": "architect",
    "assignedTo": "developer",
    "status": "proposed",
    "createdAt": "2026-09-05T00:00:00.000Z",
    "updatedAt": "2026-09-05T00:00:00.000Z"
  }
  ```

### `list_tasks`
Lists all visible tasks where the caller's role participates. A proposed task is not visible to its intended assignee until an approved proposal activates the assignment.

* **Inputs**: None (`{}`)
* **Returns**: Array of `TaskRecord` objects.

### `get_work_queue`
Returns the bound role's complete actionable coordination state in one call.

* **Inputs**: None (`{}`)
* **Returns**: Unread delivered messages, non-terminal visible tasks, summary counts, and prioritized `nextActions`. When an action can be performed directly, `suggestedTool` contains the exact MCP tool name and arguments.
* **Recommended use**: Call at session start and after every handoff or task-status change instead of separately reconciling the inbox, task list, and threads.

### `update_task_status`
Transitions a task through its validated lifecycle state graph (`proposed` → `assigned` → `in_progress` → `blocked` / `awaiting_review` → `completed` / `failed` / `cancelled`).

* **Inputs**:
  * `task_id` *(string, required)*: Task ID to transition.
  * `new_status` *(string, required)*: Target status (`proposed`, `assigned`, `in_progress`, `blocked`, `awaiting_review`, `completed`, `failed`, `cancelled`).
  * `risk_tags` *(array of strings, optional)*: Caller-declared risk tags (e.g. `["read_only"]`).
* **Returns**: Updated `TaskRecord`. If the transition is gated by policy (such as `gate-task-completion`), the transition enters `pending_approval` until approved by a human operator.

---

## 3. Inter-Agent Messaging

### `send_message`
Submits a typed message through recipient validation and the policy engine.

* **Inputs**:
  * `to_role` *(string, required)*: Recipient role ID (must be in sender's `allowed_peers`).
  * `type` *(string, required)*: Message type:
    * `"proposal"`: Formal plan or change proposal (**strictly held for human approval**).
    * `"question"`: Inquiry to peer agent.
    * `"answer"`: Response to inquiry.
    * `"report"`: Structured execution report.
    * `"review"`: Architectural or code review.
    * `"verdict"`: Formal review verdict (`go`, `no_go`, `changes_requested`).
    * `"status_update"`: Execution milestone update.
  * `payload` *(unknown / JSON object, required)*: Structured message payload.
  * `task_id` *(string, optional)*: Associated task ID.
  * `references` *(array of strings, optional)*: Referenced artifact IDs or URIs.
  * `risk_tags` *(array of strings, optional)*: Tags indicating risk category (e.g. `["read_only"]`).
  * `in_reply_to` *(string, optional)*: ID of the message being answered.
* **Returns**:
  ```json
  {
    "messageId": "msg_9f2a...",
    "taskId": "tsk_01h8x...",
    "fromRole": "architect",
    "toRole": "developer",
    "type": "proposal",
    "payload": { "spec": "0.1.0-alpha.1" },
    "references": ["art_123..."],
    "inReplyTo": null,
    "status": "pending_approval",
    "riskTags": ["read_only"],
    "createdAt": "2026-09-05T00:00:00.000Z",
    "resolvedAt": null
  }
  ```

### `get_inbox`
Retrieves delivered and approved messages addressed to the bound role. Messages held in `pending_approval` are not visible to the recipient until approved.

* **Inputs**: None (`{}`)
* **Returns**: Array of unread `MessageRecord` objects with `status: "delivered"` or `"approved"`. Acknowledged messages remain in task history but leave the inbox.

### `acknowledge_message`
Marks a delivered message as acknowledged by its recipient.

* **Inputs**:
  * `message_id` *(string, required)*: Message ID to acknowledge.
* **Returns**: Updated `MessageRecord` with `status: "acknowledged"`.

Acknowledgement is idempotent: retrying an already acknowledged message returns its current record.

### `accept_handoff`
Accepts an approved task proposal using one idempotent coordination operation.

* **Inputs**:
  * `message_id` *(string, required)*: Delivered proposal message linked to a task assigned to the caller.
* **Behavior**: Acknowledges the proposal and requests the linked task's `in_progress` transition. If that transition requires human approval, retries reuse the existing pending transition rather than creating duplicate approvals.
* **Returns**: The acknowledged message, current task, and `pendingApproval` flag.

### `get_thread`
Retrieves the complete message history for a given task visible to the caller's role.

* **Inputs**:
  * `task_id` *(string, required)*: Associated task ID.
* **Returns**: Ordered chronological array of `MessageRecord` objects.

---

## 4. Artifact Management

### `create_artifact`
Publishes an immutable, SHA-256 content-addressed artifact with role-based visibility.

* **Inputs**:
  * `type` *(string, required)*: Artifact type (`spec`, `review`, `resolution`, `code_diff`, `report`).
  * `name` *(string, required)*: Human-readable display filename.
  * `content` *(string, optional)*: Inline text content (markdown, JSON, code).
  * `content_uri` *(string, optional)*: External storage reference (e.g. `file://...` or `s3://...`).
  * `visible_to_roles` *(array of strings or "all", optional)*: Permitted roles. Defaults to role's `artifact_visibility`.
  * `related_task_id` *(string, optional)*: Task ID to associate with this artifact.
* **Returns**:
  ```json
  {
    "artifactId": "art_800eb174...",
    "type": "review",
    "name": "agentcorp-architect-release-verdict.md",
    "producedBy": "architect",
    "contentHash": "977b4f5325a4c5885de41f...",
    "visibleToRoles": ["architect", "developer"],
    "relatedTaskId": "tsk_01h8x...",
    "createdAt": "2026-09-05T00:00:00.000Z"
  }
  ```

### `list_artifacts`
Lists artifact metadata visible to the caller's role. Content is omitted from list results for performance.

* **Inputs**:
  * `task_id` *(string, optional)*: Filter by associated task ID.
* **Returns**: Array of `ArtifactRecord` metadata objects.

### `get_artifact`
Fetches complete artifact content and metadata after verifying that the caller's role is in the artifact's allowed visibility list.

* **Inputs**:
  * `artifact_id` *(string, required)*: Artifact ID to retrieve.
* **Returns**: Complete `ArtifactRecord` including `content` or `contentUri`.

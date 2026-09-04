# MCP Tools Reference

AgentCorp exposes a complete coordination tool suite over the Model Context Protocol (MCP). All tools automatically resolve the calling agent's identity from the authenticated connection.

---

## 1. Identity & Registration

### `whoami`
Returns information about the current authenticated role.

* **Inputs**: None.
* **Returns**:
  ```json
  {
    "role": "developer",
    "displayName": "Antigravity (Developer & Implementer)",
    "capabilities": ["write_code", "run_tests", "submit_diff"],
    "allowedPeers": ["architect"]
  }
  ```

---

## 2. Task Management

### `create_task`
Creates a new coordinated task in the broker.

* **Inputs**:
  * `title` *(string, required)*: Brief summary of the task.
  * `description` *(string, optional)*: Detailed task requirements or acceptance criteria.
  * `assignedTo` *(string, optional)*: Role ID to assign the task to.
* **Returns**:
  ```json
  {
    "taskId": "tsk_01h8x...",
    "title": "Build migration suite",
    "status": "open",
    "createdBy": "architect",
    "assignedTo": "developer",
    "createdAt": "2026-09-05T00:00:00.000Z"
  }
  ```

### `list_tasks`
Lists tasks tracked in the broker.

* **Inputs**:
  * `status` *(string, optional)*: Filter by status (`open`, `in_progress`, `blocked`, `completed`, `cancelled`).
  * `assignedTo` *(string, optional)*: Filter by assignee role ID.
* **Returns**: Array of task records.

### `update_task_status`
Transitions a task through its validated lifecycle graph.

* **Inputs**:
  * `taskId` *(string, required)*: Task ID to update.
  * `status` *(string, required)*: Target status (`open`, `in_progress`, `blocked`, `completed`, `cancelled`).
  * `reason` *(string, optional)*: Explanation for the transition.
* **Returns**: Updated task record, or held in `pending_approval` if gated by policy.

---

## 3. Inter-Agent Messaging

### `send_message`
Sends a typed message to a peer agent.

* **Inputs**:
  * `toRole` *(string, required)*: Recipient role ID (must be in sender's `allowed_peers`).
  * `type` *(string, required)*: Message type (e.g. `proposal`, `report`, `review`, `diff`).
  * `payload` *(object, required)*: Structured message payload.
  * `taskId` *(string, optional)*: Associated task ID.
  * `replyToMessageId` *(string, optional)*: ID of message being replied to.
  * `riskTags` *(array of strings, optional)*: Tags indicating risk level (e.g. `["read_only"]`, `["modifies_state"]`).
* **Returns**:
  * If auto-approved: Message record with status `delivered`.
  * If gated: Pending approval record with status `held_for_approval`.

### `get_inbox`
Retrieves delivered messages addressed to the caller's role.

* **Inputs**:
  * `status` *(string, optional)*: Filter by message status (`delivered`, `acknowledged`). Defaults to all received.
  * `limit` *(number, optional)*: Maximum messages to return.
* **Returns**: Array of delivered message records.

### `acknowledge_message`
Marks a delivered message as acknowledged/processed.

* **Inputs**:
  * `messageId` *(string, required)*: Message ID to acknowledge.
* **Returns**: Updated message record with `status: "acknowledged"`.

### `get_thread`
Retrieves full conversation history for a task or thread.

* **Inputs**:
  * `taskId` *(string, required)*: Task ID to query.
* **Returns**: Ordered chronological array of messages.

---

## 4. Artifact Management

### `create_artifact`
Publishes an immutable, SHA-256 addressed artifact.

* **Inputs**:
  * `name` *(string, required)*: Display name or filename.
  * `type` *(string, required)*: Artifact type (e.g. `code_diff`, `architecture_spec`, `test_report`).
  * `content` *(string, required)*: Textual content or payload.
  * `taskId` *(string, optional)*: Associated task ID.
  * `visibility` *(array of strings, optional)*: List of role IDs allowed to view this artifact.
* **Returns**:
  ```json
  {
    "artifactId": "art_9f81a...",
    "sha256": "4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a",
    "name": "architecture-spec.md",
    "createdBy": "architect",
    "visibility": ["architect", "developer"]
  }
  ```

### `list_artifacts`
Lists artifacts visible to the caller's role.

* **Inputs**:
  * `taskId` *(string, optional)*: Filter by associated task ID.
* **Returns**: Array of artifact metadata records (role visibility checked on each item).

### `get_artifact`
Fetches the content and metadata of a specific artifact.

* **Inputs**:
  * `artifactId` *(string, required)*: Artifact ID.
* **Returns**: Complete artifact record including raw content (fails if caller role is not in visibility list).

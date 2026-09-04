# AgentCorp

AgentCorp is a local-first coordination broker for teams of AI agents. It gives
MCP-capable agents stable roles, typed messages, durable tasks, approval gates,
and access-controlled artifacts without coupling the agents to one vendor or
model.

> Status: **developer preview (0.1.0-alpha.1)**.
> Central long-lived broker daemon, terminal-native human console & review loop,
> real-time SSE event pipeline with 15s keep-alive heartbeat, dark glassmorphic web dashboard, and audit exports.

![AgentCorp Architecture Blueprint](./docs/images/architecture.jpg)

## What works today

- Long-lived broker daemon over MCP Streamable HTTP, Admin REST API, and Server-Sent Events (`/api/events`)
- Terminal-native human console (`agentcorp console`) and interactive review loop (`agentcorp review`)
- Sleek dark glassmorphic web dashboard with live push updates and side-by-side JSON diff editor
- Thin role-bound stdio adapters proxying to the central daemon
- Role definitions and allowed communication paths loaded from `org.toml`
- Per-role and admin credentials stored securely in `.agentcorp/credentials.json`
- Role-bound MCP connections with connection-enforced caller identity
- Typed messages with durable status history
- Approval-bound task handoffs: intended assignees cannot see or start proposed work before approval
- Prioritized per-role work queues with executable next-action suggestions
- Idempotent handoff acceptance that acknowledges and starts approved work in one call
- Safe-by-default approval policy evaluation
- Human approve, edit-and-approve, and reject commands with full audit logging
- Validated task lifecycle transitions
- SHA-256-addressed artifact metadata with role-scoped read checks
- Transactional SQLite persistence with versioned schema migrations
- Automated human-readable Markdown and JSON audit trail exports (`coord/`)
- Public TypeScript API plus the `agentcorp` CLI

## Requirements

- Node.js 22.13 or newer

AgentCorp uses Node's built-in `node:sqlite` module to avoid native npm
dependencies. On Node 22 it may print an experimental-feature warning; it does
not require an experimental flag from 22.13 onward.

## Quick start

Until the first npm release, run the CLI from this repository:

```sh
npm install
npm run build
node dist/cli.js init
node dist/cli.js validate
node dist/cli.js start
```

After publication:

```sh
npm install --global agentcorp-broker
agentcorp init
agentcorp validate
agentcorp start
```

`agentcorp init` creates an architect/developer organization with conservative
approval defaults and generates local credentials under `.agentcorp/credentials.json`.
Runtime state under `.agentcorp/` should not be committed.

## Connect agents over MCP

Each local MCP connection is bound to exactly one configured role. Use absolute
paths for `--config` and `--db` when your MCP host does not preserve the project
working directory.

```json
{
  "mcpServers": {
    "agentcorp-architect": {
      "command": "agentcorp",
      "args": [
        "--config", "/absolute/project/org.toml",
        "--db", "/absolute/project/.agentcorp/agentcorp.db",
        "mcp", "--role", "architect"
      ]
    }
  }
}
```

Configure the second agent with the same config and database paths, changing
only the final role to `developer`.

The MCP tool surface includes:

- `register_role`, `whoami`
- `create_task`, `list_tasks`, `get_work_queue`, `update_task_status`
- `send_message`, `get_inbox`, `acknowledge_message`, `accept_handoff`, `get_thread`
- `create_artifact`, `list_artifacts`, `get_artifact`

## Efficient agent loop

Use `get_work_queue` as the first AgentCorp call in every agent session and
again after each handoff or status change. It combines unread messages, active
tasks, and prioritized next actions so an agent does not need to independently
reconcile `get_inbox`, `list_tasks`, and task threads.

For a gated task handoff:

1. The planner creates the task with an intended `assigned_to` and sends a
   linked `proposal`.
2. Until that proposal is approved, the task remains `proposed` and is hidden
   from the intended assignee.
3. Approval atomically activates the task as `assigned` and exposes the
   proposal in the assignee's work queue.
4. The assignee calls `accept_handoff` once. AgentCorp acknowledges the proposal
   and requests the `in_progress` transition without creating duplicates on
   retries.

MCP servers expose tools; they cannot independently wake an idle model inside
an IDE. Configure each agent's standing instructions to call `get_work_queue`
at session start. Background wake-up requires a host-specific runner or
notification adapter and is not claimed by this preview.

## Human approval console

AgentCorp offers first-class human-in-the-loop oversight designed for terminal-first developer workflows with an optional live web dashboard.

### 1. Terminal-Native Interaction (Preferred)

Launch the status summary or dive straight into interactive sign-off:

```sh
# View daemon status, task counts, and pending approvals
agentcorp console

# Interactive sign-off loop ([a]pprove, [e]dit & approve, [r]eject, [s]kip, [q]uit)
agentcorp review
```

### 2. Live Web Dashboard

Open the modern dark glassmorphic dashboard with live push updates over Server-Sent Events (`/api/events`):

```sh
agentcorp console --browser
```

Features include:
- Real-time approval feed with side-by-side JSON diff editor
- Role inboxes & active task threads
- Artifact catalog viewer
- Runtime policy inspector and instant toggle switch (enable / disable)

### 3. Direct Scriptable CLI Commands

Messages and transitions that do not match an `auto_approve` rule are held by default.

```sh
agentcorp approvals list
agentcorp approvals approve <approval-id> --note "Reviewed"
agentcorp approvals approve <approval-id> --payload '{"revised":"payload"}'
agentcorp approvals reject <approval-id> --note "Needs a safer plan"
agentcorp policies list
agentcorp policies set '{"id":"safe-reports","subject":"message","priority":80,"message_type":"report","risk_tags":["read_only"],"action":"auto_approve"}'
agentcorp policies disable safe-reports
```

The recipient cannot see a pending message. Approval changes its state to
`delivered`; rejection keeps it out of the inbox.

## Storage lifecycle and bounding

AgentCorp enforces bounded memory and disk usage to protect long-running daemons from denial of service and memory exhaustion:

- **Size limits**:
  - HTTP body: 2 MB maximum (returns HTTP 413 `PAYLOAD_TOO_LARGE`).
  - Message payload: 1 MB maximum (`PAYLOAD_TOO_LARGE`).
  - Artifact content: 5 MB maximum (`ARTIFACT_TOO_LARGE`).
- **Cursor pagination**:
  - Task, message, inbox, and artifact queries are bounded to 50 items by default (max 200).
  - MCP tools and Admin REST endpoints support `limit` and opaque `cursor` pagination with optional `envelope` payloads and `X-Next-Cursor` headers.
- **History pruning and WAL compaction**:
  ```sh
  # Dry-run simulate pruning resolved tasks and messages older than 30 days
  agentcorp prune --older-than 30 --dry-run

  # Execute pruning and compact SQLite database
  agentcorp prune --older-than 30 --compact

  # Manually checkpoint WAL and vacuum freed pages
  agentcorp compact
  ```
- **Bounded audit export**:
  ```sh
  # Export the 100 most recent records or only records since a timestamp
  agentcorp audit export --limit 100 --since 2026-09-01T00:00:00Z
  ```

## Policy semantics

Policies are initially seeded from `org.toml` into SQLite. After the first run,
the database is the source of truth. Rules are evaluated by descending
`priority`; every populated condition on a rule must match. Risk tags use
subset matching: all tags named by the rule must be present on the request.

If no rule matches, AgentCorp requires human approval. The reserved
`delegate_to_role` action is rejected in v0 rather than silently weakened.

## Development

```sh
npm run check
npm test
npm run build
npm pack --dry-run
```

The main design document is [AgentCorp_Design_Spec.md](./AgentCorp_Design_Spec.md).
The delivery sequence and design gaps are tracked in
[docs/ROADMAP.md](./docs/ROADMAP.md).

## Security model

AgentCorp 0.1.0-alpha.1 enforces caller identity, communication routing, policy gating, and artifact access control through its central authenticated daemon over MCP Streamable HTTP and role-bound stdio adapters using header-only bearer tokens.

As a local developer preview, AgentCorp does not sandbox an underlying agent's general shell or filesystem access. Keep `.agentcorp/credentials.json`, `.agentcorp/agentcorp.db`, and the administrative CLI unavailable to untrusted processes. Role capabilities are currently descriptive metadata, and host-agent capability sandboxing is scheduled for Milestone 4.

See [SECURITY.md](./SECURITY.md) for reporting and deployment guidance.

## License

Apache-2.0. See [LICENSE](./LICENSE).

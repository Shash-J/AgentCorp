# AgentCorp 🏢
> **Local-first coordination broker for teams of AI agents with human-in-the-loop oversight.**

[![npm version](https://img.shields.io/npm/v/agentcorp-broker?color=cb3837&label=npm)](https://www.npmjs.com/package/agentcorp-broker)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node.js: >=22.13.0](https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen.svg)](https://nodejs.org/)

AgentCorp gives MCP-capable AI assistants (such as Claude, Cursor, Codex, or Gemini) stable roles, typed messages, durable tasks, and human approval gates—storing coordination state locally in SQLite without coupling agents to a single model or vendor.

---

### ✨ Why AgentCorp?
- **Multi-Agent Collaboration**: Have an "Architect" agent design features while a "Developer" agent implements the code.
- **Human in the Loop**: Policy-matched coordination messages, task proposals, and handoffs pause for human sign-off in a terminal review or local web dashboard.
- **Local-First Coordination**: Built on Node.js and SQLite. AgentCorp's broker, message logs, credentials, and artifact metadata reside locally on your machine, eliminating third-party coordination servers.
- **MCP Integration**: Can be configured with MCP-capable agent environments, with tested and documented setups for Claude Desktop, Cursor, and Codex.

---

![AgentCorp Architecture Blueprint](./docs/images/architecture.jpg)

---

### ⚡ Quick Start: Start the Local Broker

#### 1. Install Globally (Node.js >= 22.13 required)
```bash
npm install --global agentcorp-broker@alpha
```
*(Or run without installing: `npx agentcorp-broker@alpha init`)*

> **Note**: While AgentCorp is in developer preview, specifying the `@alpha` tag explicitly targets the preview stream.

#### 2. Initialize and Start the Broker Daemon
Open a terminal in any codebase where you want agents to coordinate:
```bash
cd /path/to/your-project
agentcorp init
agentcorp validate
agentcorp start --daemon
```
`agentcorp init` automatically creates:
- `org.toml`: Defines your agent roles (e.g. `architect` and `developer`) and approval rules.
- `.agentcorp/`: Local private SQLite database and credentials.

Starting with `--daemon` runs the broker in the background so your terminal remains free.

#### 3. Oversee and Approve Actions
```bash
# Launch the live web dashboard in your browser:
agentcorp console --browser

# Or review pending agent approvals directly in your terminal:
agentcorp review
```

To connect your AI agents (e.g., Claude or Cursor) to the running broker, see [Connect agents over MCP](#connect-agents-over-mcp) below.

---

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

## Installation & Setup

New to Node.js, terminals, or MCP? Check out our complete [beginner setup guide](./docs/getting-started.md).

### Install via npm (Recommended)
```sh
npm install --global agentcorp-broker@alpha
```
Confirm the installation:
```sh
agentcorp --version
```
> The `@alpha` tag targets the developer preview stream during early releases.

### Or run from source for local development
```sh
git clone https://github.com/Shash-J/AgentCorp.git
cd AgentCorp
npm install
npm run build
```

## Connect agents over MCP

Each local MCP connection is bound to exactly one configured role. When your
MCP host does not preserve the project working directory, pass an absolute path
to `--config`. AgentCorp automatically derives project-scoped `--db`, `--credentials`,
and daemon control paths relative to the config file (or you can provide explicit overrides):

```json
{
  "mcpServers": {
    "agentcorp-architect": {
      "command": "agentcorp",
      "args": [
        "--config", "/absolute/project/org.toml",
        "mcp", "--role", "architect"
      ]
    }
  }
}
```

Configure the second agent with the same config path, changing only the final
role to `developer`. You may also explicitly provide `--db /absolute/project/.agentcorp/agentcorp.db`
if using a custom database location.

The MCP tool surface includes 15 tools:

- `register_role`, `whoami`
- `create_task`, `list_tasks`, `get_work_queue`, `update_task_status`
- `send_message`, `get_inbox`, `acknowledge_message`, `accept_handoff`, `get_thread`
- `create_artifact`, `list_artifacts`, `get_artifact`
- `get_operation`

## Efficient agent loop

Use `get_work_queue` as the first AgentCorp call in every agent session and
again after each handoff or status change. It combines unread messages, active
tasks, live role presence, and prioritized next actions so an agent does not need
to independently reconcile `get_inbox`, `list_tasks`, and task threads.

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

> [!IMPORTANT]
> **LLM Wake Limitations & Handoff Best Practices**:
> - **Passive MCP Protocol**: MCP servers expose tools over standard JSON-RPC; they **cannot independently wake an idle LLM** inside an external host (Antigravity, Codex, Cursor, Claude Desktop). Standing agent instructions must invoke `get_work_queue` at session start.
> - **Lightweight ID / Summary Handoffs**: When agents coordinate or hand off work, always pass concise IDs and brief summaries (e.g., `taskId`, `messageId`, summary of diffs/artifacts) rather than dumping whole codebase contexts or large files into prompt memory. Artifacts should be retrieved on demand with `get_artifact`.

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
- Role presence indicators (online, idle, offline) and connection health
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
  - Audit payload budget: Operator-configurable (`max_audit_payload_bytes`, defaults to 64 KB).
- **Cursor pagination**:
  - Task, message, inbox, and artifact queries are bounded to 50 items by default (max 200).
  - MCP tools and Admin REST endpoints support `limit` and opaque `cursor` pagination with optional `envelope` payloads and `X-Next-Cursor` headers.
- **History pruning and WAL compaction**:
  ```sh
  # Dry-run simulate pruning resolved tasks and messages older than 30 days
  agentcorp prune --older-than 30

  # Execute pruning and compact SQLite database
  agentcorp prune --older-than 30 --execute --compact

  # Manually checkpoint WAL and vacuum freed pages
  agentcorp compact
  ```
- **Bounded audit export**:
  ```sh
  # Export the 100 most recent records or only records since a timestamp
  agentcorp audit export --limit 100 --since 2026-09-01T00:00:00Z
  ```

## Self-healing, observability, and idempotency

AgentCorp includes enterprise-grade operational safeguards to guarantee durable multi-agent sessions:

- **Resilient Stdio MCP Proxy**: When running inside an IDE via stdio (`agentcorp mcp --role developer`), the proxy wraps connections with auto-reconnection and bounded exponential backoff. If the central daemon process crashes or restarts, running agent sessions transparently recover without transport exceptions.
- **Mutation Idempotency & Operation Lookup**: Mutations (`create_task`, `send_message`, `create_artifact`, `accept_handoff`, `update_task_status`) accept an optional `idempotency_key`. Replays return the exact recorded response without duplicate side effects. Agents can query cached outcomes at any time using `get_operation`.
- **Role Presence & Last-Seen Telemetry**: Every authenticated agent interaction touches role presence. `get_work_queue`, `/health`, `/api/status`, and the Web Console report real-time statuses (`online` <1m, `idle` 1–5m, `offline` >5m).
- **Bounded Rotating Daemon Logs & Crash Diagnostics**: Daemon events are written to `.agentcorp/daemon.log` with size-bounded rotation (5 MB with 3 backups). Uncaught exceptions record complete diagnostic forensics into `.agentcorp/crash.log`.
- **System Doctor**: Run `agentcorp doctor` at any time to verify configuration validity, database integrity (`PRAGMA integrity_check`), credential coverage, daemon status, and log health.

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

The main design document is [docs/design-spec.md](./docs/design-spec.md).
The delivery sequence and design gaps are tracked in
[docs/ROADMAP.md](./docs/ROADMAP.md).
Maintainers should follow the [release guide](./docs/RELEASING.md); do not
publish directly from an unverified working tree.

## Security model

AgentCorp 0.1.0-alpha.1 enforces caller identity, communication routing, policy gating, and artifact access control through its central authenticated daemon over MCP Streamable HTTP and role-bound stdio adapters using header-only bearer tokens.

As a local developer preview, AgentCorp does not sandbox an underlying agent's general shell or filesystem access. Keep `.agentcorp/credentials.json`, `.agentcorp/agentcorp.db`, and the administrative CLI unavailable to untrusted processes. Role capabilities are currently descriptive metadata, and host-agent capability sandboxing is scheduled for Milestone 4.

See [SECURITY.md](./SECURITY.md) for reporting and deployment guidance.

## License

Apache-2.0. See [LICENSE](./LICENSE).

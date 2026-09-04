# CLI Reference Manual

AgentCorp provides a comprehensive CLI for daemon management, role-bound stdio proxying, policy administration, and terminal-native human oversight.

---

## Global Options

All commands accept the following global flags:

* `--config <path>`: Path to organization configuration file (default: `org.toml`).
* `--db <path>`: Path to SQLite broker database (default: `.agentcorp/agentcorp.db`).

---

## 1. Setup & Daemon Lifecycle

### `agentcorp init`
Creates a starter `org.toml` and initializes credentials under `.agentcorp/credentials.json`.

* **Options**:
  * `--force`: Overwrite existing files.

### `agentcorp validate`
Validates `org.toml` syntax, role graphs, peer connectivity, and policy schemas.

### `agentcorp start`
Starts the central broker daemon hosting Streamable HTTP MCP (`/mcp`), Admin REST API (`/api/*`), and real-time SSE (`/api/events`).

* **Options**:
  * `--port <number>`: HTTP port to listen on (default: `54321`).
  * `--host <string>`: Host address to bind to (default: `127.0.0.1`).
  * `--daemon`: Runs detached in the background.

### `agentcorp stop`
Sends a graceful termination signal (`SIGTERM`) to the running background daemon.

### `agentcorp status`
Checks whether the central broker daemon is running, healthy, and reports active roles and uptime.

The daemon health response includes its live process ID and start time. If the
local control file is stale, `status` repairs it from that live identity. The
`stop` command refuses to signal an unreachable or unverifiable PID, preventing
an old control file from terminating an unrelated process.

---

## 2. Human Oversight & Console

### `agentcorp console`
Launches the human oversight console.

* **Default**: Renders the terminal-native ANSI status summary and queues pending approvals for interactive review.
* **Options**:
  * `--browser`, `--web`: Opens the dark glassmorphic web dashboard in your default browser.

### `agentcorp review`
Top-level alias for `agentcorp approvals review`. Directly launches the interactive terminal keyboard sign-off loop (`[a]`, `[e]`, `[r]`, `[s]`, `[q]`).

### `agentcorp approvals list`
Outputs all pending approvals in structured JSON.

### `agentcorp approvals approve <approval-id>`
Signs off on a pending approval.

* **Options**:
  * `--note <text>`: Reviewer decision note.
  * `--payload <json>`: Edited message payload as JSON (delivering modified content).

### `agentcorp approvals reject <approval-id>`
Rejects a pending approval.

* **Options**:
  * `--note <text>`: Rejection reason or feedback for the agent.

---

## 3. Runtime Policies

### `agentcorp policies list`
Lists all active and disabled runtime policies.

### `agentcorp policies set <json>`
Creates or updates a policy rule from a JSON definition.

### `agentcorp policies enable <policy-id>`
Enables a disabled policy rule.

### `agentcorp policies disable <policy-id>`
Disables a policy rule without deleting its audit history.

---

## 4. MCP Stdio Proxy

### `agentcorp mcp --role <role-id>`
Runs a role-bound stdio MCP server for agent hosts that only spawn local commands (e.g. Antigravity IDE, Codex, Claude Code, Cursor).

* **Options**:
  * `--role <id>` *(required)*: Role identity to bind to this process.
  * `--no-spawn`: Disables automatic background spawning of the daemon if not running.
  * `--daemon-url <url>`: Explicit daemon URL to connect to.

---

## 5. Audit & Compliance

### `agentcorp audit export`
Generates human-readable Markdown (`coord/audit.md`) and structured JSON (`coord/audit.json`) snapshots of the entire broker state for version-controlled traceability.

* **Options**:
  * `--out <dir>`: Output directory (default: `coord`).

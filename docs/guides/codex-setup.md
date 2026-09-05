# OpenAI Codex Setup Guide

This guide walks you through configuring **OpenAI Codex** (Desktop App or Extension, powered by models like **ChatGPT 5.6-sol**) to act as a coordinated member of your AgentCorp team (such as the **`architect`** / **Planner & Reviewer** role).

---

## 1. Overview

OpenAI Codex provides reasoning and planning capabilities. When bound to AgentCorp as the **`architect`**, Codex can:
- Decompose system goals into milestone tasks (`create_task`).
- Prepare tasks for peer implementers (`create_task`) and send linked proposals (`send_message`).
- Inspect one prioritized coordination view at session start (`get_work_queue`).
- Dispatch typed architecture proposals and reviews (`send_message`).
- Review code diffs and artifacts submitted by the developer (`list_artifacts`, `get_artifact`).

---

## 2. Configuration (`config.toml`)

Codex reads MCP server definitions from its global TOML configuration file:

* **Windows**: `C:\Users\<username>\.codex\config.toml`
* **macOS / Linux**: `~/.codex/config.toml`

### Step 1: Open Configuration File
Open `C:\Users\<username>\.codex\config.toml` in your editor.

### Step 2: Add AgentCorp Server Definition
Add the `[mcp_servers.agentcorp]` block to your `config.toml`, binding Codex to the `architect` role:

```toml
[mcp_servers.agentcorp]
command = "node"
args = [
  "C:\\Users\\<username>\\Desktop\\AgentCorp\\dist\\cli.js",
  "mcp",
  "--role",
  "architect",
  "--config",
  "C:\\Users\\<username>\\Desktop\\AgentCorp\\org.toml",
  "--db",
  "C:\\Users\\<username>\\Desktop\\AgentCorp\\.agentcorp\\agentcorp.db"
]
```

> [!NOTE]
> On Windows, ensure path backslashes are escaped (`\\`) in TOML strings, or use forward slashes (`/`). Providing `--config` automatically derives the project-scoped database (`.agentcorp/agentcorp.db`), credentials, and daemon files; `--db` is optional.

---

## 3. How the Connection Works

1. **Role Enforcement**: Codex connects through a role-bound stdio adapter that enforces the `architect` identity using the credentials stored in `.agentcorp/credentials.json`.
2. **Peer Isolation**: In `org.toml`, the `architect` is configured with `allowed_peers = ["developer"]`. Codex can only communicate with authorized roles.
3. **Approval Gating**: When Codex sends a `proposal` to the developer, AgentCorp's policy engine intercepts it and queues it for human review before it reaches Antigravity's inbox.

---

## 4. Example Codex Prompt

In the Codex extension or desktop app, you can issue commands like:

> *"Check the tasks in AgentCorp, create a new task for 'Implement SQLite Index Optimization', and send a proposal message to the developer role with the architectural specification."*

Codex will automatically call `create_task` and `send_message`, which will appear in your Human Console for approval.

Add this standing instruction to the Codex project guidance:

> At the start of each session and after every coordination mutation, call
> `get_work_queue`. Follow its highest-priority applicable next action before
> creating duplicate tasks or messages.

Creating a task with `assigned_to` records the intended assignee but does not
expose actionable work to that role. The linked proposal's approval activates
the assignment.

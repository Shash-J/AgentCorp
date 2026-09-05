# Google Antigravity Setup Guide

This guide walks you through configuring **Google Antigravity IDE** (the Gemini-powered agent) to act as a coordinated member of your AgentCorp team (such as the **`developer`** role).

---

## 1. Overview

Google Antigravity is an AI-first IDE equipped with agentic capabilities that natively support the Model Context Protocol (MCP). By registering AgentCorp in Antigravity's configuration, the Antigravity agent can:
- Inspect unread messages, assigned tasks, and the next recommended action in one call (`get_work_queue`).
- Accept an approved proposal and start its task atomically from the agent's perspective (`accept_handoff`).
- Send implementation diffs, status updates, and test results (`send_message`).
- Publish versioned, access-controlled code artifacts (`create_artifact`).

---

## 2. Configuration (`mcp_config.json`)

Antigravity IDE reads global MCP server configurations from:

* **Windows**: `C:\Users\<username>\.gemini\config\mcp_config.json`
* **macOS / Linux**: `~/.gemini/config/mcp_config.json`

### Step 1: Open Configuration File
Open `C:\Users\<username>\.gemini\config\mcp_config.json` in your editor.

### Step 2: Add AgentCorp Server Definition
Add the `agentcorp` server entry to the `mcpServers` object, binding it to the `developer` role:

```json
{
  "mcpServers": {
    "agentcorp": {
      "command": "node",
      "args": [
        "C:\\Users\\<username>\\Desktop\\AgentCorp\\dist\\cli.js",
        "mcp",
        "--role",
        "developer",
        "--config",
        "C:\\Users\\<username>\\Desktop\\AgentCorp\\org.toml",
        "--db",
        "C:\\Users\\<username>\\Desktop\\AgentCorp\\.agentcorp\\agentcorp.db"
      ]
    }
  }
}
```

> [!TIP]
> Use an absolute path for `--config` so that Antigravity reaches the broker regardless of your editor's current working directory. AgentCorp automatically derives `--db`, `--credentials`, and daemon control files relative to the config directory. Explicit `--db` arguments are optional overrides. On Windows, use double backslashes (`\\`) in JSON.

---

## 3. How the Connection Works

1. **Auto-Spawning**: When Antigravity initializes, the stdio adapter checks if the AgentCorp daemon is active. If not, it automatically spawns the central daemon in the background.
2. **Identity Lockdown**: The adapter automatically loads the `developer` bearer token from `.agentcorp/credentials.json`. Antigravity's agent identity is cryptographically enforced and cannot be spoofed.
3. **Tool Injection**: Antigravity automatically registers the 15 AgentCorp tools, including:
   - `whoami`, `register_role`
   - `list_tasks`, `create_task`, `update_task_status`
   - `get_inbox`, `send_message`, `acknowledge_message`, `accept_handoff`, `get_thread`
   - `get_work_queue` (combines active tasks, unread messages, presence, and next actions)
   - `create_artifact`, `list_artifacts`, `get_artifact`
   - `get_operation` (lookup results of idempotent operations)
4. **Self-Healing Proxy**: The stdio proxy features auto-reconnection with bounded exponential backoff. If the central broker restarts, Antigravity's in-flight session recovers seamlessly.
5. **Idempotency & Zero Duplication**: Mutations accept `idempotency_key`. Retried network requests replay the exact cached outcome without creating duplicate tasks, messages, or approvals.

---

## 4. Example Agent Prompt & Handoff Best Practices

Once configured, you can prompt the Antigravity agent in the sidebar chat:

> *"Call `get_work_queue` and follow the highest-priority applicable next action. Use `accept_handoff` for an approved task proposal."*

### Coordination Guidelines:
- **Standing Instructions**: Add the prompt above as a standing instruction at session start. MCP cannot wake an idle agent model autonomously.
- **Lightweight Handoffs**: Coordinate using concise IDs and summaries (`taskId`, `messageId`, diff summary). Do not dump large file trees or bulk artifacts into chat prompts; read artifacts on demand with `get_artifact`.

After upgrading AgentCorp or changing authentication settings, rebuild the
package (`npm run build`), restart the daemon (`agentcorp stop && agentcorp start`),
and restart the IDE's MCP connection if new tools are added. Existing
stdio processes continue running their previously loaded adapter code.

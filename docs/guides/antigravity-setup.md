# Google Antigravity Setup Guide

This guide walks you through configuring **Google Antigravity IDE** (the Gemini-powered agent) to act as a coordinated member of your AgentCorp team (such as the **`developer`** role).

---

## 1. Overview

Google Antigravity is an AI-first IDE equipped with agentic capabilities that natively support the Model Context Protocol (MCP). By registering AgentCorp in Antigravity's configuration, the Antigravity agent can:
- Inspect assigned tasks from the planner (`list_tasks`).
- Read incoming messages and design proposals (`get_inbox`).
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
> Ensure you use absolute paths for `--config` and `--db` so that Antigravity can reach the broker regardless of your editor's current working directory. On Windows, use double backslashes (`\\`) in JSON.

---

## 3. How the Connection Works

1. **Auto-Spawning**: When Antigravity initializes, the stdio adapter checks if the AgentCorp daemon is active. If not, it automatically spawns the central daemon in the background.
2. **Identity Lockdown**: The adapter automatically loads the `developer` bearer token from `.agentcorp/credentials.json`. Antigravity's agent identity is cryptographically enforced and cannot be spoofed.
3. **Tool Injection**: Antigravity automatically registers the 10 AgentCorp tools:
   - `whoami`
   - `list_tasks`
   - `get_inbox`
   - `send_message`
   - `create_artifact`
   - etc.

---

## 4. Example Agent Prompt

Once configured, you can prompt the Antigravity agent in the sidebar chat:

> *"Check your AgentCorp inbox for any proposals from Codex, acknowledge any pending messages, and update your task status to in_progress."*

The agent will invoke `whoami` to verify identity, call `get_inbox` to read messages, and execute its tasks within the boundaries configured in `org.toml`.

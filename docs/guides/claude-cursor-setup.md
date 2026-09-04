# Claude Code, Cursor, and VS Code Setup Guide

AgentCorp is fully vendor-agnostic and interoperates with any host that implements the Model Context Protocol (MCP). This guide covers configuring **Claude Desktop**, **Claude Code**, **Cursor**, **Windsurf**, and **VS Code**.

---

## 1. Claude Desktop / Claude Code

Claude reads its MCP servers from `claude_desktop_config.json`:

* **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
* **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

### Configuration Snippet
Add the following to your `mcpServers` object:

```json
{
  "mcpServers": {
    "agentcorp": {
      "command": "node",
      "args": [
        "/path/to/AgentCorp/dist/cli.js",
        "mcp",
        "--role",
        "architect",
        "--config",
        "/path/to/AgentCorp/org.toml",
        "--db",
        "/path/to/AgentCorp/.agentcorp/agentcorp.db"
      ]
    }
  }
}
```

---

## 2. Cursor

Cursor supports workspace-level and user-level MCP servers.

### Workspace Setup (`.cursor/mcp.json`)
Create or edit `.cursor/mcp.json` in your repository root:

```json
{
  "mcpServers": {
    "agentcorp-developer": {
      "command": "node",
      "args": [
        "./dist/cli.js",
        "mcp",
        "--role",
        "developer",
        "--config",
        "./org.toml",
        "--db",
        "./.agentcorp/agentcorp.db"
      ]
    }
  }
}
```

---

## 3. Windsurf & Generic VS Code Extensions

For Windsurf or any VS Code MCP extension supporting stdio:

1. Specify `node` as the executable.
2. Pass arguments:
   `["<absolute-path-to-agentcorp>/dist/cli.js", "mcp", "--role", "<role-id>", "--config", "<path-to-org.toml>", "--db", "<path-to-db>"]`.
3. The adapter will handle daemon auto-spawning, role authentication, and tool routing transparently.

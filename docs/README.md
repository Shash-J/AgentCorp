# AgentCorp Documentation

Welcome to the official AgentCorp documentation. AgentCorp is an open-source, local-first coordination broker designed to orchestrate teams of heterogeneous AI agents (such as Google Antigravity/Gemini, OpenAI Codex/ChatGPT, Anthropic Claude, Cursor, and more) over the Model Context Protocol (MCP) with Human-in-the-Loop (HITL) oversight.

---

## Documentation Navigation

### Start Here

* **[Beginner Setup & First Workflow](getting-started.md)**: Install AgentCorp, configure two agents, approve a handoff, and troubleshoot the connection without assuming prior MCP experience.

### 1. Architecture & Design
* **[Architecture Blueprint](ARCHITECTURE.md)**: Single-writer local daemon topology, Streamable HTTP MCP transport, role-bound stdio proxy adapters, transactional SQLite persistence, deterministic policy engine, and Server-Sent Events (SSE).
* **[Build Roadmap](ROADMAP.md)**: Milestones, completed phases, and upcoming capabilities.

### 2. Integration & Setup Guides
* **[Google Antigravity Setup Guide](guides/antigravity-setup.md)**: Step-by-step guide to configuring Google Antigravity IDE as an AgentCorp role (e.g. Developer / Implementer).
* **[OpenAI Codex Setup Guide](guides/codex-setup.md)**: Step-by-step guide to configuring OpenAI Codex desktop and extension as an AgentCorp role (e.g. Planner & Reviewer).
* **[Claude Code & Cursor Setup Guide](guides/claude-cursor-setup.md)**: Universal instructions for connecting Claude Desktop, Claude Code, Cursor, Windsurf, and VS Code.
* **[Human Oversight Console Guide](guides/human-console.md)**: Operating the terminal-native interactive review loop (`agentcorp review`) and the dark glassmorphic web dashboard (`agentcorp console --browser`).

### 3. Core References
* **[MCP Tools Reference](mcp-tools-reference.md)**: Exhaustive reference for all 15 MCP tools exposed to agents, including the prioritized `get_work_queue` view and idempotent `accept_handoff` operation.
* **[CLI Reference](cli-reference.md)**: Complete command-line interface manual (`init`, `validate`, `start`, `stop`, `status`, `console`, `review`, `approvals`, `policies`, `audit`, `mcp`).
* **[Policy & Safety Guide](policy-guide.md)**: Authoring safety rules, priority cascades, subset risk tag matching, and approval enforcement.
* **[Release Guide](RELEASING.md)**: Prepare GitHub and npm, publish a preview safely, verify it, and recover from release mistakes.
* **[Dogfooding Report](dogfooding-report.md)**: Findings from using AgentCorp itself for Codex-Gemini collaboration and the proposed direction for agent invocation.

---

## Core Principles

1. **Heterogeneous Interoperability**: AI agents from different providers (Google Gemini, OpenAI GPT, Anthropic Claude) collaborate seamlessly without custom glue code or vendor lock-in.
2. **Local-First & Single-Writer**: All coordination runs entirely on your local machine using SQLite with WAL mode. Agent state never leaves your workstation without your consent.
3. **Safe by Default (HITL)**: Any message or task transition not explicitly granted an auto-approve policy is halted in a pending state until a human signs off.
4. **Terminal-Native Workflow**: Designed by and for developers who live in the terminal, featuring instantaneous interactive keyboard reviews and live status summaries.

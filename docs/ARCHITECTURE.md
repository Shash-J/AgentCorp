# AgentCorp Architecture Specification

This document details the architectural topology, security boundaries, domain invariants, and runtime mechanics of AgentCorp.

---

## 1. System Topology & Process Boundaries

![AgentCorp Architecture Blueprint](./images/architecture.jpg)

AgentCorp follows a **single-writer local daemon** model designed to bridge heterogeneous AI clients while enforcing strict role boundaries and transactional data integrity:

```text
┌─────────────────────────────────────────────────────────────┐
│                    Heterogeneous Agents                     │
│  ┌───────────────────────┐       ┌───────────────────────┐  │
│  │   Antigravity / IDE   │       │   Codex / Extension   │  │
│  │   (Role: developer)   │       │   (Role: architect)   │  │
│  └───────────┬───────────┘       └───────────┬───────────┘  │
└──────────────┼───────────────────────────────┼──────────────┘
               │ stdio                         │ stdio
┌──────────────▼───────────────────────────────▼──────────────┐
│                 Role-Bound Stdio Adapters                   │
│         (agentcorp mcp --role developer / architect)         │
│  • Auto-spawns daemon if offline                            │
│  • Binds identity via local bearer token                     │
└──────────────┬───────────────────────────────┬──────────────┘
               │ Streamable HTTP               │ Streamable HTTP
               │ (Bearer <roleToken>)          │ (Bearer <roleToken>)
┌──────────────▼───────────────────────────────▼──────────────┐
│            AgentCorp Central Daemon (localhost:54321)        │
│                                                             │
│  ┌──────────────────┐  ┌────────────────┐  ┌─────────────┐  │
│  │ Streamable HTTP  │  │ Admin REST API │  │ SSE Stream  │  │
│  │  MCP Transport   │  │  (/api/*)      │  │ /api/events │  │
│  └────────┬─────────┘  └────────┬───────┘  └──────┬──────┘  │
│           │                     │                 │         │
│  ┌────────▼─────────────────────▼─────────────────▼──────┐  │
│  │               AgentCorp Broker Engine                 │  │
│  │ • Connection-enforced identity                        │  │
│  │ • Deterministic policy evaluator (priority/subset)    │  │
│  │ • EventEmitter domain pipeline                        │  │
│  └──────────────────────────┬────────────────────────────┘  │
│                             │                               │
│  ┌──────────────────────────▼────────────────────────────┐  │
│  │         Transactional SQLite Engine (WAL Mode)        │  │
│  │ • Versioned migrations (schema_migrations)            │  │
│  │ • Durable messages, tasks, approvals, and artifacts   │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────▲───────────────────────────────┘
                              │
┌─────────────────────────────┴───────────────────────────────┐
│                   Human Oversight Consoles                  │
│                                                             │
│   ┌─────────────────────────────┐  ┌─────────────────────┐  │
│   │ Terminal Review Loop (TUI)  │  │ Web Dashboard (SSE) │  │
│   │ (agentcorp review)          │  │ (GET /console)      │  │
│   └─────────────────────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Authentication & Identity Enforcement

1. **Role Tokens**:
   - Each role configured in `org.toml` is assigned a high-entropy cryptographically random bearer token stored in `.agentcorp/credentials.json` (`mode 0600`).
   - Tokens never live in `org.toml` or git-tracked directories.
2. **Connection-Enforced Identity**:
   - The caller's role is established strictly during HTTP handshake via `Authorization: Bearer <roleToken>`.
   - Tool arguments like `sender` or `caller` are **never** accepted from the client; identity spoofing is impossible.
3. **Admin Token**:
   - Administrative endpoints (`/api/approvals`, `/api/policies`, `/api/events`, `/api/audit/export`) require the separate `adminToken`.

---

## 3. Policy Evaluation & Human-in-the-Loop (HITL)

AgentCorp operates on a **safe-by-default** security posture:

```text
Incoming Request (Message / Task Transition)
   │
   ├── 1. Verify Allowed Peers (is recipient in sender.allowed_peers?)
   │        └── NO  ──> REJECT (NOT_AN_ALLOWED_PEER)
   │
   ├── 2. Evaluate Runtime Policies (Ordered by DESC priority)
   │        ├── Match Subject ("message" / "task")
   │        ├── Match Optional Criteria (from_role, to_role, message_type, to_status)
   │        └── Match Risk Tags (Subset matching: all rule tags must be present)
   │
   ├── 3. Decision
   │        ├── Match found with action="auto_approve" ──> PROCEED (Delivered / Updated)
   │        └── NO match found OR action="require_human"
   │              └── QUEUE in pending_approval
   │                    ├── Recipient cannot see message
   │                    ├── Event emitted over SSE
   │                    └── Awaits Human Sign-off in Terminal / Web Console
```

---

## 4. Real-Time Event Architecture (SSE)

The broker daemon maintains an event-driven pub/sub architecture:
* **Domain Events**: `message_created`, `message_delivered`, `approval_created`, `approval_decided`, `task_status_changed`, `policy_changed`.
* **Server-Sent Events (`/api/events`)**: Pushes events to connected terminal observers and web consoles in real-time.
* **Resilience**: Includes automatic 15-second keep-alive heartbeats and clean connection teardown on client disconnect.

---

## 5. Storage & Persistence

* **Database Engine**: Built-in `node:sqlite` in WAL (Write-Ahead Logging) mode.
* **Zero Native Dependencies**: No native compilation (`node-gyp`), ensuring universal cross-platform execution on Windows, macOS, and Linux.
* **Migrations**: Automated forward schema migrations tracked in `schema_migrations`.
* **Git Observability**: Complete state can be exported at any time into human-readable Markdown (`coord/audit.md`) and structured JSON (`coord/audit.json`).

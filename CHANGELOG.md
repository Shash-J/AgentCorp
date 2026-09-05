# Changelog

All notable changes to AgentCorp will be documented in this file.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) after the first public release.

---

## [0.1.0-alpha.1] — Unreleased

Initial public developer preview release of AgentCorp: a local-first coordination broker for teams of AI agents.

### Core Architecture & Coordination Broker
- **Local-First MCP Broker**: Implemented single-writer, multi-reader architecture coordinating AI agents across distinct roles without coupling agents to a single vendor, framework, or model.
- **Role Isolation & Access Control**: Strict caller role authentication enforcing allowed peer communications and role-scoped artifact visibility rules defined in `org.toml`.
- **Approval-Bound Task Activation**: Gated task handoffs where tasks remain in `proposed` state and are hidden from intended assignees until linked proposals are human-approved.
- **Prioritized Work Queue (`get_work_queue`)**: Unified endpoint returning unread messages, active tasks, live role presence, and ranked actionable suggestions in one call.
- **Idempotent Handoff Acceptance (`accept_handoff`)**: Atomically acknowledges approved proposals and initiates task transitions without duplicate executions.

### Reliability, Self-Healing & Concurrency
- **Resilient Stdio MCP Proxy**: Automatic daemon discovery, bounded exponential backoff (100ms–2000ms), and transparent auto-spawn recovery when the broker daemon restarts or crashes.
- **Cross-Process Startup Lock**: Atomic file-locking mechanism (`.agentcorp/daemon.json.lock`) with active PID probes and stale lock recovery (>10s) ensuring exactly one daemon spawns per project.
- **Working Directory Isolation**: Automatic path resolution allowing MCP host processes to run from arbitrary working directories while automatically deriving project-scoped database, credentials, logs, and daemon control files from `org.toml`.
- **Mutation Idempotency (`idempotency_key`)**: Role-scoped composite primary key `(role_id, key)` with SHA-256 operation and payload hash validation, rejecting cross-role key collisions and stale mismatches.
- **Re-Entrant Atomic Transactions**: SQLite transaction management with depth tracking guaranteeing atomic commits and clean rollbacks for business mutations and idempotency records.
- **Concurrent Database Startup**: Installs SQLite's busy handler before WAL negotiation and migrations so simultaneous worker connections wait for initialization locks instead of failing intermittently.
- **Collision-Free Daemon Default**: Background startup now selects an available loopback port by default and records actionable startup failures in the bounded daemon log.

### Persistence, Migrations & Bounded Storage
- **Transactional SQLite Persistence**: Built on Node.js 22 built-in `node:sqlite` with WAL journal mode, busy timeouts, and versioned schema migrations (Versions 1 through 7).
- **Hard Resource Bounds**: Enforced 2 MB HTTP body limits, 1 MB message payload limits, 5 MB artifact limits, and configurable audit payload extraction budgets (`max_audit_payload_bytes`).
- **Opaque Cursor Pagination**: Cursor-based pagination across inboxes, tasks, threads, approvals, and artifacts.
- **History Pruning & Compaction**: `agentcorp prune` command with foreign-key reply chain detachment, dry-run simulation, and SQLite WAL compaction (`agentcorp compact`).

### Human Oversight & Operational Observability
- **Human Review CLI (`agentcorp review`)**: Interactive terminal-native review loop with approve, edit-and-approve, reject, skip, and quit actions.
- **Dark Glassmorphic Web Dashboard (`agentcorp console`)**: Live real-time dashboard powered by Server-Sent Events (`/api/events`) with side-by-side JSON diff editor and live status telemetry.
- **Role Presence & Activity Freshness**: Telemetry tracking role liveness, last seen timestamps, and activity freshness (`fresh`, `idle`, `stale`).
- **Diagnostic Health Check (`agentcorp doctor`)**: Comprehensive operational diagnostics inspecting configuration, database schema, credentials, daemon health, and crash logs.
- **Structured Log Rotation & Sanitization**: Bounded rotating daemon logs (`.agentcorp/daemon.log`, 5 MB max with 3 backups) with payload redaction protecting conversation confidentiality, alongside fatal crash diagnostics (`.agentcorp/crash.log`).

### Release Engineering & Documentation
- **Strict Test Typechecking**: The default TypeScript check now covers both production source and tests, with a separate production-only build configuration.
- **Package Boundary Regression Test**: The clean-install smoke suite asserts that source, tests, runtime state, internal design notes, and binary documentation assets cannot enter the npm tarball.
- **Beginner and Maintainer Guides**: Added end-to-end first-workflow, troubleshooting, GitHub setup, npm preview publication, verification, and recovery instructions.
- **Dogfooding Findings**: Documented the observed Codex-Gemini collaboration strengths, host-lifecycle friction, and a bounded adapter architecture for future autonomous invocation.

### Audit Integrity & Truncation Semantics
- **Explicit Audit Semantics**: Formatted Markdown and JSON audit exports (`coord/audit.md`, `coord/audit.json`) distinguishing row-limit truncation (`rowLimitTruncated`) from field-level clipping (`fieldClippingActive`).
- **SQLite-Layer Payload Bounding**: UTF-8 BLOB-cast byte-aware truncation using `OCTET_LENGTH` and `SUBSTR` preventing native and V8 heap inflation on oversized audit records.
- **Memory-Isolated Approvals**: Omission of discarded `edited_payload` from SQL query projections.

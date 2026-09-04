# AgentCorp build roadmap

This roadmap turns the v0.1 design specification into small, independently
releasable vertical slices. Security and interoperability gates are release
criteria, not follow-up polish.

## Milestone 0 — repository foundation (complete)

- Publishable TypeScript package and global CLI shape
- Strict configuration validation for roles and role graphs
- Transactional SQLite schema
- Broker domain API for tasks, messages, approvals, policies, and artifacts
- Role-bound stdio MCP server
- Human approval CLI
- Core behavior tests and open-source contribution files

## Milestone 1 — central local broker (complete)

Goal: match the design spec's single-writer topology without losing the easy
stdio integration.

- Long-lived broker daemon over MCP Streamable HTTP
- Thin role-bound stdio adapter for hosts that only spawn local commands
- Per-role credentials stored outside `org.toml`
- Admin credential and separate approval endpoints
- Database migrations with schema version enforcement
- Graceful shutdown, health check, structured logs, and audit export
- End-to-end MCP client tests using two simultaneous role connections

Exit criteria met: agents cannot access the database directly through the
AgentCorp package path; two real MCP clients exchange an approved message
through one broker process; restart preserves all state.

## Milestone 2 — seamless human console (complete)

Goal: provide developer-first human oversight with terminal-native workflows
and a real-time dark glassmorphic web dashboard.

- Real-time event-driven broker domain events (`EventEmitter` over mutations)
- Long-lived Server-Sent Events stream (`GET /api/events`) with live push updates
- Terminal-native console (`agentcorp console`) and interactive review loop (`agentcorp review`, `agentcorp approvals review`)
- Single-page dark glassmorphic web dashboard (`/console`) with no external framework dependencies
- Side-by-side JSON diff viewer & payload editor with live validation
- Role inboxes, task threads, artifact viewer, and runtime policy toggle controls
- Prioritized per-role work queue and idempotent approved-handoff acceptance
- Approval-bound assignment visibility so agents cannot act on proposed work early
- Zero extra runtime dependencies, preserving ultra-fast startup

Exit criteria met: A user can operate, monitor, and sign off multi-agent workflows
either completely inside their terminal or via an intuitive live web dashboard without raw SQL.

## Milestone 3 — adapters and interoperability (next)

- Tested setup guides for Codex, Gemini, Claude Code, VS Code, and Cursor
- Agent Card export and an A2A compatibility adapter
- HTTP artifact content store with size limits and streaming
- Pluggable policy match dimensions
- OpenTelemetry traces and metrics
- Host-specific notification or runner adapters that can wake idle agents when approved work arrives

Exit criteria: three vendor-distinct agents complete the same workflow without
custom broker code.

## Milestone 4 — stable public release

- Threat model and independent security review
- Protocol conformance suite
- Backward-compatible database and API migration policy
- Signed releases, SBOM, provenance, and automated npm publishing
- Performance tests for concurrent roles and large task histories
- `1.0.0` API stability commitment

## Decisions to resolve before v0.2

1. Authentication: local bearer tokens versus OS-bound credentials.
2. Transport: HTTP-only daemon versus HTTP plus a local socket.
3. Package identity: retain `agentcorp-broker` or publish under an owned npm
   scope. The unscoped `agentcorp` package is already occupied.
4. Task model: retain separate task/message records until A2A adapter work
   produces evidence that unification reduces complexity.
5. Artifact storage: maximum inline content size and URI scheme allowlist.

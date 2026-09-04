# Changelog

All notable changes will be documented here. This project follows Semantic
Versioning after the first public release.

## 0.1.0 — Unreleased

- Added the SQLite-backed broker domain core.
- Added role-bound MCP v2 tools over stdio.
- Added task, message, policy, approval, and artifact workflows.
- Added the human approval CLI and starter organization configuration.
- Added core security-invariant tests and initial project documentation.
- Added long-lived broker daemon hosting MCP Streamable HTTP and Admin REST API.
- Added thin role-bound stdio proxy adapter with auto-spawn capability.
- Added credential management storing role and admin tokens in `.agentcorp/credentials.json`.
- Added versioned database migrations with schema enforcement.
- Added human-readable Markdown and JSON audit trail export (`coord/`).
- Added daemon lifecycle management (`start`, `stop`, `status`).
- Added approval-bound task activation so intended assignees cannot act on proposed work early.
- Added `get_work_queue` for a single prioritized coordination view.
- Added idempotent `accept_handoff` to acknowledge and start approved work without duplicate transitions.
- Made daemon lifecycle control self-heal stale PID metadata and verify live identity before stopping a process.

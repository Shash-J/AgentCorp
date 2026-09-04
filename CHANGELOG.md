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

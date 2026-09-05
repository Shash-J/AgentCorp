# Contributing to AgentCorp

Thank you for helping build vendor-neutral agent coordination infrastructure.

## Local setup

1. Install Node.js 22.13 or newer.
2. Run `npm ci` for a lockfile-reproducible dependency install.
3. Run `npm run check`, `npm run build`, and `npm test` before opening a pull request.

Keep changes focused and add tests for new behavior. Protocol or persistence
changes should update the design spec or an architecture note. Security
invariants must fail closed: an error must never deliver a message, approve a
transition, or broaden artifact visibility.

Use Conventional Commit-style subjects when practical, such as `feat:`,
`fix:`, `docs:`, and `test:`.

By contributing, you agree that your contribution is licensed under the
Apache License 2.0.

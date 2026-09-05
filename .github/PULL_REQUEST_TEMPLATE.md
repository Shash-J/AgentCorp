## Description

Briefly describe the change and rationale. Reference any related issues or AgentCorp task IDs.

## Type of Change

- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (non-breaking change adding functionality)
- [ ] Documentation update
- [ ] Refactoring / performance improvement
- [ ] Security / hardening

## Verification Checklist

Please ensure all local verification gates pass before submitting:

- [ ] `npm run check` (TypeScript typecheck with 0 errors)
- [ ] `npm test` (Full automated test suite passes with 100% success)
- [ ] `npm run build` (Clean production bundle build)
- [ ] `node dist/cli.js validate --config org.toml` (Config schema valid)
- [ ] `npm audit --omit=dev` (0 production vulnerabilities)
- [ ] `npm pack --dry-run --ignore-scripts` (Package manifest verified)
- [ ] `node dist/cli.js doctor` (Subsystems report healthy)

## Security Invariants Check

- [ ] **Fail-Closed**: Any unconfigured or error condition fails closed (blocks dispatch/transition).
- [ ] **Credential Isolation**: Tokens and credentials stored strictly in `.agentcorp/credentials.json` outside version control.
- [ ] **Bounded Storage**: Payload and message byte bounds strictly enforced at SQLite and HTTP layers.
- [ ] **Role Scoping**: Artifact visibility and peer communication respect `org.toml` constraints.

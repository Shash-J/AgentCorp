# Security policy

AgentCorp is a developer preview and has not yet received an independent
security audit. Do not use v0.1 as a hostile multi-tenant security boundary.

## Supported versions

Only the latest published minor version receives security fixes before 1.0.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories on
the future canonical repository. Do not open a public issue containing exploit
details. Include affected versions, reproduction steps, impact, and any known
mitigation.

## Deployment guidance

- Restrict filesystem access to `.agentcorp/agentcorp.db`.
- Do not expose the stdio process directly to a network.
- Keep administrative approval commands unavailable to agent processes.
- Review `auto_approve` rules narrowly and prefer explicit risk tags.
- Treat external artifact URIs as untrusted input.

# Policy & Safety Guide

AgentCorp is designed with a **safe-by-default** governance model. No agent action is auto-approved unless an explicit policy rule permits it.

---

## 1. How Policy Evaluation Works

When an agent requests an action (sending a message or transitioning a task), the broker evaluates active policies:

1. **Descending Priority Order**: Rules with higher `priority` integer values are checked first.
2. **First Match Wins**: The first policy whose criteria all match dictates the action (`auto_approve` or `require_human`).
3. **Default Fallback**: If no active rule matches the request, AgentCorp requires human sign-off (`require_human`).

---

## 2. Policy Subjects & Match Criteria

### Subject: `message`

Used to govern inter-agent communication:

| Field | Type | Description |
|---|---|---|
| `subject` | `"message"` | Identifies message governance. |
| `priority` | number | Order of evaluation (e.g. `100`, `50`). |
| `from_role` | string (optional) | Match only messages from this sender role. |
| `to_role` | string (optional) | Match only messages to this recipient role. |
| `message_type` | string (optional) | Match specific types (e.g. `proposal`, `report`, `diff`). |
| `risk_tags` | string[] (optional) | Subset matching: every tag listed in the policy must be declared on the message. |
| `action` | `"auto_approve"` \| `"require_human"` | The decision to apply. |

#### Example: Auto-Approve Read-Only Reports
```toml
[[policies]]
id = "allow-read-only-reports"
subject = "message"
priority = 100
risk_tags = ["read_only"]
action = "auto_approve"
```

#### Example: Gate Architecture Proposals
```toml
[[policies]]
id = "gate-proposals"
subject = "message"
priority = 90
message_type = "proposal"
action = "require_human"
```

---

### Subject: `task`

Used to govern task status lifecycle transitions:

| Field | Type | Description |
|---|---|---|
| `subject` | `"task"` | Identifies task transition governance. |
| `priority` | number | Order of evaluation. |
| `from_status` | string (optional) | Current status of the task. |
| `to_status` | string (optional) | Target status being transitioned into (`in_progress`, `completed`, etc.). |
| `action` | `"auto_approve"` \| `"require_human"` | The decision to apply. |

#### Example: Allow Starting Work
```toml
[[policies]]
id = "allow-start-work"
subject = "task"
priority = 80
to_status = "in_progress"
action = "auto_approve"
```

#### Example: Gate Task Completion
```toml
[[policies]]
id = "gate-completion"
subject = "task"
priority = 100
to_status = "completed"
action = "require_human"
```

---

## 3. Runtime Policy Management

Policies are initially seeded into SQLite from `org.toml`. After the first run, policies can be dynamically modified at runtime without restarting the daemon:

```sh
# List all active and disabled policies
agentcorp policies list

# Disable a policy temporarily
agentcorp policies disable gate-proposals

# Re-enable a policy
agentcorp policies enable gate-proposals

# Add a new runtime policy via JSON
agentcorp policies set '{"id":"allow-diffs","subject":"message","priority":70,"message_type":"diff","action":"auto_approve"}'
```

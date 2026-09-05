# AgentCorp — Multi-Agent Communication & Coordination Protocol

## Design Specification v0.1

---

## 1. Purpose and Scope

AgentCorp is an open-source coordination layer that lets multiple AI coding
agents — potentially from different vendors, CLIs, and IDEs — communicate
with each other under defined roles, a structured protocol, and human
oversight. The system is broker-mediated: agents never connect to each other
directly. All messages, task state, and artifacts pass through a central
component (the Broker) that enforces routing rules, approval policy, and
access control.

The initial deployment target is a two-agent architect/executor pair (e.g. an
OpenAI Codex-based agent as architect, a Gemini-based agent as executor)
operating inside an IDE such as Antigravity. The architecture is not
two-agent-specific; it generalizes to an arbitrary number of agents arranged
in arbitrary role hierarchies, up to and including a simulated organizational
structure with multiple specialized roles reporting through defined channels.

---

## 2. Terminology

| Term | Definition |
|---|---|
| **Agent** | A single AI system instance (a specific model + CLI/tool combination) connected to the Broker under one Role. |
| **Role** | A named function (e.g. `architect`, `executor`, `reviewer`, `qa`) with a defined capability set and routing permissions. Roles are user-defined, not hardcoded. |
| **Broker** | The central server. Owns the Role Registry, Message Bus, Approval Policy Engine, and Artifact Store. The only component every Agent connects to. |
| **Message** | A single structured unit of communication between two roles, carrying a type, payload, and status. |
| **Task** | A unit of work with its own lifecycle, composed of one or more Messages exchanged in relation to it. |
| **Artifact** | A named output produced by an Agent (code diff, test report, document, log) stored centrally and access-controlled by role. |
| **Approval Gate** | The point at which a Message or Task transition requires human sign-off before delivery, governed by the Approval Policy Engine. |
| **Human Console** | The interface through which the human reviews, approves, edits, or rejects pending Messages and Task transitions. |

---

## 3. System Architecture

AgentCorp uses a hub-and-spoke topology. Every Agent maintains exactly one
connection — to the Broker — regardless of how many other Agents exist in
the system.

```
                     ┌───────────────────────────────────┐
                     │              Broker                │
                     │                                     │
                     │  Role Registry                      │
                     │  Message Bus (typed, stateful)       │
                     │  Task Lifecycle Engine               │
                     │  Approval Policy Engine (pluggable)  │
                     │  Artifact Store (role-scoped ACL)    │
                     └───────────────┬─────────────────────┘
                                     │  MCP interface
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
      Agent: architect        Agent: executor        Agent: reviewer
      (role=architect)        (role=executor)         (role=reviewer)
                                                     [N additional roles]
                                     │
                                     │  MCP interface / web UI
                                     │
                              Human Console
                        (approves, edits, rejects,
                         adjusts policy at runtime)
```

This topology has two direct consequences:

- Connection count grows linearly (O(n)) with the number of agents, not
  quadratically. Adding a new role does not require modifying any existing
  agent's connection logic.
- Routing, access control, and approval are enforced in exactly one place
  (the Broker), rather than being the responsibility of each agent
  individually. No agent can bypass the approval gate by construction,
  because no agent has a direct channel to any other agent.

---

## 4. Core Components

### 4.1 Role Registry

A data store mapping role names to their definition. Each entry contains:

- `role_id` — unique identifier (e.g. `architect`, `executor`, `qa`).
- `display_name` — human-readable label.
- `bound_agent` — which connected agent instance currently holds this role
  (model/CLI identifier); may be reassigned without changing the role
  definition.
- `capabilities` — declared action types the role is permitted to invoke
  (e.g. `propose_plan`, `write_code`, `run_tests`, `approve_merge`).
- `allowed_peers` — list of role_ids this role is permitted to send messages
  to. Absence of an entry in this list makes routing between two roles
  invalid at the Broker level, independent of approval policy.
- `artifact_visibility` — default visibility rule applied to artifacts this
  role produces, unless overridden per-artifact.

Role definitions are user-authored configuration, not application code. This
is what makes arbitrary role structures (architect/executor today, a larger
simulated organization later) a configuration change rather than a rebuild.

**Serialization format**: Role Registry entries are authored in a single
`org.toml` file at the project root, one `[[roles]]` block per role:

```toml
[company]
name = "TuringSight"

[[roles]]
id = "architect"
model = "openai/gpt-5.6-sol"
interface = "mcp"
capabilities = ["propose_plan", "review", "approve_merge"]
allowed_peers = ["developer"]
artifact_visibility = ["architect", "developer"]

[[roles]]
id = "developer"
model = "gemini/3.7-flash"
interface = "mcp"
capabilities = ["write_code", "run_tests", "report"]
allowed_peers = ["architect"]
artifact_visibility = ["architect", "developer"]
```

`org.toml` is read once at Broker startup (and on explicit reload) to
populate the Role Registry. It is a configuration input, not a runtime
communication channel — agents do not read or write this file during
operation, and it is not polled for state changes. All in-session state
(message status, task status, approval decisions) lives in the Broker's
persistence layer (Section 4.6a), not in `org.toml` or any other file the
agents access directly.

### 4.2 Message Bus

The Message Bus is the sole channel through which any content moves between
agents. It is stateful: every message is persisted with its full status
history, not fire-and-forget.

Message fields:

- `message_id` — unique identifier.
- `task_id` — the Task this message belongs to (nullable for out-of-band
  messages).
- `from_role`, `to_role` — sender and recipient role_ids.
- `type` — one of: `proposal`, `question`, `answer`, `report`, `review`,
  `verdict`, `status_update`.
- `payload` — structured content. Free text is permitted inside a payload
  field, but the envelope itself (type, references, status) is always
  structured, so recipients do not need to infer intent from prose.
- `references` — list of `artifact_id`s this message points to, in place of
  embedding artifact content directly in the message body.
- `in_reply_to` — message_id of the message this one responds to, or null.
- `status` — one of: `draft`, `pending_approval`, `approved`, `edited`,
  `rejected`, `delivered`, `acknowledged`.
- `risk_tags` — labels describing the potential impact of the message's
  content (e.g. `writes_main`, `deploys`, `deletes_data`, `read_only`), used
  as input to the Approval Policy Engine.
- `created_at`, `resolved_at` — timestamps.

A message only becomes visible to its recipient once its status reaches
`approved` or `delivered`. `pending_approval` messages exist in the Broker
but are not exposed through the recipient's inbox query.

### 4.3 Task Lifecycle Engine

A Task groups a related sequence of messages under one unit of work and
carries its own state, independent of any individual message's status.

Task states: `proposed → assigned → in_progress → blocked ⇄ in_progress →
awaiting_review → completed | failed | cancelled`.

Each state transition is itself subject to the Approval Policy Engine, so a
Task can require human sign-off at specific transitions (e.g.
`awaiting_review → completed`) while flowing autonomously through others
(e.g. `assigned → in_progress`).

### 4.4 Artifact Store

Artifacts are stored separately from messages and referenced by ID rather
than embedded, mirroring the general principle that transient conversational
content and durable state should not share a storage location.

Artifact fields:

- `artifact_id`, `type` (`code_diff`, `test_report`, `spec_doc`, `log`,
  `build_output`, other user-defined types), `produced_by` (role_id),
  `content` or `content_uri`, `content_hash`, `visible_to_roles` (explicit
  list, or `all`), `created_at`, `related_task_id`.

Access to an artifact is checked against `visible_to_roles` at read time,
independent of whether the requesting agent has seen the message that
referenced it. This allows a role added to the system later to retroactively
access artifacts it has been granted visibility into, without replaying the
prior message history.

**Enforcement boundary**: artifact content is retrievable only through the
Broker's `get_artifact` call (Section 4.6). No artifact content is exposed
via a shared filesystem path, mounted directory, or folder-scoping
convention. This distinction is deliberate: an underlying agent CLI may
retain general-purpose file or shell access for its own working directory,
which means any access-control scheme based on which folders are "exposed"
to an agent is not actually enforceable — the agent's own tools can route
around it. Routing all artifact reads through an explicit API call with a
server-side visibility check is the only boundary that holds regardless of
what other tool access the underlying agent CLI has.

### 4.5 Approval Policy Engine

A pluggable decision function evaluated at two points: before a message
transitions from `draft` to `delivered`, and before a task transitions
between defined lifecycle states.

Policy rules are declarative and scoped by any combination of: role pair
(`from_role`, `to_role`), message `type`, and `risk_tags`. Each rule resolves
to one of three actions:

- `auto_approve` — the message or transition proceeds without human
  involvement.
- `require_human` — the message or transition is held at `pending_approval`
  until a decision is recorded through the Human Console.
- `delegate_to_role` — approval authority is assigned to another agent role
  rather than the human (reserved for future multi-tier approval chains).

Policy rules are data (stored and editable at runtime), not code, so the
gating behavior for a given role pair or risk tag can be changed without
redeploying the Broker. This is the mechanism by which HITL strictness is
adjustable rather than fixed — a role pair can be moved from
`require_human` to `auto_approve` and back at any point.

### 4.6 Transport Layer

Agents connect to the Broker over MCP. The Broker exposes a fixed tool
surface, consistent across all connected agents regardless of role:

- `register_role(role_id, capabilities)`
- `send_message(to_role, type, payload, references, risk_tags)` — creates a
  message in `draft`/`pending_approval` status; never delivers directly.
- `get_inbox(role_id)` — returns messages in `approved` or `delivered`
  status addressed to the calling role.
- `get_thread(task_id)` — returns full message history for a task,
  filtered by the calling role's visibility.
- `list_artifacts(task_id, role_id)` / `get_artifact(artifact_id, role_id)`
  — both enforce `visible_to_roles` at call time.
- `update_task_status(task_id, new_status)` — subject to Approval Policy
  Engine evaluation before taking effect.

MCP is used because it is already the transport both reference agents
(Codex-based and Gemini-based, via Antigravity) support natively, removing
the need for a custom protocol adapter at v0.

### 4.6a Persistence and Concurrency

The Broker's state (messages, task status, approval decisions, artifacts)
is held in a transactional datastore — SQLite for local/single-user
deployments — rather than in flat files read and written by multiple
processes.

This choice is a direct consequence of the transport model: because every
state change is a request/response call to the Broker (Section 4.6) rather
than a write to a shared file, there is exactly one process performing
writes to the datastore, and concurrent requests from multiple agents are
serialized through normal database transactions. This removes an entire
class of problems — partial/torn writes, lost updates from concurrent
writers, and polling latency — that a shared-file coordination mechanism
would otherwise need to solve explicitly (e.g. via file locking, atomic
rename patterns, or sequence-number reconciliation).

A read-only audit export (human-readable Markdown or JSON, mirroring
current Broker state) may be written to a `/coord/` directory on disk for
human inspection and git history. This export is derived output, generated
by the Broker; it is never read by an agent as input, and no agent process
writes to it. It exists for observability, not as a communication channel.

### 4.7 Human Console

A client of the Broker with elevated privileges: it can view all
`pending_approval` items across every role and task, approve, edit-then-
approve, or reject any of them, and modify Approval Policy Engine rules at
runtime. It is not a special agent role — it is a distinct client type that
authenticates directly against the Broker's approval endpoints.

The Console is a protocol, not a fixed UI: a terminal-based approval
interceptor (using a TUI framework, presenting pending handoffs as an
approve/reject prompt) and a browser-based dashboard are both valid front
ends against the same underlying approval API, and can be used
interchangeably or simultaneously by the same user.

---

## 5. Communication Semantics

- Communication between any two roles is duplex by default: both directions
  of a conversation use the same Message schema, the same Task grouping, and
  the same approval evaluation. Architect→executor instructions and
  executor→architect reports are structurally identical message types
  differentiated only by `type` and `from_role`/`to_role`.
- Routing is a two-stage check: first, the Role Registry's `allowed_peers`
  list determines whether the role pair may communicate at all; second, the
  Approval Policy Engine determines whether a specific message on that
  (already-valid) route requires human sign-off.
- No agent-to-agent message bypasses the Broker under any configuration.
  This is a topological property (hub-and-spoke), not a policy setting, so
  it holds regardless of how permissive the Approval Policy is configured.

---

## 6. Scalability Model

The system is designed to scale from two roles to an arbitrary number
without architectural change, through the following properties:

- **Connection scaling**: O(n) broker connections, not O(n²) peer
  connections, as agent count grows.
- **Routing scaling**: `allowed_peers` on each role definition expresses an
  arbitrary directed graph (including hierarchical, tree-shaped
  "org chart" structures), so adding a role does not require modifying any
  existing role's configuration unless a new communication path is
  explicitly desired.
- **Artifact scaling**: visibility is role-based, not agent-instance-based,
  so multiple agent instances can hold the same role (e.g. several
  `executor` instances working in parallel) and share artifact access
  without additional configuration.
- **Policy scaling**: Approval Policy rules are matched by role pair and
  message type/risk, not by individual agent identity, so policy
  configuration does not grow linearly with agent count.

---

## 7. Human-in-the-Loop Model

HITL is implemented as a first-class, adjustable property of the system
rather than a fixed behavior:

- Granularity ranges from "approve every message" (all rules set to
  `require_human`) down to "approve only high-risk transitions" (rules
  scoped narrowly by `risk_tags` such as `writes_main` or `deploys`, with
  everything else `auto_approve`).
- The same mechanism governs both message delivery and task-state
  transitions, so a role pair can be fully autonomous in conversation while
  still requiring human sign-off before a task is marked `completed`.
- Policy changes take effect at runtime through the Human Console; no
  agent restart or redeployment is required to shift the gating level.

---

## 8. Extensibility and Open-Source Contribution Model

The following are designed as explicit extension points, to support
independent contribution without modification to Broker core logic:

- **New agent adapters**: connecting an additional CLI-based agent requires
  implementing the fixed MCP tool surface (Section 4.6) against that
  agent's invocation method; it does not require Broker changes.
- **New role definitions**: entirely data-driven (Section 4.1); no code
  change required to introduce a new role.
- **New Approval Policy rule types**: the policy engine's rule-matching
  interface (role pair, message type, risk tag) is designed to accept
  additional match dimensions or custom rule plugins without altering the
  core evaluation loop.
- **New artifact types**: the Artifact Store's `type` field is open-ended;
  new artifact types require no schema migration.
- **Dashboard/Console alternatives**: the Human Console is one client of
  the Broker's approval API; alternative front ends (CLI-based, chat-based,
  IDE-embedded) can be built against the same API surface.

---

## 9. Alignment with Existing Standards

- **Google A2A Protocol** (Linux Foundation, Apache-2.0): defines Agent
  Cards for capability discovery, a Task object with lifecycle states
  including `input-required` and `rejected`, and typed Artifacts. AgentCorp's
  Role capability declarations, Task lifecycle, and Artifact references are
  structured to be representable as a subset of A2A's data model, so a
  future A2A-compatible transport is additive rather than a redesign.
- **MCP Elicitation primitive**: provides a mechanism for a server to pause
  and request structured human input mid-call. This is a candidate
  implementation mechanism for individual approval prompts within the
  Human Console, but does not itself provide the multi-agent inbox,
  role registry, or policy engine described in this document — those
  remain Broker-level concerns.

---

## 10. Explicit Non-Goals for v0

- Direct agent-to-agent transport bypassing the Broker.
- Filesystem polling or shared-file parsing (e.g. a markdown status file
  read by multiple agent processes) as a communication channel. Any file
  output under `/coord/` is a read-only audit export of Broker state, not
  an input either agent reads from.
- Filesystem-path-based artifact access control (e.g. exposing a folder
  scoped to a role). Access is enforced only through the Broker's
  `get_artifact` API call, since a folder-exposure convention cannot be
  enforced against an agent CLI with independent file or shell access.
- Cross-organization or cross-machine federation (single local Broker
  instance per deployment for v0).
- Autonomous policy learning (Approval Policy rules are explicitly
  authored, not inferred from approval history, at v0).
- Delegated approval chains (`delegate_to_role`) — the field exists in the
  schema for forward compatibility but is not implemented in v0.

---

## 11. Open Questions

- Package/project naming availability (`agentcorp` or similar) across
  PyPI, npm, and GitHub org namespaces has not yet been verified.
- SQLite is specified for local/single-user deployments (Section 4.6a);
  whether a shared/team deployment needs a server-backed store (e.g.
  Postgres) behind the same Broker interface, and at what point that
  becomes necessary, is not yet decided.
- Whether Task and Message should be unified into a single object type
  (as A2A does, where Messages are contained within Tasks) or remain
  separate, as drafted here, is an open design decision.

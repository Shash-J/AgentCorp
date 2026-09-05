# AgentCorp Dogfooding Report

Date: 2026-09-05
Scenario: Codex acting as architect/reviewer and Gemini in Antigravity acting as
developer while improving AgentCorp itself.

## Executive assessment

AgentCorp was useful as a durable, policy-controlled coordination ledger. It
made task ownership, human approval, implementation evidence, and review
decisions more explicit than ordinary copy-and-paste chat. The core broker is a
credible developer-preview tool.

The experience was not yet autonomous. AgentCorp reliably stored and exposed
work, but the human repeatedly had to tell an idle agent that new work was
available. At one point the Gemini host entered a goal-verification loop and
showed an MCP error. These are host-lifecycle failures rather than lost broker
state, but they are central to the user's experience and must be treated as
product requirements.

## What worked well

- Stable task, message, artifact, and approval IDs made handoffs auditable.
- Human approval gates prevented an eager implementer from receiving an
  unreviewed proposal and prevented automatic final completion.
- `get_work_queue` reduced several reconciliation calls to one prioritized view.
- `accept_handoff` plus idempotency keys reduced duplicate execution risk.
- The central SQLite daemon preserved coordination state across client and
  daemon restarts.
- Concise reports and on-demand artifacts kept the coordination database and
  model context smaller than copying whole files through chat.
- Independent architectural review found real reliability and release defects,
  and the developer could return targeted evidence against them.

## Friction observed

- MCP exposes tools but has no standard operation for starting a new model turn.
- IDE integrations can retain an older stdio adapter until their MCP connection
  is restarted.
- Presence indicates recent tool activity, not that a host can accept work now.
- A host-side agent loop can continue even when the broker considers its task
  complete; AgentCorp currently cannot interrupt it.
- Manual “Gemini replied” and “check AgentCorp” prompts were still needed.
- Reports can become verbose or repetitive unless agents are instructed to send
  IDs, summaries, and bounded evidence.

## Practical verdict

The coordination and safety layer is effective enough for an **alpha developer
preview**, especially for local two-agent workflows with an engaged human. It
is not yet a hands-off orchestration platform, a hostile multi-tenant security
boundary, or a guarantee that every IDE agent will resume automatically.

## Autonomous invocation direction

Autonomous invocation should be an adapter capability above the broker, not a
special case embedded into the task database.

Proposed shape:

1. The broker commits an approved-work event to a transactional outbox.
2. A runner service claims the event with a time-limited lease and a stable
   idempotency key.
3. A host adapter translates the generic request into something that host
   supports: subprocess launch, IDE extension command, webhook, notification,
   or “not supported”.
4. The adapter reports accepted, started, heartbeat, completed, failed, or
   timed-out state back to AgentCorp.
5. Retries use bounded backoff, deduplication, attempt limits, and a circuit
   breaker. Human stop and pause controls always win.

Each role should declare invocation capabilities such as `manual`, `notify`, or
`managed_runner`. A policy should separately decide whether approved work may
be invoked automatically. This keeps approval and invocation distinct: an
approved task is authorized work, but it is not automatically permission to
spawn an unrestricted process.

The first implementation should be a narrow feasibility spike for one host,
with a fake adapter for deterministic tests. The general interface should be
extracted only after a second, meaningfully different host proves which parts
are portable. Essential safeguards are workspace isolation, command allowlists,
resource and token budgets, lease expiry, deduplication, observable attempt
history, and a global kill switch.

# AgentCorp Beginner Setup and First Workflow

This guide takes you from an empty terminal to two AI agents collaborating on
one project. You do not need prior Model Context Protocol (MCP) experience.

AgentCorp is a local coordination service. It records tasks and messages,
checks who may communicate, pauses sensitive actions for human approval, and
keeps an audit trail. It does **not** choose an AI model, provide an AI
subscription, sandbox an agent's shell access, or wake an idle agent inside an
IDE.

## 1. Install the prerequisites

Install:

- Node.js 22.13 or newer from [nodejs.org](https://nodejs.org/).
- Two MCP-capable agent hosts if you want to test collaboration, such as Codex
  and Antigravity, Claude, or Cursor.
- Git if you are installing from source.

Confirm Node and npm are available:

```sh
node --version
npm --version
```

The Node version must be `v22.13.0` or newer.

## 2. Install AgentCorp

Install globally via npm:

```sh
npm install --global agentcorp-broker@alpha
agentcorp --version
```

Or run directly with zero installation:
```sh
npx agentcorp-broker@alpha init
```

> **Note**: While AgentCorp is in developer preview, specifying the `@alpha` tag ensures you target the preview stream.

If you prefer building from source:
```sh
git clone https://github.com/Shash-J/AgentCorp.git
cd AgentCorp
npm install
npm run build
```

## 3. Initialize AgentCorp in your project

Open a terminal in the software project where the agents will collaborate. Do
not run this in the AgentCorp source directory unless AgentCorp itself is the
project being coordinated.

```sh
cd /path/to/your-project
agentcorp init
agentcorp validate
```

Initialization creates:

```text
your-project/
|-- org.toml                         team roles and approval policies
`-- .agentcorp/
    `-- credentials.json             private local role and admin tokens
```

Add `.agentcorp/` to that project's `.gitignore`. Never commit or paste the
credentials file into an issue, prompt, chat, or audit artifact.

The starter `org.toml` defines:

- `architect`: plans and reviews work.
- `developer`: implements and reports work.
- Human approval for proposals and final task completion.
- Automatic delivery for narrowly tagged read-only reports and status updates.

Edit the display names, models, capabilities, and allowed peers as needed, then
run `agentcorp validate` again. Policies fail closed: if no enabled rule
matches, AgentCorp asks a human to approve the operation.

## 4. Start and inspect the daemon

Start the local broker in the background:

```sh
agentcorp start --daemon
agentcorp status
agentcorp doctor
```

By default it listens only on `127.0.0.1` and asks the operating system for an
available port. The selected address is recorded in `.agentcorp/daemon.json`,
so agents and the console discover it automatically. This avoids collisions
with applications and Windows reserved port ranges. Keep the loopback binding
for normal local use. Runtime data, logs, and the SQLite database stay in the
project's `.agentcorp/` directory.

## 5. Connect the first agent

Every agent receives its own role-bound MCP process. Use the absolute path to
the collaboration project's `org.toml`; IDEs do not always start MCP processes
from the project directory.

After npm installation, the generic command is:

```text
agentcorp --config /absolute/path/to/your-project/org.toml mcp --role architect
```

For the developer connection, change only the final role:

```text
agentcorp --config /absolute/path/to/your-project/org.toml mcp --role developer
```

If you are running from source, replace `agentcorp` with `node` and put the
absolute path to `dist/cli.js` before the other arguments.

The exact configuration-file format differs by host. Copy the relevant guide:

- [Codex setup](guides/codex-setup.md)
- [Antigravity setup](guides/antigravity-setup.md)
- [Claude and Cursor setup](guides/claude-cursor-setup.md)

Restart each host's MCP connection after editing its configuration. Ask each
agent to call `whoami`. One response should say `architect` and the other
`developer`. If both roles are correct, ask each to call `get_work_queue`.

## 6. Complete the first collaboration

Give both agents this standing instruction:

> At session start and after every handoff or status change, call
> `get_work_queue`. Follow the highest-priority applicable next action. Use
> concise task and message IDs instead of copying large histories.

Then use this workflow:

1. Tell the architect the goal and ask it to create a task for `developer` and
   send a linked `proposal` message.
2. Run `agentcorp review`. Inspect the proposed instructions, then approve,
   edit and approve, reject with feedback, or skip them.
3. Tell the developer to call `get_work_queue`. It should now see the approved
   proposal and task.
4. The developer calls `accept_handoff`, implements the work, runs tests, sends
   a concise `report`, and requests the `awaiting_review` task state.
5. The architect reviews the code and evidence, then returns a verdict.
6. When completion is requested, use `agentcorp review` again for final human
   sign-off.

The web console provides the same operational view:

```sh
agentcorp console --browser
```

MCP is passive: an approved message becomes available immediately, but
AgentCorp cannot make an idle IDE model start a new turn. Until host adapters
are added, you may need to prompt the receiving agent to check its work queue.

## 7. Keep storage bounded

Preview old resolved history without deleting it:

```sh
agentcorp prune --older-than 30
```

After checking the preview, execute the deletion and compact the database:

```sh
agentcorp prune --older-than 30 --execute --compact
```

Export only the recent audit window you need:

```sh
agentcorp audit export --limit 100
```

Audit exports go to the ignored `coord/` directory and can contain project
metadata. Review them before sharing. Back up `org.toml` and, if you need to
preserve coordination history, the entire `.agentcorp/` directory while the
daemon is stopped.

## 8. Troubleshooting

If an IDE shows an MCP error:

1. Run `agentcorp status` and `agentcorp doctor` in the collaboration project.
2. Confirm the MCP entry uses an absolute `org.toml` path.
3. Confirm the configured role exists in `org.toml`.
4. Run `agentcorp validate`.
5. Restart the daemon with `agentcorp stop`, then `agentcorp start --daemon`.
6. Restart the IDE's MCP connection so it loads the installed adapter version.
7. Inspect `.agentcorp/daemon.log` locally. Remove secrets before sharing any
   excerpt.

If a proposal is missing from the developer queue, check `agentcorp review`.
Pending proposals are deliberately invisible to the assignee until approved.

If npm reports `agentcorp: command not found`, either reopen the terminal after
global installation or use `npx agentcorp-broker@alpha --version` to verify the
package without depending on the global executable path.

## 9. Stop or remove AgentCorp

Stop the project daemon:

```sh
agentcorp stop
```

Uninstall the global CLI without deleting project data:

```sh
npm uninstall --global agentcorp-broker
```

Only delete `.agentcorp/` when you intentionally want to erase that project's
credentials, messages, tasks, approvals, and audit history.

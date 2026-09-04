import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { AgentCorpBroker } from "./broker.js";
import { AgentCorpError } from "./errors.js";
import type { PendingApproval, TaskRecord } from "./types.js";

// ANSI escape codes for slick terminal styling
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
  bgCyan: "\x1b[46m\x1b[30m",
  bgYellow: "\x1b[43m\x1b[30m",
};

export interface TuiOptions {
  daemonUrl?: string | undefined;
  adminToken?: string | undefined;
  broker?: AgentCorpBroker | undefined;
}

export class AgentCorpTui {
  private readonly daemonUrl?: string | undefined;
  private readonly adminToken?: string | undefined;
  private readonly broker?: AgentCorpBroker | undefined;

  constructor(options: TuiOptions) {
    this.daemonUrl = options.daemonUrl;
    this.adminToken = options.adminToken;
    this.broker = options.broker;
  }

  async fetchApprovals(): Promise<PendingApproval[]> {
    if (this.daemonUrl && this.adminToken) {
      try {
        const res = await fetch(`${this.daemonUrl}/api/approvals`, {
          headers: { Authorization: `Bearer ${this.adminToken}` },
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new AgentCorpError(
            "DAEMON_ERROR",
            `Daemon returned HTTP ${res.status} (${res.statusText}): ${body || "Authentication or permission failure"}`,
          );
        }
        return (await res.json()) as PendingApproval[];
      } catch (err) {
        if (err instanceof AgentCorpError) throw err;
        throw new AgentCorpError(
          "DAEMON_UNREACHABLE",
          `Cannot reach AgentCorp daemon at ${this.daemonUrl}: ${String(err)}`,
        );
      }
    }
    if (this.broker) {
      return this.broker.listPendingApprovals();
    }
    return [];
  }

  private async approve(id: string, note?: string, payload?: unknown): Promise<void> {
    if (this.daemonUrl && this.adminToken) {
      const res = await fetch(`${this.daemonUrl}/api/approvals/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ note: note || "Approved via Terminal Console", payload }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new AgentCorpError("APPROVE_FAILED", `Failed to approve ${id}: HTTP ${res.status} ${body}`);
      }
      return;
    }
    if (this.broker) {
      this.broker.approve(id, note, payload);
    }
  }

  private async reject(id: string, note?: string): Promise<void> {
    if (this.daemonUrl && this.adminToken) {
      const res = await fetch(`${this.daemonUrl}/api/approvals/${encodeURIComponent(id)}/reject`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ note: note || "Rejected via Terminal Console" }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new AgentCorpError("REJECT_FAILED", `Failed to reject ${id}: HTTP ${res.status} ${body}`);
      }
      return;
    }
    if (this.broker) {
      this.broker.reject(id, note);
    }
  }

  printHeader(): void {
    console.log(`
${c.cyan}┌─────────────────────────────────────────────────────────────┐${c.reset}
${c.cyan}│${c.reset}  ${c.bold}AGENTCORP${c.reset}  ${c.dim}::${c.reset}  ${c.bold}Human Approval & Coordination Console${c.reset}   ${c.cyan}│${c.reset}
${c.cyan}└─────────────────────────────────────────────────────────────┘${c.reset}
`);
  }

  async runReview(): Promise<{ approved: number; rejected: number; skipped: number }> {
    const rl = createInterface({ input, output });
    let approved = 0;
    let rejected = 0;
    let skipped = 0;

    try {
      this.printHeader();
      let pending: PendingApproval[] = [];
      try {
        pending = await this.fetchApprovals();
      } catch (err) {
        console.log(`\n ${c.red}${c.bold}✘ FAILED TO RETRIEVE APPROVALS:${c.reset} ${err instanceof Error ? err.message : String(err)}\n`);
        return { approved: 0, rejected: 0, skipped: 0 };
      }

      if (pending.length === 0) {
        console.log(` ${c.green}✔${c.reset} ${c.bold}All clear!${c.reset} No pending approvals requiring sign-off.`);
        return { approved: 0, rejected: 0, skipped: 0 };
      }

      console.log(` Found ${c.yellow}${c.bold}${pending.length}${c.reset} item(s) awaiting human sign-off:\n`);

      for (let i = 0; i < pending.length; i++) {
        const item = pending[i]!;
        const num = `[${i + 1}/${pending.length}]`;
        const isMsg = item.subject === "message";
        const subjectTag = isMsg
          ? `${c.cyan}[MESSAGE]${c.reset}`
          : `${c.magenta}[TASK TRANSITION]${c.reset}`;

        console.log(`${c.gray}──────────────────────────────────────────────────────────────${c.reset}`);
        console.log(` ${c.bold}${num}${c.reset} ${subjectTag} ${c.bold}ID:${c.reset} ${item.approvalId}`);
        console.log(` ${c.dim}Requested by:${c.reset} ${c.cyan}${item.requestedBy}${c.reset}  ${c.dim}Target:${c.reset} ${item.subjectId}`);
        console.log(` ${c.dim}Created at:${c.reset}   ${item.createdAt}`);

        if (item.context && typeof item.context === "object") {
          const ctx = item.context as Record<string, unknown>;
          if (ctx.toRole) {
            console.log(` ${c.dim}Recipient:${c.reset}    ${c.green}${ctx.toRole}${c.reset}`);
          }
          if (ctx.type) {
            console.log(` ${c.dim}Message Type:${c.reset} ${c.blue}${ctx.type}${c.reset}`);
          }
          if (ctx.taskId) {
            console.log(` ${c.dim}Task ID:${c.reset}      ${ctx.taskId}`);
          }
          if (ctx.fromStatus && ctx.toStatus) {
            console.log(` ${c.dim}Transition:${c.reset}   ${ctx.fromStatus} ──> ${c.bold}${ctx.toStatus}${c.reset}`);
          }
          if (ctx.payload !== undefined) {
            console.log(`\n ${c.bold}Proposed Message Payload:${c.reset}`);
            const payloadStr = typeof ctx.payload === "object"
              ? JSON.stringify(ctx.payload, null, 2)
              : String(ctx.payload);
            const indented = payloadStr
              .split("\n")
              .map((line) => `   ${c.gray}│${c.reset} ${line}`)
              .join("\n");
            console.log(indented);
          } else {
            console.log(`\n ${c.bold}Context / Details:${c.reset}`);
            const contextStr = JSON.stringify(ctx, null, 2);
            const indented = contextStr
              .split("\n")
              .map((line) => `   ${c.gray}│${c.reset} ${line}`)
              .join("\n");
            console.log(indented);
          }
        }
        console.log("");

        let promptMore = true;
        while (promptMore) {
          const promptActions = isMsg
            ? ` Action ${c.bold}[${c.green}a${c.reset}${c.bold}]pprove, [${c.cyan}e${c.reset}${c.bold}]dit & approve, [${c.red}r${c.reset}${c.bold}]eject, [${c.yellow}s${c.reset}${c.bold}]kip, [${c.dim}q${c.reset}${c.bold}]uit:${c.reset} `
            : ` Action ${c.bold}[${c.green}a${c.reset}${c.bold}]pprove, [${c.red}r${c.reset}${c.bold}]eject, [${c.yellow}s${c.reset}${c.bold}]kip, [${c.dim}q${c.reset}${c.bold}]uit:${c.reset} `;

          const action = (await rl.question(promptActions)).trim().toLowerCase();

          if (action === "a") {
            const note = (await rl.question(` ${c.dim}Approval note (optional):${c.reset} `)).trim();
            try {
              await this.approve(item.approvalId, note || undefined);
              console.log(` ${c.green}✔ Approved ${item.approvalId}${c.reset}\n`);
              approved++;
              promptMore = false;
            } catch (err) {
              console.log(` ${c.red}✘ Approval Failed:${c.reset} ${err instanceof Error ? err.message : String(err)}\n`);
            }
          } else if (action === "e") {
            if (!isMsg) {
              console.log(` ${c.yellow}↷ Payload editing is only supported for messages.${c.reset}`);
              continue;
            }
            console.log(`\n ${c.cyan}Enter revised JSON payload:${c.reset}`);
            const inputJson = await rl.question(` ${c.dim}>${c.reset} `);
            try {
              const parsed = JSON.parse(inputJson.trim());
              const note = (await rl.question(` ${c.dim}Modification note (optional):${c.reset} `)).trim();
              await this.approve(item.approvalId, note || undefined, parsed);
              console.log(` ${c.green}✔ Approved with modification ${item.approvalId}${c.reset}\n`);
              approved++;
              promptMore = false;
            } catch (err) {
              console.log(` ${c.red}✘ Error:${c.reset} ${err instanceof Error ? err.message : String(err)}\n`);
            }
          } else if (action === "r") {
            const note = (await rl.question(` ${c.dim}Rejection reason / feedback:${c.reset} `)).trim();
            try {
              await this.reject(item.approvalId, note || undefined);
              console.log(` ${c.red}✘ Rejected ${item.approvalId}${c.reset}\n`);
              rejected++;
              promptMore = false;
            } catch (err) {
              console.log(` ${c.red}✘ Rejection Failed:${c.reset} ${err instanceof Error ? err.message : String(err)}\n`);
            }
          } else if (action === "s") {
            console.log(` ${c.yellow}↷ Skipped${c.reset}\n`);
            skipped++;
            promptMore = false;
          } else if (action === "q") {
            console.log(`\n ${c.dim}Review session cancelled.${c.reset}`);
            return { approved, rejected, skipped };
          } else {
            console.log(` Invalid choice. Press 'a', 'e', 'r', 's', or 'q'.`);
          }
        }
      }

      console.log(`${c.gray}──────────────────────────────────────────────────────────────${c.reset}`);
      console.log(` ${c.bold}Review Complete:${c.reset} ${c.green}${approved} approved${c.reset}, ${c.red}${rejected} rejected${c.reset}, ${c.yellow}${skipped} skipped${c.reset}.\n`);
      return { approved, rejected, skipped };
    } finally {
      rl.close();
    }
  }

  async runDashboard(): Promise<{ pendingCount: number; tasksCount: number }> {
    this.printHeader();
    let pending: PendingApproval[] = [];
    try {
      pending = await this.fetchApprovals();
    } catch (err) {
      console.log(` ${c.red}${c.bold}✘ FAILED TO CONNECT TO APPROVALS QUEUE:${c.reset}`);
      console.log(`   ${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}\n`);
      throw err;
    }

    let tasks: TaskRecord[] = [];
    if (this.daemonUrl && this.adminToken) {
      try {
        const res = await fetch(`${this.daemonUrl}/api/tasks`, {
          headers: { Authorization: `Bearer ${this.adminToken}` },
        });
        if (res.ok) tasks = (await res.json()) as TaskRecord[];
      } catch {}
    } else if (this.broker) {
      tasks = this.broker.database.listAllTasks();
    }

    console.log(` ${c.bold}Status Summary:${c.reset}`);
    console.log(`   Pending Approvals: ${pending.length > 0 ? `${c.yellow}${c.bold}${pending.length}${c.reset}` : `${c.green}0 (Clean)${c.reset}`}`);
    console.log(`   Total Tasks:       ${c.cyan}${tasks.length}${c.reset}`);
    if (this.daemonUrl) {
      console.log(`   Daemon URL:        ${c.blue}${this.daemonUrl}${c.reset}`);
      console.log(`   Web Dashboard:     ${c.blue}${this.daemonUrl}/console${c.reset}`);
    }
    console.log("");

    if (pending.length > 0) {
      console.log(` ${c.yellow}Pending Approvals Queue:${c.reset}`);
      for (const p of pending) {
        console.log(`   ${c.yellow}•${c.reset} ${c.bold}${p.approvalId}${c.reset} (${p.subject}) by ${c.cyan}${p.requestedBy}${c.reset} [${p.createdAt}]`);
      }
      console.log(`\n Run ${c.bold}agentcorp approvals review${c.reset} to sign off interactively.`);
    }

    console.log("");
    return { pendingCount: pending.length, tasksCount: tasks.length };
  }
}

// Approval gate for destructive commands (`token revoke`, `profile remove`).
// Adapted from cligentic block `trust-ladder` (`approveGate`, T2 only): --yes passes; in
// machine mode or without a TTY it throws a structured `confirmation_required` error instead
// of prompting; otherwise it asks on stderr. T3 intent tokens were not adopted: the worst
// outcome here is a revoked token the user can recreate in seconds.

import { confirm } from "./blocks/prompt";
import { rt } from "./blocks/runtime";
import { colors } from "./blocks/style";
import { CliError, EXIT } from "./exit";

export interface GateRequest {
  /** What will happen, one line. */
  summary: string;
  details?: Array<[string, string | undefined]>;
  /** The exact command that passes the gate non-interactively. */
  retryCommand: string;
  yes: boolean | undefined;
  machine: boolean;
}

export async function approve(request: GateRequest): Promise<void> {
  if (request.yes) return;
  const cancelledError = () =>
    new CliError("cancelled", "Cancelled; nothing was changed", { exitCode: EXIT.USAGE });
  if (request.machine) {
    throw new CliError("confirmation_required", `${request.summary}: pass --yes to confirm`, {
      exitCode: EXIT.USAGE,
      hint: request.retryCommand,
    });
  }
  const { stderr } = rt();
  const c = colors(stderr);
  stderr.write(`${c.warn("▲")} ${c.bold(request.summary)}\n`);
  for (const [key, value] of request.details ?? []) {
    if (value !== undefined) stderr.write(`  ${c.muted(key.padEnd(10))} ${value}\n`);
  }
  const answer = await confirm("Continue?").catch(() => false);
  if (answer === null) {
    throw new CliError("confirmation_required", `${request.summary}: pass --yes to confirm`, {
      exitCode: EXIT.USAGE,
      hint: request.retryCommand,
    });
  }
  if (!answer) throw cancelledError();
}

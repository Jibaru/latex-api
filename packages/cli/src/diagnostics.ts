import type { Diagnostic, Job } from "@jibaru/latex-api-sdk";
import { createColors } from "picocolors";
import { sanitize } from "./blocks/style";

const pc = createColors(true);

export interface FormatOptions {
  /** Maximum number of diagnostics to print before "+N more". Default 20. */
  max?: number;
  /** Disable ANSI colors. */
  color?: boolean;
  /** Link to the full log, printed as the last line. */
  logUrl?: string;
  /** Job id, printed with the log hint. */
  jobId?: string;
}

const SEVERITY_ORDER: Record<Diagnostic["severity"], number> = { error: 0, warning: 1, info: 2 };

function paint(color: boolean, fn: (s: string) => string, text: string): string {
  return color ? fn(text) : text;
}

function cleanFile(file: string | undefined): string | undefined {
  if (!file) return undefined;
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Errors first, then warnings, then info; stable within each severity. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics
    .map((d, i) => ({ d, i }))
    .sort((a, b) => SEVERITY_ORDER[a.d.severity] - SEVERITY_ORDER[b.d.severity] || a.i - b.i)
    .map(({ d }) => d);
}

export function formatDiagnostic(d: Diagnostic, color = true): string {
  const location = [cleanFile(d.file), d.line].filter((x) => x !== undefined).join(":");
  const severity =
    d.severity === "error"
      ? paint(color, pc.red, "error")
      : d.severity === "warning"
        ? paint(color, pc.yellow, "warning")
        : paint(color, pc.blue, "info");
  const message = sanitize(d.message).replace(/\s+/g, " ").trim();
  const prefix = location ? `${paint(color, pc.bold, location)}: ` : "";
  const context = d.context?.trim()
    ? `\n    ${paint(color, pc.dim, sanitize(d.context).trim())}`
    : "";
  return `${prefix}${severity}: ${message}${context}`;
}

export function summarize(diagnostics: readonly Diagnostic[]): {
  errors: number;
  warnings: number;
  info: number;
} {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  for (const d of diagnostics) {
    if (d.severity === "error") errors += 1;
    else if (d.severity === "warning") warnings += 1;
    else info += 1;
  }
  return { errors, warnings, info };
}

/**
 * Compact report: `file:line: severity: message`, errors first, up to `max` entries,
 * then `+N more` and the log URL.
 */
export function formatDiagnostics(
  diagnostics: readonly Diagnostic[],
  options: FormatOptions = {},
): string {
  const color = options.color ?? true;
  const max = options.max ?? 20;
  const sorted = sortDiagnostics(diagnostics);
  const lines: string[] = [];
  for (const d of sorted.slice(0, max)) lines.push(formatDiagnostic(d, color));
  if (sorted.length > max) lines.push(paint(color, pc.dim, `+${sorted.length - max} more`));
  const { errors, warnings } = summarize(diagnostics);
  const summary = `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`;
  lines.push(paint(color, errors > 0 ? pc.red : pc.yellow, summary));
  if (options.logUrl) lines.push(`${paint(color, pc.dim, "Full log:")} ${options.logUrl}`);
  else if (options.jobId) {
    lines.push(paint(color, pc.dim, `Full log: latex-api jobs logs ${options.jobId}`));
  }
  return lines.join("\n");
}

/** Report for a job that finished without a PDF. */
export function formatJobFailure(job: Job, color = true): string {
  const head =
    job.status === "timed_out"
      ? "Compilation timed out"
      : job.status === "cancelled"
        ? "Job was cancelled"
        : sanitize(job.error?.message ?? "Compilation failed");
  const body = job.result?.diagnostics?.length
    ? formatDiagnostics(job.result.diagnostics, { color, logUrl: job.result.logUrl })
    : job.result?.logUrl
      ? `${paint(color, pc.dim, "Full log:")} ${job.result.logUrl}`
      : "";
  return [paint(color, pc.red, head), body].filter(Boolean).join("\n");
}

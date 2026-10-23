import type { Diagnostic } from "./diagnostic";
import type { BibliographyMode, Engine } from "./engine";

export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type JobMode = "sync" | "async" | "demo";

export interface CompileOptions {
  timeoutMs: number;
  bibliography: BibliographyMode;
  /** Number of latexmk runs allowed; latexmk decides on its own but we cap it. */
  maxPasses: number;
  webhookUrl?: string;
}

export interface Principal {
  /**
   * Stable owner id used for job ownership and rate limits: a user id (`user_...`) for
   * signed-in users, the operator key name for env keys, `demo` or `anonymous`. Never a secret.
   */
  name: string;
  kind: "user" | "key" | "demo" | "anonymous";
  /** How the caller authenticated. */
  via?: "token" | "session" | "env";
  /** Personal API token used, when `via` is `token`. */
  tokenId?: string;
  email?: string;
}

export type FailureReason = "compile_failed" | "timeout" | "cancelled" | "internal";

export interface JobResult {
  /** Artifact key of the PDF when one was produced (also present on failed compiles sometimes). */
  pdfKey?: string;
  pdfBytes?: number;
  pages?: number;
  logKey: string;
  diagnostics: Diagnostic[];
  errors: number;
  warnings: number;
  durationMs: number;
  exitCode: number | null;
  cached: boolean;
}

export interface JobError {
  reason: FailureReason;
  message: string;
}

export interface CompileJob {
  id: string;
  status: JobStatus;
  mode: JobMode;
  engine: Engine;
  entrypoint: string;
  projectHash: string;
  fileCount: number;
  totalBytes: number;
  options: CompileOptions;
  principal: Principal;
  templateId?: string;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  expiresAt: Date;
  result?: JobResult;
  error?: JobError;
  compilerVersion: string;
}

export function isTerminal(status: JobStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled"
  );
}

export function canCancel(status: JobStatus): boolean {
  return status === "queued" || status === "running";
}

export type JobEvent =
  | { type: "queued"; jobId: string; at: string }
  | { type: "running"; jobId: string; at: string }
  | { type: "log"; jobId: string; at: string; chunk: string }
  | { type: "done"; jobId: string; at: string; status: JobStatus }
  | { type: "error"; jobId: string; at: string; status: JobStatus; message: string };

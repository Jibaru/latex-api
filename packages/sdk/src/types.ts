import type {
  CompileOptions as ApiCompileOptions,
  BibliographyMode,
  Diagnostic,
  Engine,
  Job,
} from "./client/types.gen";

export type JobStatus = Job["status"];

/** A file to upload. Text content is sent as UTF-8, binary content as base64. */
export interface ProjectFileInput {
  /** Relative POSIX path inside the project, e.g. `sections/intro.tex`. */
  path: string;
  content: string | Uint8Array;
}

/** Options shared by every compile request. */
export interface CompileRequestOptions {
  /** Capped by the server (`limits.syncTimeoutMs` / `limits.jobTimeoutMaxMs`). */
  timeoutMs?: number;
  /** `auto` runs bibtex/biber only when the document needs it. */
  bibliography?: BibliographyMode;
  /** Async jobs only: the server POSTs the job envelope here when it finishes. */
  webhookUrl?: string;
  /** Skip the content-addressed cache. */
  force?: boolean;
}

interface CompileInputBase {
  /** Main `.tex` file. Guessed when there is a single `.tex` or a `main.tex`. */
  entrypoint?: string;
  /** TeX engine. Detected from a `% !TEX program = ...` comment when omitted; defaults to pdflatex. */
  engine?: Engine;
  options?: CompileRequestOptions;
}

/** A multi-file project, sent as JSON. */
export interface FilesCompileInput extends CompileInputBase {
  files: ProjectFileInput[];
}

/** A single-file document, sent as `text/x-tex`. */
export interface SourceCompileInput extends CompileInputBase {
  source: string;
}

/** A zipped project, sent as `application/zip`. */
export interface ZipCompileInput extends CompileInputBase {
  zip: Uint8Array;
}

export type CompileInput = FilesCompileInput | SourceCompileInput | ZipCompileInput;

/** Overrides applied on top of a template before compiling it. */
export interface TemplateCompileInput extends CompileInputBase {
  /** Files that replace template files with the same path, or are added to the project. */
  files?: ProjectFileInput[];
}

export interface CompilePdfResult {
  pdf: Uint8Array;
  jobId: string;
  cached: boolean;
  warnings: number;
  job?: undefined;
}

export interface CompileJsonResult {
  job: Job;
  pdf?: undefined;
}

export type CompileResult = CompilePdfResult | CompileJsonResult;

export interface CompileCallOptions<A extends "pdf" | "json" = "pdf" | "json"> {
  /** `pdf` (default) returns the bytes; `json` returns the job envelope with diagnostics. */
  accept?: A;
  signal?: AbortSignal;
}

export interface RequestCallOptions {
  signal?: AbortSignal;
}

/** Events emitted by `GET /v1/jobs/:id/events`. */
export type JobEvent =
  | { type: "queued"; jobId: string; at: string }
  | { type: "running"; jobId: string; at: string }
  | { type: "log"; jobId: string; at: string; chunk: string }
  | { type: "done"; jobId: string; at: string; status: JobStatus }
  | { type: "error"; jobId: string; at: string; status: JobStatus; message: string }
  | { type: "ping"; at: string };

export interface WaitOptions {
  /** Polling interval used when the event stream is unavailable. Default 1000 ms. */
  pollMs?: number;
  /** Give up after this long. Default 10 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Receives every event (real ones from SSE, or synthesized status changes when polling). */
  onEvent?: (event: JobEvent) => void;
}

export interface EventsOptions {
  signal?: AbortSignal;
}

export interface LatexApiOptions {
  /** Defaults to `LATEX_API_URL` (Node) or `https://latex-api.crafter.run`. */
  baseUrl?: string;
  /**
   * A personal API token (`lta_...`). Defaults to `LATEX_API_TOKEN` (or the deprecated
   * `LATEX_API_KEY`) in Node. Public endpoints work without one.
   */
  apiKey?: string;
  /** Alias of `apiKey`. */
  token?: string;
  /** Custom fetch implementation (defaults to `globalThis.fetch`). */
  fetch?: typeof fetch;
  /** Sent as `User-Agent` outside browsers. */
  userAgent?: string;
}

export interface CreateTokenInput {
  name: string;
  /** Days until the token expires; `null` or omitted for a token that never expires. */
  expiresInDays?: number | null;
}

export interface DeviceStartInput {
  clientName?: string;
  hostname?: string;
  platform?: string;
}

/** One `POST /v1/auth/device/token` outcome; denial and expiry are thrown as errors. */
export type DevicePollResult =
  | { status: "pending" | "slow_down"; interval: number | undefined }
  | {
      status: "approved";
      token: string;
      tokenId: string;
      name: string;
      expiresAt?: string;
      user: { id: string; email?: string } | null;
    };

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export type { ApiCompileOptions, BibliographyMode, Diagnostic, Engine, Job };

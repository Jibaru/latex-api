import type { Engine } from "../domain/engine.js";
import type { CompileJob, CompileOptions, JobEvent, JobStatus, Principal } from "../domain/job.js";
import type { Project, ProjectFile } from "../domain/project.js";
import type { Template } from "../domain/template.js";

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/** A materialized project on disk (or wherever the adapter keeps it). */
export interface Workspace {
  jobId: string;
  entrypoint: string;
  engine: Engine;
}

export interface Workspaces {
  create(jobId: string, project: Project): Promise<Workspace>;
  /** Re-open a workspace created earlier (async jobs). */
  open(jobId: string): Promise<Workspace | null>;
  remove(jobId: string): Promise<void>;
}

export interface CompileRequest {
  workspace: Workspace;
  options: CompileOptions;
  /** Called with chunks of compiler output as they arrive. */
  onLog?: (chunk: string) => void;
}

export interface RawCompileOutput {
  exitCode: number | null;
  timedOut: boolean;
  /** Full LaTeX log (the .log file if present, else stdout/stderr). */
  log: string;
  /** Process stdout/stderr, useful when no .log was produced. */
  stdout: string;
  pdf?: Uint8Array;
  durationMs: number;
}

export interface Compiler {
  /** Identifies the compiler image/toolchain; part of the cache key. */
  version(): Promise<string>;
  compile(request: CompileRequest, signal: AbortSignal): Promise<RawCompileOutput>;
  /** Cheap liveness check used by /health. */
  ping(): Promise<{ ok: boolean; detail?: string }>;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface StoredArtifact {
  key: string;
  contentType: string;
  size: number;
}

export interface ArtifactStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<StoredArtifact>;
  get(key: string): Promise<Uint8Array | null>;
  stat(key: string): Promise<StoredArtifact | null>;
  /** Readable stream for large downloads. */
  stream(key: string): Promise<ReadableStream<Uint8Array> | null>;
  deletePrefix(prefix: string): Promise<void>;
  /** Free space information for /health. */
  usage(): Promise<{ usedBytes: number; freeBytes?: number }>;
}

export interface JobStats {
  byStatus: Record<JobStatus, number>;
  last24h: { total: number; succeeded: number; failed: number; cached: number };
  durationMs: { p50: number; p95: number };
}

export interface JobRepository {
  insert(job: CompileJob): Promise<void>;
  update(job: CompileJob): Promise<void>;
  get(id: string): Promise<CompileJob | null>;
  /** Latest terminal job with a cacheable result for this content hash. */
  findCacheable(projectHash: string, now: Date): Promise<CompileJob | null>;
  listExpired(now: Date, limit: number): Promise<CompileJob[]>;
  delete(ids: string[]): Promise<void>;
  countByHash(projectHash: string): Promise<number>;
  stats(now: Date): Promise<JobStats>;
  /** Jobs still marked running but started before the given instant (crash recovery). */
  listStale(startedBefore: Date): Promise<CompileJob[]>;
}

// ---------------------------------------------------------------------------
// Queueing and events
// ---------------------------------------------------------------------------

export interface JobQueue {
  enqueue(jobId: string, opts: { timeoutMs: number }): Promise<void>;
  /** Best-effort cancellation of a queued job. Running jobs are cancelled via events. */
  cancel(jobId: string): Promise<void>;
  /** Number of queued (not started) jobs. */
  depth(): Promise<number>;
}

export interface JobEvents {
  publish(event: JobEvent): void;
  subscribe(jobId: string, listener: (event: JobEvent) => void): () => void;
  /** Request cancellation of a running job on this instance. Returns true if it was running here. */
  requestCancel(jobId: string): boolean;
  onCancel(jobId: string, handler: () => void): () => void;
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

export interface ApiKeyResolver {
  resolve(token: string): Promise<Principal | null>;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  limit: number;
}

export interface RateLimiter {
  /** Sliding window counter. */
  consume(bucket: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
  /** Concurrency gate. Returns a release function or null when the gate is full. */
  acquire(bucket: string, max: number): Promise<(() => void) | null>;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface TemplateRepository {
  list(): Promise<Template[]>;
  get(id: string): Promise<Template | null>;
  files(id: string): Promise<ProjectFile[] | null>;
  readFile(id: string, path: string): Promise<Uint8Array | null>;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  jobId(): string;
}

export interface Logger {
  debug(obj: Record<string, unknown> | string, msg?: string): void;
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface WebhookNotifier {
  notify(url: string, payload: unknown): Promise<void>;
}

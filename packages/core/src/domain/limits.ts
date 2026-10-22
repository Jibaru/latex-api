export interface Limits {
  /** Maximum size of the raw upload (zip, multipart or JSON body). */
  maxUploadBytes: number;
  /** Maximum total size of the project files once decoded / unpacked. */
  maxUnpackedBytes: number;
  /** Maximum number of files in a project. */
  maxFiles: number;
  /** Maximum size of a single file. */
  maxFileBytes: number;
  /** Timeout applied to synchronous compiles. */
  syncTimeoutMs: number;
  /** Default timeout for asynchronous jobs. */
  jobTimeoutMs: number;
  /** Hard ceiling a client can request for an asynchronous job. */
  jobTimeoutMaxMs: number;
  /** Memory limit per compile container, in bytes. */
  jobMemoryBytes: number;
  /** CPU quota per compile container. */
  jobCpus: number;
  /** Maximum processes inside a compile container. */
  jobPids: number;
  /** Maximum compiles running at the same time on this instance. */
  maxConcurrentJobs: number;
  /** Hours before a job and its artifacts are purged. */
  artifactTtlHours: number;
  /** Compiles allowed per API key in a rolling hour. */
  rateLimitPerKeyPerHour: number;
  /** Compiles a single key may have running at once. */
  rateLimitConcurrentPerKey: number;
  /** Demo endpoint: compiles per IP per minute. */
  demoRateLimitPerMinute: number;
  /** Demo endpoint: compiles per IP per day. */
  demoRateLimitPerDay: number;
  /** Demo endpoint: timeout. */
  demoTimeoutMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxUploadBytes: 50 * 1024 * 1024,
  maxUnpackedBytes: 200 * 1024 * 1024,
  maxFiles: 500,
  maxFileBytes: 50 * 1024 * 1024,
  syncTimeoutMs: 60_000,
  jobTimeoutMs: 300_000,
  jobTimeoutMaxMs: 600_000,
  jobMemoryBytes: 2 * 1024 * 1024 * 1024,
  jobCpus: 2,
  jobPids: 64,
  maxConcurrentJobs: 2,
  artifactTtlHours: 24,
  rateLimitPerKeyPerHour: 60,
  rateLimitConcurrentPerKey: 5,
  demoRateLimitPerMinute: 5,
  demoRateLimitPerDay: 30,
  demoTimeoutMs: 30_000,
};

/** The subset of limits that is safe to expose publicly. */
export interface PublicLimits {
  maxUploadBytes: number;
  maxUnpackedBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  syncTimeoutMs: number;
  jobTimeoutMs: number;
  jobTimeoutMaxMs: number;
  jobMemoryBytes: number;
  jobCpus: number;
  artifactTtlHours: number;
  rateLimitPerKeyPerHour: number;
  rateLimitConcurrentPerKey: number;
  engines: readonly string[];
}

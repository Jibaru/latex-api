import path from "node:path";
import { DEFAULT_LIMITS, type Limits } from "@latex-api/core";

export type EnvSource = Record<string, string | undefined>;

export interface InfraConfig {
  limits: Limits;
  /** Directory the API uses for workspaces and artifacts. */
  dataDir: string;
  /** Same directory as seen by the Docker daemon (host path). Defaults to dataDir. */
  hostDataDir: string;
  compilerImage: string;
  /** Optional OCI runtime for compile containers (e.g. runsc). */
  compilerRuntime: string | undefined;
  /** Path to a seccomp profile JSON inside the API container, if any. */
  compilerSeccompProfile: string | undefined;
  /** uid:gid for the compile container; defaults to the current process on Linux. */
  compilerUser: string;
  dockerSocket: string | undefined;
  databaseUrl: string | undefined;
  templatesDir: string;
  apiKeys: string;
  demoApiKey: string | undefined;
  publicUrl: string;
  logLevel: string;
}

function int(env: EnvSource, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${key} must be a number`);
  return parsed;
}

function bytes(env: EnvSource, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?b?)$/i.exec(raw.trim());
  if (!m) throw new Error(`Environment variable ${key} must be a size like 50MB`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase().replace("b", "");
  const mult =
    unit === "k"
      ? 1024
      : unit === "m"
        ? 1024 ** 2
        : unit === "g"
          ? 1024 ** 3
          : unit === "t"
            ? 1024 ** 4
            : 1;
  return Math.floor(n * mult);
}

export function loadConfig(env: EnvSource = process.env): InfraConfig {
  const dataDir = path.resolve(/*turbopackIgnore: true*/ env.DATA_DIR ?? ".data");
  const d = DEFAULT_LIMITS;
  const limits: Limits = {
    maxUploadBytes: bytes(env, "MAX_UPLOAD_BYTES", d.maxUploadBytes),
    maxUnpackedBytes: bytes(env, "MAX_UNPACKED_BYTES", d.maxUnpackedBytes),
    maxFiles: int(env, "MAX_FILES", d.maxFiles),
    maxFileBytes: bytes(env, "MAX_FILE_BYTES", d.maxFileBytes),
    syncTimeoutMs: int(env, "SYNC_TIMEOUT_MS", d.syncTimeoutMs),
    jobTimeoutMs: int(env, "JOB_TIMEOUT_MS", d.jobTimeoutMs),
    jobTimeoutMaxMs: int(env, "JOB_TIMEOUT_MAX_MS", d.jobTimeoutMaxMs),
    jobMemoryBytes: bytes(env, "JOB_MEMORY", d.jobMemoryBytes),
    jobCpus: Number(env.JOB_CPUS ?? d.jobCpus),
    jobPids: int(env, "JOB_PIDS", d.jobPids),
    maxConcurrentJobs: int(env, "MAX_CONCURRENT_JOBS", d.maxConcurrentJobs),
    artifactTtlHours: Number(env.ARTIFACT_TTL_HOURS ?? d.artifactTtlHours),
    rateLimitPerKeyPerHour: int(env, "RATE_LIMIT_PER_KEY_PER_HOUR", d.rateLimitPerKeyPerHour),
    rateLimitConcurrentPerKey: int(
      env,
      "RATE_LIMIT_CONCURRENT_PER_KEY",
      d.rateLimitConcurrentPerKey,
    ),
    demoRateLimitPerMinute: int(env, "DEMO_RATE_LIMIT_PER_MINUTE", d.demoRateLimitPerMinute),
    demoRateLimitPerDay: int(env, "DEMO_RATE_LIMIT_PER_DAY", d.demoRateLimitPerDay),
    demoTimeoutMs: int(env, "DEMO_TIMEOUT_MS", d.demoTimeoutMs),
  };
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  return {
    limits,
    dataDir,
    hostDataDir: env.HOST_DATA_DIR ? env.HOST_DATA_DIR : dataDir,
    compilerImage: env.COMPILER_IMAGE ?? "ghcr.io/jibaru/latex-compiler:latest",
    compilerRuntime: env.COMPILER_RUNTIME || undefined,
    compilerSeccompProfile: env.COMPILER_SECCOMP_PROFILE || undefined,
    compilerUser: env.COMPILER_USER ?? `${uid}:${gid}`,
    dockerSocket: env.DOCKER_SOCKET || undefined,
    databaseUrl: env.DATABASE_URL || undefined,
    templatesDir: path.resolve(
      /*turbopackIgnore: true*/ env.TEMPLATES_DIR ?? "../../packages/templates/templates",
    ),
    apiKeys: env.API_KEYS ?? "",
    demoApiKey: env.DEMO_API_KEY || undefined,
    publicUrl: (env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    logLevel: env.LOG_LEVEL ?? "info",
  };
}

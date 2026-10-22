import type { BibliographyMode } from "../domain/engine.js";
import { InvalidProjectError, RateLimitedError } from "../domain/errors.js";
import type { CompileJob, CompileOptions, JobMode, Principal } from "../domain/job.js";
import { type Project, projectHash } from "../domain/project.js";
import {
  buildJob,
  cancelSignalReason,
  cloneCachedJob,
  isCacheable,
  runCompile,
} from "./compile-pipeline.js";
import type { CoreDeps } from "./deps.js";

export interface CompileOptionsInput {
  timeoutMs?: number;
  bibliography?: BibliographyMode;
  webhookUrl?: string;
  /** Skip the content cache and force a fresh compile. */
  force?: boolean;
}

export interface CompileCommand {
  project: Project;
  principal: Principal;
  options?: CompileOptionsInput;
  templateId?: string;
}

/** Resolves user options against limits for the given mode. */
export function resolveOptions(
  deps: CoreDeps,
  mode: JobMode,
  input: CompileOptionsInput | undefined,
): CompileOptions {
  const { limits } = deps;
  const ceiling =
    mode === "sync"
      ? limits.syncTimeoutMs
      : mode === "demo"
        ? limits.demoTimeoutMs
        : limits.jobTimeoutMaxMs;
  const fallback = mode === "async" ? limits.jobTimeoutMs : ceiling;
  let timeoutMs = input?.timeoutMs ?? fallback;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new InvalidProjectError("timeoutMs must be a positive number");
  }
  timeoutMs = Math.min(Math.floor(timeoutMs), ceiling);
  if (input?.webhookUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(input.webhookUrl);
    } catch {
      throw new InvalidProjectError("webhookUrl must be a valid URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new InvalidProjectError("webhookUrl must use http or https");
    }
  }
  return {
    timeoutMs,
    bibliography: input?.bibliography ?? "auto",
    maxPasses: 8,
    webhookUrl: input?.webhookUrl,
  };
}

/** Applies per-principal rate limiting. Throws RateLimitedError. */
export async function enforceRateLimit(deps: CoreDeps, principal: Principal): Promise<void> {
  if (principal.kind === "demo") return; // demo is limited per IP by the HTTP layer
  const decision = await deps.rateLimiter.consume(
    `key:${principal.name}:hour`,
    deps.limits.rateLimitPerKeyPerHour,
    3_600_000,
  );
  if (!decision.allowed) {
    throw new RateLimitedError(Math.ceil(decision.retryAfterMs / 1000));
  }
}

/**
 * Synchronous compile: validates, consults the cache, compiles in-process and returns a
 * terminal job. Used by `POST /v1/compile` and the demo endpoint.
 */
export class CompileProject {
  constructor(private readonly deps: CoreDeps) {}

  async execute(command: CompileCommand, mode: "sync" | "demo" = "sync"): Promise<CompileJob> {
    const deps = this.deps;
    const options = resolveOptions(deps, mode, command.options);
    await enforceRateLimit(deps, command.principal);

    const compilerVersion = await deps.compiler.version();
    const hash = projectHash(command.project, compilerVersion);
    const job = buildJob(deps, {
      project: command.project,
      mode,
      principal: command.principal,
      options,
      projectHash: hash,
      compilerVersion,
      templateId: command.templateId,
    });

    if (!command.options?.force) {
      const cached = await deps.jobs.findCacheable(hash, deps.clock.now());
      if (cached && isCacheable(cached)) {
        deps.logger.info({ jobId: job.id, from: cached.id }, "served from cache");
        return cloneCachedJob(deps, job, cached);
      }
    }

    const release = await acquireSlots(deps, command.principal);
    try {
      await deps.jobs.insert(job);
      deps.events.publish({ type: "queued", jobId: job.id, at: job.createdAt.toISOString() });
      const workspace = await deps.workspaces.create(job.id, command.project);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort("timeout"), options.timeoutMs + 5_000);
      const offCancel = deps.events.onCancel(job.id, () => controller.abort(cancelSignalReason()));
      try {
        return await runCompile(deps, job, workspace, controller.signal);
      } finally {
        clearTimeout(timer);
        offCancel();
        await deps.workspaces.remove(job.id).catch(() => undefined);
      }
    } finally {
      release();
    }
  }
}

/** Takes both the global and the per-key concurrency slots, waiting briefly for the global one. */
export async function acquireSlots(deps: CoreDeps, principal: Principal): Promise<() => void> {
  const perKey =
    principal.kind === "demo"
      ? await deps.rateLimiter.acquire("concurrency:demo", 1)
      : await deps.rateLimiter.acquire(
          `concurrency:key:${principal.name}`,
          deps.limits.rateLimitConcurrentPerKey,
        );
  if (!perKey) throw new RateLimitedError(5, "Too many concurrent compilations for this key");

  const deadline = Date.now() + 15_000;
  let global: (() => void) | null = null;
  while (!global) {
    global = await deps.rateLimiter.acquire("concurrency:global", deps.limits.maxConcurrentJobs);
    if (global) break;
    if (Date.now() > deadline) {
      perKey();
      throw new RateLimitedError(10, "Server is busy, retry shortly or use an async job");
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return () => {
    global?.();
    perKey();
  };
}

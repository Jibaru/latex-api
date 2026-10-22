import { ENGINES } from "../domain/engine.js";
import type { PublicLimits } from "../domain/limits.js";
import { artifactKeys, type CoreDeps } from "./deps.js";

/** Deletes expired jobs and the artifacts nobody references any more. */
export class PurgeExpired {
  constructor(private readonly deps: CoreDeps) {}

  async execute(batch = 200): Promise<{ jobs: number; artifactSets: number }> {
    const { jobs, artifacts, clock, logger } = this.deps;
    const expired = await jobs.listExpired(clock.now(), batch);
    if (expired.length === 0) return { jobs: 0, artifactSets: 0 };
    await jobs.delete(expired.map((j) => j.id));
    const hashes = new Set(expired.map((j) => j.projectHash));
    let removed = 0;
    for (const hash of hashes) {
      if ((await jobs.countByHash(hash)) === 0) {
        await artifacts.deletePrefix(artifactKeys.prefix(hash));
        removed++;
      }
    }
    logger.info({ jobs: expired.length, artifactSets: removed }, "purged expired jobs");
    return { jobs: expired.length, artifactSets: removed };
  }
}

/** Marks jobs that were running when the process died as failed. */
export class RecoverStaleJobs {
  constructor(private readonly deps: CoreDeps) {}

  async execute(olderThanMs = 15 * 60_000): Promise<number> {
    const { jobs, clock } = this.deps;
    const stale = await jobs.listStale(new Date(clock.now().getTime() - olderThanMs));
    for (const job of stale) {
      job.status = "failed";
      job.finishedAt = clock.now();
      job.error = { reason: "internal", message: "Worker restarted while the job was running" };
      await jobs.update(job);
      await this.deps.workspaces.remove(job.id).catch(() => undefined);
    }
    return stale.length;
  }
}

export class GetLimits {
  constructor(private readonly deps: CoreDeps) {}

  execute(): PublicLimits {
    const l = this.deps.limits;
    return {
      maxUploadBytes: l.maxUploadBytes,
      maxUnpackedBytes: l.maxUnpackedBytes,
      maxFiles: l.maxFiles,
      maxFileBytes: l.maxFileBytes,
      syncTimeoutMs: l.syncTimeoutMs,
      jobTimeoutMs: l.jobTimeoutMs,
      jobTimeoutMaxMs: l.jobTimeoutMaxMs,
      jobMemoryBytes: l.jobMemoryBytes,
      jobCpus: l.jobCpus,
      artifactTtlHours: l.artifactTtlHours,
      rateLimitPerKeyPerHour: l.rateLimitPerKeyPerHour,
      rateLimitConcurrentPerKey: l.rateLimitConcurrentPerKey,
      engines: ENGINES,
    };
  }
}

export class GetStats {
  constructor(private readonly deps: CoreDeps) {}

  async execute() {
    const [stats, depth, usage, compilerVersion] = await Promise.all([
      this.deps.jobs.stats(this.deps.clock.now()),
      this.deps.queue.depth(),
      this.deps.artifacts.usage(),
      this.deps.compiler.version(),
    ]);
    return { ...stats, queueDepth: depth, storage: usage, compilerVersion };
  }
}

export class GetHealth {
  constructor(private readonly deps: CoreDeps) {}

  async execute(): Promise<{
    status: "ok" | "degraded";
    checks: Record<string, { ok: boolean; detail?: string }>;
  }> {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      await this.deps.jobs.stats(this.deps.clock.now());
      checks.database = { ok: true };
    } catch (error) {
      checks.database = { ok: false, detail: message(error) };
    }
    try {
      checks.compiler = await this.deps.compiler.ping();
    } catch (error) {
      checks.compiler = { ok: false, detail: message(error) };
    }
    try {
      const usage = await this.deps.artifacts.usage();
      const low = usage.freeBytes !== undefined && usage.freeBytes < 512 * 1024 * 1024;
      checks.storage = {
        ok: !low,
        detail:
          usage.freeBytes !== undefined
            ? `${Math.round(usage.freeBytes / 1048576)} MB free`
            : undefined,
      };
    } catch (error) {
      checks.storage = { ok: false, detail: message(error) };
    }
    const ok = Object.values(checks).every((c) => c.ok);
    return { status: ok ? "ok" : "degraded", checks };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

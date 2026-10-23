import {
  type CompileJob,
  isTerminal,
  JOB_STATUSES,
  type JobQueue,
  type JobRepository,
  type JobStats,
  type JobStatus,
} from "@latex-api/core";

/** Volatile job store for development and tests (no DATABASE_URL). */
export class MemoryJobRepository implements JobRepository {
  private readonly rows = new Map<string, CompileJob>();

  async insert(job: CompileJob): Promise<void> {
    this.rows.set(job.id, structuredClone(job));
  }
  async update(job: CompileJob): Promise<void> {
    this.rows.set(job.id, structuredClone(job));
  }
  async get(id: string): Promise<CompileJob | null> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : null;
  }
  async findCacheable(projectHash: string, now: Date): Promise<CompileJob | null> {
    const hits = Array.from(this.rows.values())
      .filter(
        (j) =>
          j.projectHash === projectHash &&
          isTerminal(j.status) &&
          j.expiresAt > now &&
          j.result &&
          (j.status === "succeeded" ||
            (j.status === "failed" && j.error?.reason === "compile_failed")),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return hits[0] ? structuredClone(hits[0]) : null;
  }
  async listExpired(now: Date, limit: number): Promise<CompileJob[]> {
    return Array.from(this.rows.values())
      .filter((j) => j.expiresAt <= now)
      .slice(0, limit)
      .map((j) => structuredClone(j));
  }
  async delete(ids: string[]): Promise<void> {
    for (const id of ids) this.rows.delete(id);
  }
  async countByHash(projectHash: string): Promise<number> {
    let n = 0;
    for (const j of this.rows.values()) if (j.projectHash === projectHash) n++;
    return n;
  }
  async listByOwner(owner: string, limit: number): Promise<CompileJob[]> {
    return Array.from(this.rows.values())
      .filter((j) => j.principal.name === owner)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((j) => structuredClone(j));
  }
  async listStale(startedBefore: Date): Promise<CompileJob[]> {
    return Array.from(this.rows.values()).filter(
      (j) => j.status === "running" && j.startedAt !== undefined && j.startedAt < startedBefore,
    );
  }
  async stats(now: Date): Promise<JobStats> {
    const byStatus = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<
      JobStatus,
      number
    >;
    const since = now.getTime() - 24 * 3_600_000;
    let total = 0;
    let succeeded = 0;
    let failed = 0;
    let cached = 0;
    const durations: number[] = [];
    for (const j of this.rows.values()) {
      byStatus[j.status]++;
      if (j.createdAt.getTime() >= since) {
        total++;
        if (j.status === "succeeded") succeeded++;
        if (j.status === "failed" || j.status === "timed_out") failed++;
        if (j.result?.cached) cached++;
        if (j.result && !j.result.cached) durations.push(j.result.durationMs);
      }
    }
    durations.sort((a, b) => a - b);
    const pct = (p: number) =>
      durations.length
        ? durations[Math.min(durations.length - 1, Math.floor(p * durations.length))]!
        : 0;
    return {
      byStatus,
      last24h: { total, succeeded, failed, cached },
      durationMs: { p50: pct(0.5), p95: pct(0.95) },
    };
  }
}

/** Runs jobs in-process right after enqueue; used when no Postgres is configured. */
export class InlineJobQueue implements JobQueue {
  private handler: ((jobId: string, signal: AbortSignal) => Promise<void>) | undefined;
  private readonly pending = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly controller = new AbortController();

  setHandler(handler: (jobId: string, signal: AbortSignal) => Promise<void>): void {
    this.handler = handler;
  }

  async enqueue(jobId: string): Promise<void> {
    this.pending.add(jobId);
    setImmediate(() => {
      this.pending.delete(jobId);
      if (this.cancelled.delete(jobId)) return;
      void this.handler?.(jobId, this.controller.signal);
    });
  }

  async cancel(jobId: string): Promise<void> {
    if (this.pending.has(jobId)) this.cancelled.add(jobId);
  }

  async depth(): Promise<number> {
    return this.pending.size;
  }

  stop(): void {
    this.controller.abort("shutdown");
  }
}

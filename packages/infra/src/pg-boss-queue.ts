import type { JobQueue, Logger } from "@latex-api/core";
import { PgBoss } from "pg-boss";

export const COMPILE_QUEUE = "compile";
export const PURGE_QUEUE = "purge";

export interface PgBossQueueOptions {
  connectionString: string;
  logger: Logger;
  schema?: string;
}

/**
 * pg-boss backed queue. Job ids are UUIDs so our job id doubles as the pg-boss job id,
 * which makes cancellation of queued jobs trivial.
 */
export class PgBossQueue implements JobQueue {
  readonly boss: PgBoss;
  private started = false;

  constructor(private readonly opts: PgBossQueueOptions) {
    this.boss = new PgBoss({
      connectionString: opts.connectionString,
      schema: opts.schema ?? "pgboss",
      supervise: true,
      schedule: true,
    });
    this.boss.on("error", (error) => opts.logger.error({ err: error }, "pg-boss error"));
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    await this.boss.createQueue(COMPILE_QUEUE, {
      retryLimit: 0,
      expireInSeconds: 60 * 15,
      retentionSeconds: 60 * 60 * 24,
      deleteAfterSeconds: 60 * 60 * 48,
    });
    await this.boss.createQueue(PURGE_QUEUE, {
      retryLimit: 1,
      expireInSeconds: 60 * 5,
      retentionSeconds: 60 * 60,
      deleteAfterSeconds: 60 * 60 * 24,
    });
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.boss.stop({ graceful: true, timeout: 20_000 });
    this.started = false;
  }

  async enqueue(jobId: string, opts: { timeoutMs: number }): Promise<void> {
    await this.boss.send(
      COMPILE_QUEUE,
      { jobId },
      {
        id: jobId,
        singletonKey: jobId,
        expireInSeconds: Math.ceil(opts.timeoutMs / 1000) + 120,
      },
    );
  }

  async cancel(jobId: string): Promise<void> {
    await this.boss.cancel(COMPILE_QUEUE, jobId).catch(() => undefined);
  }

  async depth(): Promise<number> {
    try {
      const stats = await this.boss.getQueueStats(COMPILE_QUEUE);
      return stats.reduce((n, s) => n + (s.queuedCount ?? 0), 0);
    } catch {
      return 0;
    }
  }

  /** Registers `concurrency` workers that call `handler` for each job. */
  async work(
    concurrency: number,
    handler: (jobId: string, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    await this.boss.work<{ jobId: string }>(
      COMPILE_QUEUE,
      { localConcurrency: Math.max(1, concurrency), batchSize: 1, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) {
          await handler(job.data.jobId, job.signal);
        }
      },
    );
  }

  /** Runs `handler` on a cron schedule (single instance across the cluster). */
  async schedulePurge(cron: string, handler: () => Promise<void>): Promise<void> {
    await this.boss.work(PURGE_QUEUE, { localConcurrency: 1, batchSize: 1 }, async () => {
      await handler();
    });
    await this.boss.schedule(PURGE_QUEUE, cron, {}, { singletonKey: "purge" });
  }
}

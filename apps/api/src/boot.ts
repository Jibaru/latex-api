import { InlineJobQueue, migrate, PgBossQueue } from "@latex-api/infra";
import { getContainer } from "./container";

const BOOT_KEY = Symbol.for("latex-api.boot");
type GlobalWithBoot = typeof globalThis & { [BOOT_KEY]?: Promise<void> };

/**
 * Process start-up: migrations, queue workers, scheduled purge, crash recovery.
 * Safe to call more than once; the work happens a single time per process (the promise
 * lives on globalThis because Next.js bundles instrumentation separately from routes).
 */
export function boot(): Promise<void> {
  const g = globalThis as GlobalWithBoot;
  if (!g[BOOT_KEY]) {
    g[BOOT_KEY] = doBoot().catch((error) => {
      g[BOOT_KEY] = undefined;
      throw error;
    });
  }
  return g[BOOT_KEY];
}

async function doBoot(): Promise<void> {
  const container = getContainer();
  const { deps, config, useCases, compiler, workspaces } = container;
  const logger = deps.logger.child({ component: "boot" });

  if (container.pool) {
    await migrate(container.pool);
    logger.info("database migrations applied");
  }

  try {
    const reaped = await compiler.reapOrphans();
    if (reaped > 0) logger.warn({ reaped }, "removed orphan compile containers");
  } catch (error) {
    logger.warn({ err: error }, "could not reap orphan containers (is the Docker socket mounted?)");
  }

  const recovered = await useCases.recoverStaleJobs.execute(0).catch(() => 0);
  if (recovered > 0) logger.warn({ recovered }, "marked stale running jobs as failed");
  await workspaces.sweep(6 * 3_600_000).catch(() => 0);

  const handler = async (jobId: string, signal: AbortSignal) => {
    try {
      await useCases.processCompileJob.execute(jobId, signal);
    } catch (error) {
      logger.error({ err: error, jobId }, "job processing failed");
    }
  };

  if (container.queue instanceof PgBossQueue) {
    await container.queue.start();
    await container.queue.work(config.limits.maxConcurrentJobs, handler);
    await container.queue.schedulePurge("*/15 * * * *", async () => {
      await useCases.purgeExpired.execute();
      await workspaces.sweep(6 * 3_600_000);
    });
    logger.info({ concurrency: config.limits.maxConcurrentJobs }, "pg-boss workers started");
  } else if (container.queue instanceof InlineJobQueue) {
    container.queue.setHandler(handler);
    const timer = setInterval(
      () => void useCases.purgeExpired.execute().catch(() => undefined),
      15 * 60_000,
    );
    timer.unref();
  }

  void compiler
    .version()
    .then((v) => logger.info({ compiler: v }, "compiler image ready"))
    .catch((error) => logger.error({ err: error }, "compiler image unavailable"));

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    try {
      if (container.queue instanceof PgBossQueue) await container.queue.stop();
      else if (container.queue instanceof InlineJobQueue) container.queue.stop();
      await container.pool?.end();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

import { JobNotCancellableError, JobNotFoundError } from "../domain/errors";
import { type CompileJob, canCancel, isTerminal } from "../domain/job";
import { projectHash } from "../domain/project";
import {
  buildJob,
  cancelSignalReason,
  cloneCachedJob,
  isCacheable,
  runCompile,
} from "./compile-pipeline";
import {
  acquireSlots,
  type CompileCommand,
  enforceRateLimit,
  resolveOptions,
} from "./compile-project";
import type { CoreDeps } from "./deps";

/** Creates a job, stores the workspace and enqueues it. Returns immediately. */
export class EnqueueCompileJob {
  constructor(private readonly deps: CoreDeps) {}

  async execute(command: CompileCommand): Promise<CompileJob> {
    const deps = this.deps;
    const options = resolveOptions(deps, "async", command.options);
    await enforceRateLimit(deps, command.principal);

    const compilerVersion = await deps.compiler.version();
    const hash = projectHash(command.project, compilerVersion);
    const job = buildJob(deps, {
      project: command.project,
      mode: "async",
      principal: command.principal,
      options,
      projectHash: hash,
      compilerVersion,
      templateId: command.templateId,
    });

    if (!command.options?.force) {
      const cached = await deps.jobs.findCacheable(hash, deps.clock.now());
      if (cached && isCacheable(cached)) {
        const cloned = await cloneCachedJob(deps, job, cached);
        if (options.webhookUrl) {
          void deps.webhooks
            .notify(options.webhookUrl, webhookPayload(cloned))
            .catch(() => undefined);
        }
        return cloned;
      }
    }

    await deps.workspaces.create(job.id, command.project);
    await deps.jobs.insert(job);
    await deps.queue.enqueue(job.id, { timeoutMs: options.timeoutMs });
    deps.events.publish({ type: "queued", jobId: job.id, at: job.createdAt.toISOString() });
    return job;
  }
}

/** Worker-side execution of a queued job. */
export class ProcessCompileJob {
  constructor(private readonly deps: CoreDeps) {}

  async execute(jobId: string, workerSignal?: AbortSignal): Promise<CompileJob> {
    const deps = this.deps;
    const job = await deps.jobs.get(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    if (isTerminal(job.status)) return job;

    const workspace = await deps.workspaces.open(job.id);
    if (!workspace) {
      job.status = "failed";
      job.finishedAt = deps.clock.now();
      job.error = { reason: "internal", message: "Workspace is missing" };
      await deps.jobs.update(job);
      return job;
    }

    const release = await acquireSlots(deps, job.principal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), job.options.timeoutMs + 5_000);
    const offCancel = deps.events.onCancel(job.id, () => controller.abort(cancelSignalReason()));
    const onWorkerAbort = () => controller.abort("shutdown");
    workerSignal?.addEventListener("abort", onWorkerAbort, { once: true });
    try {
      const finished = await runCompile(deps, job, workspace, controller.signal);
      if (finished.options.webhookUrl) {
        void deps.webhooks
          .notify(finished.options.webhookUrl, webhookPayload(finished))
          .catch((err) => deps.logger.warn({ err, jobId }, "webhook delivery failed"));
      }
      return finished;
    } finally {
      clearTimeout(timer);
      offCancel();
      workerSignal?.removeEventListener("abort", onWorkerAbort);
      release();
      await deps.workspaces.remove(job.id).catch(() => undefined);
    }
  }
}

export class GetJob {
  constructor(private readonly deps: CoreDeps) {}

  async execute(jobId: string, principal?: { name: string }): Promise<CompileJob> {
    const job = await this.deps.jobs.get(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    if (principal && job.principal.name !== principal.name && job.principal.kind !== "demo") {
      // Hide other keys' jobs: pretend it does not exist.
      throw new JobNotFoundError(jobId);
    }
    return job;
  }
}

export class CancelJob {
  constructor(private readonly deps: CoreDeps) {}

  async execute(jobId: string, principal?: { name: string }): Promise<CompileJob> {
    const job = await new GetJob(this.deps).execute(jobId, principal);
    if (!canCancel(job.status)) throw new JobNotCancellableError(jobId, job.status);
    const wasRunningHere = this.deps.events.requestCancel(jobId);
    if (job.status === "queued" && !wasRunningHere) {
      await this.deps.queue.cancel(jobId);
      job.status = "cancelled";
      job.finishedAt = this.deps.clock.now();
      job.error = { reason: "cancelled", message: "Cancelled by client" };
      await this.deps.jobs.update(job);
      await this.deps.workspaces.remove(jobId).catch(() => undefined);
      this.deps.events.publish({
        type: "error",
        jobId,
        at: job.finishedAt.toISOString(),
        status: "cancelled",
        message: "Cancelled by client",
      });
    }
    return job;
  }
}

export function webhookPayload(job: CompileJob) {
  return {
    event: job.status === "succeeded" ? "job.succeeded" : "job.failed",
    job: {
      id: job.id,
      status: job.status,
      engine: job.engine,
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString(),
      errors: job.result?.errors ?? 0,
      warnings: job.result?.warnings ?? 0,
      durationMs: job.result?.durationMs ?? 0,
      cached: job.result?.cached ?? false,
      error: job.error,
    },
  };
}

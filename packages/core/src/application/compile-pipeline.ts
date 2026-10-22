import type { CompileJob, JobResult } from "../domain/job";
import { parseLatexLog, summarizeDiagnostics } from "../domain/log-parser";
import type { Project } from "../domain/project";
import type { Workspace } from "../ports/index";
import { artifactKeys, type CoreDeps } from "./deps";

/**
 * Shared compile pipeline for sync, async and demo compiles. Mutates and persists the job.
 * Caller is responsible for creating the workspace beforehand and for rate limiting.
 */
export async function runCompile(
  deps: CoreDeps,
  job: CompileJob,
  workspace: Workspace,
  signal: AbortSignal,
): Promise<CompileJob> {
  const { compiler, artifacts, jobs, events, clock, logger } = deps;
  const log = logger.child({ jobId: job.id });

  job.status = "running";
  job.startedAt = clock.now();
  await jobs.update(job);
  events.publish({ type: "running", jobId: job.id, at: job.startedAt.toISOString() });

  const startedAt = Date.now();
  try {
    const output = await compiler.compile(
      {
        workspace,
        options: job.options,
        onLog: (chunk) =>
          events.publish({ type: "log", jobId: job.id, at: new Date().toISOString(), chunk }),
      },
      signal,
    );

    const fullLog = output.log.length > 0 ? output.log : output.stdout;
    const diagnostics = parseLatexLog(fullLog);
    const { errors, warnings } = summarizeDiagnostics(diagnostics);
    const logStored = await artifacts.put(
      artifactKeys.log(job.projectHash),
      new TextEncoder().encode(fullLog),
      "text/plain; charset=utf-8",
    );

    const result: JobResult = {
      logKey: logStored.key,
      diagnostics,
      errors,
      warnings,
      durationMs: output.durationMs,
      exitCode: output.exitCode,
      cached: false,
    };

    if (output.pdf && output.pdf.byteLength > 0) {
      const pdfStored = await artifacts.put(
        artifactKeys.pdf(job.projectHash),
        output.pdf,
        "application/pdf",
      );
      result.pdfKey = pdfStored.key;
      result.pdfBytes = pdfStored.size;
      result.pages = pagesFromLog(fullLog) ?? countPdfPages(output.pdf);
    }

    job.result = result;
    job.finishedAt = clock.now();

    if (signal.aborted && job.status === "running" && cancelRequested(signal)) {
      job.status = "cancelled";
      job.error = { reason: "cancelled", message: "Cancelled by client" };
    } else if (output.timedOut) {
      job.status = "timed_out";
      job.error = {
        reason: "timeout",
        message: `Compilation exceeded ${job.options.timeoutMs} ms`,
      };
    } else if (output.exitCode === 0 && result.pdfKey) {
      job.status = "succeeded";
    } else {
      job.status = "failed";
      job.error = {
        reason: "compile_failed",
        message: firstErrorMessage(diagnostics) ?? `Compiler exited with code ${output.exitCode}`,
      };
    }
  } catch (error) {
    job.finishedAt = clock.now();
    if (signal.aborted && cancelRequested(signal)) {
      job.status = "cancelled";
      job.error = { reason: "cancelled", message: "Cancelled by client" };
    } else {
      job.status = "failed";
      job.error = {
        reason: "internal",
        message: error instanceof Error ? error.message : "Unknown compiler error",
      };
      log.error({ err: error }, "compile pipeline crashed");
    }
    if (!job.result) {
      job.result = {
        logKey: artifactKeys.log(job.projectHash),
        diagnostics: [],
        errors: 0,
        warnings: 0,
        durationMs: Date.now() - startedAt,
        exitCode: null,
        cached: false,
      };
    }
  }

  await jobs.update(job);
  const at = (job.finishedAt ?? clock.now()).toISOString();
  if (job.status === "succeeded") {
    events.publish({ type: "done", jobId: job.id, at, status: job.status });
  } else {
    events.publish({
      type: "error",
      jobId: job.id,
      at,
      status: job.status,
      message: job.error?.message ?? "Compilation failed",
    });
  }
  log.info(
    { status: job.status, durationMs: job.result?.durationMs, errors: job.result?.errors },
    "compile finished",
  );
  return job;
}

/** Creates the job record for a project; does not persist. */
export function buildJob(
  deps: CoreDeps,
  input: {
    project: Project;
    mode: CompileJob["mode"];
    principal: CompileJob["principal"];
    options: CompileJob["options"];
    projectHash: string;
    compilerVersion: string;
    templateId?: string;
  },
): CompileJob {
  const now = deps.clock.now();
  return {
    id: deps.ids.jobId(),
    status: "queued",
    mode: input.mode,
    engine: input.project.engine,
    entrypoint: input.project.entrypoint,
    projectHash: input.projectHash,
    fileCount: input.project.files.length,
    totalBytes: input.project.totalBytes,
    options: input.options,
    principal: input.principal,
    templateId: input.templateId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + deps.limits.artifactTtlHours * 3_600_000),
    compilerVersion: input.compilerVersion,
  };
}

/** Returns a job that reuses the cached result of `source`, persisted as a new record. */
export async function cloneCachedJob(
  deps: CoreDeps,
  fresh: CompileJob,
  source: CompileJob,
): Promise<CompileJob> {
  const now = deps.clock.now();
  fresh.status = source.status;
  fresh.startedAt = now;
  fresh.finishedAt = now;
  fresh.result = source.result ? { ...source.result, cached: true, durationMs: 0 } : undefined;
  fresh.error = source.error;
  await deps.jobs.insert(fresh);
  deps.events.publish({
    type: fresh.status === "succeeded" ? "done" : "error",
    jobId: fresh.id,
    at: now.toISOString(),
    status: fresh.status,
    message: fresh.error?.message ?? "",
  } as never);
  return fresh;
}

export function isCacheable(job: CompileJob): boolean {
  if (!job.result) return false;
  if (job.status === "succeeded") return true;
  // Deterministic failures are cacheable too; timeouts and internal errors are not.
  return job.status === "failed" && job.error?.reason === "compile_failed";
}

function firstErrorMessage(diagnostics: ReturnType<typeof parseLatexLog>): string | undefined {
  const first = diagnostics.find((d) => d.severity === "error");
  if (!first) return undefined;
  return first.file && first.line ? `${first.file}:${first.line}: ${first.message}` : first.message;
}

const CANCEL_REASON = "cancelled";
export function cancelSignalReason(): string {
  return CANCEL_REASON;
}
function cancelRequested(signal: AbortSignal): boolean {
  return signal.reason === CANCEL_REASON || signal.reason?.message === CANCEL_REASON;
}

/** Page count as reported by the engine: `Output written on main.pdf (3 pages, 1234 bytes).` */
export function pagesFromLog(log: string): number | undefined {
  const matches = log.match(/Output written on [^\n]*?\((\d+) pages?/g);
  if (!matches || matches.length === 0) return undefined;
  const last = /\((\d+) pages?/.exec(matches[matches.length - 1]!);
  return last ? Number(last[1]) : undefined;
}

/** Fallback page count for PDFs without object streams: counts `/Type /Page` objects. */
export function countPdfPages(pdf: Uint8Array): number | undefined {
  const text = latin1(pdf);
  const matches = text.match(/\/Type\s*\/Page(?![s\w])/g);
  if (!matches) return undefined;
  return matches.length;
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return out;
}

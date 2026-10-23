import path from "node:path";
import { CompileFailedError, type Job, type LatexApiError } from "@jibaru/latex-api-sdk";
import type { ArgsDef } from "citty";
import { rt } from "../blocks/runtime";
import { colors } from "../blocks/style";
import { leaf, t } from "../command";
import type { AppContext } from "../context";
import { formatDiagnostics, formatJobFailure } from "../diagnostics";
import { CliError, EXIT, toCliError } from "../exit";
import { appendLedger } from "../ledger";
import { errorEnvelope, log, out, progress, successEnvelope, writeEnvelope } from "../output";
import {
  BIBLIOGRAPHY_MODES,
  createWatchFilter,
  ENGINES,
  parseCompileOptions,
  parseEngine,
  prepareProject,
  type ResolvedProject,
  resolveProject,
} from "../project";
import {
  formatBytes,
  formatDuration,
  openFile,
  plural,
  relativeToCwd,
  timestamp,
  writeOutput,
} from "../ui";

export const compileArgs = {
  path: {
    type: "positional",
    description: "A .tex file (sent on its own) or a project directory (zipped)",
    default: ".",
    required: false,
  },
  "with-siblings": {
    type: "boolean",
    description: "For a .tex file: zip its whole folder so \\input and figures resolve",
  },
  engine: { type: "enum", options: [...ENGINES], description: "TeX engine (default: detected)" },
  entrypoint: { type: "string", description: "Main .tex file relative to the project directory" },
  output: {
    type: "string",
    alias: "o",
    description: "Where to write the PDF (default: <entrypoint>.pdf)",
  },
  timeout: { type: "string", description: "Compile timeout in milliseconds", valueHint: "ms" },
  bibliography: {
    type: "enum",
    options: [...BIBLIOGRAPHY_MODES],
    description: "Bibliography tool: auto, bibtex, biber or none",
  },
  force: { type: "boolean", description: "Skip the server-side cache" },
} as const satisfies ArgsDef;

export const pdfShape = t.object({ path: t.string(), bytes: t.number() });

/** Builds a compile_failed error carrying the diagnostics an agent needs to fix the source. */
export function jobFailure(job: Job): CliError {
  const reason =
    job.status === "timed_out"
      ? "Compilation timed out"
      : job.status === "cancelled"
        ? "The job was cancelled"
        : (job.error?.message ?? "LaTeX reported errors");
  return new CliError(job.status === "failed" ? "compile_failed" : `job_${job.status}`, reason, {
    exitCode: EXIT.COMPILE_FAILED,
    hint:
      job.status === "timed_out"
        ? "Raise --timeout (see `latex-api limits`) or use `latex-api jobs create --wait`"
        : "Fix the errors in error.details.diagnostics (file:line), then re-run the same command",
    details: {
      jobId: job.id,
      status: job.status,
      errors: job.result?.errors,
      warnings: job.result?.warnings,
      diagnostics: job.result?.diagnostics ?? [],
      logUrl: job.result?.logUrl,
    },
  });
}

/** Human rendering of a failed compile: the compact `file:line: error: ...` report. */
export function printFailure(error: CliError): void {
  const details = error.details ?? {};
  const diagnostics = Array.isArray(details.diagnostics) ? details.diagnostics : [];
  if (diagnostics.length === 0 && !details.logUrl) return;
  rt().stderr.write(
    `${formatDiagnostics(diagnostics as Parameters<typeof formatDiagnostics>[0], {
      color: colors(rt().stderr).enabled,
      logUrl: typeof details.logUrl === "string" ? details.logUrl : undefined,
      jobId: typeof details.jobId === "string" ? details.jobId : undefined,
    })}\n`,
  );
}

export { formatJobFailure };

export interface CompileData {
  /** Same field as error.details.jobId on failure, so scripts read one place. */
  jobId: string;
  entrypoint?: string;
  job: Job | { id: string; status: "succeeded"; cached: boolean; warnings: number };
  pdf: { path: string; bytes: number };
  /** Server time spent compiling for this request; 0 when the result came from cache. */
  compileMs: number;
  /** Wall-clock time of the whole command: pack, upload, compile or cache hit, download. */
  totalMs: number;
}

/** Extracts the byte limit from problem details such as "Request body exceeds 52428800 bytes". */
export function parseByteLimit(error: LatexApiError): number | undefined {
  const text = `${error.problem?.detail ?? ""} ${error.message}`;
  const match = /(\d{4,})\s*bytes/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

export interface ReportContext {
  uploadBytes?: number;
  transport?: ResolvedProject["transport"];
}

export function describePayloadTooLarge(error: LatexApiError, context: ReportContext): string {
  const limit = parseByteLimit(error);
  const what = context.transport === "single" ? "file" : "zip";
  const parts = ["Payload too large"];
  if (context.uploadBytes !== undefined)
    parts.push(`${what} was ${formatBytes(context.uploadBytes)}`);
  if (limit !== undefined) parts.push(`limit ${formatBytes(limit)}`);
  const advice =
    context.transport === "single"
      ? "split the document or compile a folder"
      : "exclude files with .latexapiignore (.gitignore is already honored; e.g. figure sources, PDFs, drafts)";
  return `${parts.join("; ")}; ${advice}.`;
}

/** Rewrites a 413 into a message naming the upload size, the limit and the remedy. */
export function withUploadContext(error: unknown, context: ReportContext): unknown {
  const e = error as LatexApiError;
  if (e && typeof e === "object" && (e.status === 413 || e.code === "payload_too_large")) {
    return new CliError("payload_too_large", describePayloadTooLarge(e, context), {
      exitCode: EXIT.USAGE,
      hint: "Exclude files with .latexapiignore or split the document",
      details: { uploadBytes: context.uploadBytes, limitBytes: parseByteLimit(e) },
      cause: error,
    });
  }
  return error;
}

export interface CompileOnceOptions {
  project: ResolvedProject;
  engine: string | undefined;
  timeout: string | undefined;
  bibliography: string | undefined;
  force: boolean | undefined;
  machine: boolean;
}

/** Packs, compiles and writes the PDF once. Throws CliError on any failure. */
export async function compileOnce(app: AppContext, opts: CompileOnceOptions): Promise<CompileData> {
  const { project } = opts;
  const { api, settings } = await app.api({ requireAuth: true });
  const startedAt = Date.now();
  const engine = parseEngine(opts.engine);
  const options = parseCompileOptions({
    timeout: opts.timeout,
    bibliography: opts.bibliography,
    force: opts.force,
  });
  const status = progress(
    `Packing ${relativeToCwd(project.kind === "file" && project.filePath ? project.filePath : project.dir)}`,
  );
  let prepared: Awaited<ReturnType<typeof prepareProject>>;
  try {
    prepared = await prepareProject(project, { engine, options });
  } catch (error) {
    status.fail("Could not pack the project");
    throw error;
  }
  const { input, bytes, hint } = prepared;
  if (hint) log.info(hint);
  status.update(`Compiling on ${new URL(settings.baseUrl).host} (${formatBytes(bytes)} uploaded)`);
  const record = {
    mode: "sync" as const,
    profile: settings.profileName,
    baseUrl: settings.baseUrl,
    engine: engine ?? undefined,
    entrypoint: project.entrypoint,
    source: project.kind === "file" ? project.filePath : project.dir,
    output: project.outputPath,
  };
  try {
    if (opts.machine) {
      const { job } = await api.compile(input, { accept: "json" });
      appendLedger(app.paths.ledger, {
        ...record,
        event: "finished",
        id: job.id,
        status: job.status,
      });
      if (job.status !== "succeeded") throw jobFailure(job);
      status.update("Downloading the PDF");
      const pdf = await api.jobs.pdf(job.id);
      await writeOutput(project.outputPath, pdf);
      status.stop();
      return {
        jobId: job.id,
        entrypoint: project.entrypoint,
        job,
        pdf: { path: project.outputPath, bytes: pdf.byteLength },
        compileMs: job.result?.cached ? 0 : (job.result?.durationMs ?? 0),
        totalMs: Date.now() - startedAt,
      };
    }
    const result = await api.compile(input);
    await writeOutput(project.outputPath, result.pdf);
    appendLedger(app.paths.ledger, {
      ...record,
      event: "finished",
      id: result.jobId,
      status: "succeeded",
    });
    status.stop();
    return {
      jobId: result.jobId,
      entrypoint: project.entrypoint,
      job: {
        id: result.jobId,
        status: "succeeded",
        cached: result.cached,
        warnings: result.warnings,
      },
      pdf: { path: project.outputPath, bytes: result.pdf.byteLength },
      compileMs: result.compileMs,
      totalMs: Date.now() - startedAt,
    };
  } catch (error) {
    status.fail("Compilation failed");
    if (error instanceof CompileFailedError && error.jobId) {
      appendLedger(app.paths.ledger, {
        ...record,
        event: "finished",
        id: error.jobId,
        status: "failed",
      });
    }
    throw withUploadContext(error, { uploadBytes: bytes, transport: project.transport });
  }
}

export function renderCompile(data: CompileData): void {
  const c = colors(rt().stdout);
  const job = data.job as { cached?: boolean; warnings?: number; result?: Job["result"] };
  const cached = job.cached ?? job.result?.cached ?? false;
  const warnings = job.warnings ?? job.result?.warnings ?? 0;
  const parts = [
    c.bold(relativeToCwd(data.pdf.path)),
    formatBytes(data.pdf.bytes),
    formatDuration(data.totalMs),
  ];
  if (cached) parts.push(c.info("cached"));
  if (warnings > 0) parts.push(c.warn(plural(warnings, "warning")));
  out(`${c.ok("✔")} ${parts.join(c.muted("  ·  "))}`);
}

export const compileCommand = leaf({
  name: "compile",
  description: "Compile a .tex file or a project directory to PDF (the shorthand for most work)",
  args: {
    ...compileArgs,
    watch: {
      type: "boolean",
      alias: "w",
      description: "Recompile whenever a project file changes",
    },
    open: { type: "boolean", description: "Open the PDF after a successful compile" },
  },
  contract: {
    data: t.object({
      job: t.ref("Job"),
      jobId: t.string(),
      "entrypoint?": t.string(),
      pdf: pdfShape,
      compileMs: t.number(
        "Server time spent compiling; 0 when served from cache (see job.result.cached)",
      ),
      totalMs: t.number("Wall-clock time of the command, including upload and download"),
    }),
    exitCodes: [EXIT.OK, EXIT.COMPILE_FAILED, EXIT.USAGE, EXIT.AUTH, EXIT.CONFLICT],
    auth: "required",
    effect: "write",
    notes:
      "On LaTeX errors: exit 1 and error.code=compile_failed with error.details.diagnostics[] ({severity,file,line,message,context}), errors, warnings, jobId and logUrl. With --watch in machine mode, one envelope per compile (NDJSON) until interrupted. The PDF is written to --output (default <entrypoint>.pdf next to the source).",
  },
  examples: [
    "latex-api compile paper/",
    "latex-api compile thesis.tex -o out/thesis.pdf --engine xelatex",
    "latex-api compile paper/ --json | jq '.error.details.diagnostics'",
  ],
  async run({ args, app, machine }) {
    const project = await resolveProject(args.path, {
      entrypoint: args.entrypoint,
      output: args.output,
      withSiblings: args["with-siblings"],
    });
    const onceOptions: CompileOnceOptions = {
      project,
      engine: args.engine,
      timeout: args.timeout,
      bibliography: args.bibliography,
      force: args.force,
      machine,
    };
    if (!args.watch) {
      const data = await compileOnce(app, onceOptions);
      if (args.open) openFile(project.outputPath);
      return {
        data,
        human: renderCompile,
        nextSteps: [`latex-api jobs logs ${data.job.id}`],
      };
    }
    await watchLoop(app, project, onceOptions, Boolean(args.open), machine);
    return undefined;
  },
});

async function watchLoop(
  app: AppContext,
  project: ResolvedProject,
  onceOptions: CompileOnceOptions,
  open: boolean,
  machine: boolean,
): Promise<never> {
  const { watch } = await import("chokidar");
  const isIgnored = createWatchFilter(project);
  const single = project.transport === "single" && project.filePath;
  const watchTarget = single ? (project.filePath as string) : project.dir;
  const c = colors(rt().stderr);
  const meta = await app.meta();
  log.step(
    single
      ? `Watching ${c.bold(relativeToCwd(watchTarget))} (single file; add --with-siblings to watch the folder). Ctrl+C to stop.`
      : `Watching ${c.bold(relativeToCwd(project.dir))} (entrypoint: ${project.entrypoint ?? "auto"}). Ctrl+C to stop.`,
    true,
  );
  let running = false;
  let pending = false;
  let timer: NodeJS.Timeout | undefined;
  const runCompile = async (reason: string) => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    log.step(`${timestamp()} ${c.muted(reason)}`, true);
    try {
      const data = await compileOnce(app, onceOptions);
      if (machine) writeEnvelope(successEnvelope(data, meta));
      else renderCompile(data);
    } catch (error) {
      const cliError = toCliError(error);
      if (machine) writeEnvelope(errorEnvelope(cliError, meta));
      else {
        log.error(cliError);
        printFailure(cliError);
      }
    }
    running = false;
    if (pending) {
      pending = false;
      await runCompile("changes queued during compile");
    }
  };
  const schedule = (file: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => void runCompile(`changed: ${relativeToCwd(file)}`), 300);
  };
  const watcher = watch(watchTarget, {
    ignoreInitial: true,
    ignored: (file, stats) => {
      if (path.resolve(file) === watchTarget) return false;
      return isIgnored(file, stats?.isDirectory() ?? false);
    },
  });
  watcher.on("add", schedule).on("change", schedule).on("unlink", schedule);
  watcher.on("error", (error) => log.warn(`Watcher error: ${String(error)}`));
  const stop = async () => {
    await watcher.close();
    process.exit(EXIT.OK);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  await runCompile("initial compile");
  if (open) openFile(project.outputPath);
  return new Promise<never>(() => {});
}

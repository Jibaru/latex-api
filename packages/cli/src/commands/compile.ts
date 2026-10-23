import path from "node:path";
import { CompileFailedError, LatexApiError } from "@jibaru/latex-api-sdk";
import { type ArgsDef, defineCommand } from "citty";
import { consola } from "consola";
import pc from "picocolors";
import { createSession } from "../client";
import { formatDiagnostics } from "../diagnostics";
import { EXIT, exitCodeFor } from "../exit";
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
  printJson,
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
  timeout: { type: "string", description: "Compile timeout in milliseconds" },
  bibliography: {
    type: "enum",
    options: [...BIBLIOGRAPHY_MODES],
    description: "Bibliography tool: auto, bibtex, biber or none",
  },
  force: { type: "boolean", description: "Skip the server-side cache" },
  json: { type: "boolean", description: "Print the job envelope as JSON" },
} satisfies ArgsDef;

export interface CompileRunOptions {
  project: ResolvedProject;
  engine: string | undefined;
  timeout: string | undefined;
  bibliography: string | undefined;
  force: boolean | undefined;
  json: boolean | undefined;
  open: boolean | undefined;
}

/** Packs, compiles and writes the PDF once. Returns the exit code instead of exiting. */
export async function compileOnce(opts: CompileRunOptions): Promise<number> {
  const { project } = opts;
  const session = await createSession({ requireKey: true });
  const startedAt = Date.now();
  const engine = parseEngine(opts.engine);
  const options = parseCompileOptions({
    timeout: opts.timeout,
    bibliography: opts.bibliography,
    force: opts.force,
  });
  const { input, bytes, hint } = await prepareProject(project, { engine, options });
  if (hint) consola.info(hint);

  try {
    if (opts.json) {
      const { job } = await session.api.compile(input, { accept: "json" });
      printJson({ job });
      if (job.status === "succeeded" && job.result?.pdfUrl) {
        const pdf = await session.api.jobs.pdf(job.id);
        await writeOutput(project.outputPath, pdf);
        consola.success(
          describeResult(
            project.outputPath,
            pdf.byteLength,
            Date.now() - startedAt,
            job.result.cached,
            job.result.warnings,
          ),
        );
      }
      if (opts.open) openFile(project.outputPath);
      return job.status === "succeeded" ? EXIT.OK : EXIT.COMPILE_FAILED;
    }
    const result = await session.api.compile(input);
    await writeOutput(project.outputPath, result.pdf);
    consola.success(
      describeResult(
        project.outputPath,
        result.pdf.byteLength,
        Date.now() - startedAt,
        result.cached,
        result.warnings,
      ),
    );
    if (opts.open) openFile(project.outputPath);
    return EXIT.OK;
  } catch (error) {
    reportError(error, opts.json, { uploadBytes: bytes, transport: project.transport });
    return exitCodeFor(error);
  }
}

function describeResult(
  outputPath: string,
  bytes: number,
  ms: number,
  cached: boolean,
  warnings: number,
): string {
  const parts = [pc.bold(relativeToCwd(outputPath)), formatBytes(bytes), formatDuration(ms)];
  if (cached) parts.push(pc.cyan("cached"));
  if (warnings > 0) parts.push(pc.yellow(`${warnings} warning${warnings === 1 ? "" : "s"}`));
  return parts.join(pc.dim("  ·  "));
}

export interface ReportContext {
  /** Size of the body that was sent, for `payload_too_large` messages. */
  uploadBytes?: number;
  transport?: ResolvedProject["transport"];
}

/** Extracts the byte limit from problem details such as "Request body exceeds 52428800 bytes". */
export function parseByteLimit(error: LatexApiError): number | undefined {
  const text = `${error.problem?.detail ?? ""} ${error.message}`;
  const match = /(\d{4,})\s*bytes/i.exec(text);
  return match ? Number(match[1]) : undefined;
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
      : "exclude files with .latexapiignore (e.g. figures sources, PDFs, drafts)";
  return `${parts.join("; ")}; ${advice}.`;
}

export function reportError(
  error: unknown,
  json: boolean | undefined,
  context: ReportContext = {},
): void {
  if (error instanceof CompileFailedError) {
    if (json) printJson(error.problem);
    consola.error(error.problem?.detail ?? error.message);
    console.error(
      formatDiagnostics(error.diagnostics, { logUrl: error.logUrl, jobId: error.jobId }),
    );
    return;
  }
  if (error instanceof LatexApiError) {
    if (json && error.problem) printJson(error.problem);
    if (error.status === 413 || error.code === "payload_too_large") {
      consola.error(describePayloadTooLarge(error, context));
      return;
    }
    const hint =
      error.status === 401
        ? " Run `latex-api login` or set LATEX_API_KEY."
        : error.code === "rate_limited" && error.retryAfterSeconds
          ? ` Retry in ${error.retryAfterSeconds}s.`
          : error.status === 0
            ? " Check LATEX_API_URL and your connection."
            : "";
    consola.error(`${error.message}${hint}`);
    return;
  }
  consola.error(error);
}

export const compileCommand = defineCommand({
  meta: {
    name: "compile",
    description: "Compile a .tex file or a project directory to PDF",
  },
  args: {
    ...compileArgs,
    watch: {
      type: "boolean",
      alias: "w",
      description: "Recompile whenever a project file changes",
    },
    open: { type: "boolean", description: "Open the PDF after a successful compile" },
  },
  async run({ args }) {
    const project = await resolveProject(args.path, {
      entrypoint: args.entrypoint,
      output: args.output,
      withSiblings: args["with-siblings"],
    });
    const runOptions: CompileRunOptions = {
      project,
      engine: args.engine,
      timeout: args.timeout,
      bibliography: args.bibliography,
      force: args.force,
      json: args.json,
      open: args.open,
    };

    if (!args.watch) {
      process.exitCode = await compileOnce(runOptions);
      return;
    }

    const { watch } = await import("chokidar");
    const isIgnored = createWatchFilter(project);
    const single = project.transport === "single" && project.filePath;
    const watchTarget = single ? project.filePath! : project.dir;
    consola.info(
      single
        ? `Watching ${pc.bold(relativeToCwd(watchTarget))} (single file; add --with-siblings to watch the folder). Press Ctrl+C to stop.`
        : `Watching ${pc.bold(relativeToCwd(project.dir))} (entrypoint: ${project.entrypoint ?? "auto"}). Press Ctrl+C to stop.`,
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
      console.log(`${timestamp()} ${pc.dim(reason)}`);
      const code = await compileOnce({ ...runOptions, open: false });
      console.log(
        `${timestamp()} ${code === EXIT.OK ? pc.green("done") : pc.red(`failed (exit ${code})`)}`,
      );
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
    watcher.on("error", (error) => consola.warn(`Watcher error: ${String(error)}`));
    const stop = async () => {
      await watcher.close();
      process.exit(EXIT.OK);
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
    await runCompile("initial compile");
    if (runOptions.open) openFile(project.outputPath);
    await new Promise(() => {});
  },
});

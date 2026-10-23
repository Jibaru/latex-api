import type { Job, LatexApi } from "@jibaru/latex-api-sdk";
import { LatexApiError } from "@jibaru/latex-api-sdk";
import { rt } from "../blocks/runtime";
import { colors, sanitize } from "../blocks/style";
import { group, leaf, t } from "../command";
import type { ResolvedSettings } from "../config";
import type { AppContext } from "../context";
import { CliError, EXIT } from "../exit";
import { appendLedger, type LedgerJob, readLedger } from "../ledger";
import { getGlobals, log, out, progress } from "../output";
import { parseCompileOptions, parseEngine, prepareProject, resolveProject } from "../project";
import {
  formatBytes,
  formatDuration,
  formatRelative,
  relativeToCwd,
  renderFields,
  renderTable,
  writeOutput,
} from "../ui";
import { compileArgs, jobFailure, pdfShape, printFailure, withUploadContext } from "./compile";

const idArg = { id: { type: "positional", description: "Job id", required: true } } as const;

const jobWithPdf = t.object({ job: t.ref("Job"), "pdf?": pdfShape });

export function colorStatus(status: string): string {
  const c = colors(rt().stdout);
  switch (status) {
    case "succeeded":
      return c.ok(status);
    case "failed":
    case "timed_out":
      return c.danger(status);
    case "cancelled":
      return c.warn(status);
    case "running":
    case "queued":
    case "submitted":
      return c.info(status);
    default:
      return status;
  }
}

function describeJob(job: Job): string {
  return renderFields([
    ["id", job.id],
    ["status", colorStatus(job.status)],
    ["engine", job.engine],
    ["entrypoint", job.entrypoint],
    ["created", job.createdAt],
    ["finished", job.finishedAt],
    ["duration", job.result ? formatDuration(job.result.durationMs) : undefined],
    ["cached", job.result ? String(job.result.cached) : undefined],
    ["errors / warn", job.result ? `${job.result.errors} / ${job.result.warnings}` : undefined],
    ["pages", job.result?.pages === undefined ? undefined : String(job.result.pages)],
    ["pdf", job.result?.pdfBytes === undefined ? undefined : formatBytes(job.result.pdfBytes)],
    ["log", job.result?.logUrl],
    ["error", job.error ? sanitize(`${job.error.reason}: ${job.error.message}`) : undefined],
  ]);
}

function parseMs(value: string | undefined, flag: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new CliError("usage", `${flag} must be a positive number of milliseconds`, {
      exitCode: EXIT.USAGE,
    });
  }
  return ms;
}

/**
 * Waits for a job (SSE with polling fallback, from the SDK), records the outcome in the
 * ledger and downloads the PDF. Throws compile_failed (exit 1) with diagnostics on failure.
 */
async function waitAndDownload(
  app: AppContext,
  api: LatexApi,
  settings: ResolvedSettings,
  id: string,
  output: string,
  timeoutMs: number | undefined,
): Promise<{ job: Job; pdf: { path: string; bytes: number } }> {
  const streamLog = !getGlobals().quiet && rt().stderr.isTTY === true;
  const status = progress(`Waiting for job ${id}`);
  let job: Job;
  try {
    job = await api.jobs.wait(id, {
      timeoutMs,
      onEvent: (event) => {
        if (event.type === "queued" || event.type === "running")
          status.update(`Job ${id} is ${event.type}`);
        else if (event.type === "log" && streamLog) {
          status.stop();
          rt().stderr.write(colors(rt().stderr).muted(sanitize(event.chunk)));
        }
      },
    });
  } catch (error) {
    status.fail(`Stopped waiting for ${id}`);
    if (error instanceof LatexApiError && error.code === "wait_timeout") {
      throw new CliError("wait_timeout", error.message, {
        exitCode: EXIT.COMPILE_FAILED,
        hint: `The job is still running; resume with \`latex-api jobs wait ${id}\``,
        details: { jobId: id },
      });
    }
    throw error;
  }
  appendLedger(app.paths.ledger, {
    event: "finished",
    id,
    mode: "async",
    profile: settings.profileName,
    baseUrl: settings.baseUrl,
    status: job.status,
    output,
  });
  if (job.status !== "succeeded" || !job.result?.pdfUrl) {
    status.fail(`Job ${id} ${job.status}`);
    throw jobFailure(job);
  }
  status.update("Downloading the PDF");
  const pdf = await api.jobs.pdf(job.id);
  await writeOutput(output, pdf);
  status.stop();
  return { job, pdf: { path: output, bytes: pdf.byteLength } };
}

function renderJobResult(d: { job: Job; pdf?: { path: string; bytes: number } }): void {
  const c = colors(rt().stdout);
  if (d.pdf) {
    out(
      `${c.ok("✔")} ${c.bold(relativeToCwd(d.pdf.path))}  ${c.muted(formatBytes(d.pdf.bytes))}  ${c.muted(d.job.id)}`,
    );
  } else {
    out(d.job.id);
    log.info(`${colorStatus(d.job.status)}  ${c.muted(d.job.links.self)}`);
  }
}

const createCommand = leaf({
  name: "create",
  description: "Submit an asynchronous compile job; --wait follows it and downloads the PDF",
  args: {
    ...compileArgs,
    webhook: {
      type: "string",
      description: "URL to POST the job envelope to when it finishes",
      valueHint: "url",
    },
    wait: {
      type: "boolean",
      description: "Wait for the job to finish and write the PDF to --output",
    },
    "wait-timeout": {
      type: "string",
      description: "With --wait: give up after this many milliseconds (default 600000)",
      valueHint: "ms",
    },
  },
  contract: {
    data: jobWithPdf,
    exitCodes: [EXIT.OK, EXIT.COMPILE_FAILED, EXIT.USAGE, EXIT.AUTH, EXIT.CONFLICT],
    auth: "required",
    effect: "write",
    notes:
      "Every submission is appended to the local ledger (jobs.jsonl) before waiting, so an interrupted --wait can be resumed with `jobs wait <id>` and is listed by `jobs list --local`. Without --wait, data.pdf is absent.",
  },
  examples: [
    "latex-api jobs create thesis/ --wait -o thesis.pdf",
    "latex-api jobs create paper/ --webhook https://example.com/hook",
  ],
  async run({ args, app }) {
    const project = await resolveProject(args.path, {
      entrypoint: args.entrypoint,
      output: args.output,
      withSiblings: args["with-siblings"],
    });
    const waitTimeout = parseMs(args["wait-timeout"], "--wait-timeout");
    const { api, settings } = await app.api({ requireAuth: true });
    const engine = parseEngine(args.engine);
    const { input, bytes, hint } = await prepareProject(project, {
      engine,
      options: parseCompileOptions({
        timeout: args.timeout,
        bibliography: args.bibliography,
        force: args.force,
        webhook: args.webhook,
      }),
    });
    if (hint) log.info(hint);
    const submitting = progress(`Submitting ${formatBytes(bytes)}`);
    let job: Job;
    try {
      job = await api.jobs.create(input);
      submitting.stop();
    } catch (error) {
      submitting.fail("Submission failed");
      throw withUploadContext(error, { uploadBytes: bytes, transport: project.transport });
    }
    appendLedger(app.paths.ledger, {
      event: "submitted",
      id: job.id,
      mode: "async",
      profile: settings.profileName,
      baseUrl: settings.baseUrl,
      status: job.status,
      engine: job.engine,
      entrypoint: job.entrypoint,
      source: project.kind === "file" ? project.filePath : project.dir,
      output: project.outputPath,
    });
    if (!args.wait) {
      return {
        data: { job },
        human: renderJobResult,
        nextSteps: [`latex-api jobs wait ${job.id} -o ${relativeToCwd(project.outputPath)}`],
      };
    }
    const data = await waitAndDownload(app, api, settings, job.id, project.outputPath, waitTimeout);
    return { data, human: renderJobResult, nextSteps: [`latex-api jobs logs ${job.id}`] };
  },
});

const getCommand = leaf({
  name: "get",
  description: "Show the status and result of a job",
  args: idArg,
  contract: {
    data: t.object({ job: t.ref("Job") }),
    exitCodes: [EXIT.OK, EXIT.AUTH, EXIT.NOT_FOUND],
    auth: "required",
    effect: "read",
  },
  examples: ["latex-api jobs get 7f1c…"],
  async run({ args, app }) {
    const { api } = await app.api({ requireAuth: true });
    const job = await api.jobs.get(String(args.id));
    return {
      data: { job },
      human: (d) => out(describeJob(d.job)),
      nextSteps:
        job.status === "succeeded"
          ? [`latex-api jobs pdf ${job.id} -o ${job.id}.pdf`]
          : job.status === "queued" || job.status === "running"
            ? [`latex-api jobs wait ${job.id}`]
            : [`latex-api jobs logs ${job.id}`],
    };
  },
});

const listCommand = leaf({
  name: "list",
  description: "List your recent jobs from the server, or with --local from this machine's ledger",
  args: {
    limit: { type: "string", description: "How many jobs (1-100, default 20)", valueHint: "n" },
    local: { type: "boolean", description: "Read the local ledger (works offline, no credential)" },
  },
  contract: {
    data: t.object({
      source: t.enum(["server", "local"]),
      jobs: t.array(
        t.any(
          "server: Job objects (#/definitions/Job); local: ledger entries {id, mode, status, profile, baseUrl, engine?, entrypoint?, source?, output?, submittedAt, updatedAt}",
        ),
      ),
      "ledgerPath?": t.string(),
    }),
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.AUTH],
    auth: "optional",
    effect: "read",
  },
  examples: ["latex-api jobs list", "latex-api jobs list --local --limit 5"],
  async run({ args, app }) {
    let limit = 20;
    if (args.limit !== undefined) {
      limit = Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new CliError("usage", "--limit must be a whole number from 1 to 100", {
          exitCode: EXIT.USAGE,
        });
      }
    }
    if (args.local) {
      const jobs = readLedger(app.paths.ledger, limit);
      return {
        data: { source: "local" as const, jobs, ledgerPath: app.paths.ledger },
        human: (d) => {
          if (d.jobs.length === 0) {
            out(`No local jobs yet (${d.ledgerPath}).`);
            return;
          }
          out(
            renderTable(
              ["id", "status", "mode", "profile", "submitted", "source"],
              d.jobs.map((j: LedgerJob) => [
                j.id,
                colorStatus(j.status),
                j.mode,
                j.profile,
                formatRelative(j.submittedAt),
                j.source ? relativeToCwd(j.source) : "-",
              ]),
              { maxWidths: { 5: 40 } },
            ),
          );
        },
      };
    }
    const { api } = await app.api({ requireAuth: true });
    const jobs = await api.jobs.list({ limit });
    return {
      data: { source: "server" as const, jobs },
      human: (d) => {
        if (d.jobs.length === 0) {
          out("No jobs yet. Compile something with: latex-api compile <path>");
          return;
        }
        out(
          renderTable(
            ["id", "status", "mode", "engine", "entrypoint", "created", "duration"],
            (d.jobs as Job[]).map((j) => [
              j.id,
              colorStatus(j.status),
              j.mode,
              j.engine,
              j.entrypoint,
              formatRelative(j.createdAt),
              j.result ? formatDuration(j.result.durationMs) : "-",
            ]),
            { maxWidths: { 4: 32 } },
          ),
        );
      },
      nextSteps: ["latex-api jobs get <id>"],
    };
  },
});

const waitCommand = leaf({
  name: "wait",
  description: "Follow a job (live log on a terminal) until it finishes, then download the PDF",
  args: {
    ...idArg,
    output: {
      type: "string",
      alias: "o",
      description: "Where to write the PDF (default: <id>.pdf)",
    },
    timeout: {
      type: "string",
      description: "Give up after this many milliseconds (default 600000)",
      valueHint: "ms",
    },
  },
  contract: {
    data: t.object({ job: t.ref("Job"), pdf: pdfShape }),
    exitCodes: [EXIT.OK, EXIT.COMPILE_FAILED, EXIT.USAGE, EXIT.AUTH, EXIT.NOT_FOUND],
    auth: "required",
    effect: "read",
  },
  examples: ["latex-api jobs wait 7f1c… -o paper.pdf"],
  async run({ args, app }) {
    const id = String(args.id);
    const { api, settings } = await app.api({ requireAuth: true });
    const data = await waitAndDownload(
      app,
      api,
      settings,
      id,
      args.output ?? `${id}.pdf`,
      parseMs(args.timeout, "--timeout"),
    );
    return { data, human: renderJobResult };
  },
});

const logsCommand = leaf({
  name: "logs",
  description: "Print the LaTeX log of a job (latexmk and biber output at the end)",
  args: {
    ...idArg,
    tail: { type: "string", description: "Only the last N lines", valueHint: "n" },
    grep: {
      type: "string",
      description: "Only lines matching this regular expression (case-insensitive)",
      valueHint: "regex",
    },
  },
  contract: {
    data: t.object({ jobId: t.string(), log: t.string(), totalLines: t.number() }),
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.AUTH, EXIT.NOT_FOUND],
    auth: "required",
    effect: "read",
  },
  examples: [
    "latex-api jobs logs 7f1c… --tail 40",
    "latex-api jobs logs 7f1c… --grep 'error|undefined|biber'",
  ],
  async run({ args, app }) {
    let tail: number | undefined;
    if (args.tail !== undefined) {
      tail = Number(args.tail);
      if (!Number.isInteger(tail) || tail < 1) {
        throw new CliError("usage", "--tail must be a positive whole number", {
          exitCode: EXIT.USAGE,
        });
      }
    }
    let pattern: RegExp | undefined;
    if (args.grep !== undefined) {
      try {
        pattern = new RegExp(String(args.grep), "i");
      } catch {
        throw new CliError("usage", `--grep is not a valid regular expression: ${args.grep}`, {
          exitCode: EXIT.USAGE,
        });
      }
    }
    const { api } = await app.api({ requireAuth: true });
    const id = String(args.id);
    const text = await api.jobs.log(id);
    let lines = text.split("\n");
    const totalLines = lines.length;
    if (pattern) lines = lines.filter((line) => pattern.test(line));
    if (tail !== undefined) lines = lines.slice(-tail);
    const log = pattern || tail !== undefined ? `${lines.join("\n")}\n` : text;
    return { data: { jobId: id, log, totalLines }, human: (d) => rt().stdout.write(d.log) };
  },
});

const cancelCommand = leaf({
  name: "cancel",
  description: "Cancel a queued or running job",
  args: idArg,
  contract: {
    data: t.object({ job: t.ref("Job") }),
    exitCodes: [EXIT.OK, EXIT.AUTH, EXIT.NOT_FOUND, EXIT.CONFLICT],
    auth: "required",
    effect: "write",
    notes: "Exit 5 (conflict) when the job already finished.",
  },
  examples: ["latex-api jobs cancel 7f1c…"],
  async run({ args, app }) {
    const { api, settings } = await app.api({ requireAuth: true });
    const job = await api.jobs.cancel(String(args.id));
    appendLedger(app.paths.ledger, {
      event: "finished",
      id: job.id,
      mode: "async",
      profile: settings.profileName,
      baseUrl: settings.baseUrl,
      status: job.status,
    });
    return {
      data: { job },
      human: (d) =>
        out(`${colors(rt().stdout).ok("✔")} Job ${d.job.id} is now ${colorStatus(d.job.status)}`),
    };
  },
});

const pdfCommand = leaf({
  name: "pdf",
  description: "Download the PDF of a finished job",
  args: {
    ...idArg,
    output: {
      type: "string",
      alias: "o",
      description: "Where to write the PDF (default: <id>.pdf)",
    },
  },
  contract: {
    data: t.object({ jobId: t.string(), pdf: pdfShape }),
    exitCodes: [EXIT.OK, EXIT.AUTH, EXIT.NOT_FOUND],
    auth: "required",
    effect: "read",
  },
  examples: ["latex-api jobs pdf 7f1c… -o paper.pdf"],
  async run({ args, app }) {
    const { api } = await app.api({ requireAuth: true });
    const id = String(args.id);
    const file = args.output ?? `${id}.pdf`;
    const pdf = await api.jobs.pdf(id);
    await writeOutput(file, pdf);
    return {
      data: { jobId: id, pdf: { path: file, bytes: pdf.byteLength } },
      human: (d) =>
        out(
          `${colors(rt().stdout).ok("✔")} ${relativeToCwd(d.pdf.path)}  ${formatBytes(d.pdf.bytes)}`,
        ),
    };
  },
});

export { printFailure };

export const jobsGroup = group({
  name: "jobs",
  description: "Asynchronous compile jobs (up to the server's job timeout) and the local ledger",
  commands: [
    createCommand,
    getCommand,
    listCommand,
    waitCommand,
    logsCommand,
    cancelCommand,
    pdfCommand,
  ],
});

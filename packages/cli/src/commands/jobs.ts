import { type Job, LatexApiError } from "@jibaru/latex-api-sdk";
import { defineCommand } from "citty";
import { consola } from "consola";
import pc from "picocolors";
import { createSession } from "../client";
import { formatJobFailure } from "../diagnostics";
import { CliError, EXIT } from "../exit";
import { parseCompileOptions, parseEngine, prepareProject, resolveProject } from "../project";
import {
  formatBytes,
  formatDuration,
  printJson,
  relativeToCwd,
  renderTable,
  writeOutput,
} from "../ui";
import { compileArgs, reportError } from "./compile";

const idArg = {
  id: { type: "positional", description: "Job id", required: true },
} as const;

function describeJob(job: Job): string {
  const rows: string[][] = [
    ["id", job.id],
    ["status", colorStatus(job.status)],
    ["engine", job.engine],
    ["entrypoint", job.entrypoint],
    ["created", job.createdAt],
  ];
  if (job.finishedAt) rows.push(["finished", job.finishedAt]);
  if (job.result) {
    rows.push(["duration", formatDuration(job.result.durationMs)]);
    rows.push(["cached", String(job.result.cached)]);
    rows.push(["errors / warnings", `${job.result.errors} / ${job.result.warnings}`]);
    if (job.result.pages !== undefined) rows.push(["pages", String(job.result.pages)]);
    if (job.result.pdfBytes !== undefined) rows.push(["pdf", formatBytes(job.result.pdfBytes)]);
    if (job.result.pdfUrl) rows.push(["pdf url", job.result.pdfUrl]);
    rows.push(["log url", job.result.logUrl]);
  }
  if (job.error) rows.push(["error", `${job.error.reason}: ${job.error.message}`]);
  rows.push(["self", job.links.self]);
  return renderTable(["field", "value"], rows);
}

function colorStatus(status: Job["status"]): string {
  switch (status) {
    case "succeeded":
      return pc.green(status);
    case "failed":
    case "timed_out":
      return pc.red(status);
    case "cancelled":
      return pc.yellow(status);
    case "running":
      return pc.cyan(status);
    default:
      return status;
  }
}

async function finish(
  job: Job,
  output: string | undefined,
  json: boolean | undefined,
): Promise<number> {
  const session = await createSession({ requireKey: true });
  if (json) printJson({ job });
  if (job.status === "succeeded" && job.result?.pdfUrl) {
    const file = output ?? `${job.id}.pdf`;
    const pdf = await session.api.jobs.pdf(job.id);
    await writeOutput(file, pdf);
    consola.success(`${pc.bold(relativeToCwd(file))} ${pc.dim(formatBytes(pdf.byteLength))}`);
    return EXIT.OK;
  }
  if (!json) console.error(formatJobFailure(job));
  return EXIT.COMPILE_FAILED;
}

const createCommand = defineCommand({
  meta: { name: "create", description: "Enqueue an asynchronous compile job and print its id" },
  args: {
    ...compileArgs,
    webhook: { type: "string", description: "URL to POST the job envelope to when it finishes" },
  },
  async run({ args }) {
    const project = await resolveProject(args.path, {
      entrypoint: args.entrypoint,
      output: args.output,
      withSiblings: args["with-siblings"],
    });
    const session = await createSession({ requireKey: true });
    const { input, bytes, hint } = await prepareProject(project, {
      engine: parseEngine(args.engine),
      options: parseCompileOptions({
        timeout: args.timeout,
        bibliography: args.bibliography,
        force: args.force,
        webhook: args.webhook,
      }),
    });
    if (hint) consola.info(hint);
    try {
      const job = await session.api.jobs.create(input);
      if (args.json) {
        printJson({ job });
        return;
      }
      console.log(job.id);
      consola.info(`${colorStatus(job.status)}  ${pc.dim(job.links.self)}`);
      consola.info(
        `Follow it with: latex-api jobs wait ${job.id} -o ${relativeToCwd(project.outputPath)}`,
      );
    } catch (error) {
      reportError(error, args.json, { uploadBytes: bytes, transport: project.transport });
      process.exitCode = EXIT.NETWORK;
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Show the status and result of a job" },
  args: { ...idArg, json: { type: "boolean", description: "Print the job envelope as JSON" } },
  async run({ args }) {
    const session = await createSession({ requireKey: true });
    const job = await session.api.jobs.get(args.id);
    if (args.json) printJson({ job });
    else console.log(describeJob(job));
  },
});

const waitCommand = defineCommand({
  meta: {
    name: "wait",
    description: "Stream a job's log until it finishes, then download the PDF",
  },
  args: {
    ...idArg,
    output: {
      type: "string",
      alias: "o",
      description: "Where to write the PDF (default: <id>.pdf)",
    },
    json: { type: "boolean", description: "Print the final job envelope as JSON" },
    quiet: { type: "boolean", alias: "q", description: "Do not stream the compiler log" },
    timeout: {
      type: "string",
      description: "Give up after this many milliseconds (default 600000)",
    },
  },
  async run({ args }) {
    const session = await createSession({ requireKey: true });
    const timeoutMs = args.timeout ? Number(args.timeout) : undefined;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new CliError("--timeout must be a positive number of milliseconds", EXIT.USAGE);
    }
    const job = await session.api.jobs.wait(args.id, {
      timeoutMs,
      onEvent: (event) => {
        if (args.quiet) return;
        if (event.type === "log") process.stderr.write(event.chunk);
        else if (event.type === "queued" || event.type === "running") {
          console.error(`${pc.dim(event.at)} ${colorStatus(event.type)}`);
        }
      },
    });
    process.exitCode = await finish(job, args.output, args.json);
  },
});

const logsCommand = defineCommand({
  meta: { name: "logs", description: "Print the full LaTeX log of a job" },
  args: idArg,
  async run({ args }) {
    const session = await createSession({ requireKey: true });
    process.stdout.write(await session.api.jobs.log(args.id));
  },
});

const cancelCommand = defineCommand({
  meta: { name: "cancel", description: "Cancel a queued or running job" },
  args: { ...idArg, json: { type: "boolean", description: "Print the job envelope as JSON" } },
  async run({ args }) {
    const session = await createSession({ requireKey: true });
    try {
      const job = await session.api.jobs.cancel(args.id);
      if (args.json) printJson({ job });
      else consola.success(`Job ${job.id} is now ${colorStatus(job.status)}`);
    } catch (error) {
      if (error instanceof LatexApiError && error.status === 409) {
        throw new CliError(error.message, EXIT.USAGE);
      }
      throw error;
    }
  },
});

const pdfCommand = defineCommand({
  meta: { name: "pdf", description: "Download the PDF of a finished job" },
  args: {
    ...idArg,
    output: {
      type: "string",
      alias: "o",
      description: "Where to write the PDF (default: <id>.pdf)",
    },
  },
  async run({ args }) {
    const session = await createSession({ requireKey: true });
    const file = args.output ?? `${args.id}.pdf`;
    const pdf = await session.api.jobs.pdf(args.id);
    await writeOutput(file, pdf);
    consola.success(`${pc.bold(relativeToCwd(file))} ${pc.dim(formatBytes(pdf.byteLength))}`);
  },
});

export const jobsCommand = defineCommand({
  meta: { name: "jobs", description: "Asynchronous compile jobs" },
  subCommands: {
    create: createCommand,
    get: getCommand,
    wait: waitCommand,
    logs: logsCommand,
    cancel: cancelCommand,
    pdf: pdfCommand,
  },
});

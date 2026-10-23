import { promises as fs } from "node:fs";
import path from "node:path";
import { listDirectoryFiles, type ProjectFileInput } from "@jibaru/latex-api-sdk";
import { defineCommand } from "citty";
import { consola } from "consola";
import { unzipSync } from "fflate";
import pc from "picocolors";
import { createSession } from "../client";
import { CliError, EXIT } from "../exit";
import { ENGINES, parseCompileOptions, parseEngine } from "../project";
import { formatBytes, printJson, relativeToCwd, renderTable, writeOutput } from "../ui";
import { reportError } from "./compile";

const idArg = {
  id: { type: "positional", description: "Template id (see `templates list`)", required: true },
} as const;

const listCommand = defineCommand({
  meta: { name: "list", description: "List the available templates" },
  args: { json: { type: "boolean", description: "Print the catalog as JSON" } },
  async run({ args }) {
    const session = await createSession();
    const templates = await session.api.templates.list();
    if (args.json) {
      printJson({ templates });
      return;
    }
    if (templates.length === 0) {
      consola.info("No templates available on this server.");
      return;
    }
    console.log(
      renderTable(
        ["id", "category", "engine", "name", "tags"],
        templates.map((t) => [pc.bold(t.id), t.category, t.engine, t.name, t.tags.join(", ")]),
      ),
    );
    console.log(pc.dim(`\nStart from one with: latex-api templates init <id> [dir]`));
  },
});

/** Strips the `<id>/` prefix the archive endpoint adds to every entry. */
export function stripArchivePrefix(
  entries: Record<string, Uint8Array>,
  id: string,
): Record<string, Uint8Array> {
  const prefix = `${id}/`;
  const out: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    const rel = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    if (!rel || rel.split("/").some((seg) => seg === "..")) continue;
    out[rel] = data;
  }
  return out;
}

const initCommand = defineCommand({
  meta: { name: "init", description: "Download a template into a new directory" },
  args: {
    ...idArg,
    dir: { type: "positional", description: "Target directory (default: ./<id>)", required: false },
    force: { type: "boolean", description: "Write into a non-empty directory" },
  },
  async run({ args }) {
    const session = await createSession();
    const target = path.resolve(args.dir ?? args.id);
    const existing = await fs.readdir(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (existing.length > 0 && !args.force) {
      throw new CliError(
        `${relativeToCwd(target)} is not empty. Use --force to write into it anyway.`,
        EXIT.USAGE,
      );
    }
    const archive = await session.api.templates.archive(args.id);
    const files = stripArchivePrefix(unzipSync(archive), args.id);
    const names = Object.keys(files).sort();
    if (names.length === 0) throw new CliError(`Template "${args.id}" has no files`, EXIT.NETWORK);
    for (const name of names) {
      await writeOutput(path.join(target, ...name.split("/")), files[name]!);
    }
    consola.success(
      `Created ${pc.bold(relativeToCwd(target))} with ${names.length} file${names.length === 1 ? "" : "s"}`,
    );
    for (const name of names) console.log(`  ${name}`);
    const template = await session.api.templates.get(args.id).catch(() => undefined);
    const entry = template?.entrypoint ?? "main.tex";
    console.log(
      pc.dim(`\nCompile it with: latex-api compile ${relativeToCwd(target)} --entrypoint ${entry}`),
    );
  },
});

const previewCommand = defineCommand({
  meta: { name: "preview", description: "Download the rendered PDF of the untouched template" },
  args: {
    ...idArg,
    output: {
      type: "string",
      alias: "o",
      description: "Where to write the PDF (default: <id>.pdf)",
    },
  },
  async run({ args }) {
    const session = await createSession();
    const file = args.output ?? `${args.id}.pdf`;
    try {
      const pdf = await session.api.templates.preview(args.id);
      await writeOutput(file, pdf);
      consola.success(`${pc.bold(relativeToCwd(file))} ${pc.dim(formatBytes(pdf.byteLength))}`);
    } catch (error) {
      reportError(error, false);
      process.exitCode = EXIT.NETWORK;
    }
  },
});

/** Reads every file of `dir` as an override (text files as UTF-8 strings, the rest as bytes). */
export async function readOverrides(dir: string): Promise<ProjectFileInput[]> {
  const files = await listDirectoryFiles(dir);
  const overrides: ProjectFileInput[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await fs.readFile(path.join(dir, ...file.path.split("/"))));
    overrides.push({ path: file.path, content: bytes });
  }
  return overrides;
}

const compileCommand = defineCommand({
  meta: {
    name: "compile",
    description: "Compile a template, optionally overriding files from a directory",
  },
  args: {
    ...idArg,
    dir: {
      type: "positional",
      description: "Directory whose files replace/extend the template",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Where to write the PDF (default: <id>.pdf)",
    },
    engine: { type: "enum", options: [...ENGINES], description: "Override the template engine" },
    entrypoint: { type: "string", description: "Override the template entrypoint" },
    timeout: { type: "string", description: "Compile timeout in milliseconds" },
    force: { type: "boolean", description: "Skip the server-side cache" },
    json: { type: "boolean", description: "Print the job envelope as JSON" },
  },
  async run({ args }) {
    const session = await createSession({ requireKey: true });
    const file = args.output ?? `${args.id}.pdf`;
    const files = args.dir ? await readOverrides(path.resolve(args.dir)) : undefined;
    const input = {
      files,
      engine: parseEngine(args.engine),
      entrypoint: args.entrypoint,
      options: parseCompileOptions({ timeout: args.timeout, force: args.force }),
    };
    try {
      if (args.json) {
        const { job } = await session.api.templates.compile(args.id, input, { accept: "json" });
        printJson({ job });
        if (job.status === "succeeded" && job.result?.pdfUrl) {
          await writeOutput(file, await session.api.jobs.pdf(job.id));
        }
        process.exitCode = job.status === "succeeded" ? EXIT.OK : EXIT.COMPILE_FAILED;
        return;
      }
      const result = await session.api.templates.compile(args.id, input);
      await writeOutput(file, result.pdf);
      const extra = [
        result.cached ? pc.cyan("cached") : "",
        result.warnings ? pc.yellow(`${result.warnings} warnings`) : "",
      ]
        .filter(Boolean)
        .join(pc.dim("  ·  "));
      consola.success(
        `${pc.bold(relativeToCwd(file))} ${pc.dim(formatBytes(result.pdf.byteLength))}${extra ? `  ${extra}` : ""}`,
      );
    } catch (error) {
      reportError(error, args.json);
      process.exitCode =
        error instanceof Error && error.name === "CompileFailedError"
          ? EXIT.COMPILE_FAILED
          : EXIT.NETWORK;
    }
  },
});

export const templatesCommand = defineCommand({
  meta: { name: "templates", description: "Browse, scaffold and compile templates" },
  subCommands: {
    list: listCommand,
    init: initCommand,
    preview: previewCommand,
    compile: compileCommand,
  },
});

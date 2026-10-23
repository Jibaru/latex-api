import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type Job,
  listDirectoryFiles,
  type ProjectFileInput,
  type Template,
} from "@jibaru/latex-api-sdk";
import { unzipSync } from "fflate";
import { rt } from "../blocks/runtime";
import { colors } from "../blocks/style";
import { group, leaf, t } from "../command";
import { CliError, EXIT } from "../exit";
import { appendLedger } from "../ledger";
import { out, progress } from "../output";
import { ENGINES, parseCompileOptions, parseEngine } from "../project";
import { formatBytes, plural, relativeToCwd, renderFields, renderTable, writeOutput } from "../ui";
import { jobFailure, pdfShape } from "./compile";

const idArg = {
  id: { type: "positional", description: "Template id (see `templates list`)", required: true },
} as const;

const listCommand = leaf({
  name: "list",
  description: "List the available templates",
  contract: {
    data: t.object({ templates: t.array(t.ref("Template")) }),
    exitCodes: [EXIT.OK, EXIT.AUTH],
    auth: "none",
    effect: "read",
  },
  examples: [
    "latex-api templates list",
    "latex-api templates list --json | jq -r '.data.templates[].id'",
  ],
  async run({ app }) {
    const { api } = await app.api();
    const templates = await api.templates.list();
    return {
      data: { templates },
      human: (d) => {
        if (d.templates.length === 0) {
          out("No templates available on this server.");
          return;
        }
        const c = colors(rt().stdout);
        const byCategory = new Map<string, typeof d.templates>();
        for (const template of d.templates) {
          byCategory.set(template.category, [
            ...(byCategory.get(template.category) ?? []),
            template,
          ]);
        }
        for (const [category, items] of byCategory) {
          out(c.bold(category));
          out(
            renderTable(
              ["id", "engine", "name", "tags"],
              items.map((tpl: Template) => [
                c.info(tpl.id),
                tpl.engine,
                tpl.name,
                c.muted(tpl.tags.join(", ")),
              ]),
              { maxWidths: { 2: 40, 3: 40 } },
            )
              .split("\n")
              .slice(1)
              .map((line) => `  ${line}`)
              .join("\n"),
          );
          out("");
        }
      },
      nextSteps: [
        "latex-api templates init <id> [dir]",
        "latex-api templates preview <id> -o preview.pdf",
      ],
    };
  },
});

const getCommand = leaf({
  name: "get",
  description: "Show one template: engine, entrypoint and files",
  args: idArg,
  contract: {
    data: t.object({ template: t.ref("Template") }),
    exitCodes: [EXIT.OK, EXIT.AUTH, EXIT.NOT_FOUND],
    auth: "none",
    effect: "read",
  },
  examples: ["latex-api templates get ieee-conference"],
  async run({ args, app }) {
    const { api } = await app.api();
    const template = await api.templates.get(String(args.id));
    return {
      data: { template },
      human: (d) => {
        const tpl = d.template;
        out(colors(rt().stdout).bold(tpl.name));
        out(
          renderFields([
            ["id", tpl.id],
            ["category", tpl.category],
            ["engine", tpl.engine],
            ["entrypoint", tpl.entrypoint],
            ["tags", tpl.tags.join(", ")],
            ["description", tpl.description],
          ]),
        );
      },
      nextSteps: [`latex-api templates init ${template.id}`],
    };
  },
});

/** Strips the `<id>/` prefix the archive endpoint adds to every entry. */
export function stripArchivePrefix(
  entries: Record<string, Uint8Array>,
  id: string,
): Record<string, Uint8Array> {
  const prefix = `${id}/`;
  const result: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    const rel = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    if (!rel || rel.split("/").some((seg) => seg === "..") || path.isAbsolute(rel)) continue;
    result[rel] = data;
  }
  return result;
}

const initCommand = leaf({
  name: "init",
  description: "Download a template's files into a new directory",
  args: {
    ...idArg,
    dir: { type: "positional", description: "Target directory (default: ./<id>)", required: false },
    force: { type: "boolean", description: "Write into a non-empty directory" },
  },
  contract: {
    data: t.object({
      template: t.string(),
      dir: t.string(),
      files: t.array(t.string()),
      entrypoint: t.string(),
    }),
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.AUTH, EXIT.NOT_FOUND],
    auth: "none",
    effect: "write",
  },
  examples: ["latex-api templates init cv-awesome my-cv"],
  async run({ args, app }) {
    const { api } = await app.api();
    const id = String(args.id);
    const target = path.resolve(args.dir ?? id);
    const existing = await fs.readdir(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (existing.length > 0 && !args.force) {
      throw new CliError("directory_not_empty", `${relativeToCwd(target)} is not empty`, {
        exitCode: EXIT.USAGE,
        hint: `Pick another directory or pass --force: latex-api templates init ${id} ${args.dir ?? id} --force`,
      });
    }
    const archive = await api.templates.archive(id);
    const files = stripArchivePrefix(unzipSync(archive), id);
    const names = Object.keys(files).sort();
    if (names.length === 0) {
      throw new CliError("template_empty", `Template "${id}" has no files`, {
        exitCode: EXIT.AUTH,
      });
    }
    for (const name of names) {
      await writeOutput(path.join(target, ...name.split("/")), files[name] as Uint8Array);
    }
    const template = await api.templates.get(id).catch(() => undefined);
    const entrypoint = template?.entrypoint ?? "main.tex";
    const dir = relativeToCwd(target);
    return {
      data: { template: id, dir: target, files: names, entrypoint },
      human: (d) => {
        const c = colors(rt().stdout);
        out(`${c.ok("✔")} Created ${c.bold(dir)} with ${plural(d.files.length, "file")}`);
        for (const name of d.files) out(`  ${c.muted(name)}`);
      },
      nextSteps: [`latex-api compile ${dir} --entrypoint ${entrypoint}`],
    };
  },
});

const previewCommand = leaf({
  name: "preview",
  description: "Download the rendered PDF of the untouched template",
  args: {
    ...idArg,
    output: {
      type: "string",
      alias: "o",
      description: "Where to write the PDF (default: <id>.pdf)",
    },
  },
  contract: {
    data: t.object({ template: t.string(), pdf: pdfShape }),
    exitCodes: [EXIT.OK, EXIT.AUTH, EXIT.NOT_FOUND],
    auth: "none",
    effect: "write",
  },
  examples: ["latex-api templates preview cv-awesome -o cv.pdf"],
  async run({ args, app }) {
    const { api } = await app.api();
    const id = String(args.id);
    const file = args.output ?? `${id}.pdf`;
    const pdf = await api.templates.preview(id);
    await writeOutput(file, pdf);
    return {
      data: { template: id, pdf: { path: file, bytes: pdf.byteLength } },
      human: (d) =>
        out(
          `${colors(rt().stdout).ok("✔")} ${relativeToCwd(d.pdf.path)}  ${formatBytes(d.pdf.bytes)}`,
        ),
    };
  },
});

/** Reads every file of `dir` as an override. */
export async function readOverrides(dir: string): Promise<ProjectFileInput[]> {
  const files = await listDirectoryFiles(dir);
  const overrides: ProjectFileInput[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await fs.readFile(path.join(dir, ...file.path.split("/"))));
    overrides.push({ path: file.path, content: bytes });
  }
  return overrides;
}

const compileCommand = leaf({
  name: "compile",
  description: "Compile a template, optionally layering the files of a directory on top",
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
    timeout: { type: "string", description: "Compile timeout in milliseconds", valueHint: "ms" },
    force: { type: "boolean", description: "Skip the server-side cache" },
  },
  contract: {
    data: t.object({ job: t.ref("Job"), pdf: pdfShape }),
    exitCodes: [EXIT.OK, EXIT.COMPILE_FAILED, EXIT.USAGE, EXIT.AUTH, EXIT.NOT_FOUND, EXIT.CONFLICT],
    auth: "required",
    effect: "write",
    notes: "Failures carry diagnostics exactly like `compile`.",
  },
  examples: ["latex-api templates compile cv-awesome ./my-cv -o cv.pdf"],
  async run({ args, app }) {
    const { api, settings } = await app.api({ requireAuth: true });
    const id = String(args.id);
    const file = args.output ?? `${id}.pdf`;
    const files = args.dir ? await readOverrides(path.resolve(args.dir)) : undefined;
    const status = progress(`Compiling template ${id}`);
    let job: Job;
    try {
      ({ job } = await api.templates.compile(
        id,
        {
          files,
          engine: parseEngine(args.engine),
          entrypoint: args.entrypoint,
          options: parseCompileOptions({ timeout: args.timeout, force: args.force }),
        },
        { accept: "json" },
      ));
    } catch (error) {
      status.fail("Compilation failed");
      throw error;
    }
    appendLedger(app.paths.ledger, {
      event: "finished",
      id: job.id,
      mode: "sync",
      profile: settings.profileName,
      baseUrl: settings.baseUrl,
      status: job.status,
      engine: job.engine,
      entrypoint: job.entrypoint,
      source: args.dir ? path.resolve(args.dir) : `template:${id}`,
      output: path.resolve(file),
    });
    if (job.status !== "succeeded") {
      status.fail("Compilation failed");
      throw jobFailure(job);
    }
    const pdf = await api.jobs.pdf(job.id);
    await writeOutput(file, pdf);
    status.stop();
    return {
      data: { job, pdf: { path: file, bytes: pdf.byteLength } },
      human: (d) => {
        const c = colors(rt().stdout);
        const extra = [
          d.job.result?.cached ? c.info("cached") : "",
          d.job.result?.warnings ? c.warn(plural(d.job.result.warnings, "warning")) : "",
        ].filter(Boolean);
        out(
          `${c.ok("✔")} ${c.bold(relativeToCwd(d.pdf.path))}  ${formatBytes(d.pdf.bytes)}${extra.length ? `  ${extra.join(c.muted("  ·  "))}` : ""}`,
        );
      },
    };
  },
});

export const templatesGroup = group({
  name: "templates",
  description: "Browse, scaffold and compile templates (papers, CVs, posters, ...)",
  commands: [listCommand, getCommand, initCommand, previewCommand, compileCommand],
});

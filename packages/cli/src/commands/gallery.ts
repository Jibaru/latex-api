import { promises as fs } from "node:fs";
import path from "node:path";
import type { GalleryTemplate, GalleryTemplateDetail } from "@jibaru/latex-api-sdk";
import { unzipSync } from "fflate";
import { rt } from "../blocks/runtime";
import { colors, sanitize } from "../blocks/style";
import { group, leaf, t } from "../command";
import { CliError, EXIT } from "../exit";
import { approve } from "../gate";
import { out, progress } from "../output";
import { ENGINES, packProject, parseEngine, resolveProject } from "../project";
import { formatBytes, plural, relativeToCwd, renderFields, renderTable, writeOutput } from "../ui";

const LICENSE = "CC-BY 4.0 (https://creativecommons.org/licenses/by/4.0/)";
const CATEGORIES = ["paper", "cv", "brochure", "poster", "report", "letter", "other"] as const;

const idArg = {
  id: {
    type: "positional",
    description: "Gallery template id (gt_…, see `gallery search`)",
    required: true,
  },
} as const;

function splitTags(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return iso.slice(0, 10);
}

const searchCommand = leaf({
  name: "search",
  description: "Browse or search community templates (by meaning, in any language)",
  args: {
    query: { type: "positional", description: "What you are looking for", required: false },
    tag: { type: "string", description: "Comma-separated tags that must all match" },
    category: { type: "enum", options: [...CATEGORIES], description: "Only this category" },
    sort: {
      type: "enum",
      options: ["stars", "recent", "relevance"],
      description: "Order (default: relevance with a query, stars without)",
    },
    mine: { type: "boolean", description: "Only templates you published" },
    starred: { type: "boolean", description: "Only templates you starred" },
    limit: { type: "string", description: "How many results (1-100, default 20)" },
  },
  contract: {
    data: t.object({
      items: t.array(t.ref("GalleryTemplate")),
      total: t.number(),
      semantic: t.boolean("false when the server fell back to keyword matching"),
    }),
    exitCodes: [EXIT.OK, EXIT.AUTH],
    auth: "optional",
    effect: "read",
    notes: "--mine and --starred need you to be signed in.",
  },
  examples: [
    'latex-api gallery search "tesis con normas apa"',
    "latex-api gallery search --tag cv --sort stars",
    "latex-api gallery search --starred",
  ],
  async run({ args, app }) {
    const { api } = await app.api({ requireAuth: Boolean(args.mine || args.starred) });
    const limit = args.limit ? Number(args.limit) : 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new CliError("usage", "--limit must be a number from 1 to 100", {
        exitCode: EXIT.USAGE,
      });
    }
    const page = await api.gallery.search({
      q: args.query ? String(args.query) : undefined,
      tags: splitTags(args.tag),
      category: args.category as GalleryTemplate["category"] | undefined,
      sort: args.sort as "stars" | "recent" | "relevance" | undefined,
      mine: Boolean(args.mine),
      starred: Boolean(args.starred),
      limit,
    });
    return {
      data: { items: page.items, total: page.total, semantic: page.semantic },
      human: (d) => {
        const c = colors(rt().stdout);
        if (d.items.length === 0) {
          out(
            args.query
              ? `Nothing matches "${sanitize(String(args.query))}".`
              : "The gallery is empty.",
          );
          return;
        }
        out(
          renderTable(
            ["id", "★", "name", "author", "tags", "published"],
            d.items.map((g: GalleryTemplate) => [
              c.info(g.id),
              `${g.starred ? c.warn("★") : ""}${g.stars}`,
              sanitize(g.name),
              sanitize(g.author.name),
              c.muted(g.tags.join(", ")),
              c.muted(ago(g.createdAt)),
            ]),
            { maxWidths: { 2: 40, 3: 18, 4: 30 } },
          ),
        );
        if (d.total > d.items.length) out(c.muted(`  ${d.items.length} of ${d.total}`));
      },
      nextSteps: ["latex-api gallery get <id>", "latex-api gallery use <id> [dir]"],
    };
  },
});

function renderDetail(g: GalleryTemplateDetail) {
  const c = colors(rt().stdout);
  out(
    `${c.bold(sanitize(g.name))}  ${c.warn(`★ ${g.stars}`)}${g.starred ? c.muted(" (starred)") : ""}`,
  );
  out(
    renderFields([
      ["id", g.id],
      ["author", sanitize(g.author.name)],
      ["category", g.category],
      ["engine", g.engine],
      ["entrypoint", g.entrypoint],
      ["tags", g.tags.join(", ")],
      [
        "files",
        `${g.fileCount} · ${formatBytes(g.totalBytes)}${g.pages ? ` · ${plural(g.pages, "page")}` : ""}`,
      ],
      ["downloads", String(g.downloads)],
      [
        "published",
        `${g.createdAt.slice(0, 10)}${g.version > 1 ? ` (v${g.version}, ${g.updatedAt.slice(0, 10)})` : ""}`,
      ],
      ["license", g.license.id],
      ["hidden", g.hidden ? "yes (only you and moderators see it)" : undefined],
      ["web", g.links.web],
      ["description", sanitize(g.description)],
    ]),
  );
}

const getCommand = leaf({
  name: "get",
  description: "Show one community template",
  args: idArg,
  contract: {
    data: t.object({ template: t.ref("GalleryTemplateDetail") }),
    exitCodes: [EXIT.OK, EXIT.AUTH, EXIT.NOT_FOUND],
    auth: "optional",
    effect: "read",
  },
  examples: ["latex-api gallery get gt_4fK9aQ2LmZ"],
  async run({ args, app }) {
    const { api } = await app.api();
    const template = await api.gallery.get(String(args.id));
    return {
      data: { template },
      human: (d) => renderDetail(d.template),
      nextSteps: [`latex-api gallery use ${template.id}`, `latex-api gallery star ${template.id}`],
    };
  },
});

const useCommand = leaf({
  name: "use",
  description: "Download a community template's files into a new directory",
  args: {
    ...idArg,
    dir: {
      type: "positional",
      description: "Target directory (default: ./<slug>)",
      required: false,
    },
    force: { type: "boolean", description: "Write into a non-empty directory" },
  },
  contract: {
    data: t.object({
      template: t.string(),
      dir: t.string(),
      files: t.array(t.string()),
      entrypoint: t.string(),
      license: t.string(),
    }),
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.AUTH, EXIT.NOT_FOUND],
    auth: "none",
    effect: "write",
    notes: "Community templates are CC-BY 4.0: keep the author's credit when you reuse them.",
  },
  examples: ["latex-api gallery use gt_4fK9aQ2LmZ my-thesis"],
  async run({ args, app }) {
    const { api } = await app.api();
    const id = String(args.id);
    const template = await api.gallery.get(id);
    const target = path.resolve(args.dir ?? template.slug);
    const existing = await fs.readdir(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (existing.length > 0 && !args.force) {
      throw new CliError("directory_not_empty", `${relativeToCwd(target)} is not empty`, {
        exitCode: EXIT.USAGE,
        hint: `Pick another directory or pass --force: latex-api gallery use ${id} ${args.dir ?? template.slug} --force`,
      });
    }
    const entries = unzipSync(await api.gallery.archive(id));
    const names: string[] = [];
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith("/")) continue;
      if (name.split("/").some((seg) => seg === "..") || path.isAbsolute(name)) continue;
      await writeOutput(path.join(target, ...name.split("/")), data);
      names.push(name);
    }
    names.sort();
    const dir = relativeToCwd(target);
    return {
      data: {
        template: id,
        dir: target,
        files: names,
        entrypoint: template.entrypoint,
        license: template.license.id,
      },
      human: (d) => {
        const c = colors(rt().stdout);
        out(`${c.ok("✔")} Created ${c.bold(dir)} with ${plural(d.files.length, "file")}`);
        out(
          c.muted(
            `  "${sanitize(template.name)}" by ${sanitize(template.author.name)} · ${template.license.id}: keep the credit when you reuse it`,
          ),
        );
      },
      nextSteps: [`latex-api compile ${dir} --entrypoint ${template.entrypoint}`],
    };
  },
});

const publishCommand = leaf({
  name: "publish",
  description: "Publish a project to the community gallery (it must compile)",
  args: {
    path: {
      type: "positional",
      description: "Project directory or main .tex file (default: .)",
      required: false,
    },
    name: { type: "string", description: "Template name (required for a new template)" },
    description: { type: "string", description: "What it is for, 20-1000 characters" },
    category: { type: "enum", options: [...CATEGORIES], description: "Category (default: other)" },
    tags: { type: "string", description: "Comma-separated tags, up to 8" },
    entrypoint: { type: "string", description: "Main .tex file inside the directory" },
    engine: { type: "enum", options: [...ENGINES], description: "TeX engine (default: detected)" },
    update: {
      type: "string",
      description: "Publish a new version of this template id instead of a new one",
      valueHint: "gt_…",
    },
    yes: { type: "boolean", description: `Accept publishing under ${LICENSE}` },
  },
  contract: {
    data: t.object({ template: t.ref("GalleryTemplateDetail") }),
    exitCodes: [EXIT.OK, EXIT.COMPILE_FAILED, EXIT.USAGE, EXIT.AUTH, EXIT.NOT_FOUND, EXIT.CONFLICT],
    auth: "required",
    effect: "write",
    notes: `The whole folder is uploaded (minus .latexapiignore) and compiled first; LaTeX errors fail with compile_failed and diagnostics, like \`compile\`. Templates are public under ${LICENSE}. Without --yes in machine mode it fails with confirmation_required.`,
  },
  examples: [
    'latex-api gallery publish ./thesis --name "Tesis UNTELS" --description "Plantilla de tesis con APA 7" --category report --tags tesis,apa,espanol --yes',
    "latex-api gallery publish ./thesis --update gt_4fK9aQ2LmZ --yes",
  ],
  async run({ args, app, machine }) {
    const { api } = await app.api({ requireAuth: true });
    if (!args.update && !args.name) {
      throw new CliError("usage", "A new template needs --name and --description", {
        exitCode: EXIT.USAGE,
        hint: 'latex-api gallery publish . --name "My template" --description "What it is for" --tags a,b',
      });
    }
    const project = await resolveProject(args.path, {
      entrypoint: args.entrypoint,
      withSiblings: true,
    });
    if (!project.entrypoint) {
      throw new CliError("entrypoint_not_found", "Could not tell which .tex file is the main one", {
        exitCode: EXIT.USAGE,
        hint: "Pass --entrypoint main.tex",
      });
    }
    await approve({
      summary: args.update
        ? `Publish a new version of ${args.update} under ${LICENSE}`
        : `Publish "${args.name}" publicly under ${LICENSE}`,
      details: [
        ["folder", relativeToCwd(project.dir) || "."],
        ["entrypoint", project.entrypoint],
        ["note", "anyone can download, reuse and adapt it, crediting you"],
      ],
      retryCommand: "re-run the same command with --yes",
      yes: args.yes,
      machine,
    });
    const zip = await packProject(project);
    const status = progress(`Compiling and publishing (${formatBytes(zip.byteLength)})`);
    let template: GalleryTemplateDetail;
    try {
      template = await api.gallery.publish(
        {
          zip,
          entrypoint: project.entrypoint,
          engine: parseEngine(args.engine),
          name: args.name,
          description: args.description,
          category: args.category as GalleryTemplate["category"] | undefined,
          tags: splitTags(args.tags),
          acceptLicense: true,
        },
        { replaceId: args.update },
      );
    } catch (error) {
      status.fail("Not published");
      throw error;
    }
    status.stop();
    return {
      data: { template },
      human: (d) => {
        const c = colors(rt().stdout);
        out(
          `${c.ok("✔")} Published ${c.bold(sanitize(d.template.name))} ${c.muted(`(${d.template.id}, v${d.template.version})`)}`,
        );
        out(`  ${d.template.links.web}`);
      },
      nextSteps: [`latex-api gallery get ${template.id}`],
    };
  },
});

function starCommand(starred: boolean) {
  return leaf({
    name: starred ? "star" : "unstar",
    description: starred ? "Star a community template" : "Remove your star",
    args: idArg,
    contract: {
      data: t.object({ id: t.string(), stars: t.number(), starred: t.boolean() }),
      exitCodes: [EXIT.OK, EXIT.AUTH, EXIT.NOT_FOUND],
      auth: "required",
      effect: "write",
    },
    examples: [`latex-api gallery ${starred ? "star" : "unstar"} gt_4fK9aQ2LmZ`],
    async run({ args, app }) {
      const { api } = await app.api({ requireAuth: true });
      const id = String(args.id);
      const res = await api.gallery.star(id, starred);
      return {
        data: { id, ...res },
        human: (d) => {
          const c = colors(rt().stdout);
          out(
            `${c.ok("✔")} ${d.starred ? "Starred" : "Unstarred"} ${id}  ${c.warn(`★ ${d.stars}`)}`,
          );
        },
      };
    },
  });
}

const removeCommand = leaf({
  name: "remove",
  description: "Delete one of your community templates from the gallery",
  args: {
    ...idArg,
    yes: { type: "boolean", description: "Skip the confirmation" },
    "dry-run": { type: "boolean", description: "Check that you can delete it, change nothing" },
  },
  contract: {
    data: t.object({ id: t.string(), removed: t.boolean(), "dryRun?": t.boolean() }),
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.AUTH, EXIT.NOT_FOUND],
    auth: "required",
    effect: "destructive",
    notes:
      "Stars and download counts are lost. Without --yes in machine mode it fails with confirmation_required.",
  },
  examples: [
    "latex-api gallery remove gt_4fK9aQ2LmZ --dry-run",
    "latex-api gallery remove gt_4fK9aQ2LmZ --yes",
  ],
  async run({ args, app, machine }) {
    const { api } = await app.api({ requireAuth: true });
    const id = String(args.id);
    const template = await api.gallery.get(id);
    if (!template.canEdit && !template.canModerate) {
      throw new CliError("forbidden", "Only the author can delete this template", {
        exitCode: EXIT.AUTH,
      });
    }
    if (args["dry-run"]) {
      return {
        data: { id, removed: false, dryRun: true },
        human: () =>
          out(
            `${colors(rt().stdout).warn("dry run")} would delete "${sanitize(template.name)}" (★ ${template.stars})`,
          ),
      };
    }
    await approve({
      summary: `Delete "${template.name}" from the gallery`,
      details: [
        ["id", id],
        ["stars", String(template.stars)],
      ],
      retryCommand: `latex-api gallery remove ${id} --yes`,
      yes: args.yes,
      machine,
    });
    await api.gallery.delete(id);
    return {
      data: { id, removed: true },
      human: () => out(`${colors(rt().stdout).ok("✔")} Deleted ${id}`),
    };
  },
});

export const galleryGroup = group({
  name: "gallery",
  description: "Community templates: search, use, publish and star (CC-BY 4.0)",
  commands: [
    searchCommand,
    getCommand,
    useCommand,
    publishCommand,
    starCommand(true),
    starCommand(false),
    removeCommand,
  ],
});

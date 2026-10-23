import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type CompileInput,
  type CompileRequestOptions,
  createIgnoreMatcher,
  DEFAULT_IGNORE,
  type Engine,
  packDirectory,
} from "@jibaru/latex-api-sdk";
import { CliError, EXIT } from "./exit";

export const ENGINES = ["pdflatex", "xelatex", "lualatex"] as const;
export const BIBLIOGRAPHY_MODES = ["auto", "bibtex", "biber", "none"] as const;

export interface ResolvedProject {
  /** Absolute project directory (the folder that gets zipped, or the file's parent). */
  dir: string;
  /** Entry file relative to `dir` (POSIX), or undefined to let the server guess. */
  entrypoint: string | undefined;
  /** Absolute path of the PDF to write. */
  outputPath: string;
  /** Whether the user pointed at a `.tex` file or a folder. */
  kind: "file" | "directory";
  /** `single`: send only the file as `text/x-tex`; `zip`: pack `dir`. */
  transport: "single" | "zip";
  /** Absolute path of the `.tex` file when `kind` is `file`. */
  filePath: string | undefined;
}

export interface ResolveOptions {
  entrypoint?: string;
  output?: string;
  cwd?: string;
  /** For a `.tex` argument: pack its parent directory instead of sending only the file. */
  withSiblings?: boolean;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Turns the `path` argument into what gets compiled plus an entrypoint and output path.
 * A `.tex` file is sent on its own (`text/x-tex`) unless `withSiblings` (or `entrypoint`)
 * asks for its parent folder to be packed; a directory is always packed.
 */
export async function resolveProject(
  input: string | undefined,
  options: ResolveOptions = {},
): Promise<ResolvedProject> {
  const cwd = options.cwd ?? process.cwd();
  const target = path.resolve(cwd, input ?? ".");
  const stat = await fs.stat(target).catch(() => undefined);
  if (!stat)
    throw new CliError("path_not_found", `Path not found: ${input ?? "."}`, {
      exitCode: EXIT.USAGE,
    });

  let dir: string;
  let entrypoint: string | undefined;
  let kind: ResolvedProject["kind"];
  let transport: ResolvedProject["transport"] = "zip";
  let filePath: string | undefined;
  if (stat.isDirectory()) {
    dir = target;
    kind = "directory";
    entrypoint = options.entrypoint ? toPosix(path.normalize(options.entrypoint)) : undefined;
    if (entrypoint) {
      const abs = path.join(dir, entrypoint);
      if (!(await fs.stat(abs).catch(() => undefined))?.isFile()) {
        throw new CliError(
          "entrypoint_not_found",
          `Entrypoint not found: ${entrypoint} (in ${dir})`,
          { exitCode: EXIT.USAGE },
        );
      }
    } else {
      entrypoint = await guessEntrypoint(dir);
    }
  } else if (stat.isFile()) {
    if (!/\.(tex|ltx|latex)$/i.test(target)) {
      throw new CliError("usage", `Expected a .tex file or a directory, got: ${input}`, {
        exitCode: EXIT.USAGE,
      });
    }
    dir = path.dirname(target);
    kind = "file";
    filePath = target;
    entrypoint = options.entrypoint
      ? toPosix(path.normalize(options.entrypoint))
      : path.basename(target);
    transport = options.withSiblings || options.entrypoint ? "zip" : "single";
  } else {
    throw new CliError("usage", `Not a file or directory: ${input}`, { exitCode: EXIT.USAGE });
  }

  const outputPath = options.output
    ? path.resolve(cwd, options.output)
    : path.join(dir, `${pdfBaseName(entrypoint ?? path.basename(dir))}.pdf`);
  return { dir, entrypoint, outputPath, kind, transport, filePath };
}

export function pdfBaseName(entrypointOrName: string): string {
  const base = entrypointOrName.split("/").pop() ?? "output";
  return base.replace(/\.(tex|ltx|latex)$/i, "") || "output";
}

/** Mirrors the server heuristic: `main.tex`, else the only top-level `.tex`. */
export async function guessEntrypoint(dir: string): Promise<string | undefined> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const texFiles = entries.filter((e) => e.isFile() && /\.tex$/i.test(e.name)).map((e) => e.name);
  if (texFiles.includes("main.tex")) return "main.tex";
  if (texFiles.length === 1) return texFiles[0];
  return undefined;
}

/** Ignore patterns for packing and watching: defaults plus the output PDF when it lives inside. */
export function projectIgnorePatterns(project: ResolvedProject): string[] {
  const patterns: string[] = [];
  const rel = path.relative(project.dir, project.outputPath);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) patterns.push(`/${toPosix(rel)}`);
  return patterns;
}

export async function packProject(project: ResolvedProject): Promise<Uint8Array> {
  return packDirectory(project.dir, { ignore: projectIgnorePatterns(project) });
}

const FILE_REFERENCE = /\\(input|include|includegraphics|bibliography|addbibresource)\b/;

/**
 * True when the source uses macros that read other files (`\input`, `\include`,
 * `\includegraphics`, `\bibliography`, `\addbibresource`), ignoring commented lines.
 */
export function referencesOtherFiles(source: string): boolean {
  return source.split(/\r?\n/).some((line) => {
    const code = line.replace(/(^|[^\\])%.*$/, "$1");
    return FILE_REFERENCE.test(code);
  });
}

export interface PreparedProject {
  input: CompileInput;
  /** Bytes that will be uploaded. */
  bytes: number;
  /** Set when a single file references other files and the user did not pack the folder. */
  hint: string | undefined;
}

/** Builds the SDK input: the file's source for `single`, a zip of `dir` for `zip`. */
export async function prepareProject(
  project: ResolvedProject,
  extra: { engine?: Engine; options?: CompileRequestOptions } = {},
): Promise<PreparedProject> {
  if (project.transport === "single" && project.filePath) {
    const source = await fs.readFile(project.filePath, "utf8");
    if (!source.trim())
      throw new CliError("usage", `${project.filePath} is empty`, { exitCode: EXIT.USAGE });
    const name = path.basename(project.filePath);
    const hint = referencesOtherFiles(source)
      ? `This file references other files; compile the folder instead: latex-api compile ${toPosix(path.relative(process.cwd(), project.dir) || ".")} --entrypoint ${name}`
      : undefined;
    return {
      input: { source, entrypoint: name, engine: extra.engine, options: extra.options },
      bytes: Buffer.byteLength(source, "utf8"),
      hint,
    };
  }
  const zip = await packProject(project);
  return {
    input: { zip, entrypoint: project.entrypoint, engine: extra.engine, options: extra.options },
    bytes: zip.byteLength,
    hint: undefined,
  };
}

/** Matcher used by `--watch` to skip build artifacts and the output PDF. */
export function createWatchFilter(
  project: ResolvedProject,
): (absolutePath: string, isDir: boolean) => boolean {
  const ignored = createIgnoreMatcher([...DEFAULT_IGNORE, ...projectIgnorePatterns(project)]);
  return (absolutePath, isDir) => {
    const rel = toPosix(path.relative(project.dir, absolutePath));
    if (!rel || rel.startsWith("..")) return false;
    return ignored(rel, isDir);
  };
}

export interface CompileFlags {
  engine?: string;
  timeout?: string;
  bibliography?: string;
  force?: boolean;
  webhook?: string;
}

export function parseEngine(value: string | undefined): Engine | undefined {
  if (!value) return undefined;
  if (!(ENGINES as readonly string[]).includes(value)) {
    throw new CliError("usage", `Unknown engine "${value}". Use one of: ${ENGINES.join(", ")}`, {
      exitCode: EXIT.USAGE,
    });
  }
  return value as Engine;
}

export function parseCompileOptions(flags: CompileFlags): CompileRequestOptions | undefined {
  const options: CompileRequestOptions = {};
  if (flags.timeout !== undefined && flags.timeout !== "") {
    const ms = Number(flags.timeout);
    if (!Number.isInteger(ms) || ms <= 0) {
      throw new CliError(
        "usage",
        `--timeout must be a positive number of milliseconds, got "${flags.timeout}"`,
        { exitCode: EXIT.USAGE },
      );
    }
    options.timeoutMs = ms;
  }
  if (flags.bibliography) {
    if (!(BIBLIOGRAPHY_MODES as readonly string[]).includes(flags.bibliography)) {
      throw new CliError(
        "usage",
        `--bibliography must be one of ${BIBLIOGRAPHY_MODES.join(", ")}, got "${flags.bibliography}"`,
        { exitCode: EXIT.USAGE },
      );
    }
    options.bibliography = flags.bibliography as CompileRequestOptions["bibliography"];
  }
  if (flags.force) options.force = true;
  if (flags.webhook) {
    try {
      new URL(flags.webhook);
    } catch {
      throw new CliError("usage", `--webhook must be a valid URL, got "${flags.webhook}"`, {
        exitCode: EXIT.USAGE,
      });
    }
    options.webhookUrl = flags.webhook;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

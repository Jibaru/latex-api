import { type AsyncZippable, zip } from "fflate";
import { createIgnoreMatcher, DEFAULT_IGNORE, parseIgnoreFile } from "./ignore";

export interface PackDirectoryOptions {
  /** Extra gitignore-like patterns, applied after `.latexapiignore` (later patterns win). */
  ignore?: readonly string[];
  /**
   * Also honor the root `.gitignore` (read before `.latexapiignore`, so the latter can
   * re-include with `!pattern`). Default true.
   */
  gitignore?: boolean;
  /** Name of the ignore file read from `dir`. Default `.latexapiignore`. */
  ignoreFile?: string | false;
  /** Replace the built-in artifact/VCS exclusions instead of extending them. */
  defaults?: readonly string[];
  /** Deflate level 0-9. Default 6; already-compressed files are always stored. */
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  /** Called for every file that goes into the archive. */
  onFile?: (relativePath: string, bytes: number) => void;
}

export interface PackedFile {
  path: string;
  size: number;
}

const STORED_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "pdf",
  "zip",
  "gz",
  "woff",
  "woff2",
  "mp4",
  "mp3",
  "otf",
  "ttf",
]);

/**
 * Lists the files `packDirectory` would include, honoring the same ignore rules.
 * Node only.
 */
export async function listDirectoryFiles(
  dir: string,
  options: PackDirectoryOptions = {},
): Promise<PackedFile[]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(dir);
  const stat = await fs.stat(root).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`packDirectory: "${dir}" is not a directory`);

  const patterns: string[] = [...(options.defaults ?? DEFAULT_IGNORE)];
  if (options.gitignore !== false) {
    const content = await fs.readFile(path.join(root, ".gitignore"), "utf8").catch(() => undefined);
    if (content !== undefined) patterns.push(...parseIgnoreFile(content));
  }
  const ignoreFile = options.ignoreFile === undefined ? ".latexapiignore" : options.ignoreFile;
  if (ignoreFile) {
    const content = await fs.readFile(path.join(root, ignoreFile), "utf8").catch(() => undefined);
    if (content !== undefined) patterns.push(...parseIgnoreFile(content));
  }
  if (options.ignore) patterns.push(...options.ignore);
  const ignored = createIgnoreMatcher(patterns);

  const files: PackedFile[] = [];
  const walk = async (absolute: string, relative: string): Promise<void> => {
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const abs = path.join(absolute, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        const target = await fs.stat(abs).catch(() => undefined);
        if (!target) continue;
        isDir = target.isDirectory();
        isFile = target.isFile();
      }
      if (isDir) {
        if (ignored(rel, true)) continue;
        await walk(abs, rel);
      } else if (isFile) {
        if (ignored(rel, false)) continue;
        const info = await fs.stat(abs);
        files.push({ path: rel, size: info.size });
      }
    }
  };
  await walk(root, "");
  return files;
}

/**
 * Zips a project folder for the `zip` transport. Honors `.latexapiignore` (gitignore-like
 * globs) on top of built-in exclusions for VCS folders and LaTeX build artifacts. Node only.
 */
export async function packDirectory(
  dir: string,
  options: PackDirectoryOptions = {},
): Promise<Uint8Array> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(dir);
  const files = await listDirectoryFiles(root, options);
  if (files.length === 0) throw new Error(`packDirectory: no files to pack in "${dir}"`);

  const entries: AsyncZippable = {};
  for (const file of files) {
    const bytes = new Uint8Array(await fs.readFile(path.join(root, ...file.path.split("/"))));
    options.onFile?.(file.path, bytes.byteLength);
    const ext = file.path.split(".").pop()?.toLowerCase() ?? "";
    entries[file.path] = STORED_EXTENSIONS.has(ext) ? [bytes, { level: 0 }] : bytes;
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    zip(entries, { level: options.level ?? 6 }, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

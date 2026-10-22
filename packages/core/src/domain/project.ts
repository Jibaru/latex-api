import { createHash } from "node:crypto";
import { DEFAULT_ENGINE, detectEngineFromSource, type Engine, isEngine } from "./engine.js";
import { InvalidProjectError, PayloadTooLargeError } from "./errors.js";
import type { Limits } from "./limits.js";

export interface ProjectFile {
  /** Normalized, relative, POSIX path inside the project (e.g. `sections/intro.tex`). */
  path: string;
  content: Uint8Array;
}

export interface Project {
  files: ProjectFile[];
  entrypoint: string;
  engine: Engine;
  /** True when the engine was given explicitly, false when detected or defaulted. */
  engineExplicit: boolean;
  totalBytes: number;
}

export interface ProjectInput {
  files: Array<{ path: string; content: Uint8Array }>;
  entrypoint?: string;
  engine?: string;
}

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;
// biome-ignore lint/suspicious/noControlCharactersInRegex: we deliberately reject control characters
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Normalizes and validates a project path. Rejects anything that could escape the
 * workspace: absolute paths, `..` segments, control characters and over-long names.
 */
export function normalizeProjectPath(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new InvalidProjectError("File path must be a non-empty string");
  }
  if (raw.length > MAX_PATH_LENGTH) {
    throw new InvalidProjectError(`File path is too long (max ${MAX_PATH_LENGTH} characters)`, {
      path: raw.slice(0, 80),
    });
  }
  if (CONTROL_CHARS.test(raw)) {
    throw new InvalidProjectError("File path contains control characters", { path: raw });
  }
  let path = raw.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(path) || path.startsWith("/") || path.startsWith("//")) {
    throw new InvalidProjectError("File path must be relative", { path: raw });
  }
  path = path.replace(/^(\.\/)+/, "");
  const segments = path.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) {
    throw new InvalidProjectError("File path must not be empty", { path: raw });
  }
  for (const segment of segments) {
    if (segment === "..") {
      throw new InvalidProjectError("File path must not contain '..'", { path: raw });
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new InvalidProjectError("File name is too long", { path: raw });
    }
    if (WINDOWS_RESERVED.test(segment)) {
      throw new InvalidProjectError("File name is reserved", { path: raw });
    }
  }
  return segments.join("/");
}

export function isTexSource(path: string): boolean {
  return /\.(tex|ltx|latex)$/i.test(path);
}

export function guessEntrypoint(paths: string[]): string | undefined {
  const tex = paths.filter(isTexSource);
  if (tex.length === 0) return undefined;
  if (tex.length === 1) return tex[0];
  const preferred = ["main.tex", "paper.tex", "cv.tex", "resume.tex", "document.tex", "index.tex"];
  for (const name of preferred) {
    const hit = tex.find((p) => p.toLowerCase() === name);
    if (hit) return hit;
  }
  const roots = tex.filter((p) => !p.includes("/"));
  if (roots.length === 1) return roots[0];
  return undefined;
}

export function createProject(input: ProjectInput, limits: Limits): Project {
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new InvalidProjectError("A project needs at least one file");
  }
  if (input.files.length > limits.maxFiles) {
    throw new PayloadTooLargeError(`Too many files (max ${limits.maxFiles})`, {
      files: input.files.length,
      maxFiles: limits.maxFiles,
    });
  }
  const seen = new Set<string>();
  const files: ProjectFile[] = [];
  let totalBytes = 0;
  for (const file of input.files) {
    const path = normalizeProjectPath(file.path);
    const key = path.toLowerCase();
    if (seen.has(key)) {
      throw new InvalidProjectError(`Duplicate file path "${path}"`, { path });
    }
    seen.add(key);
    if (!(file.content instanceof Uint8Array)) {
      throw new InvalidProjectError(`File "${path}" has no binary content`, { path });
    }
    if (file.content.byteLength > limits.maxFileBytes) {
      throw new PayloadTooLargeError(`File "${path}" exceeds ${limits.maxFileBytes} bytes`, {
        path,
        maxFileBytes: limits.maxFileBytes,
      });
    }
    totalBytes += file.content.byteLength;
    if (totalBytes > limits.maxUnpackedBytes) {
      throw new PayloadTooLargeError(`Project exceeds ${limits.maxUnpackedBytes} bytes`, {
        maxUnpackedBytes: limits.maxUnpackedBytes,
      });
    }
    files.push({ path, content: file.content });
  }

  let entrypoint: string;
  if (input.entrypoint !== undefined && input.entrypoint !== "") {
    entrypoint = normalizeProjectPath(input.entrypoint);
    if (!files.some((f) => f.path === entrypoint)) {
      throw new InvalidProjectError(`Entrypoint "${entrypoint}" is not among the project files`, {
        entrypoint,
      });
    }
  } else {
    const guessed = guessEntrypoint(files.map((f) => f.path));
    if (!guessed) {
      throw new InvalidProjectError(
        "Could not determine the entrypoint; pass `entrypoint` or include a main.tex",
      );
    }
    entrypoint = guessed;
  }

  let engine: Engine;
  let engineExplicit = false;
  if (input.engine !== undefined && input.engine !== "") {
    if (!isEngine(input.engine)) {
      throw new InvalidProjectError(`Unknown engine "${input.engine}"`, { engine: input.engine });
    }
    engine = input.engine;
    engineExplicit = true;
  } else {
    const main = files.find((f) => f.path === entrypoint)!;
    engine = detectEngineFromSource(decodeHead(main.content)) ?? DEFAULT_ENGINE;
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, entrypoint, engine, engineExplicit, totalBytes };
}

function decodeHead(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096));
}

/**
 * Content-addressed identity of a compile: same files, entrypoint, engine and compiler
 * version produce the same hash, so the result can be served from cache.
 */
export function projectHash(project: Project, compilerVersion: string, salt = ""): string {
  const hash = createHash("sha256");
  hash.update(`v1\0${compilerVersion}\0${project.engine}\0${project.entrypoint}\0${salt}\0`);
  for (const file of project.files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(file.content.byteLength));
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

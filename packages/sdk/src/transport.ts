import type { CompileRequest, TemplateCompileRequest } from "./client/types.gen";
import { encodeText, toBase64 } from "./encoding";
import type {
  CompileInput,
  CompileRequestOptions,
  ProjectFileInput,
  TemplateCompileInput,
} from "./types";

export interface PreparedBody {
  /** Fully serialized body ready for `fetch`. */
  body: BodyInit;
  /** Explicit content type, or undefined for multipart (set by the runtime). */
  contentType: string | undefined;
  query: Record<string, string>;
}

export function encodeFiles(files: ProjectFileInput[]): CompileRequest["files"] {
  return files.map((f) => {
    if (typeof f.content === "string") return { path: f.path, content: f.content };
    return { path: f.path, content: toBase64(f.content), encoding: "base64" as const };
  });
}

function optionsToQuery(input: {
  engine?: string;
  entrypoint?: string;
  options?: CompileRequestOptions;
}): Record<string, string> {
  const query: Record<string, string> = {};
  if (input.engine) query.engine = input.engine;
  if (input.entrypoint) query.entrypoint = input.entrypoint;
  if (input.options?.timeoutMs !== undefined) query.timeoutMs = String(input.options.timeoutMs);
  if (input.options?.bibliography) query.bibliography = input.options.bibliography;
  if (input.options?.force) query.force = "true";
  return query;
}

function cleanOptions(options: CompileRequestOptions | undefined): CompileRequest["options"] {
  if (!options) return undefined;
  const out: NonNullable<CompileRequest["options"]> = {};
  if (options.timeoutMs !== undefined) out.timeoutMs = options.timeoutMs;
  if (options.bibliography !== undefined) out.bibliography = options.bibliography;
  if (options.webhookUrl !== undefined) out.webhookUrl = options.webhookUrl;
  if (options.force !== undefined) out.force = options.force;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Picks the wire format for a compile input: JSON for `files`, `text/x-tex` for `source`,
 * `application/zip` for `zip`. Raw bodies fall back to multipart when `webhookUrl` is set,
 * because the server only reads that option from a body.
 */
export function prepareCompileBody(input: CompileInput): PreparedBody {
  if ("files" in input) {
    if (!Array.isArray(input.files) || input.files.length === 0) {
      throw new TypeError("CompileInput.files must contain at least one file");
    }
    const json: CompileRequest = { files: encodeFiles(input.files) };
    if (input.entrypoint) json.entrypoint = input.entrypoint;
    if (input.engine) json.engine = input.engine;
    const options = cleanOptions(input.options);
    if (options) json.options = options;
    return { body: JSON.stringify(json), contentType: "application/json", query: {} };
  }

  const needsMultipart = Boolean(input.options?.webhookUrl);
  if ("zip" in input) {
    if (!(input.zip instanceof Uint8Array) || input.zip.byteLength === 0) {
      throw new TypeError("CompileInput.zip must be a non-empty Uint8Array");
    }
    if (needsMultipart) return multipart({ project: input.zip }, input);
    return {
      body: input.zip as BodyInit,
      contentType: "application/zip",
      query: optionsToQuery(input),
    };
  }

  if ("source" in input) {
    if (typeof input.source !== "string" || input.source.length === 0) {
      throw new TypeError("CompileInput.source must be a non-empty string");
    }
    if (needsMultipart) {
      const name = input.entrypoint ?? "main.tex";
      return multipart(
        { files: [{ path: name, content: encodeText(input.source) }] },
        { ...input, entrypoint: name },
      );
    }
    return {
      body: input.source,
      contentType: "text/x-tex; charset=utf-8",
      query: optionsToQuery(input),
    };
  }

  throw new TypeError("CompileInput must have `files`, `source` or `zip`");
}

function multipart(
  parts: { project?: Uint8Array; files?: Array<{ path: string; content: Uint8Array }> },
  input: { engine?: string; entrypoint?: string; options?: CompileRequestOptions },
): PreparedBody {
  const form = new FormData();
  if (parts.project) {
    const blob = new Blob([parts.project as BlobPart], { type: "application/zip" });
    form.append("project", blob, "project.zip");
  }
  for (const f of parts.files ?? [])
    form.append("files", new Blob([f.content as BlobPart]), f.path);
  if (input.entrypoint) form.append("entrypoint", input.entrypoint);
  if (input.engine) form.append("engine", input.engine);
  const options = cleanOptions(input.options);
  if (options) form.append("options", JSON.stringify(options));
  return { body: form, contentType: undefined, query: {} };
}

export function prepareTemplateBody(input: TemplateCompileInput | undefined): PreparedBody {
  const json: TemplateCompileRequest = {};
  if (input?.files?.length) json.files = encodeFiles(input.files);
  if (input?.entrypoint) json.entrypoint = input.entrypoint;
  if (input?.engine) json.engine = input.engine;
  const options = cleanOptions(input?.options);
  if (options) json.options = options;
  return { body: JSON.stringify(json), contentType: "application/json", query: {} };
}

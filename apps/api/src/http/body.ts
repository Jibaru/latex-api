import { InvalidProjectError, isEngine, type Limits, PayloadTooLargeError } from "@latex-api/core";
import { extractZip } from "@latex-api/infra";
import type { Context } from "hono";
import type { z } from "zod";
import type { CompileOptionsSchema, CompileRequestSchema } from "./schemas";

export interface ParsedProjectInput {
  files: Array<{ path: string; content: Uint8Array }>;
  entrypoint?: string;
  engine?: string;
  options?: z.infer<typeof CompileOptionsSchema>;
}

const enc = new TextEncoder();

export function decodeJsonFiles(
  files: Array<{ path: string; content: string; encoding?: "utf8" | "base64" }>,
): Array<{ path: string; content: Uint8Array }> {
  return files.map((f) => ({
    path: f.path,
    content:
      f.encoding === "base64"
        ? new Uint8Array(Buffer.from(f.content, "base64"))
        : enc.encode(f.content),
  }));
}

export function fromJson(body: z.infer<typeof CompileRequestSchema>): ParsedProjectInput {
  return {
    files: decodeJsonFiles(body.files),
    entrypoint: body.entrypoint,
    engine: body.engine,
    options: body.options,
  };
}

/**
 * Parses non-JSON bodies: multipart (files[] and/or project.zip), application/zip and
 * text/x-tex. The whole body is read into memory, bounded by `limits.maxUploadBytes`
 * (enforced by the body-limit middleware before we get here).
 */
export async function fromRequest(c: Context, limits: Limits): Promise<ParsedProjectInput> {
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();

  if (contentType.startsWith("multipart/form-data")) {
    const form = await c.req.raw.formData();
    const files: Array<{ path: string; content: Uint8Array }> = [];
    let entrypoint: string | undefined;
    let engine: string | undefined;
    let options: ParsedProjectInput["options"];
    for (const [name, value] of form.entries()) {
      if (typeof value === "string") {
        if (name === "entrypoint") entrypoint = value;
        else if (name === "engine") engine = value;
        else if (name === "options") {
          try {
            options = JSON.parse(value) as ParsedProjectInput["options"];
          } catch {
            throw new InvalidProjectError("`options` must be a JSON object");
          }
        } else if (name === "timeoutMs") options = { ...options, timeoutMs: Number(value) };
        else if (name === "bibliography") options = { ...options, bibliography: value as never };
        else if (name === "force")
          options = { ...options, force: value === "true" || value === "1" };
        else if (name === "webhookUrl") options = { ...options, webhookUrl: value };
        continue;
      }
      const bytes = new Uint8Array(await value.arrayBuffer());
      const filename = value.name || name;
      if (isZipPart(name, filename, value.type)) {
        files.push(...(await extractZip(bytes, limits)));
      } else {
        // `files` parts may carry a relative path in the filename, e.g. "sections/intro.tex".
        files.push({ path: filename, content: bytes });
      }
    }
    if (files.length === 0)
      throw new InvalidProjectError("Upload at least one file (`files` or `project` zip)");
    return { files, entrypoint, engine, options };
  }

  const raw = new Uint8Array(await c.req.raw.arrayBuffer());
  if (raw.byteLength > limits.maxUploadBytes) {
    throw new PayloadTooLargeError(`Body exceeds ${limits.maxUploadBytes} bytes`);
  }
  const query = c.req.query();
  const options: ParsedProjectInput["options"] = {};
  if (query.timeoutMs) options.timeoutMs = Number(query.timeoutMs);
  if (query.force) options.force = query.force === "true" || query.force === "1";
  if (query.bibliography) options.bibliography = query.bibliography as never;
  const engine = query.engine && isEngine(query.engine) ? query.engine : query.engine;

  if (
    contentType.startsWith("application/zip") ||
    contentType.startsWith("application/x-zip-compressed")
  ) {
    const files = await extractZip(raw, limits);
    return { files, entrypoint: query.entrypoint, engine, options };
  }
  if (
    contentType.startsWith("text/x-tex") ||
    contentType.startsWith("application/x-tex") ||
    contentType.startsWith("text/plain") ||
    contentType.startsWith("application/x-latex") ||
    contentType === ""
  ) {
    if (raw.byteLength === 0) throw new InvalidProjectError("Empty body");
    const name = query.entrypoint ?? "main.tex";
    return { files: [{ path: name, content: raw }], entrypoint: name, engine, options };
  }
  throw new InvalidProjectError(`Unsupported content type "${contentType}"`);
}

function isZipPart(field: string, filename: string, mime: string): boolean {
  if (field === "project" || field === "zip" || field === "archive") return true;
  if (/\.zip$/i.test(filename)) return true;
  return mime === "application/zip" || mime === "application/x-zip-compressed";
}

import { Buffer } from "node:buffer";
import {
  InvalidProjectError,
  type Limits,
  normalizeProjectPath,
  PayloadTooLargeError,
} from "@latex-api/core";
import yauzl from "yauzl";

export interface ExtractedFile {
  path: string;
  content: Uint8Array;
}

/**
 * Extracts a zip archive held in memory with the usual defenses: path validation,
 * symlink rejection, entry count and uncompressed size limits (zip bombs), and a cap on
 * the declared vs actual size of each entry. A single top-level folder is stripped.
 */
export function extractZip(buffer: Uint8Array, limits: Limits): Promise<ExtractedFile[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(buffer),
      { lazyEntries: true, decodeStrings: true },
      (err, zip) => {
        if (err || !zip)
          return reject(
            new InvalidProjectError(`Invalid zip archive: ${err?.message ?? "unknown"}`),
          );
        const files: ExtractedFile[] = [];
        let total = 0;
        let count = 0;
        let failed = false;
        const fail = (error: Error) => {
          if (failed) return;
          failed = true;
          zip.close();
          reject(error);
        };
        zip.on("error", (e: Error) =>
          fail(new InvalidProjectError(`Invalid zip archive: ${e.message}`)),
        );
        zip.on("end", () => {
          if (failed) return;
          resolve(stripCommonRoot(files));
        });
        zip.on("entry", (entry: yauzl.Entry) => {
          if (failed) return;
          const name = entry.fileName;
          if (name.endsWith("/")) return zip.readEntry(); // directory
          if (/(^|\/)__MACOSX\//.test(name) || /(^|\/)\.DS_Store$/.test(name))
            return zip.readEntry();
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode === 0o120000)
            return fail(new InvalidProjectError(`Symbolic links are not allowed: ${name}`));
          if (++count > limits.maxFiles)
            return fail(new PayloadTooLargeError(`Too many files (max ${limits.maxFiles})`));
          if (entry.uncompressedSize > limits.maxFileBytes) {
            return fail(
              new PayloadTooLargeError(`File "${name}" exceeds ${limits.maxFileBytes} bytes`),
            );
          }
          total += entry.uncompressedSize;
          if (total > limits.maxUnpackedBytes) {
            return fail(
              new PayloadTooLargeError(
                `Archive exceeds ${limits.maxUnpackedBytes} bytes when unpacked`,
              ),
            );
          }
          let normalized: string;
          try {
            normalized = normalizeProjectPath(name);
          } catch (e) {
            return fail(e as Error);
          }
          zip.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) return fail(new InvalidProjectError(`Cannot read "${name}"`));
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > limits.maxFileBytes + 1024) {
                stream.destroy();
                return fail(new PayloadTooLargeError(`File "${name}" is larger than declared`));
              }
              chunks.push(chunk);
            });
            stream.on("error", (e: Error) =>
              fail(new InvalidProjectError(`Cannot read "${name}": ${e.message}`)),
            );
            stream.on("end", () => {
              if (failed) return;
              files.push({ path: normalized, content: new Uint8Array(Buffer.concat(chunks)) });
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}

/** If every file lives under the same first-level folder, strip it. */
export function stripCommonRoot(files: ExtractedFile[]): ExtractedFile[] {
  if (files.length === 0) return files;
  const firsts = new Set(files.map((f) => f.path.split("/")[0]));
  if (firsts.size !== 1) return files;
  if (!files.every((f) => f.path.includes("/"))) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(f.path.indexOf("/") + 1) }));
}

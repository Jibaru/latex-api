// Adapted from cligentic block `atomic-write` (registry/foundation/atomic-write.ts).
// Adopted almost as-is: temp sibling, fsync, rename, explicit mode, parent dirs created.
// Change: the temp file is a sibling of the *target* named after it, and the Windows path
// retries the rename instead of unlinking first (unlink-then-rename leaves a window with no
// file at all, which is the corruption this block exists to avoid).

import {
  chmodSync,
  closeSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export interface WriteOptions {
  /** File permissions. Default 0o644; use 0o600 for anything sensitive. */
  mode?: number;
}

export function atomicWrite(filePath: string, content: string, options: WriteOptions = {}): void {
  const mode = options.mode ?? 0o644;
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, content);
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameWithRetry(tmp, filePath);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(filePath, mode);
    } catch {
      // best effort: the open() mode already applied to new files
    }
  }
}

export function atomicWriteJson(filePath: string, value: unknown, options: WriteOptions = {}) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

function renameWithRetry(from: string, to: string): void {
  // On Windows rename can fail with EPERM/EBUSY while another process (an antivirus, a
  // second CLI invocation) holds the target open. A few short retries cover it.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 5 || (code !== "EPERM" && code !== "EBUSY")) {
        throw error;
      }
      // Brief synchronous backoff; this path only runs on contention.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

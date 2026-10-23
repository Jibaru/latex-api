import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { rt } from "./blocks/runtime";
import { colors, padVisible, stripAnsi, truncateVisible, visibleWidth } from "./blocks/style";

export { stripAnsi };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** "3h ago", "in 12d", or the date for anything older than a month. */
export function formatRelative(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "-";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = t - now;
  const abs = Math.abs(diff);
  const units: Array<[number, string]> = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
  ];
  if (abs > 30 * 86_400_000) return iso.slice(0, 10);
  for (const [size, unit] of units) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      return diff < 0 ? `${n}${unit} ago` : `in ${n}${unit}`;
    }
  }
  return diff < 0 ? "just now" : "now";
}

export function timestamp(date = new Date()): string {
  return colors(rt().stderr).dim(date.toTimeString().slice(0, 8));
}

export interface TableOptions {
  /** Max visible width per column index; longer cells are truncated with an ellipsis. */
  maxWidths?: Record<number, number>;
}

/**
 * An aligned, borderless table for stdout. Widths use the visible width, so cells that carry
 * color escapes line up with plain ones.
 */
export function renderTable(headers: string[], rows: string[][], opts: TableOptions = {}): string {
  const c = colors(rt().stdout);
  const fitted = rows.map((row) =>
    row.map((cell, i) => {
      const max = opts.maxWidths?.[i];
      return max ? truncateVisible(cell, max) : cell;
    }),
  );
  const widths = headers.map((h, i) =>
    Math.max(visibleWidth(h), ...fitted.map((r) => visibleWidth(r[i] ?? ""))),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => padVisible(cell, widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [c.bold(line(headers.map((h) => h.toUpperCase()))), ...fitted.map(line)].join("\n");
}

/** Two-column key/value block for a single record. */
export function renderFields(rows: Array<[string, string | undefined]>): string {
  const c = colors(rt().stdout);
  const present = rows.filter((r): r is [string, string] => r[1] !== undefined && r[1] !== "");
  const width = Math.max(0, ...present.map(([k]) => visibleWidth(k)));
  return present.map(([k, v]) => `${c.muted(padVisible(k, width))}  ${v}`).join("\n");
}

export async function writeOutput(file: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fs.writeFile(file, bytes);
}

/** Opens a file with the OS default application (best effort, detached). */
export function openFile(file: string): void {
  const target = path.resolve(file);
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", target]]
      : process.platform === "darwin"
        ? ["open", [target]]
        : ["xdg-open", [target]];
  try {
    const child = spawn(command as string, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // opening is a convenience
  }
}

export function relativeToCwd(file: string): string {
  const rel = path.relative(process.cwd(), file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

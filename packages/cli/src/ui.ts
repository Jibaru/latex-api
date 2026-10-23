import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import pc from "picocolors";

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

export function timestamp(date = new Date()): string {
  return pc.dim(date.toTimeString().slice(0, 8));
}

/** Renders rows as an aligned table (no borders) for terminal output. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell + " ".repeat(Math.max(0, widths[i]! - stripAnsi(cell).length)))
      .join("  ")
      .trimEnd();
  return [pc.bold(line(headers)), ...rows.map(line)].join("\n");
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
const ANSI = /\u001b\[[0-9;]*m/g;
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function writeOutput(file: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fs.writeFile(file, bytes);
}

/** Opens a file with the OS default application (best effort, detached). */
export function openFile(file: string): void {
  const target = path.resolve(file);
  let command: string;
  let args: string[];
  if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", target];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [target];
  } else {
    command = "xdg-open";
    args = [target];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore: opening is a convenience
  }
}

export function relativeToCwd(file: string): string {
  const rel = path.relative(process.cwd(), file);
  return rel && !rel.startsWith("..") ? rel : file;
}

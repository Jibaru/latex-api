// Adapted from cligentic block `style` (registry/platform/style.ts).
// Hybrid: kept the semantic names (danger/warn/ok/info/muted), the single shouldColor()
// decision point and the visible-width helpers. Replaced the 256-color escapes with
// picocolors (`createColors`), which the owner asked for and which handles nested resets;
// color is decided per stream instead of from stdout only.

import { createColors } from "picocolors";
import { shouldColor } from "./detect";
import { type OutStream, rt } from "./runtime";

export interface Palette {
  enabled: boolean;
  bold: (t: string) => string;
  dim: (t: string) => string;
  /** Errors, and only errors. */
  danger: (t: string) => string;
  /** Irreversible actions, dry runs, warnings. */
  warn: (t: string) => string;
  /** Completed operations. */
  ok: (t: string) => string;
  /** Values that depart from the default and deserve a look. */
  info: (t: string) => string;
  /** Context: separators, units, hints. */
  muted: (t: string) => string;
}

/** The palette for one stream: `colors(rt().stderr)` for diagnostics, stdout for data. */
export function colors(stream: OutStream = rt().stdout): Palette {
  const enabled = shouldColor(stream);
  const pc = createColors(enabled);
  return {
    enabled,
    bold: pc.bold,
    dim: pc.dim,
    danger: pc.red,
    warn: pc.yellow,
    ok: pc.green,
    info: pc.cyan,
    muted: pc.gray,
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Width on screen, ignoring ANSI escapes (`"\x1b[1mHi\x1b[0m".length` is 12, its width 2). */
export function visibleWidth(text: string): number {
  return [...stripAnsi(text)].length;
}

export function padVisible(text: string, width: number): string {
  const missing = width - visibleWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}

export function padStartVisible(text: string, width: number): string {
  const missing = width - visibleWidth(text);
  return missing > 0 ? " ".repeat(missing) + text : text;
}

/** Truncates with an ellipsis; styled text comes back plain when cut (never cut an escape). */
export function truncateVisible(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  const plain = [...stripAnsi(text)];
  return width <= 1 ? plain.slice(0, width).join("") : `${plain.slice(0, width - 1).join("")}…`;
}

/**
 * Removes escape sequences and control characters from text that came from the network
 * (problem details, LaTeX log lines) before it reaches a terminal or an agent's context.
 */
export function sanitize(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
  return stripAnsi(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

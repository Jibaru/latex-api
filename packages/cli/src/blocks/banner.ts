// Adapted from cligentic block `banner` (registry/foundation/banner.ts).
// Hybrid: same 5-row block-letter renderer and vertical gradient, trimmed to the glyphs this
// wordmark needs; writes to the runtime's stderr and only when stderr is a TTY (the block
// printed a plain fallback when piped, which is still noise in a captured stderr).

import { shouldColor } from "./detect";
import { rt } from "./runtime";

const GLYPHS: Record<string, string[]> = {
  L: ["█    ", "█    ", "█    ", "█    ", "█████"],
  A: ["  █  ", " █ █ ", "█████", "█   █", "█   █"],
  T: ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
  X: ["█   █", " █ █ ", "  █  ", " █ █ ", "█   █"],
  P: ["████ ", "█   █", "████ ", "█    ", "█    "],
  I: ["█████", "  █  ", "  █  ", "  █  ", "█████"],
  " ": ["  ", "  ", "  ", "  ", "  "],
};

export function bannerLines(text: string): string[] {
  const rows = ["", "", "", "", ""];
  const blank = GLYPHS[" "] as string[];
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? blank;
    for (let r = 0; r < 5; r++) rows[r] += `${glyph[r]} `;
  }
  return rows.map((row) => row.trimEnd());
}

export interface BannerOptions {
  version: string;
  tagline: string;
  gradient?: [string, string];
}

type Rgb = [number, number, number];

function hex(h: string): Rgb {
  const v = h.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(v.slice(i, i + 2), 16)) as Rgb;
}

/** Prints the wordmark to stderr. No-op unless stderr is an interactive terminal. */
export function printBanner(opts: BannerOptions): void {
  const { stderr } = rt();
  if (stderr.isTTY !== true) return;
  if (!shouldColor(stderr)) {
    stderr.write(`\n  latex-api v${opts.version}  ${opts.tagline}\n\n`);
    return;
  }
  const [top, bottom] = opts.gradient ?? ["#7dd3fc", "#6366f1"];
  const from = hex(top);
  const to = hex(bottom);
  const lines = bannerLines("LATEX API");
  stderr.write("\n");
  lines.forEach((line, i) => {
    const t = i / (lines.length - 1);
    const [r, g, b] = from.map((c, k) => Math.round(c + ((to[k] as number) - c) * t));
    stderr.write(`  \x1b[38;2;${r};${g};${b}m${line}\x1b[0m\n`);
  });
  stderr.write(`  \x1b[2mv${opts.version}  ·  ${opts.tagline}\x1b[0m\n\n`);
}

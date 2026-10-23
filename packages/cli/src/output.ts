// The one place that decides output mode and writes the envelope.
//
// Machine mode (`--json`, or stdout not a TTY): exactly one JSON envelope per line on stdout,
//   { "ok": true,  "data": {...}, "meta": { "profile", "baseUrl", "nextSteps"? } }
//   { "ok": false, "error": { "code", "message", "hint"?, "details"? }, "meta"? }
// Human mode: the command's renderer writes to stdout; everything else goes to stderr.
// Diagnostics, progress and the banner always go to stderr, in both modes.

import { rt } from "./blocks/runtime";
import { colors, sanitize } from "./blocks/style";
import type { CliError } from "./exit";

export interface Globals {
  json: boolean;
  profile: string | undefined;
  quiet: boolean;
  help: boolean;
  version: boolean;
}

export const DEFAULT_GLOBALS: Globals = {
  json: false,
  profile: undefined,
  quiet: false,
  help: false,
  version: false,
};

export interface Meta {
  profile?: string;
  baseUrl?: string;
  nextSteps?: string[];
  [key: string]: unknown;
}

export interface SuccessEnvelope<T = unknown> {
  ok: true;
  data: T;
  meta: Meta;
}

export interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
  meta?: Meta;
}

export type Envelope<T = unknown> = SuccessEnvelope<T> | ErrorEnvelope;

let globals: Globals = { ...DEFAULT_GLOBALS };

export function setGlobals(next: Globals): void {
  globals = next;
}

export function getGlobals(): Globals {
  return globals;
}

/**
 * JSON on stdout when asked for (--json), or when nobody is reading stdout in a terminal.
 * LATEX_API_OUTPUT=human|json overrides the TTY guess (e.g. `| less -R`); --json still wins.
 */
export function isMachine(g: Globals = globals): boolean {
  if (g.json) return true;
  const forced = rt().env.LATEX_API_OUTPUT;
  if (forced === "human") return false;
  if (forced === "json") return true;
  return rt().stdout.isTTY !== true;
}

function cleanMeta(meta: Meta): Meta {
  const out: Meta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    if (key === "nextSteps" && Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

export function successEnvelope<T>(data: T, meta: Meta = {}): SuccessEnvelope<T> {
  return { ok: true, data, meta: cleanMeta(meta) };
}

export function errorEnvelope(error: CliError, meta?: Meta): ErrorEnvelope {
  const body: ErrorEnvelope["error"] = { code: error.code, message: error.message };
  if (error.hint) body.hint = error.hint;
  if (error.details && Object.keys(error.details).length > 0) body.details = error.details;
  const envelope: ErrorEnvelope = { ok: false, error: body };
  if (meta) {
    const cleaned = cleanMeta(meta);
    if (Object.keys(cleaned).length > 0) envelope.meta = cleaned;
  }
  return envelope;
}

/** One envelope, one line, stdout. */
export function writeEnvelope(envelope: Envelope): void {
  rt().stdout.write(`${JSON.stringify(envelope)}\n`);
}

/** Human-mode data line on stdout. */
export function out(line = ""): void {
  rt().stdout.write(`${line}\n`);
}

function err(line: string): void {
  rt().stderr.write(`${line}\n`);
}

/**
 * Diagnostics on stderr. `info`/`step` are progress chatter: shown when stderr is a terminal
 * (and not `--quiet`). Warnings and errors always show.
 */
export const log = {
  chatty(): boolean {
    return !globals.quiet && rt().stderr.isTTY === true;
  },
  info(message: string): void {
    if (!log.chatty()) return;
    err(`${colors(rt().stderr).info("ℹ")} ${message}`);
  },
  success(message: string): void {
    if (!log.chatty()) return;
    err(`${colors(rt().stderr).ok("✔")} ${message}`);
  },
  step(message: string, force = false): void {
    if (!force && !log.chatty()) return;
    if (force && globals.quiet) return;
    err(`${colors(rt().stderr).muted("›")} ${message}`);
  },
  warn(message: string): void {
    err(`${colors(rt().stderr).warn("▲ warning")} ${message}`);
  },
  /** Human rendering of a failure: the word in red, code muted, message plain, hint below. */
  error(error: CliError): void {
    const c = colors(rt().stderr);
    err(`${c.danger("✖ error")} ${c.muted(`[${error.code}]`)} ${sanitize(error.message)}`);
    if (error.hint) err(`  ${c.muted(`hint: ${error.hint}`)}`);
  },
  raw(text: string): void {
    rt().stderr.write(text);
  },
};

const warned = new Set<string>();

/** A warning printed at most once per process (deprecations). */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(message);
}

export function resetWarnings(): void {
  warned.clear();
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Progress {
  update(text: string): void;
  succeed(text: string): void;
  fail(text: string): void;
  stop(): void;
}

/**
 * A status line on stderr. On a TTY it animates in place; elsewhere each *phase change* is
 * one plain line (only when `force`, e.g. login polling an agent must see). The text always
 * names the phase reached, so progress reflects completed work rather than elapsed time.
 */
export function progress(initial: string, opts: { force?: boolean } = {}): Progress {
  const { stderr } = rt();
  const tty = stderr.isTTY === true && !globals.quiet;
  const plain = !tty && opts.force === true && !globals.quiet;
  const c = colors(stderr);
  let text = initial;
  let frame = 0;
  let timer: NodeJS.Timeout | undefined;
  const draw = () => {
    stderr.write(`\r\x1b[2K${c.info(FRAMES[frame % FRAMES.length] ?? "-")} ${text}`);
    frame += 1;
  };
  if (tty) {
    draw();
    timer = setInterval(draw, 80);
    timer.unref?.();
  } else if (plain) {
    err(`… ${text}`);
  }
  const end = (symbol: string, line: string | undefined) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (tty) stderr.write(`\r\x1b[2K${line === undefined ? "" : `${symbol} ${line}\n`}`);
    else if (plain && line !== undefined) err(`${symbol} ${line}`);
  };
  return {
    update(next) {
      if (next === text) return;
      text = next;
      if (plain) err(`… ${text}`);
    },
    succeed(line) {
      end(c.ok("✔"), line);
    },
    fail(line) {
      end(c.danger("✖"), line);
    },
    stop() {
      end("", undefined);
    },
  };
}

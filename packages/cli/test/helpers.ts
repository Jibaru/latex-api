import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { Job } from "@jibaru/latex-api-sdk";
import { run } from "../src/app";
import type { InStream } from "../src/blocks/runtime";
import type { Shape } from "../src/command";
import type { KeyringLoader, KeyringModule } from "../src/credentials";

export const BASE = "https://api.test";

export async function tempHome(prefix = "latex-cli-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** An in-memory OS keychain. `fail` makes every call throw like a missing secret service. */
export function memoryKeyring(opts: { fail?: "load" | "calls" } = {}) {
  const entries = new Map<string, string>();
  const loader: KeyringLoader = async () => {
    if (opts.fail === "load") throw new Error("Cannot find module '@napi-rs/keyring'");
    class Entry {
      constructor(
        private readonly service: string,
        private readonly account: string,
      ) {}
      private get key() {
        return `${this.service}/${this.account}`;
      }
      getPassword() {
        if (opts.fail === "calls")
          throw new Error("Platform secure storage failure: no secret service");
        return entries.get(this.key) ?? null;
      }
      setPassword(password: string) {
        if (opts.fail === "calls")
          throw new Error("Platform secure storage failure: no secret service");
        entries.set(this.key, password);
      }
      deletePassword() {
        if (opts.fail === "calls") throw new Error("Platform secure storage failure");
        return entries.delete(this.key);
      }
    }
    return { Entry } as unknown as KeyringModule;
  };
  return { loader, entries };
}

export interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

export type Route = (req: Recorded) => Response | Promise<Response> | undefined;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      type: `https://x/docs/errors#${code}`,
      title: code,
      status,
      code,
      detail: `detail ${code}`,
      ...extra,
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

export const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");

export function pdf() {
  return new Response(PDF_BYTES, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "x-job-id": "job_sync",
      "x-compile-cached": "false",
      "x-compile-warnings": "1",
    },
  });
}

/** A fetch stub routing on method + path; unknown routes are a 599 so tests notice. */
export function stubFetch(routes: Record<string, Route>) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const recorded: Recorded = {
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body: request.method === "GET" ? "" : await request.text(),
    };
    calls.push(recorded);
    const key = `${recorded.method} ${recorded.url.pathname}`;
    const route = routes[key] ?? routes[`* ${recorded.url.hostname}`];
    const response = route ? await route(recorded) : undefined;
    return response ?? new Response(`no route for ${key}`, { status: 599 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export function makeJob(overrides: Partial<Job> = {}): Job {
  const id = overrides.id ?? "job_1";
  return {
    id,
    status: "succeeded",
    mode: "async",
    engine: "pdflatex",
    entrypoint: "main.tex",
    createdAt: "2026-10-22T10:00:00.000Z",
    finishedAt: "2026-10-22T10:00:02.000Z",
    expiresAt: "2026-10-23T10:00:00.000Z",
    options: { timeoutMs: 60000, bibliography: "auto" },
    result: {
      cached: false,
      durationMs: 1800,
      exitCode: 0,
      errors: 0,
      warnings: 1,
      pages: 1,
      pdfBytes: PDF_BYTES.byteLength,
      pdfUrl: `${BASE}/v1/jobs/${id}/pdf`,
      logUrl: `${BASE}/v1/jobs/${id}/log`,
      diagnostics: [],
    },
    links: { self: `${BASE}/v1/jobs/${id}` },
    ...overrides,
  } as Job;
}

export const TOKEN = {
  id: "tok_cli",
  name: "latex-api-cli on host",
  prefix: "lta_Ab12Cd34",
  origin: "cli" as const,
  status: "active" as const,
  createdAt: "2026-10-01T00:00:00.000Z",
};

export const ME = {
  user: { id: "user_1", email: "ada@example.com" },
  principal: { name: "ada@example.com", kind: "user", via: "token", tokenId: "tok_cli" },
};

class Sink {
  chunks: string[] = [];
  constructor(readonly isTTY: boolean) {}
  write(chunk: string) {
    this.chunks.push(String(chunk));
    return true;
  }
  get text() {
    return this.chunks.join("");
  }
}

/** A parsed envelope; tests probe it freely, the contract check gives the type safety. */
// biome-ignore lint/suspicious/noExplicitAny: parsed JSON is inspected ad hoc in assertions
export type Envelope = Record<string, any>;

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  /** Every stdout line parsed as JSON. */
  envelopes: Envelope[];
  /** The last envelope. */
  envelope: Envelope;
  sleeps: number[];
}

export interface RunCliOptions {
  home: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  keyring?: KeyringLoader;
  stdin?: string;
  tty?: boolean;
  cwd?: string;
}

/** Runs the real dispatcher in-process with fake streams, a fake clock and no network. */
export async function runCli(argv: string[], opts: RunCliOptions): Promise<CliRun> {
  const stdout = new Sink(opts.tty ?? false);
  const stderr = new Sink(opts.tty ?? false);
  const stdin = Readable.from(opts.stdin === undefined ? [] : [opts.stdin]) as unknown as InStream;
  (stdin as { isTTY?: boolean }).isTTY = false;
  let clock = Date.parse("2026-10-22T12:00:00.000Z");
  const sleeps: number[] = [];
  const previousCwd = process.cwd();
  if (opts.cwd) process.chdir(opts.cwd);
  try {
    const code = await run(argv, {
      runtime: {
        stdout,
        stderr,
        stdin,
        env: {
          LATEX_API_HOME: opts.home,
          LATEX_API_URL: BASE,
          PATH: process.env.PATH,
          USERPROFILE: opts.home,
          HOME: opts.home,
          CI: "1",
          ...opts.env,
        },
        fetch: opts.fetch ?? stubFetch({}).fetch,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        now: () => clock,
      },
      loadKeyring: opts.keyring ?? memoryKeyring().loader,
    });
    const lines = stdout.text.split("\n").filter((l) => l.trim().startsWith("{"));
    const envelopes = lines.flatMap((l) => {
      try {
        return [JSON.parse(l) as Envelope];
      } catch {
        return [];
      }
    });
    return {
      code,
      stdout: stdout.text,
      stderr: stderr.text,
      envelopes,
      envelope: envelopes[envelopes.length - 1] ?? {},
      sleeps,
    };
  } finally {
    if (opts.cwd) process.chdir(previousCwd);
  }
}

/**
 * Minimal validator for the contract shapes (type/properties/required/items/enum/anyOf/$ref).
 * Returns the list of mismatches; [] means the value fits the documented shape.
 */
export function checkShape(
  shape: Shape,
  value: unknown,
  definitions: Record<string, Shape>,
  at = "data",
): string[] {
  if (value === null && shape.nullable === true) return [];
  if ("$ref" in shape) {
    const name = String(shape.$ref).split("/").pop() as string;
    const def = definitions[name];
    return def ? checkShape(def, value, definitions, at) : [`${at}: unknown $ref ${name}`];
  }
  if ("anyOf" in shape) {
    const options = shape.anyOf as Shape[];
    return options.some((option) => checkShape(option, value, definitions, at).length === 0)
      ? []
      : [`${at}: matches none of anyOf`];
  }
  if ("const" in shape)
    return value === shape.const ? [] : [`${at}: expected ${String(shape.const)}`];
  const type = shape.type;
  const errors: string[] = [];
  if (Array.isArray(type)) {
    if (value === null) return type.includes("null") ? [] : [`${at}: unexpected null`];
    return checkShape({ ...shape, type: type.find((t) => t !== "null") }, value, definitions, at);
  }
  if (type === "null") return value === null ? [] : [`${at}: expected null`];
  if (type === "string") {
    if (typeof value !== "string") return [`${at}: expected string, got ${JSON.stringify(value)}`];
    if (Array.isArray(shape.enum) && !shape.enum.includes(value)) {
      return [`${at}: ${value} not in ${shape.enum.join("|")}`];
    }
    return [];
  }
  if (type === "number" || type === "integer") {
    return typeof value === "number" ? [] : [`${at}: expected number`];
  }
  if (type === "boolean") return typeof value === "boolean" ? [] : [`${at}: expected boolean`];
  if (type === "array") {
    if (!Array.isArray(value)) return [`${at}: expected array`];
    value.forEach((item, i) => {
      errors.push(...checkShape(shape.items as Shape, item, definitions, `${at}[${i}]`));
    });
    return errors;
  }
  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [`${at}: expected object`];
    }
    const record = value as Record<string, unknown>;
    for (const key of (shape.required as string[] | undefined) ?? []) {
      if (!(key in record) || record[key] === undefined) errors.push(`${at}.${key}: missing`);
    }
    for (const [key, sub] of Object.entries((shape.properties as Record<string, Shape>) ?? {})) {
      if (record[key] !== undefined)
        errors.push(...checkShape(sub, record[key], definitions, `${at}.${key}`));
    }
    return errors;
  }
  return errors;
}

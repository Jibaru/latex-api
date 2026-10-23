import { type Client, createClient, createConfig } from "./client/client";
import * as ops from "./client/sdk.gen";
import type {
  ApiToken,
  CreatedApiToken,
  DeviceAuthorizationStart,
  DeviceToken,
  Health,
  Job,
  JobEnvelope,
  Limits,
  Me,
  Stats,
  Template,
} from "./client/types.gen";
import { envVar, isBrowser } from "./encoding";
import { errorFromRawResponse, errorFromResponse, isProblem, LatexApiError } from "./errors";
import { parseSse, type SseMessage } from "./sse";
import { type PreparedBody, prepareCompileBody, prepareTemplateBody } from "./transport";
import {
  type CompileCallOptions,
  type CompileInput,
  type CompileJsonResult,
  type CompilePdfResult,
  type CompileResult,
  type CreateTokenInput,
  type DevicePollResult,
  type DeviceStartInput,
  type EventsOptions,
  isTerminalStatus,
  type JobEvent,
  type LatexApiOptions,
  type RequestCallOptions,
  type TemplateCompileInput,
  type WaitOptions,
} from "./types";

export const SDK_VERSION = "0.2.0";
export const DEFAULT_BASE_URL = "https://latex-api.crafter.run";

const BEARER = [{ scheme: "bearer", type: "http" }] as const;

interface RawResult {
  data?: unknown;
  error?: unknown;
  response?: Response;
}

function unwrap<T>(result: RawResult): { data: T; response: Response } {
  if (result.error !== undefined || !result.response?.ok) {
    throw errorFromResponse(result.error, result.response);
  }
  return { data: result.data as T, response: result.response };
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data === undefined || data === null || data === "") return new Uint8Array();
  throw new LatexApiError("Unexpected non-binary response body", {
    status: 0,
    code: "unexpected_response",
  });
}

function toJobEvent(message: SseMessage): JobEvent | undefined {
  if (message.event === "ping") return { type: "ping", at: message.data };
  if (!["queued", "running", "log", "done", "error"].includes(message.event)) return undefined;
  try {
    const payload = JSON.parse(message.data) as Record<string, unknown>;
    return { ...payload, type: message.event } as JobEvent;
  } catch {
    return undefined;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Operations under `/v1/jobs`. */
export class JobsApi {
  constructor(private readonly api: LatexApi) {}

  /** `POST /v1/jobs`: enqueue a compile and return immediately. */
  async create(input: CompileInput, opts: RequestCallOptions = {}): Promise<Job> {
    const prepared = prepareCompileBody(input);
    const { data } = await this.api.postPrepared("/v1/jobs", {}, prepared, "json", opts.signal);
    return (data as JobEnvelope).job;
  }

  /** `GET /v1/jobs`: the caller's recent jobs, newest first. */
  async list(opts: RequestCallOptions & { limit?: number } = {}): Promise<Job[]> {
    const { data } = unwrap<{ jobs: Job[] }>(
      await ops.getV1Jobs({
        client: this.api.client,
        query: opts.limit === undefined ? undefined : { limit: opts.limit },
        signal: opts.signal,
      }),
    );
    return data.jobs;
  }

  /** `GET /v1/jobs/:id`. */
  async get(id: string, opts: RequestCallOptions = {}): Promise<Job> {
    const { data } = unwrap<JobEnvelope>(
      await ops.getV1JobsById({ client: this.api.client, path: { id }, signal: opts.signal }),
    );
    return data.job;
  }

  /** `DELETE /v1/jobs/:id`: cancel a queued or running job. */
  async cancel(id: string, opts: RequestCallOptions = {}): Promise<Job> {
    const { data } = unwrap<JobEnvelope>(
      await ops.deleteV1JobsById({ client: this.api.client, path: { id }, signal: opts.signal }),
    );
    return data.job;
  }

  /** `GET /v1/jobs/:id/pdf`. */
  async pdf(id: string, opts: RequestCallOptions = {}): Promise<Uint8Array> {
    const { data } = unwrap<ArrayBuffer>(
      await ops.getV1JobsByIdPdf({
        client: this.api.client,
        path: { id },
        parseAs: "arrayBuffer",
        signal: opts.signal,
      }),
    );
    return toBytes(data);
  }

  /** `GET /v1/jobs/:id/log`: the full LaTeX log. */
  async log(id: string, opts: RequestCallOptions = {}): Promise<string> {
    const { data } = unwrap<string>(
      await ops.getV1JobsByIdLog({
        client: this.api.client,
        path: { id },
        parseAs: "text",
        signal: opts.signal,
      }),
    );
    return typeof data === "string" ? data : "";
  }

  /**
   * `GET /v1/jobs/:id/events` as an async iterable of parsed events. Ends after the
   * terminal `done`/`error` event or when the server closes the stream.
   */
  async *events(id: string, opts: EventsOptions = {}): AsyncGenerator<JobEvent, void, undefined> {
    const url = `${this.api.baseUrl}/v1/jobs/${encodeURIComponent(id)}/events`;
    const response = await this.api.fetch(url, {
      method: "GET",
      headers: { ...this.api.authHeaders(), accept: "text/event-stream" },
      signal: opts.signal,
    });
    if (!response.ok) throw await errorFromRawResponse(response);
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body || !contentType.includes("text/event-stream")) {
      await response.body?.cancel().catch(() => {});
      throw new LatexApiError("Server did not return an event stream", {
        status: response.status,
        code: "sse_unsupported",
      });
    }
    for await (const message of parseSse(response.body, opts.signal)) {
      const event = toJobEvent(message);
      if (!event) continue;
      yield event;
      if (event.type === "done" || event.type === "error") return;
    }
  }

  /**
   * Waits until the job reaches a terminal status. Streams `/events` when possible and
   * falls back to polling `GET /v1/jobs/:id`. Resolves with the final job (check
   * `job.status`); throws `LatexApiError` with code `wait_timeout` or `aborted`.
   */
  async wait(id: string, opts: WaitOptions = {}): Promise<Job> {
    const pollMs = Math.max(50, opts.pollMs ?? 1000);
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    const controller = new AbortController();
    const abortError = () =>
      opts.signal?.aborted
        ? new LatexApiError("Wait aborted", {
            status: 0,
            code: "aborted",
            cause: opts.signal.reason,
          })
        : new LatexApiError(`Job ${id} did not finish within ${timeoutMs} ms`, {
            status: 0,
            code: "wait_timeout",
          });
    const onOuterAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    const signal = controller.signal;
    const emit = (event: JobEvent) => opts.onEvent?.(event);
    const terminalEvent = (job: Job): JobEvent =>
      job.status === "succeeded"
        ? {
            type: "done",
            jobId: job.id,
            at: job.finishedAt ?? new Date().toISOString(),
            status: job.status,
          }
        : {
            type: "error",
            jobId: job.id,
            at: job.finishedAt ?? new Date().toISOString(),
            status: job.status,
            message: job.error?.message ?? "",
          };

    try {
      if (opts.signal?.aborted) throw abortError();
      let job = await this.get(id, { signal });
      if (isTerminalStatus(job.status)) {
        emit(terminalEvent(job));
        return job;
      }

      let streamed = false;
      try {
        for await (const event of this.events(id, { signal })) {
          streamed = true;
          emit(event);
          if (event.type === "done" || event.type === "error") {
            return await this.get(id, { signal });
          }
        }
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (error instanceof LatexApiError && [401, 403, 404].includes(error.status)) throw error;
        // Any other failure (no SSE support, proxy buffering, network blip): poll instead.
        if (streamed) {
          job = await this.get(id, { signal });
          if (isTerminalStatus(job.status)) {
            emit(terminalEvent(job));
            return job;
          }
        }
      }

      let lastStatus = job.status;
      for (;;) {
        if (signal.aborted) throw abortError();
        try {
          await sleep(pollMs, signal);
        } catch {
          throw abortError();
        }
        job = await this.get(id, { signal }).catch((error: unknown) => {
          if (signal.aborted) throw abortError();
          throw error;
        });
        if (isTerminalStatus(job.status)) {
          emit(terminalEvent(job));
          return job;
        }
        if (job.status !== lastStatus) {
          lastStatus = job.status;
          if (job.status === "queued" || job.status === "running") {
            emit({
              type: job.status,
              jobId: job.id,
              at: job.startedAt ?? new Date().toISOString(),
            });
          }
        }
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
      if (!signal.aborted) controller.abort();
    }
  }
}

/** Operations under `/v1/templates`. */
export class TemplatesApi {
  constructor(private readonly api: LatexApi) {}

  /** `GET /v1/templates`. */
  async list(opts: RequestCallOptions = {}): Promise<Template[]> {
    const { data } = unwrap<{ templates: Template[] }>(
      await ops.getV1Templates({ client: this.api.client, signal: opts.signal }),
    );
    return data.templates;
  }

  /** `GET /v1/templates/:id`. */
  async get(id: string, opts: RequestCallOptions = {}): Promise<Template> {
    const { data } = unwrap<{ template: Template }>(
      await ops.getV1TemplatesById({ client: this.api.client, path: { id }, signal: opts.signal }),
    );
    return data.template;
  }

  /** `GET /v1/templates/:id/files/:path`: one file of the template. */
  async file(id: string, path: string, opts: RequestCallOptions = {}): Promise<Uint8Array> {
    const { data } = unwrap<ArrayBuffer>(
      await ops.getV1TemplatesByIdFilesByPath({
        client: this.api.client,
        path: { id, path },
        parseAs: "arrayBuffer",
        signal: opts.signal,
      }),
    );
    return toBytes(data);
  }

  /** `GET /v1/templates/:id/archive`: the template as a zip (entries prefixed with `<id>/`). */
  async archive(id: string, opts: RequestCallOptions = {}): Promise<Uint8Array> {
    const { data } = unwrap<ArrayBuffer>(
      await ops.getV1TemplatesByIdArchive({
        client: this.api.client,
        path: { id },
        parseAs: "arrayBuffer",
        signal: opts.signal,
      }),
    );
    return toBytes(data);
  }

  /** `GET /v1/templates/:id/preview`: the rendered PDF of the untouched template. */
  async preview(id: string, opts: RequestCallOptions = {}): Promise<Uint8Array> {
    const { data } = unwrap<ArrayBuffer>(
      await ops.getV1TemplatesByIdPreview({
        client: this.api.client,
        path: { id },
        parseAs: "arrayBuffer",
        signal: opts.signal,
      }),
    );
    return toBytes(data);
  }

  /** `POST /v1/templates/:id/compile`: compile the template with your overrides. */
  compile(
    id: string,
    input: TemplateCompileInput | undefined,
    opts: CompileCallOptions<"json">,
  ): Promise<CompileJsonResult>;
  compile(
    id: string,
    input?: TemplateCompileInput,
    opts?: CompileCallOptions<"pdf">,
  ): Promise<CompilePdfResult>;
  compile(
    id: string,
    input?: TemplateCompileInput,
    opts?: CompileCallOptions,
  ): Promise<CompileResult>;
  async compile(
    id: string,
    input?: TemplateCompileInput,
    opts: CompileCallOptions = {},
  ): Promise<CompileResult> {
    const prepared = prepareTemplateBody(input);
    return this.api.compileWith("/v1/templates/{id}/compile", { id }, prepared, opts);
  }

  /** `POST /v1/templates/:id/jobs`: compile the template asynchronously. */
  async createJob(
    id: string,
    input?: TemplateCompileInput,
    opts: RequestCallOptions = {},
  ): Promise<Job> {
    const prepared = prepareTemplateBody(input);
    const { data } = await this.api.postPrepared(
      "/v1/templates/{id}/jobs",
      { id },
      prepared,
      "json",
      opts.signal,
    );
    return (data as JobEnvelope).job;
  }
}

/** Personal API tokens under `/v1/tokens` (secrets are only returned by `create`). */
export class TokensApi {
  constructor(private readonly api: LatexApi) {}

  /** `GET /v1/tokens`: the caller's tokens, newest first. */
  async list(opts: RequestCallOptions = {}): Promise<ApiToken[]> {
    const { data } = unwrap<{ tokens: ApiToken[] }>(
      await ops.getV1Tokens({ client: this.api.client, signal: opts.signal }),
    );
    return data.tokens;
  }

  /**
   * `POST /v1/tokens`. The secret in `token` is shown once. `expiresInDays: null` (or
   * omitted) creates a token that never expires.
   */
  async create(input: CreateTokenInput, opts: RequestCallOptions = {}): Promise<CreatedApiToken> {
    const body: { name: string; expiresInDays?: number | null } = { name: input.name };
    if (input.expiresInDays !== undefined) body.expiresInDays = input.expiresInDays;
    const { data } = unwrap<CreatedApiToken>(
      await ops.postV1Tokens({ client: this.api.client, body, signal: opts.signal }),
    );
    return data;
  }

  /** `DELETE /v1/tokens/:id`: revoke a token. Irreversible. */
  async revoke(id: string, opts: RequestCallOptions = {}): Promise<ApiToken> {
    const { data } = unwrap<{ apiToken: ApiToken }>(
      await ops.deleteV1TokensById({ client: this.api.client, path: { id }, signal: opts.signal }),
    );
    return data.apiToken;
  }
}

/** Device sign-in (RFC 8628 style) under `/v1/auth/device`. These calls send no credential. */
export class AuthApi {
  constructor(private readonly api: LatexApi) {}

  /** `POST /v1/auth/device`: start a sign-in and get the code to show to the user. */
  async startDevice(
    input: DeviceStartInput = {},
    opts: RequestCallOptions = {},
  ): Promise<DeviceAuthorizationStart> {
    const { data } = unwrap<DeviceAuthorizationStart>(
      await ops.postV1AuthDevice({ client: this.api.client, body: input, signal: opts.signal }),
    );
    return data;
  }

  /**
   * `POST /v1/auth/device/token`, once. Resolves `pending` / `slow_down` (with the server's
   * `interval` when it sent one) or `approved` with the token. Throws `LatexApiError` with
   * code `access_denied` or `expired_token` (HTTP 400) and for any other failure.
   */
  async pollDevice(deviceCode: string, opts: RequestCallOptions = {}): Promise<DevicePollResult> {
    const result = (await ops.postV1AuthDeviceToken({
      client: this.api.client,
      body: { deviceCode },
      signal: opts.signal,
    })) as RawResult;
    if (result.response?.status === 428 && isProblem(result.error)) {
      const code = result.error.code;
      const interval =
        typeof result.error.interval === "number" ? (result.error.interval as number) : undefined;
      return { status: code === "slow_down" ? "slow_down" : "pending", interval };
    }
    const { data } = unwrap<DeviceToken>(result);
    return { status: "approved", ...data };
  }
}

/**
 * Ergonomic client for the LaTeX API.
 *
 * @example
 * const api = new LatexApi({ apiKey: process.env.LATEX_API_KEY });
 * const { pdf } = await api.compile({ source: "\\documentclass{article}\\begin{document}Hi\\end{document}" });
 */
export class LatexApi {
  readonly baseUrl: string;
  /** The generated low-level client, configured with this instance's base URL, key and fetch. */
  readonly client: Client;
  readonly jobs: JobsApi;
  readonly templates: TemplatesApi;
  readonly tokens: TokensApi;
  readonly auth: AuthApi;
  /** @internal */
  readonly fetch: typeof fetch;
  private readonly apiKey: string | undefined;
  private readonly userAgent: string | undefined;

  constructor(opts: LatexApiOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? envVar("LATEX_API_URL") ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.apiKey =
      opts.apiKey ??
      opts.token ??
      envVar("LATEX_API_TOKEN") ??
      envVar("LATEX_API_KEY") ??
      undefined;
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new TypeError("No fetch implementation available; pass one in `fetch`");
    }
    this.fetch = opts.fetch
      ? opts.fetch
      : (input: RequestInfo | URL, init?: RequestInit) => fetchImpl(input, init);
    this.userAgent = opts.userAgent ?? (isBrowser() ? undefined : `latex-api-sdk/${SDK_VERSION}`);
    const headers: Record<string, string> = {};
    if (this.userAgent) headers["User-Agent"] = this.userAgent;
    this.client = createClient(
      createConfig({
        baseUrl: this.baseUrl,
        fetch: this.fetch,
        headers,
        auth: () => this.apiKey,
        throwOnError: false,
      }),
    );
    this.jobs = new JobsApi(this);
    this.templates = new TemplatesApi(this);
    this.tokens = new TokensApi(this);
    this.auth = new AuthApi(this);
  }

  /** True when an API key is configured. */
  get authenticated(): boolean {
    return Boolean(this.apiKey);
  }

  /** @internal Headers for requests made outside the generated client (SSE). */
  authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (this.userAgent) headers["user-agent"] = this.userAgent;
    return headers;
  }

  /**
   * `POST /v1/compile`: compile synchronously. Resolves with the PDF bytes by default, or
   * with the job envelope (diagnostics included) when `accept` is `json`. Throws
   * `CompileFailedError` when LaTeX reports errors.
   */
  compile(input: CompileInput, opts: CompileCallOptions<"json">): Promise<CompileJsonResult>;
  compile(input: CompileInput, opts?: CompileCallOptions<"pdf">): Promise<CompilePdfResult>;
  compile(input: CompileInput, opts?: CompileCallOptions): Promise<CompileResult>;
  async compile(input: CompileInput, opts: CompileCallOptions = {}): Promise<CompileResult> {
    const prepared = prepareCompileBody(input);
    return this.compileWith("/v1/compile", {}, prepared, opts);
  }

  /** Like `compile`, but writes the PDF to `outPath` (Node only). */
  async compileToFile(
    input: CompileInput,
    outPath: string,
    opts: Omit<CompileCallOptions, "accept"> = {},
  ): Promise<CompilePdfResult> {
    const result = await this.compile(input, { ...opts, accept: "pdf" });
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
    await fs.writeFile(outPath, result.pdf);
    return result;
  }

  /** `GET /v1/limits` (public). */
  async limits(opts: RequestCallOptions = {}): Promise<Limits> {
    return unwrap<Limits>(await ops.getV1Limits({ client: this.client, signal: opts.signal })).data;
  }

  /** `GET /v1/me`: the identity behind the configured credential (validates a token). */
  async me(opts: RequestCallOptions = {}): Promise<Me> {
    return unwrap<Me>(await ops.getV1Me({ client: this.client, signal: opts.signal })).data;
  }

  /** `GET /v1/stats` (requires a key). */
  async stats(opts: RequestCallOptions = {}): Promise<Stats> {
    return unwrap<Stats>(await ops.getV1Stats({ client: this.client, signal: opts.signal })).data;
  }

  /** `GET /health` (public). Resolves even when the server reports `degraded` (503). */
  async health(opts: RequestCallOptions = {}): Promise<Health> {
    const result = await ops.getHealth({ client: this.client, signal: opts.signal });
    if (result.response?.status === 503 && isHealth(result.error)) return result.error;
    return unwrap<Health>(result).data;
  }

  /** @internal */
  async compileWith(
    url: string,
    path: Record<string, string>,
    prepared: PreparedBody,
    opts: CompileCallOptions,
  ): Promise<CompileResult> {
    const accept = opts.accept ?? "pdf";
    const { data, response } = await this.postPrepared(url, path, prepared, accept, opts.signal);
    if (accept === "json") return { job: (data as JobEnvelope).job };
    return {
      pdf: toBytes(data),
      jobId: response.headers.get("x-job-id") ?? "",
      cached: response.headers.get("x-compile-cached") === "true",
      warnings: Number(response.headers.get("x-compile-warnings") ?? 0) || 0,
      compileMs: Number(response.headers.get("x-compile-duration-ms") ?? 0) || 0,
    };
  }

  /** @internal */
  async postPrepared(
    url: string,
    path: Record<string, string>,
    prepared: PreparedBody,
    accept: "pdf" | "json",
    signal: AbortSignal | undefined,
  ): Promise<{ data: unknown; response: Response }> {
    const headers: Record<string, string | null> = {
      Accept: accept === "json" ? "application/json" : "application/pdf, application/json",
      // `null` removes the header so the runtime adds the multipart boundary itself.
      "Content-Type": prepared.contentType ?? null,
    };
    const result = await this.client.post({
      url,
      path,
      query: prepared.query,
      body: prepared.body,
      bodySerializer: null,
      headers,
      security: BEARER as unknown as never,
      parseAs: accept === "json" ? "json" : "arrayBuffer",
      signal,
    });
    return unwrap<unknown>(result as RawResult);
  }
}

function isHealth(value: unknown): value is Health {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Health).status === "string" &&
    typeof (value as Health).checks === "object"
  );
}

export type {
  ApiToken,
  CompileFailedProblem,
  CompileRequest,
  CreatedApiToken,
  DeviceAuthorizationStart,
  DeviceToken,
  Diagnostic,
  Health,
  Job,
  JobEnvelope,
  JobResult,
  Limits,
  Me,
  ProjectFile,
  Stats,
  Template,
  TemplateCompileRequest,
  TemplateFile,
  User,
} from "./client/types.gen";
export type { Problem } from "./errors";
export { CompileFailedError, isProblem, LatexApiError } from "./errors";
export {
  createIgnoreMatcher,
  DEFAULT_IGNORE,
  type IgnoreMatcher,
  parseIgnoreFile,
} from "./ignore";
export {
  listDirectoryFiles,
  type PackDirectoryOptions,
  type PackedFile,
  packDirectory,
} from "./pack";
export { parseSse, type SseMessage } from "./sse";
export type { PreparedBody } from "./transport";
export { encodeFiles, prepareCompileBody, prepareTemplateBody } from "./transport";
export * from "./types";

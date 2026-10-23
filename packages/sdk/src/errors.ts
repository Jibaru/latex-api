import type { Diagnostic } from "./client/types.gen";

/** RFC 9457 problem details as returned by the API, plus any extension members. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  [key: string]: unknown;
}

export interface LatexApiErrorInit {
  status: number;
  code: string;
  problem?: Problem;
  retryAfterSeconds?: number;
  cause?: unknown;
}

/**
 * Thrown for every non-2xx response and for transport failures.
 * `status` is 0 when the request never reached the server.
 */
export class LatexApiError extends Error {
  override readonly name: string = "LatexApiError";
  readonly status: number;
  /** Machine-readable error code (`unauthorized`, `rate_limited`, `compile_failed`, ...). */
  readonly code: string;
  /** The parsed `application/problem+json` body, when there was one. */
  readonly problem: Problem | undefined;
  /** Seconds to wait before retrying (`rate_limited`). */
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, init: LatexApiErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.status = init.status;
    this.code = init.code;
    this.problem = init.problem;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }

  /** True for errors worth retrying as-is (network failures, rate limits, 5xx). */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/** Thrown when LaTeX itself failed (HTTP 422 `compile_failed`). */
export class CompileFailedError extends LatexApiError {
  override readonly name: string = "CompileFailedError";
  readonly diagnostics: Diagnostic[];
  readonly logUrl: string | undefined;
  readonly pdfUrl: string | undefined;
  readonly jobId: string | undefined;
  readonly errors: number;
  readonly warnings: number;

  constructor(message: string, init: LatexApiErrorInit & { problem: Problem }) {
    super(message, init);
    const p = init.problem;
    this.diagnostics = Array.isArray(p.diagnostics) ? (p.diagnostics as Diagnostic[]) : [];
    this.logUrl = typeof p.logUrl === "string" ? p.logUrl : undefined;
    this.pdfUrl = typeof p.pdfUrl === "string" ? p.pdfUrl : undefined;
    this.jobId = typeof p.jobId === "string" ? p.jobId : undefined;
    this.errors =
      typeof p.errors === "number"
        ? p.errors
        : this.diagnostics.filter((d) => d.severity === "error").length;
    this.warnings =
      typeof p.warnings === "number"
        ? p.warnings
        : this.diagnostics.filter((d) => d.severity === "warning").length;
  }
}

export function isProblem(value: unknown): value is Problem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Problem).code === "string" &&
    typeof (value as Problem).status === "number"
  );
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/**
 * Builds the right error for a failed request. `body` is whatever was parsed from the
 * response (problem JSON or text), or the thrown value for transport failures.
 */
export function errorFromResponse(body: unknown, response: Response | undefined): LatexApiError {
  if (!response) {
    const message = body instanceof Error ? body.message : "Network request failed";
    return new LatexApiError(message, { status: 0, code: "network_error", cause: body });
  }
  const status = response.status;
  if (response.ok) {
    // The server answered 2xx but the body could not be parsed as expected
    // (e.g. a proxy returned HTML, or a PDF arrived where JSON was requested).
    const detail = body instanceof Error ? body.message : "unparseable body";
    return new LatexApiError(`Unexpected ${status} response: ${detail}`, {
      status,
      code: "unexpected_response",
      cause: body,
    });
  }
  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
  if (isProblem(body)) {
    const message = body.detail ? `${body.title}: ${body.detail}` : body.title || body.code;
    if (body.code === "compile_failed") {
      return new CompileFailedError(message, {
        status,
        code: body.code,
        problem: body,
        retryAfterSeconds,
      });
    }
    return new LatexApiError(message, {
      status,
      code: body.code,
      problem: body,
      retryAfterSeconds,
    });
  }
  const code =
    status === 401
      ? "unauthorized"
      : status === 404
        ? "not_found"
        : status === 429
          ? "rate_limited"
          : `http_${status}`;
  const text =
    typeof body === "string" && body.trim() ? body.trim().slice(0, 200) : response.statusText;
  return new LatexApiError(`HTTP ${status}${text ? `: ${text}` : ""}`, {
    status,
    code,
    retryAfterSeconds,
    cause: body,
  });
}

/** Builds a LatexApiError from a raw `fetch` Response that is not ok. */
export async function errorFromRawResponse(response: Response): Promise<LatexApiError> {
  const text = await response.text().catch(() => "");
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  return errorFromResponse(body, response);
}

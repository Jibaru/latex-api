import { type DomainError, isDomainError } from "@latex-api/core";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  [key: string]: unknown;
}

const TITLES: Record<string, string> = {
  invalid_project: "Invalid project",
  invalid_request: "Invalid request",
  payload_too_large: "Payload too large",
  compile_failed: "Compilation failed",
  timeout: "Compilation timed out",
  unauthorized: "Unauthorized",
  forbidden: "Forbidden",
  rate_limited: "Rate limited",
  template_not_found: "Template not found",
  job_not_found: "Job not found",
  job_not_cancellable: "Job cannot be cancelled",
  compiler_unavailable: "Compiler unavailable",
  unsupported_media_type: "Unsupported media type",
  not_found: "Not found",
  internal: "Internal error",
  conflict: "Conflict",
  authorization_pending: "Authorization pending",
  slow_down: "Slow down",
  access_denied: "Access denied",
  expired_token: "Expired token",
};

export function problem(
  c: Context,
  status: number,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  const publicUrl = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  const body: ProblemDetails = {
    type: `${publicUrl}/docs/errors#${code}`,
    title: TITLES[code] ?? code,
    status,
    detail,
    instance: new URL(c.req.url).pathname,
    code,
    ...extra,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json; charset=utf-8", ...headers },
  });
}

export function problemFromDomainError(c: Context, error: DomainError): Response {
  const headers: Record<string, string> = {};
  if (error.code === "rate_limited" && error.details?.retryAfterSeconds) {
    headers["retry-after"] = String(error.details.retryAfterSeconds);
  }
  return problem(c, error.status, error.code, error.message, error.details ?? {}, headers);
}

export function onError(error: unknown, c: Context): Response {
  if (isDomainError(error)) return problemFromDomainError(c, error);
  if (error instanceof ZodError) {
    return problem(c, 400, "invalid_request", "Request validation failed", {
      issues: error.issues,
    });
  }
  if (error instanceof HTTPException) {
    const status = error.status;
    const code =
      status === 413
        ? "payload_too_large"
        : status === 415
          ? "unsupported_media_type"
          : status === 401
            ? "unauthorized"
            : status === 404
              ? "not_found"
              : "invalid_request";
    return problem(c, status, code, error.message || TITLES[code] || "Request failed");
  }
  if (error instanceof SyntaxError) {
    return problem(c, 400, "invalid_request", `Malformed JSON body: ${error.message}`);
  }
  console.error(error);
  return problem(c, 500, "internal", "Unexpected server error");
}

export type ErrorCode =
  | "invalid_project"
  | "payload_too_large"
  | "compile_failed"
  | "timeout"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "template_not_found"
  | "job_not_found"
  | "job_not_cancellable"
  | "compiler_unavailable"
  | "not_found"
  | "conflict"
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "internal";

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class InvalidProjectError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("invalid_project", 400, message, details);
    this.name = "InvalidProjectError";
  }
}

export class PayloadTooLargeError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("payload_too_large", 413, message, details);
    this.name = "PayloadTooLargeError";
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = "Missing or invalid API key") {
    super("unauthorized", 401, message);
    this.name = "UnauthorizedError";
  }
}

export class RateLimitedError extends DomainError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message = "Rate limit exceeded") {
    super("rate_limited", 429, message, { retryAfterSeconds });
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class TemplateNotFoundError extends DomainError {
  constructor(id: string) {
    super("template_not_found", 404, `Template "${id}" not found`, { templateId: id });
    this.name = "TemplateNotFoundError";
  }
}

export class JobNotFoundError extends DomainError {
  constructor(id: string) {
    super("job_not_found", 404, `Job "${id}" not found`, { jobId: id });
    this.name = "JobNotFoundError";
  }
}

export class JobNotCancellableError extends DomainError {
  constructor(id: string, status: string) {
    super("job_not_cancellable", 409, `Job "${id}" is ${status} and cannot be cancelled`, {
      jobId: id,
      status,
    });
    this.name = "JobNotCancellableError";
  }
}

export class CompilerUnavailableError extends DomainError {
  constructor(message = "The compiler backend is unavailable") {
    super("compiler_unavailable", 503, message);
    this.name = "CompilerUnavailableError";
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

export class ForbiddenError extends DomainError {
  constructor(message = "This credential cannot perform this action") {
    super("forbidden", 403, message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("not_found", 404, message, details);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("conflict", 409, message, details);
    this.name = "ConflictError";
  }
}

/** Device flow outcomes, mirroring RFC 8628 error codes. */
export class DeviceFlowError extends DomainError {
  constructor(
    code: "authorization_pending" | "slow_down" | "access_denied" | "expired_token",
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(
      code,
      code === "authorization_pending" || code === "slow_down" ? 428 : 400,
      message,
      details,
    );
    this.name = "DeviceFlowError";
  }
}

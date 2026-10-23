import { CompileFailedError, LatexApiError } from "@jibaru/latex-api-sdk";
import { sanitize } from "./blocks/style";

/** Process exit codes. Part of the published contract (README, `schema`, SKILL.md). */
export const EXIT = {
  OK: 0,
  /** LaTeX reported errors, a job failed / timed out / was cancelled, or a runtime failure. */
  COMPILE_FAILED: 1,
  /** Bad flags or arguments, missing files, refusing to overwrite, confirmation required. */
  USAGE: 2,
  /** Not authenticated, credential rejected or forbidden, network or server unreachable. */
  AUTH: 3,
  /** The job, token, template or profile does not exist. */
  NOT_FOUND: 4,
  /** Conflict (already exists, too many tokens, job already finished) or rate limited. */
  CONFLICT: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const EXIT_DESCRIPTIONS: Record<ExitCode, string> = {
  0: "Success",
  1: "Compile or runtime failure: LaTeX errors, a failed, timed out or cancelled job",
  2: "Usage error: bad flag or argument, missing file, refusing to overwrite, confirmation required",
  3: "Authentication or network error: not logged in, token rejected or forbidden, server unreachable",
  4: "Not found: job, token, template or profile",
  5: "Conflict or rate limited: already exists, too many tokens, job already finished, HTTP 429",
};

export interface CliErrorOptions {
  exitCode?: ExitCode;
  hint?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * Every failure a command reports. `code` is stable and machine-readable (snake_case),
 * `message` is for people, `hint` names the command that fixes it.
 */
export class CliError extends Error {
  override readonly name = "CliError";
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, options: CliErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.exitCode = options.exitCode ?? EXIT.USAGE;
    this.hint = options.hint;
    this.details = options.details;
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError("usage", message, { exitCode: EXIT.USAGE, hint });
}

function apiExitCode(error: LatexApiError): ExitCode {
  if (error instanceof CompileFailedError) return EXIT.COMPILE_FAILED;
  if (error.code === "wait_timeout" || error.code === "aborted") return EXIT.COMPILE_FAILED;
  const s = error.status;
  if (s === 404) return EXIT.NOT_FOUND;
  if (s === 409 || s === 429) return EXIT.CONFLICT;
  if (s === 0 || s === 401 || s === 403 || s >= 500) return EXIT.AUTH;
  if (s >= 400) return EXIT.USAGE;
  return EXIT.COMPILE_FAILED;
}

function apiHint(error: LatexApiError): string | undefined {
  if (error instanceof CompileFailedError) {
    return "Fix the errors in error.details.diagnostics (file:line), then re-run the same command";
  }
  switch (error.status) {
    case 0:
      return "Check your connection and the base URL (`latex-api profile get`)";
    case 401:
      return "Run `latex-api auth login` (or set LATEX_API_TOKEN)";
    case 403:
      return "This credential is not allowed to do that; sign in as a user with `latex-api auth login`";
    case 404:
      return undefined;
    case 413:
      return "Exclude files with .latexapiignore or split the document";
    case 429:
      return error.retryAfterSeconds
        ? `Retry in ${error.retryAfterSeconds}s`
        : "Wait and retry; see `latex-api limits`";
    default:
      return error.status >= 500
        ? "The server failed; retry, or check `latex-api health`"
        : undefined;
  }
}

/** Normalizes anything thrown into a CliError carrying the documented exit code. */
export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof CompileFailedError) {
    return new CliError("compile_failed", sanitize(error.problem?.detail ?? error.message), {
      exitCode: EXIT.COMPILE_FAILED,
      hint: apiHint(error),
      details: {
        jobId: error.jobId,
        errors: error.errors,
        warnings: error.warnings,
        diagnostics: error.diagnostics,
        logUrl: error.logUrl,
      },
      cause: error,
    });
  }
  if (error instanceof LatexApiError) {
    const details: Record<string, unknown> = { status: error.status };
    if (error.retryAfterSeconds !== undefined) details.retryAfterSeconds = error.retryAfterSeconds;
    return new CliError(error.code, sanitize(error.message), {
      exitCode: apiExitCode(error),
      hint: apiHint(error),
      details,
      cause: error,
    });
  }
  if (error instanceof Error && error.name === "CLIError") {
    // citty's argument errors (missing positional, invalid enum value)
    return new CliError("usage", error.message, {
      exitCode: EXIT.USAGE,
      hint: "Run the command with --help to see its arguments",
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CliError("internal_error", message, { exitCode: EXIT.COMPILE_FAILED, cause: error });
}

export function exitCodeFor(error: unknown): ExitCode {
  return toCliError(error).exitCode;
}

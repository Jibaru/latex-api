import { CompileFailedError, LatexApiError } from "@jibaru/latex-api-sdk";

/** Process exit codes used by every command. */
export const EXIT = {
  OK: 0,
  /** LaTeX reported errors (or the job failed). */
  COMPILE_FAILED: 1,
  /** Bad arguments, missing files, refusing to overwrite. */
  USAGE: 2,
  /** Network, authentication, rate limit or server errors. */
  NETWORK: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error with a predetermined exit code and a message meant for the user. */
export class CliError extends Error {
  override readonly name = "CliError";
  constructor(
    message: string,
    readonly exitCode: ExitCode = EXIT.USAGE,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function exitCodeFor(error: unknown): ExitCode {
  if (error instanceof CliError) return error.exitCode;
  if (error instanceof CompileFailedError) return EXIT.COMPILE_FAILED;
  if (error instanceof LatexApiError) return EXIT.NETWORK;
  return EXIT.COMPILE_FAILED;
}

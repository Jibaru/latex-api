// Device sign-in polling (RFC 8628 style). Pure over an SDK client plus injected sleep/clock,
// so the whole state machine is unit-tested against a stubbed fetch.

import { type LatexApi, LatexApiError } from "@jibaru/latex-api-sdk";
import { CliError, EXIT } from "./exit";

export interface DeviceApproval {
  token: string;
  tokenId: string;
  name: string;
  expiresAt?: string;
  user: { id: string; email?: string } | null;
}

export type PollStatus = "pending" | "slow_down" | "retrying";

export interface PollOptions {
  api: LatexApi;
  deviceCode: string;
  /** Seconds between polls, from the start response. */
  interval: number;
  /** Absolute deadline of the device code (ms since epoch). */
  expiresAt: number;
  /** Give up after this long even if the code is still valid. */
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onStatus?: (status: PollStatus, info: { interval: number; remainingMs: number }) => void;
}

const SLOW_DOWN_STEP_SECONDS = 2;
const MAX_TRANSIENT_FAILURES = 5;

export async function pollDeviceToken(opts: PollOptions): Promise<DeviceApproval> {
  const started = opts.now();
  const deadline = Math.min(opts.expiresAt, started + opts.timeoutMs);
  let interval = Math.max(1, opts.interval);
  let transient = 0;

  for (;;) {
    const remaining = deadline - opts.now();
    if (remaining <= 0) {
      if (opts.now() >= opts.expiresAt) {
        throw new CliError("expired_token", "The sign-in code expired before it was approved", {
          exitCode: EXIT.AUTH,
          hint: "Run `latex-api auth login` again",
        });
      }
      throw new CliError("login_timeout", "Gave up waiting for the browser approval", {
        exitCode: EXIT.AUTH,
        hint: "Approve the code in the browser, then run `latex-api auth login --resume`",
      });
    }
    await opts.sleep(Math.min(interval * 1000, remaining));
    if (opts.now() >= deadline) continue;

    let result: Awaited<ReturnType<LatexApi["auth"]["pollDevice"]>>;
    try {
      result = await opts.api.auth.pollDevice(opts.deviceCode);
      transient = 0;
    } catch (error) {
      if (error instanceof LatexApiError) {
        if (error.code === "access_denied") {
          throw new CliError("access_denied", "The sign-in was denied in the browser", {
            exitCode: EXIT.AUTH,
            hint: "Run `latex-api auth login` to start over",
            cause: error,
          });
        }
        if (error.code === "expired_token") {
          throw new CliError("expired_token", "The sign-in code expired or was already used", {
            exitCode: EXIT.AUTH,
            hint: "Run `latex-api auth login` again",
            cause: error,
          });
        }
        if ((error.status === 0 || error.status >= 500) && transient < MAX_TRANSIENT_FAILURES) {
          transient += 1;
          opts.onStatus?.("retrying", { interval, remainingMs: deadline - opts.now() });
          continue;
        }
      }
      throw error;
    }

    if (result.status === "approved") {
      const { status: _status, ...approval } = result;
      return approval;
    }
    // The server's interval is authoritative when present; slow_down always adds a step on
    // top so a client that was told to back off never polls at the old rate.
    if (typeof result.interval === "number" && result.interval > 0) interval = result.interval;
    if (result.status === "slow_down") interval += SLOW_DOWN_STEP_SECONDS;
    opts.onStatus?.(result.status, { interval, remainingMs: deadline - opts.now() });
  }
}

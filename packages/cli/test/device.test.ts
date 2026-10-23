import { LatexApi } from "@jibaru/latex-api-sdk";
import { describe, expect, it } from "vitest";
import { pollDeviceToken } from "../src/device";
import { CliError } from "../src/exit";
import { json, problem, stubFetch } from "./helpers";

const APPROVED = {
  token: "lta_new",
  tokenId: "tok_new",
  name: "latex-api-cli",
  user: { id: "u1", email: "a@b.c" },
};

function setup(responses: Array<() => Response>) {
  const queue = [...responses];
  const stub = stubFetch({
    "POST /v1/auth/device/token": () => (queue.shift() ?? (() => problem(500, "exhausted")))(),
  });
  const api = new LatexApi({ baseUrl: "https://api.test", apiKey: "", fetch: stub.fetch });
  let clock = 0;
  const sleeps: number[] = [];
  const statuses: string[] = [];
  const opts = {
    api,
    deviceCode: "d".repeat(32),
    interval: 5,
    expiresAt: 600_000,
    timeoutMs: 600_000,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    onStatus: (status: string) => statuses.push(status),
  };
  return { opts, sleeps, statuses, calls: stub.calls, setClock: (v: number) => (clock = v) };
}

describe("device sign-in polling", () => {
  it("pending → slow_down → approved, backing off on slow_down", async () => {
    const { opts, sleeps, statuses, calls } = setup([
      () => problem(428, "authorization_pending"),
      () => problem(428, "slow_down"),
      () => json(APPROVED),
    ]);
    const approval = await pollDeviceToken(opts);
    expect(approval).toEqual(APPROVED);
    expect(sleeps).toEqual([5000, 5000, 7000]);
    expect(statuses).toEqual(["pending", "slow_down"]);
    expect(calls).toHaveLength(3);
    expect(JSON.parse(calls[0]!.body)).toEqual({ deviceCode: "d".repeat(32) });
    expect(calls[0]!.headers.get("authorization")).toBeNull();
  });

  it("uses the interval from the problem body, plus 2 s on slow_down", async () => {
    const { opts, sleeps } = setup([
      () => problem(428, "authorization_pending", { interval: 8 }),
      () => problem(428, "slow_down", { interval: 10 }),
      () => json(APPROVED),
    ]);
    await pollDeviceToken(opts);
    expect(sleeps).toEqual([5000, 8000, 12000]);
  });

  it("stops with access_denied (exit 3) when the user denies", async () => {
    const { opts } = setup([
      () => problem(428, "authorization_pending"),
      () => problem(400, "access_denied"),
    ]);
    const error = await pollDeviceToken(opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: "access_denied", exitCode: 3 });
  });

  it("stops with expired_token when the server says the code expired", async () => {
    const { opts } = setup([() => problem(400, "expired_token")]);
    await expect(pollDeviceToken(opts)).rejects.toMatchObject({
      code: "expired_token",
      exitCode: 3,
    });
  });

  it("stops at the code's own expiry without another request", async () => {
    const { opts, calls } = setup(
      Array.from({ length: 50 }, () => () => problem(428, "authorization_pending")),
    );
    await expect(pollDeviceToken({ ...opts, expiresAt: 12_000 })).rejects.toMatchObject({
      code: "expired_token",
    });
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it("gives up at --timeout with login_timeout and a resume hint", async () => {
    const { opts } = setup(
      Array.from({ length: 50 }, () => () => problem(428, "authorization_pending")),
    );
    const error = (await pollDeviceToken({ ...opts, timeoutMs: 20_000 }).catch(
      (e: unknown) => e,
    )) as CliError;
    expect(error.code).toBe("login_timeout");
    expect(error.hint).toMatch(/--resume/);
  });

  it("retries transient server errors, then succeeds", async () => {
    const { opts, statuses } = setup([() => problem(503, "unavailable"), () => json(APPROVED)]);
    expect(await pollDeviceToken(opts)).toEqual(APPROVED);
    expect(statuses).toEqual(["retrying"]);
  });
});

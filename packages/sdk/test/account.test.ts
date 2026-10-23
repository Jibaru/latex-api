import { describe, expect, it } from "vitest";
import { LatexApi, LatexApiError } from "../src/index";
import { json, makeJob, problem, stubFetch } from "./helpers";

function api(responder: Parameters<typeof stubFetch>[0], apiKey: string | undefined = "secret") {
  const stub = stubFetch(responder);
  const client = new LatexApi({ baseUrl: "https://api.test", apiKey, fetch: stub.fetch });
  return { client, calls: stub.calls };
}

const TOKEN = {
  id: "tok_1",
  name: "laptop",
  prefix: "lta_Ab12Cd34",
  origin: "cli" as const,
  status: "active" as const,
  createdAt: "2026-10-01T00:00:00.000Z",
};

describe("account", () => {
  it("reads /v1/me with the bearer token", async () => {
    const me = { user: { id: "u1", email: "a@b.c" }, principal: { name: "a@b.c", kind: "user" } };
    const { client, calls } = api(() => json(me));
    expect(await client.me()).toEqual(me);
    expect(calls[0]!.url.pathname).toBe("/v1/me");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer secret");
  });

  it("lists, creates and revokes tokens", async () => {
    const { client, calls } = api((req) => {
      if (req.method === "GET") return json({ tokens: [TOKEN] });
      if (req.method === "POST") return json({ token: "lta_secret", apiToken: TOKEN }, 201);
      return json({ apiToken: { ...TOKEN, status: "revoked" } });
    });
    expect(await client.tokens.list()).toEqual([TOKEN]);
    const created = await client.tokens.create({ name: "ci", expiresInDays: null });
    expect(created.token).toBe("lta_secret");
    expect(calls[1]!.json()).toEqual({ name: "ci", expiresInDays: null });
    await client.tokens.create({ name: "ci2" });
    expect(calls[2]!.json()).toEqual({ name: "ci2" });
    const revoked = await client.tokens.revoke("tok_1");
    expect(revoked.status).toBe("revoked");
    expect(calls[3]!.method).toBe("DELETE");
    expect(calls[3]!.url.pathname).toBe("/v1/tokens/tok_1");
  });

  it("lists the caller's jobs with a limit", async () => {
    const { client, calls } = api(() => json({ jobs: [makeJob()] }));
    const jobs = await client.jobs.list({ limit: 5 });
    expect(jobs).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/v1/jobs");
    expect(calls[0]!.url.searchParams.get("limit")).toBe("5");
  });

  it("reads LATEX_API_TOKEN before the deprecated LATEX_API_KEY", () => {
    const previous = { token: process.env.LATEX_API_TOKEN, key: process.env.LATEX_API_KEY };
    process.env.LATEX_API_TOKEN = "from-token";
    process.env.LATEX_API_KEY = "from-key";
    try {
      const client = new LatexApi({ fetch: stubFetch(() => json({})).fetch });
      expect(client.authHeaders().authorization).toBe("Bearer from-token");
      expect(
        new LatexApi({ token: "explicit", fetch: stubFetch(() => json({})).fetch }).authHeaders()
          .authorization,
      ).toBe("Bearer explicit");
    } finally {
      if (previous.token === undefined) delete process.env.LATEX_API_TOKEN;
      else process.env.LATEX_API_TOKEN = previous.token;
      if (previous.key === undefined) delete process.env.LATEX_API_KEY;
      else process.env.LATEX_API_KEY = previous.key;
    }
  });
});

describe("device sign-in", () => {
  const start = {
    deviceCode: "d".repeat(32),
    userCode: "ABCD-EFGH",
    verificationUri: "https://app.test/device",
    verificationUriComplete: "https://app.test/device?code=ABCD-EFGH",
    expiresIn: 600,
    interval: 5,
  };

  it("starts without sending a credential", async () => {
    const { client, calls } = api(() => json(start));
    expect(await client.auth.startDevice({ clientName: "cli", hostname: "h" })).toEqual(start);
    expect(calls[0]!.url.pathname).toBe("/v1/auth/device");
    expect(calls[0]!.headers.get("authorization")).toBeNull();
    expect(calls[0]!.json()).toEqual({ clientName: "cli", hostname: "h" });
  });

  it("maps 428 to pending / slow_down and 200 to approved", async () => {
    const responses = [
      problem(428, "authorization_pending"),
      problem(428, "slow_down", { interval: 10 }),
      json({ token: "lta_x", tokenId: "tok_1", name: "cli", user: { id: "u1" } }),
    ];
    const { client, calls } = api(() => responses.shift()!);
    expect(await client.auth.pollDevice(start.deviceCode)).toEqual({
      status: "pending",
      interval: undefined,
    });
    expect(await client.auth.pollDevice(start.deviceCode)).toEqual({
      status: "slow_down",
      interval: 10,
    });
    expect(await client.auth.pollDevice(start.deviceCode)).toMatchObject({
      status: "approved",
      token: "lta_x",
      tokenId: "tok_1",
    });
    expect(calls[0]!.json()).toEqual({ deviceCode: start.deviceCode });
    expect(calls[0]!.headers.get("authorization")).toBeNull();
  });

  it("throws access_denied and expired_token", async () => {
    const { client } = api(() => problem(400, "access_denied"));
    await expect(client.auth.pollDevice(start.deviceCode)).rejects.toMatchObject({
      name: "LatexApiError",
      code: "access_denied",
      status: 400,
    });
    const expired = api(() => problem(400, "expired_token"));
    const error = await expired.client.auth.pollDevice(start.deviceCode).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LatexApiError);
    expect((error as LatexApiError).code).toBe("expired_token");
  });
});

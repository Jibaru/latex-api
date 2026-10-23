import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auth, session, TEX, testContainer } from "./helpers";

type Ctx = Awaited<ReturnType<typeof testContainer>>;
const json = { "content-type": "application/json" };

describe("accounts, tokens and CLI device sign-in", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await testContainer();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it("identifies session, operator key and anonymous callers", async () => {
    const me = await ctx.app.request("/v1/me", { headers: session });
    expect(await me.json()).toMatchObject({
      user: { id: "user_ada", email: "ada@example.com" },
      principal: { via: "session" },
    });
    const op = await ctx.app.request("/v1/me", { headers: auth });
    expect(await op.json()).toMatchObject({ user: null, principal: { kind: "key", via: "env" } });
    expect((await ctx.app.request("/v1/me")).status).toBe(401);
  });

  it("creates a token from the dashboard, uses it, lists jobs, then revokes it", async () => {
    const created = await ctx.app.request("/v1/tokens", {
      method: "POST",
      headers: { ...session, ...json },
      body: JSON.stringify({ name: "laptop", expiresInDays: 30 }),
    });
    expect(created.status).toBe(201);
    const { token, apiToken } = (await created.json()) as {
      token: string;
      apiToken: { id: string; origin: string; status: string };
    };
    expect(token).toMatch(/^lta_/);
    expect(apiToken).toMatchObject({ origin: "dashboard", status: "active" });
    const bearer = { authorization: `Bearer ${token}` };

    const compiled = await ctx.app.request("/v1/compile", {
      method: "POST",
      headers: { ...bearer, "content-type": "text/x-tex" },
      body: TEX,
    });
    expect(compiled.status).toBe(200);
    const jobs = (await (
      await ctx.app.request("/v1/jobs?limit=5", { headers: bearer })
    ).json()) as { jobs: unknown[] };
    expect(jobs.jobs).toHaveLength(1);
    // Same user through the browser sees the same jobs.
    const viaSession = (await (await ctx.app.request("/v1/jobs", { headers: session })).json()) as {
      jobs: unknown[];
    };
    expect(viaSession.jobs).toHaveLength(1);
    // The operator key does not.
    const viaKey = (await (await ctx.app.request("/v1/jobs", { headers: auth })).json()) as {
      jobs: unknown[];
    };
    expect(viaKey.jobs).toHaveLength(0);

    const list = (await (await ctx.app.request("/v1/tokens", { headers: bearer })).json()) as {
      tokens: Array<{ id: string }>;
    };
    expect(list.tokens.map((t) => t.id)).toEqual([apiToken.id]);
    expect(JSON.stringify(list)).not.toContain(token);

    const revoked = await ctx.app.request(`/v1/tokens/${apiToken.id}`, {
      method: "DELETE",
      headers: session,
    });
    expect(revoked.status).toBe(200);
    expect((await ctx.app.request("/v1/me", { headers: bearer })).status).toBe(401);
  });

  it("forbids personal-token endpoints to operator keys", async () => {
    const res = await ctx.app.request("/v1/tokens", { headers: auth });
    expect(res.status).toBe(403);
  });

  it("runs the full device flow", async () => {
    const start = await ctx.app.request("/v1/auth/device", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ hostname: "ada-laptop", platform: "linux" }),
    });
    expect(start.status).toBe(200);
    const s = (await start.json()) as {
      deviceCode: string;
      userCode: string;
      verificationUriComplete: string;
      interval: number;
    };
    expect(s.verificationUriComplete).toBe(`http://api.test/cli/authorize?code=${s.userCode}`);

    const poll = () =>
      ctx.app.request("/v1/auth/device/token", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ deviceCode: s.deviceCode }),
      });
    const pending = await poll();
    expect(pending.status).toBe(428);
    expect(((await pending.json()) as { code: string }).code).toBe("authorization_pending");

    const view = await ctx.app.request(`/v1/auth/device/${s.userCode}`, { headers: session });
    expect(await view.json()).toMatchObject({ status: "pending", hostname: "ada-laptop" });

    // A token cannot approve; only a browser session can.
    const forbidden = await ctx.app.request(`/v1/auth/device/${s.userCode}/approve`, {
      method: "POST",
      headers: { ...auth, ...json },
      body: "{}",
    });
    expect(forbidden.status).toBe(403);

    const approved = await ctx.app.request(`/v1/auth/device/${s.userCode}/approve`, {
      method: "POST",
      headers: { ...session, ...json },
      body: JSON.stringify({ expiresInDays: null }),
    });
    expect(approved.status).toBe(200);

    const done = await poll();
    expect(done.status).toBe(200);
    const result = (await done.json()) as { token: string; name: string; user: { id: string } };
    expect(result).toMatchObject({ name: "CLI on ada-laptop", user: { id: "user_ada" } });
    const me = await ctx.app.request("/v1/me", {
      headers: { authorization: `Bearer ${result.token}` },
    });
    expect(await me.json()).toMatchObject({ principal: { via: "token" } });

    const again = await poll();
    expect(again.status).toBe(400);
    expect(((await again.json()) as { code: string }).code).toBe("expired_token");
  });
});

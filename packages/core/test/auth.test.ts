import { describe, expect, it } from "vitest";
import {
  ApproveDeviceAuthorization,
  CreateApiToken,
  DenyDeviceAuthorization,
  ForbiddenError,
  GetDeviceAuthorization,
  ListApiTokens,
  looksLikeApiToken,
  normalizeUserCode,
  PollDeviceAuthorization,
  ResolveCredential,
  RevokeApiToken,
  StartDeviceAuthorization,
} from "../src/index";
import { makeDeps } from "./fakes";

const session = {
  name: "user_1",
  kind: "user" as const,
  via: "session" as const,
  email: "ada@example.com",
};

describe("personal API tokens", () => {
  it("creates, resolves, lists and revokes", async () => {
    const deps = makeDeps();
    const { secret, token } = await new CreateApiToken(deps).execute({
      principal: session,
      name: "laptop",
      expiresInDays: 30,
      origin: "dashboard",
    });
    expect(looksLikeApiToken(secret)).toBe(true);
    expect(secret.startsWith(token.prefix)).toBe(true);
    expect(token.hash).not.toContain(secret);

    const principal = await new ResolveCredential(deps).execute(secret);
    expect(principal).toMatchObject({
      name: "user_1",
      kind: "user",
      via: "token",
      tokenId: token.id,
    });

    const list = await new ListApiTokens(deps).execute(session);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "laptop", status: "active", origin: "dashboard" });
    expect(JSON.stringify(list)).not.toContain(secret);

    await new RevokeApiToken(deps).execute(session, token.id);
    expect(await new ResolveCredential(deps).execute(secret)).toBeNull();
    await expect(
      new RevokeApiToken(deps).execute({ ...session, name: "user_2" }, token.id),
    ).rejects.toThrow(/not found/);
  });

  it("rejects expired tokens, bad TTLs and non-user principals", async () => {
    const deps = makeDeps();
    const { secret, token } = await new CreateApiToken(deps).execute({
      principal: session,
      name: "short",
      expiresInDays: 1,
      origin: "api",
    });
    deps.tokens.rows.get(token.id)!.expiresAt = new Date(0);
    expect(await new ResolveCredential(deps).execute(secret)).toBeNull();
    await expect(
      new CreateApiToken(deps).execute({
        principal: session,
        name: "x",
        expiresInDays: 0,
        origin: "api",
      }),
    ).rejects.toThrow(/expiresInDays/);
    await expect(
      new CreateApiToken(deps).execute({
        principal: { name: "ops", kind: "key" },
        name: "x",
        origin: "api",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("resolves sessions and env keys", async () => {
    const deps = makeDeps();
    expect(await new ResolveCredential(deps).execute("aaa.bbb.ccc")).toMatchObject({
      name: "user_1",
      via: "session",
    });
    expect(await new ResolveCredential(deps).execute("secret")).toMatchObject({
      name: "test",
      via: "env",
    });
    expect(await new ResolveCredential(deps).execute("nope")).toBeNull();
  });
});

describe("device authorization", () => {
  it("goes pending → approved → token, single use", async () => {
    const deps = makeDeps();
    const start = await new StartDeviceAuthorization(deps).execute({
      hostname: "ada-mbp",
      platform: "darwin",
    });
    expect(start.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    await expect(new PollDeviceAuthorization(deps).execute(start.deviceCode)).rejects.toMatchObject(
      {
        code: "authorization_pending",
      },
    );

    const view = await new GetDeviceAuthorization(deps).execute(
      session,
      start.userCode.toLowerCase().replace("-", ""),
    );
    expect(view).toMatchObject({ status: "pending", hostname: "ada-mbp" });

    await new ApproveDeviceAuthorization(deps).execute(session, start.userCode, {
      expiresInDays: null,
    });
    const result = await new PollDeviceAuthorization(deps).execute(start.deviceCode);
    expect(result.name).toBe("CLI on ada-mbp");
    expect(result.user.id).toBe("user_1");
    expect(result.expiresAt).toBeUndefined();
    expect(await new ResolveCredential(deps).execute(result.token)).toMatchObject({
      name: "user_1",
    });

    await expect(new PollDeviceAuthorization(deps).execute(start.deviceCode)).rejects.toMatchObject(
      {
        code: "expired_token",
      },
    );
  });

  it("requires a browser session to approve and supports denial", async () => {
    const deps = makeDeps();
    const start = await new StartDeviceAuthorization(deps).execute({});
    await expect(
      new ApproveDeviceAuthorization(deps).execute(
        { ...session, via: "token" },
        start.userCode,
        {},
      ),
    ).rejects.toThrow(ForbiddenError);
    await new DenyDeviceAuthorization(deps).execute(session, start.userCode);
    await expect(new PollDeviceAuthorization(deps).execute(start.deviceCode)).rejects.toMatchObject(
      {
        code: "access_denied",
      },
    );
    expect(normalizeUserCode("abcd efgh")).toBe("ABCD-EFGH");
  });
});

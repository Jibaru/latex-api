import { randomUUID } from "node:crypto";
import {
  type ApiToken,
  DEVICE_CODE_TTL_MS,
  DEVICE_POLL_INTERVAL_S,
  type DeviceAuthorization,
  deviceLookupHash,
  generateDeviceCode,
  generateTokenSecret,
  generateUserCode,
  hashSecret,
  looksLikeApiToken,
  looksLikeJwt,
  MAX_ACTIVE_TOKENS_PER_USER,
  MAX_TOKEN_TTL_DAYS,
  normalizeUserCode,
  type TokenOrigin,
  tokenStatus,
} from "../domain/auth";
import {
  ConflictError,
  DeviceFlowError,
  ForbiddenError,
  InvalidProjectError,
  NotFoundError,
} from "../domain/errors";
import type { Principal } from "../domain/job";
import type { CoreDeps } from "./deps";

const TOUCH_INTERVAL_MS = 60_000;

/**
 * Turns a bearer credential into a principal. Order: personal API token (`lta_...`),
 * identity-provider session JWT, then operator keys from the environment.
 */
export class ResolveCredential {
  constructor(private readonly deps: CoreDeps) {}

  async execute(raw: string): Promise<Principal | null> {
    const token = raw.trim();
    if (!token) return null;
    const now = this.deps.clock.now();

    if (looksLikeApiToken(token)) {
      const record = await this.deps.tokens.findByHash(hashSecret(token));
      if (!record || tokenStatus(record, now) !== "active") return null;
      if (!record.lastUsedAt || now.getTime() - record.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
        void this.deps.tokens.touch(record.id, now).catch(() => undefined);
      }
      return {
        name: record.userId,
        kind: "user",
        via: "token",
        tokenId: record.id,
        email: record.userEmail,
      };
    }

    if (looksLikeJwt(token) && this.deps.sessions.enabled) {
      const user = await this.deps.sessions.verify(token);
      if (user) return { name: user.id, kind: "user", via: "session", email: user.email };
      return null;
    }

    const env = await this.deps.apiKeys.resolve(token);
    return env ? { ...env, via: "env" } : null;
  }
}

export interface ApiTokenView {
  id: string;
  name: string;
  prefix: string;
  origin: TokenOrigin;
  status: "active" | "expired" | "revoked";
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export function toTokenView(token: ApiToken, now: Date): ApiTokenView {
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    origin: token.origin,
    status: tokenStatus(token, now),
    createdAt: token.createdAt.toISOString(),
    expiresAt: token.expiresAt?.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString(),
    revokedAt: token.revokedAt?.toISOString(),
  };
}

export function requireUser(principal: Principal): { id: string; email?: string } {
  if (principal.kind !== "user") {
    throw new ForbiddenError("Sign in with a user account (personal token or session) to do this");
  }
  return { id: principal.name, email: principal.email };
}

export class CreateApiToken {
  constructor(private readonly deps: CoreDeps) {}

  async execute(input: {
    principal: Principal;
    name: string;
    /** `null` or omitted = never expires. */
    expiresInDays?: number | null;
    origin: TokenOrigin;
  }): Promise<{ secret: string; token: ApiToken }> {
    const user = requireUser(input.principal);
    const name = input.name.trim();
    if (name.length < 1 || name.length > 80) {
      throw new InvalidProjectError("Token name must be 1-80 characters");
    }
    const now = this.deps.clock.now();
    if ((await this.deps.tokens.countActive(user.id, now)) >= MAX_ACTIVE_TOKENS_PER_USER) {
      throw new ConflictError(
        `You already have ${MAX_ACTIVE_TOKENS_PER_USER} active tokens; revoke one first`,
      );
    }
    let expiresAt: Date | undefined;
    if (input.expiresInDays !== undefined && input.expiresInDays !== null) {
      const days = Math.floor(input.expiresInDays);
      if (!Number.isFinite(days) || days < 1 || days > MAX_TOKEN_TTL_DAYS) {
        throw new InvalidProjectError(`expiresInDays must be between 1 and ${MAX_TOKEN_TTL_DAYS}`);
      }
      expiresAt = new Date(now.getTime() + days * 86_400_000);
    }
    const { secret, prefix, hash } = generateTokenSecret();
    const token: ApiToken = {
      id: `tok_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      userId: user.id,
      userEmail: user.email,
      name,
      prefix,
      hash,
      origin: input.origin,
      createdAt: now,
      expiresAt,
    };
    await this.deps.tokens.insert(token);
    this.deps.logger.info(
      { userId: user.id, tokenId: token.id, origin: token.origin },
      "api token created",
    );
    return { secret, token };
  }
}

export class ListApiTokens {
  constructor(private readonly deps: CoreDeps) {}
  async execute(principal: Principal): Promise<ApiTokenView[]> {
    const user = requireUser(principal);
    const now = this.deps.clock.now();
    const tokens = await this.deps.tokens.listByUser(user.id);
    return tokens.map((t) => toTokenView(t, now));
  }
}

export class RevokeApiToken {
  constructor(private readonly deps: CoreDeps) {}
  async execute(principal: Principal, tokenId: string): Promise<ApiTokenView> {
    const user = requireUser(principal);
    const token = await this.deps.tokens.get(tokenId);
    if (!token || token.userId !== user.id) throw new NotFoundError(`Token "${tokenId}" not found`);
    const now = this.deps.clock.now();
    if (!token.revokedAt) {
      await this.deps.tokens.revoke(token.id, now);
      token.revokedAt = now;
      this.deps.logger.info({ userId: user.id, tokenId }, "api token revoked");
    }
    return toTokenView(token, now);
  }
}

// ---------------------------------------------------------------------------
// Device flow
// ---------------------------------------------------------------------------

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

export class StartDeviceAuthorization {
  constructor(private readonly deps: CoreDeps) {}

  async execute(input: {
    clientName?: string;
    hostname?: string;
    platform?: string;
  }): Promise<DeviceStart> {
    const now = this.deps.clock.now();
    const deviceCode = generateDeviceCode();
    let userCode = generateUserCode();
    for (let i = 0; i < 5 && (await this.deps.devices.findByUserCode(userCode)); i++) {
      userCode = generateUserCode();
    }
    const record: DeviceAuthorization = {
      id: randomUUID(),
      deviceCodeHash: deviceLookupHash(deviceCode),
      userCode,
      status: "pending",
      clientName: clean(input.clientName, 60) ?? "latex-api CLI",
      hostname: clean(input.hostname, 120),
      platform: clean(input.platform, 60),
      createdAt: now,
      expiresAt: new Date(now.getTime() + DEVICE_CODE_TTL_MS),
    };
    await this.deps.devices.insert(record);
    void this.deps.devices
      .deleteExpired(new Date(now.getTime() - 3_600_000))
      .catch(() => undefined);
    return {
      deviceCode,
      userCode,
      expiresIn: Math.round(DEVICE_CODE_TTL_MS / 1000),
      interval: DEVICE_POLL_INTERVAL_S,
    };
  }
}

export interface DeviceView {
  userCode: string;
  status: DeviceAuthorization["status"] | "expired";
  clientName: string;
  hostname?: string;
  platform?: string;
  createdAt: string;
  expiresAt: string;
}

function deviceView(record: DeviceAuthorization, now: Date): DeviceView {
  return {
    userCode: record.userCode,
    status: record.status === "pending" && record.expiresAt <= now ? "expired" : record.status,
    clientName: record.clientName,
    hostname: record.hostname,
    platform: record.platform,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  };
}

async function findPending(deps: CoreDeps, userCode: string): Promise<DeviceAuthorization> {
  const record = await deps.devices.findByUserCode(normalizeUserCode(userCode));
  if (!record)
    throw new NotFoundError("Unknown or expired code. Run `latex-api auth login` again.");
  return record;
}

export class GetDeviceAuthorization {
  constructor(private readonly deps: CoreDeps) {}
  async execute(principal: Principal, userCode: string): Promise<DeviceView> {
    requireSession(principal);
    return deviceView(await findPending(this.deps, userCode), this.deps.clock.now());
  }
}

/** Device approval must come from an interactive browser session, never from a token. */
function requireSession(principal: Principal) {
  const user = requireUser(principal);
  if (principal.via !== "session") {
    throw new ForbiddenError("Approve CLI sign-ins from the browser while signed in");
  }
  return user;
}

export class ApproveDeviceAuthorization {
  constructor(private readonly deps: CoreDeps) {}

  /** Records the browser approval; the CLI mints the token on its next poll. */
  async execute(
    principal: Principal,
    userCode: string,
    input: { tokenName?: string; expiresInDays?: number | null },
  ): Promise<DeviceView> {
    const user = requireSession(principal);
    const now = this.deps.clock.now();
    const record = await findPending(this.deps, userCode);
    if (record.status !== "pending")
      throw new ConflictError(`This code is already ${record.status}`);
    if (record.expiresAt <= now)
      throw new DeviceFlowError("expired_token", "This code has expired");
    if (input.expiresInDays !== undefined && input.expiresInDays !== null) {
      const days = Math.floor(input.expiresInDays);
      if (!Number.isFinite(days) || days < 1 || days > MAX_TOKEN_TTL_DAYS) {
        throw new InvalidProjectError(`expiresInDays must be between 1 and ${MAX_TOKEN_TTL_DAYS}`);
      }
    }
    record.status = "approved";
    record.userId = user.id;
    record.userEmail = user.email;
    record.grant = {
      name: (input.tokenName?.trim() || defaultTokenName(record)).slice(0, 80),
      expiresInDays: input.expiresInDays ?? null,
    };
    await this.deps.devices.update(record);
    this.deps.logger.info({ userId: user.id, device: record.id }, "device authorization approved");
    return deviceView(record, now);
  }
}

export class DenyDeviceAuthorization {
  constructor(private readonly deps: CoreDeps) {}
  async execute(principal: Principal, userCode: string): Promise<DeviceView> {
    requireSession(principal);
    const record = await findPending(this.deps, userCode);
    if (record.status === "pending") {
      record.status = "denied";
      await this.deps.devices.update(record);
    }
    return deviceView(record, this.deps.clock.now());
  }
}

export interface DeviceTokenResult {
  token: string;
  tokenId: string;
  name: string;
  expiresAt?: string;
  user: { id: string; email?: string };
}

/**
 * Called by the CLI with its secret device code. Pending → 428 authorization_pending;
 * approved → the token is minted now and the record is marked consumed (single use).
 */
export class PollDeviceAuthorization {
  constructor(private readonly deps: CoreDeps) {}

  async execute(deviceCode: string): Promise<DeviceTokenResult> {
    const now = this.deps.clock.now();
    const record = await this.deps.devices.findByDeviceCodeHash(deviceLookupHash(deviceCode));
    if (!record) throw new DeviceFlowError("expired_token", "Unknown device code; start again");
    if (record.status === "denied")
      throw new DeviceFlowError("access_denied", "The sign-in was denied in the browser");
    if (record.status === "consumed")
      throw new DeviceFlowError("expired_token", "This device code was already used");
    if (record.expiresAt <= now)
      throw new DeviceFlowError("expired_token", "The code expired; run login again");
    if (record.status === "pending") {
      const tooFast =
        record.lastPolledAt &&
        now.getTime() - record.lastPolledAt.getTime() < (DEVICE_POLL_INTERVAL_S - 1) * 1000;
      record.lastPolledAt = now;
      await this.deps.devices.update(record);
      if (tooFast) {
        throw new DeviceFlowError("slow_down", "Polling too fast", {
          interval: DEVICE_POLL_INTERVAL_S + 2,
        });
      }
      throw new DeviceFlowError("authorization_pending", "Waiting for approval in the browser", {
        interval: DEVICE_POLL_INTERVAL_S,
      });
    }

    // approved
    const grant = record.grant ?? { name: defaultTokenName(record), expiresInDays: null };
    record.status = "consumed";
    await this.deps.devices.update(record);
    const { secret, token } = await new CreateApiToken(this.deps).execute({
      principal: { name: record.userId!, kind: "user", via: "session", email: record.userEmail },
      name: grant.name,
      expiresInDays: grant.expiresInDays,
      origin: "cli",
    });
    record.tokenId = token.id;
    await this.deps.devices.update(record);
    return {
      token: secret,
      tokenId: token.id,
      name: token.name,
      expiresAt: token.expiresAt?.toISOString(),
      user: { id: token.userId, email: token.userEmail },
    };
  }
}

function defaultTokenName(record: DeviceAuthorization): string {
  return record.hostname ? `CLI on ${record.hostname}` : record.clientName;
}

function clean(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters
  const v = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return v ? v.slice(0, max) : undefined;
}

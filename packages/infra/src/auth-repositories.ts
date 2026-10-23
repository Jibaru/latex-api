import type {
  ApiToken,
  ApiTokenRepository,
  DeviceAuthorization,
  DeviceAuthRepository,
} from "@latex-api/core";
import type pg from "pg";

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

interface TokenRow {
  id: string;
  user_id: string;
  user_email: string | null;
  name: string;
  prefix: string;
  hash: string;
  origin: string;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const TOKEN_COLS =
  "id, user_id, user_email, name, prefix, hash, origin, created_at, expires_at, last_used_at, revoked_at";

function toToken(r: TokenRow): ApiToken {
  return {
    id: r.id,
    userId: r.user_id,
    userEmail: r.user_email ?? undefined,
    name: r.name,
    prefix: r.prefix,
    hash: r.hash,
    origin: r.origin as ApiToken["origin"],
    createdAt: r.created_at,
    expiresAt: r.expires_at ?? undefined,
    lastUsedAt: r.last_used_at ?? undefined,
    revokedAt: r.revoked_at ?? undefined,
  };
}

export class PgApiTokenRepository implements ApiTokenRepository {
  constructor(private readonly pool: pg.Pool) {}

  async insert(t: ApiToken): Promise<void> {
    await this.pool.query(
      `INSERT INTO api_tokens (${TOKEN_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        t.id,
        t.userId,
        t.userEmail ?? null,
        t.name,
        t.prefix,
        t.hash,
        t.origin,
        t.createdAt,
        t.expiresAt ?? null,
        t.lastUsedAt ?? null,
        t.revokedAt ?? null,
      ],
    );
  }
  async findByHash(hash: string) {
    const { rows } = await this.pool.query<TokenRow>(
      `SELECT ${TOKEN_COLS} FROM api_tokens WHERE hash=$1`,
      [hash],
    );
    return rows[0] ? toToken(rows[0]) : null;
  }
  async get(id: string) {
    const { rows } = await this.pool.query<TokenRow>(
      `SELECT ${TOKEN_COLS} FROM api_tokens WHERE id=$1`,
      [id],
    );
    return rows[0] ? toToken(rows[0]) : null;
  }
  async listByUser(userId: string) {
    const { rows } = await this.pool.query<TokenRow>(
      `SELECT ${TOKEN_COLS} FROM api_tokens WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`,
      [userId],
    );
    return rows.map(toToken);
  }
  async countActive(userId: string, now: Date) {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM api_tokens
       WHERE user_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`,
      [userId, now],
    );
    return Number(rows[0]?.n ?? 0);
  }
  async revoke(id: string, at: Date) {
    await this.pool.query(
      "UPDATE api_tokens SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL",
      [id, at],
    );
  }
  async touch(id: string, at: Date) {
    await this.pool.query("UPDATE api_tokens SET last_used_at=$2 WHERE id=$1", [id, at]);
  }
}

interface DeviceRow {
  id: string;
  device_code_hash: string;
  user_code: string;
  status: string;
  client_name: string;
  hostname: string | null;
  platform: string | null;
  created_at: Date;
  expires_at: Date;
  last_polled_at: Date | null;
  user_id: string | null;
  user_email: string | null;
  token_id: string | null;
  grant_info: DeviceAuthorization["grant"] | null;
}

const DEVICE_COLS =
  "id, device_code_hash, user_code, status, client_name, hostname, platform, created_at, expires_at, last_polled_at, user_id, user_email, token_id, grant_info";

function toDevice(r: DeviceRow): DeviceAuthorization {
  return {
    id: r.id,
    deviceCodeHash: r.device_code_hash,
    userCode: r.user_code,
    status: r.status as DeviceAuthorization["status"],
    clientName: r.client_name,
    hostname: r.hostname ?? undefined,
    platform: r.platform ?? undefined,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastPolledAt: r.last_polled_at ?? undefined,
    userId: r.user_id ?? undefined,
    userEmail: r.user_email ?? undefined,
    tokenId: r.token_id ?? undefined,
    grant: r.grant_info ?? undefined,
  };
}

export class PgDeviceAuthRepository implements DeviceAuthRepository {
  constructor(private readonly pool: pg.Pool) {}

  async insert(d: DeviceAuthorization) {
    await this.pool.query(
      `INSERT INTO device_authorizations (${DEVICE_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        d.id,
        d.deviceCodeHash,
        d.userCode,
        d.status,
        d.clientName,
        d.hostname ?? null,
        d.platform ?? null,
        d.createdAt,
        d.expiresAt,
        d.lastPolledAt ?? null,
        d.userId ?? null,
        d.userEmail ?? null,
        d.tokenId ?? null,
        d.grant ? JSON.stringify(d.grant) : null,
      ],
    );
  }
  async update(d: DeviceAuthorization) {
    await this.pool.query(
      `UPDATE device_authorizations SET status=$2, last_polled_at=$3, user_id=$4, user_email=$5, token_id=$6, grant_info=$7 WHERE id=$1`,
      [
        d.id,
        d.status,
        d.lastPolledAt ?? null,
        d.userId ?? null,
        d.userEmail ?? null,
        d.tokenId ?? null,
        d.grant ? JSON.stringify(d.grant) : null,
      ],
    );
  }
  async findByDeviceCodeHash(hash: string) {
    const { rows } = await this.pool.query<DeviceRow>(
      `SELECT ${DEVICE_COLS} FROM device_authorizations WHERE device_code_hash=$1`,
      [hash],
    );
    return rows[0] ? toDevice(rows[0]) : null;
  }
  async findByUserCode(code: string) {
    const { rows } = await this.pool.query<DeviceRow>(
      `SELECT ${DEVICE_COLS} FROM device_authorizations WHERE user_code=$1 ORDER BY created_at DESC LIMIT 1`,
      [code],
    );
    return rows[0] ? toDevice(rows[0]) : null;
  }
  async deleteExpired(before: Date) {
    const res = await this.pool.query("DELETE FROM device_authorizations WHERE expires_at < $1", [
      before,
    ]);
    return res.rowCount ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Memory (development without DATABASE_URL, tests)
// ---------------------------------------------------------------------------

export class MemoryApiTokenRepository implements ApiTokenRepository {
  private readonly rows = new Map<string, ApiToken>();
  async insert(t: ApiToken) {
    this.rows.set(t.id, { ...t });
  }
  async findByHash(hash: string) {
    for (const t of this.rows.values()) if (t.hash === hash) return { ...t };
    return null;
  }
  async get(id: string) {
    const t = this.rows.get(id);
    return t ? { ...t } : null;
  }
  async listByUser(userId: string) {
    return Array.from(this.rows.values())
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((t) => ({ ...t }));
  }
  async countActive(userId: string, now: Date) {
    let n = 0;
    for (const t of this.rows.values()) {
      if (t.userId === userId && !t.revokedAt && (!t.expiresAt || t.expiresAt > now)) n++;
    }
    return n;
  }
  async revoke(id: string, at: Date) {
    const t = this.rows.get(id);
    if (t && !t.revokedAt) t.revokedAt = at;
  }
  async touch(id: string, at: Date) {
    const t = this.rows.get(id);
    if (t) t.lastUsedAt = at;
  }
}

export class MemoryDeviceAuthRepository implements DeviceAuthRepository {
  private readonly rows = new Map<string, DeviceAuthorization>();
  async insert(d: DeviceAuthorization) {
    this.rows.set(d.id, structuredClone(d));
  }
  async update(d: DeviceAuthorization) {
    this.rows.set(d.id, structuredClone(d));
  }
  async findByDeviceCodeHash(hash: string) {
    for (const d of this.rows.values()) if (d.deviceCodeHash === hash) return structuredClone(d);
    return null;
  }
  async findByUserCode(code: string) {
    let best: DeviceAuthorization | null = null;
    for (const d of this.rows.values()) {
      if (d.userCode === code && (!best || d.createdAt > best.createdAt)) best = d;
    }
    return best ? structuredClone(best) : null;
  }
  async deleteExpired(before: Date) {
    let n = 0;
    for (const [id, d] of this.rows) {
      if (d.expiresAt < before) {
        this.rows.delete(id);
        n++;
      }
    }
    return n;
  }
}

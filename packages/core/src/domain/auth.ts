import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A person who signed in through the identity provider (Clerk in production). */
export interface UserIdentity {
  id: string;
  email?: string;
}

export type TokenOrigin = "dashboard" | "cli" | "api";

/** Long-lived personal API token. Only the SHA-256 of the secret is stored. */
export interface ApiToken {
  id: string;
  userId: string;
  userEmail?: string;
  name: string;
  /** First characters of the secret, safe to display (`lta_ab12cd34`). */
  prefix: string;
  hash: string;
  origin: TokenOrigin;
  createdAt: Date;
  expiresAt?: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
}

export type ApiTokenStatus = "active" | "expired" | "revoked";

export function tokenStatus(token: ApiToken, now: Date): ApiTokenStatus {
  if (token.revokedAt) return "revoked";
  if (token.expiresAt && token.expiresAt <= now) return "expired";
  return "active";
}

export const TOKEN_PREFIX = "lta_";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += BASE62[b % 62];
  return out;
}

/** `lta_<8 id chars>_<32 secret chars>`; the id part doubles as the display prefix. */
export function generateTokenSecret(): { secret: string; prefix: string; hash: string } {
  const id = base62(randomBytes(8));
  const secret = `${TOKEN_PREFIX}${id}_${base62(randomBytes(32))}`;
  return { secret, prefix: `${TOKEN_PREFIX}${id}`, hash: hashSecret(secret) };
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function looksLikeApiToken(value: string): boolean {
  return /^lta_[0-9A-Za-z]{8}_[0-9A-Za-z]{32}$/.test(value);
}

export function looksLikeJwt(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// ---------------------------------------------------------------------------
// Device authorization (RFC 8628 style) used by `latex-api auth login`.
// ---------------------------------------------------------------------------

export type DeviceAuthStatus = "pending" | "approved" | "denied" | "consumed";

export interface DeviceAuthorization {
  id: string;
  /** sha256("lookup:" + deviceCode); the device code itself is never stored. */
  deviceCodeHash: string;
  /** Human code shown in the terminal and typed or confirmed in the browser. */
  userCode: string;
  status: DeviceAuthStatus;
  clientName: string;
  hostname?: string;
  platform?: string;
  createdAt: Date;
  expiresAt: Date;
  lastPolledAt?: Date;
  /** Set on approval. */
  userId?: string;
  userEmail?: string;
  /** Token minted for this device once the CLI claimed it. */
  tokenId?: string;
  /**
   * What the browser approved. The token itself is minted only when the CLI presents the
   * device code, so its secret is never stored anywhere server-side.
   */
  grant?: { name: string; expiresInDays: number | null };
}

export const DEVICE_CODE_TTL_MS = 10 * 60_000;
export const DEVICE_POLL_INTERVAL_S = 3;

// No 0/O/1/I/L to avoid transcription mistakes.
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateUserCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) code += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizeUserCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : input.toUpperCase();
}

export function generateDeviceCode(): string {
  return randomBytes(32).toString("base64url");
}

export function deviceLookupHash(deviceCode: string): string {
  return createHash("sha256").update(`lookup:${deviceCode}`).digest("hex");
}

export const MAX_ACTIVE_TOKENS_PER_USER = 25;
export const MAX_TOKEN_TTL_DAYS = 3650;

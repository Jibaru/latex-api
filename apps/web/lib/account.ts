import "server-only";
import { auth } from "@clerk/nextjs/server";
import { serverApiBase } from "./shared";

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  origin: "dashboard" | "cli" | "api";
  status: "active" | "expired" | "revoked";
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface JobSummary {
  id: string;
  status: string;
  mode: string;
  engine: string;
  entrypoint: string;
  templateId?: string;
  createdAt: string;
  result?: {
    durationMs: number;
    pages?: number;
    errors: number;
    warnings: number;
    cached: boolean;
  };
  error?: { reason: string; message: string };
}

export interface DeviceRequest {
  userCode: string;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  clientName: string;
  hostname?: string;
  platform?: string;
  createdAt: string;
  expiresAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the API as the signed-in user, forwarding the Clerk session token. */
export async function apiAsUser<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) throw new ApiError(401, "unauthorized", "Your session expired; sign in again.");
  const res = await fetch(`${serverApiBase()}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    let code = "internal";
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { code?: string; detail?: string; title?: string };
      code = body.code ?? code;
      message = body.detail ?? body.title ?? message;
    } catch {
      // keep defaults
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

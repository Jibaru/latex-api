import type { Principal } from "@latex-api/core";
import { UnauthorizedError } from "@latex-api/core";
import type { Context, MiddlewareHandler } from "hono";
import type { Container } from "../container";

export type Env = {
  Variables: {
    principal: Principal;
    container: Container;
    requestId: string;
  };
};

/** Paths under /v1 that never require a key. */
export function isPublicPath(method: string, path: string): boolean {
  if (method === "OPTIONS") return true;
  if (path === "/v1/limits" || path === "/v1/demo/compile") return true;
  if (method === "GET" && path.startsWith("/v1/templates")) return true;
  return false;
}

export function bearerAuth(): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (isPublicPath(c.req.method, c.req.path)) {
      c.set("principal", { name: "anonymous", kind: "anonymous" });
      return next();
    }
    const principal = await resolvePrincipal(c);
    if (!principal) throw new UnauthorizedError();
    c.set("principal", principal);
    await next();
  };
}

export async function resolvePrincipal(c: Context<Env>): Promise<Principal | null> {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim() || c.req.header("x-api-key")?.trim();
  if (!token) return null;
  return c.get("container").apiKeys.resolve(token);
}

/** Best-effort client IP behind Traefik/Nginx. */
export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return c.req.header("x-real-ip") ?? c.req.header("cf-connecting-ip") ?? "unknown";
}

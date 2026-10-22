import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { createProject, RateLimitedError } from "@latex-api/core";
import type { Env } from "../auth";
import { clientIp } from "../auth";
import { decodeJsonFiles } from "../body";
import {
  DemoCompileRequestSchema,
  HealthSchema,
  LimitsSchema,
  ProblemSchema,
  StatsSchema,
} from "../schemas";
import { respondSync } from "./compile";

export const API_VERSION = process.env.API_VERSION ?? process.env.npm_package_version ?? "0.1.0";

const limitsRoute = createRoute({
  method: "get",
  path: "/v1/limits",
  tags: ["Meta"],
  summary: "Effective server limits",
  responses: {
    200: { description: "Limits", content: { "application/json": { schema: LimitsSchema } } },
  },
});

const statsRoute = createRoute({
  method: "get",
  path: "/v1/stats",
  tags: ["Meta"],
  summary: "Usage statistics",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "Stats", content: { "application/json": { schema: StatsSchema } } },
    401: {
      description: "Unauthorized",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["Meta"],
  summary: "Health check",
  responses: {
    200: { description: "Healthy", content: { "application/json": { schema: HealthSchema } } },
    503: { description: "Degraded", content: { "application/json": { schema: HealthSchema } } },
  },
});

const demoRoute = createRoute({
  method: "post",
  path: "/v1/demo/compile",
  tags: ["Compile"],
  summary: "Compile without an API key (playground)",
  description:
    "Heavily rate limited per IP and restricted to small JSON projects. Returns the same responses as `/v1/compile`.",
  request: {
    body: { content: { "application/json": { schema: DemoCompileRequestSchema } }, required: true },
  },
  responses: {
    200: {
      description: "PDF or job envelope",
      content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
    },
    422: {
      description: "LaTeX reported errors",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    429: {
      description: "Rate limited",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export function registerMetaRoutes(app: OpenAPIHono<Env>) {
  app.openapi(limitsRoute, (c) => {
    const limits = c.get("container").useCases.getLimits.execute();
    return c.json({ ...limits, engines: [...limits.engines] }, 200);
  });

  app.openapi(statsRoute, async (c) =>
    c.json(await c.get("container").useCases.getStats.execute(), 200),
  );

  app.openapi(healthRoute, async (c) => {
    const health = await c.get("container").useCases.getHealth.execute();
    return c.json({ ...health, version: API_VERSION }, health.status === "ok" ? 200 : 503);
  });

  app.openapi(demoRoute, async (c) => {
    const container = c.get("container");
    const { limits } = container.config;
    const ip = clientIp(c);
    const minute = await container.rateLimiter.consume(
      `demo:${ip}:minute`,
      limits.demoRateLimitPerMinute,
      60_000,
    );
    if (!minute.allowed)
      throw new RateLimitedError(
        Math.ceil(minute.retryAfterMs / 1000),
        "Demo limit: try again in a minute",
      );
    const day = await container.rateLimiter.consume(
      `demo:${ip}:day`,
      limits.demoRateLimitPerDay,
      86_400_000,
    );
    if (!day.allowed)
      throw new RateLimitedError(
        Math.ceil(day.retryAfterMs / 1000),
        "Demo limit for today reached; use an API key",
      );

    const body = c.req.valid("json");
    const files = body.files ? decodeJsonFiles(body.files) : [];
    if (body.source)
      files.push({
        path: body.entrypoint ?? "main.tex",
        content: new TextEncoder().encode(body.source),
      });
    const project = createProject(
      { files, entrypoint: body.entrypoint, engine: body.engine },
      { ...limits, maxFiles: 20, maxUnpackedBytes: 2 * 1024 * 1024, maxFileBytes: 1024 * 1024 },
    );
    const job = await container.useCases.compileProject.execute(
      {
        project,
        principal: { name: "demo", kind: "demo" },
        options: { timeoutMs: limits.demoTimeoutMs },
      },
      "demo",
    );
    return respondSync(c, job);
  });
}

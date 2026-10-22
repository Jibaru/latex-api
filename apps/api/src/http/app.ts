import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { getContainer } from "../container";
import { bearerAuth, type Env } from "./auth";
import { onError, problem } from "./errors";
import { registerCompileRoutes } from "./routes/compile";
import { registerJobRoutes } from "./routes/jobs";
import { API_VERSION, registerMetaRoutes } from "./routes/meta";
import { registerTemplateRoutes } from "./routes/templates";

let app: OpenAPIHono<Env> | undefined;

export function getHttpApp(): OpenAPIHono<Env> {
  if (!app) app = createHttpApp();
  return app;
}

export function createHttpApp(containerFactory = getContainer): OpenAPIHono<Env> {
  const hono = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return problem(c, 400, "invalid_request", "Request validation failed", {
          issues: result.error.issues,
        });
      }
      return undefined;
    },
  });

  hono.use("*", async (c, next) => {
    const container = containerFactory();
    c.set("container", container);
    c.set("requestId", c.req.header("x-request-id") ?? randomUUID());
    const started = Date.now();
    await next();
    c.header("x-request-id", c.get("requestId"));
    c.header("x-api-version", API_VERSION);
    if (c.req.path !== "/health") {
      container.deps.logger.info(
        {
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          ms: Date.now() - started,
          principal: c.get("principal")?.name,
          requestId: c.get("requestId"),
        },
        "request",
      );
    }
  });

  hono.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "Accept", "X-API-Key", "X-Request-Id"],
      exposeHeaders: [
        "X-Job-Id",
        "X-Compile-Cached",
        "X-Compile-Warnings",
        "X-Request-Id",
        "Location",
        "Retry-After",
      ],
      maxAge: 86400,
    }),
  );

  hono.use("/v1/*", async (c, next) => {
    const max = c.get("container").config.limits.maxUploadBytes;
    return bodyLimit({
      maxSize: max,
      onError: () => {
        throw new HTTPException(413, { message: `Request body exceeds ${max} bytes` });
      },
    })(c, next);
  });

  hono.use("/v1/*", bearerAuth());

  registerMetaRoutes(hono);
  registerCompileRoutes(hono);
  registerJobRoutes(hono);
  registerTemplateRoutes(hono);

  hono.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "API key issued by the operator. Also accepted in the `X-API-Key` header.",
  });

  hono.doc31("/openapi.json", (c) => ({
    openapi: "3.1.0",
    info: {
      title: "LaTeX API",
      version: API_VERSION,
      description:
        "Compile LaTeX projects to PDF over HTTP: papers, CVs, brochures, posters and reports. " +
        "Every compile runs in an isolated container with pdflatex, xelatex or lualatex from TeX Live 2026.",
      license: { name: "MIT", url: "https://github.com/jibaru/latex-api/blob/main/LICENSE" },
      contact: { name: "latex-api", url: "https://github.com/jibaru/latex-api" },
    },
    servers: [{ url: c.get("container").config.publicUrl, description: "This server" }],
    tags: [
      { name: "Compile", description: "Synchronous compilation" },
      { name: "Jobs", description: "Asynchronous jobs, artifacts and live events" },
      { name: "Templates", description: "Ready-to-use starter projects" },
      { name: "Meta", description: "Limits, health and statistics" },
    ],
  }));

  hono.notFound((c) => problem(c, 404, "not_found", `No route for ${c.req.method} ${c.req.path}`));
  hono.onError(onError);
  return hono;
}

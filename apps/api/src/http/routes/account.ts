import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { RateLimitedError, toTokenView } from "@latex-api/core";
import { clientIp, type Env } from "../auth";
import { toJobDto } from "../dto";
import { JobSchema, ProblemSchema } from "../schemas";

const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

const UserSchema = z.object({ id: z.string(), email: z.string().optional() }).openapi("User");

const MeSchema = z
  .object({
    user: UserSchema.nullable(),
    principal: z.object({
      name: z.string(),
      kind: z.enum(["user", "key", "demo", "anonymous"]),
      via: z.enum(["token", "session", "env"]).optional(),
      tokenId: z.string().optional(),
    }),
  })
  .openapi("Me");

const ApiTokenSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string().openapi({ example: "lta_Ab12Cd34" }),
    origin: z.enum(["dashboard", "cli", "api"]),
    status: z.enum(["active", "expired", "revoked"]),
    createdAt: z.string(),
    expiresAt: z.string().optional(),
    lastUsedAt: z.string().optional(),
    revokedAt: z.string().optional(),
  })
  .openapi("ApiToken");

const CreateTokenSchema = z
  .object({
    name: z.string().min(1).max(80).openapi({ example: "GitHub Actions" }),
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .nullable()
      .optional()
      .openapi({ description: "Omit or null for a token that never expires." }),
  })
  .openapi("CreateApiTokenRequest");

const CreatedTokenSchema = z
  .object({
    token: z.string().openapi({ description: "The secret. Shown once; store it now." }),
    apiToken: ApiTokenSchema,
  })
  .openapi("CreatedApiToken");

const DeviceStartSchema = z
  .object({
    deviceCode: z.string(),
    userCode: z.string().openapi({ example: "WDJB-MJHT" }),
    verificationUri: z.string(),
    verificationUriComplete: z.string(),
    expiresIn: z.number(),
    interval: z.number(),
  })
  .openapi("DeviceAuthorizationStart");

const DeviceViewSchema = z
  .object({
    userCode: z.string(),
    status: z.enum(["pending", "approved", "denied", "consumed", "expired"]),
    clientName: z.string(),
    hostname: z.string().optional(),
    platform: z.string().optional(),
    createdAt: z.string(),
    expiresAt: z.string(),
  })
  .openapi("DeviceAuthorization");

const DeviceTokenSchema = z
  .object({
    token: z.string(),
    tokenId: z.string(),
    name: z.string(),
    expiresAt: z.string().optional(),
    user: UserSchema,
  })
  .openapi("DeviceToken");

const UserCodeParam = z.object({
  code: z
    .string()
    .min(8)
    .max(12)
    .openapi({ param: { name: "code", in: "path" }, example: "WDJB-MJHT" }),
});

const TokenIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

const meRoute = createRoute({
  method: "get",
  path: "/v1/me",
  tags: ["Account"],
  summary: "Who am I",
  description: "Returns the identity behind the credential. Useful to validate a token.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "Identity", content: { "application/json": { schema: MeSchema } } },
    401: problem("Missing or invalid credential"),
  },
});

const listTokensRoute = createRoute({
  method: "get",
  path: "/v1/tokens",
  tags: ["Account"],
  summary: "List your personal API tokens",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Tokens, newest first. Secrets are never returned.",
      content: { "application/json": { schema: z.object({ tokens: z.array(ApiTokenSchema) }) } },
    },
    403: problem("Operator keys have no personal tokens"),
  },
});

const createTokenRoute = createRoute({
  method: "post",
  path: "/v1/tokens",
  tags: ["Account"],
  summary: "Create a personal API token",
  description: "The secret is returned once. Tokens last until revoked or until `expiresInDays`.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: CreateTokenSchema } }, required: true },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: CreatedTokenSchema } },
    },
    403: problem("Operator keys cannot create personal tokens"),
    409: problem("Too many active tokens"),
  },
});

const revokeTokenRoute = createRoute({
  method: "delete",
  path: "/v1/tokens/{id}",
  tags: ["Account"],
  summary: "Revoke a personal API token",
  security: [{ bearerAuth: [] }],
  request: { params: TokenIdParam },
  responses: {
    200: {
      description: "Revoked",
      content: { "application/json": { schema: z.object({ apiToken: ApiTokenSchema }) } },
    },
    404: problem("Unknown token"),
  },
});

const listJobsRoute = createRoute({
  method: "get",
  path: "/v1/jobs",
  tags: ["Jobs"],
  summary: "List your recent jobs",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional().openapi({ example: 20 }),
    }),
  },
  responses: {
    200: {
      description: "Jobs, newest first",
      content: { "application/json": { schema: z.object({ jobs: z.array(JobSchema) }) } },
    },
  },
});

const deviceStartRoute = createRoute({
  method: "post",
  path: "/v1/auth/device",
  tags: ["Account"],
  summary: "Start a CLI sign-in (device flow)",
  description:
    "Returns a `userCode` to show in the terminal and a `deviceCode` to poll with. The user approves at `verificationUriComplete` while signed in.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            clientName: z.string().max(60).optional(),
            hostname: z.string().max(120).optional(),
            platform: z.string().max(60).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Started", content: { "application/json": { schema: DeviceStartSchema } } },
    429: problem("Too many sign-in attempts from this IP"),
  },
});

const deviceTokenRoute = createRoute({
  method: "post",
  path: "/v1/auth/device/token",
  tags: ["Account"],
  summary: "Exchange an approved device code for a token",
  description:
    "Poll every `interval` seconds. While pending the response is 428 with code `authorization_pending` (or `slow_down`). Denied → 400 `access_denied`; expired or reused → 400 `expired_token`.",
  request: {
    body: {
      content: {
        "application/json": { schema: z.object({ deviceCode: z.string().min(20).max(200) }) },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Approved",
      content: { "application/json": { schema: DeviceTokenSchema } },
    },
    400: problem("access_denied or expired_token"),
    428: problem("authorization_pending or slow_down"),
  },
});

const deviceGetRoute = createRoute({
  method: "get",
  path: "/v1/auth/device/{code}",
  tags: ["Account"],
  summary: "Inspect a pending CLI sign-in (browser session only)",
  security: [{ bearerAuth: [] }],
  request: { params: UserCodeParam },
  responses: {
    200: {
      description: "Device request",
      content: { "application/json": { schema: DeviceViewSchema } },
    },
    403: problem("Requires a browser session"),
    404: problem("Unknown code"),
  },
});

const deviceApproveRoute = createRoute({
  method: "post",
  path: "/v1/auth/device/{code}/approve",
  tags: ["Account"],
  summary: "Approve a CLI sign-in (browser session only)",
  security: [{ bearerAuth: [] }],
  request: {
    params: UserCodeParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            tokenName: z.string().max(80).optional(),
            expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Approved", content: { "application/json": { schema: DeviceViewSchema } } },
    403: problem("Requires a browser session"),
    409: problem("Already handled"),
  },
});

const deviceDenyRoute = createRoute({
  method: "post",
  path: "/v1/auth/device/{code}/deny",
  tags: ["Account"],
  summary: "Deny a CLI sign-in (browser session only)",
  security: [{ bearerAuth: [] }],
  request: { params: UserCodeParam },
  responses: {
    200: { description: "Denied", content: { "application/json": { schema: DeviceViewSchema } } },
    403: problem("Requires a browser session"),
  },
});

export function registerAccountRoutes(app: OpenAPIHono<Env>) {
  app.openapi(meRoute, (c) => {
    const p = c.get("principal");
    return c.json(
      {
        user: p.kind === "user" ? { id: p.name, email: p.email } : null,
        principal: { name: p.name, kind: p.kind, via: p.via, tokenId: p.tokenId },
      },
      200,
    );
  });

  app.openapi(listTokensRoute, async (c) => {
    const tokens = await c.get("container").useCases.listApiTokens.execute(c.get("principal"));
    return c.json({ tokens }, 200);
  });

  app.openapi(createTokenRoute, async (c) => {
    const container = c.get("container");
    const body = c.req.valid("json");
    const principal = c.get("principal");
    const { secret, token } = await container.useCases.createApiToken.execute({
      principal,
      name: body.name,
      expiresInDays: body.expiresInDays ?? null,
      origin: principal.via === "session" ? "dashboard" : "api",
    });
    return c.json({ token: secret, apiToken: toTokenView(token, new Date()) }, 201);
  });

  app.openapi(revokeTokenRoute, async (c) => {
    const apiToken = await c
      .get("container")
      .useCases.revokeApiToken.execute(c.get("principal"), c.req.valid("param").id);
    return c.json({ apiToken }, 200);
  });

  app.openapi(listJobsRoute, async (c) => {
    const container = c.get("container");
    const jobs = await container.useCases.listJobs.execute(
      c.get("principal"),
      c.req.valid("query").limit ?? 20,
    );
    return c.json({ jobs: jobs.map((j) => toJobDto(j, container.config.publicUrl)) }, 200);
  });

  app.openapi(deviceStartRoute, async (c) => {
    const container = c.get("container");
    const ip = clientIp(c);
    const limit = await container.rateLimiter.consume(`device:${ip}`, 20, 3_600_000);
    if (!limit.allowed)
      throw new RateLimitedError(Math.ceil(limit.retryAfterMs / 1000), "Too many sign-in attempts");
    let body: { clientName?: string; hostname?: string; platform?: string } = {};
    try {
      body = c.req.valid("json") ?? {};
    } catch {
      body = {};
    }
    const start = await container.useCases.startDevice.execute(body);
    const base = container.config.publicUrl;
    return c.json(
      {
        ...start,
        verificationUri: `${base}/cli/authorize`,
        verificationUriComplete: `${base}/cli/authorize?code=${encodeURIComponent(start.userCode)}`,
      },
      200,
    );
  });

  app.openapi(deviceTokenRoute, async (c) => {
    const result = await c
      .get("container")
      .useCases.pollDevice.execute(c.req.valid("json").deviceCode);
    return c.json(result, 200);
  });

  app.openapi(deviceGetRoute, async (c) => {
    const view = await c
      .get("container")
      .useCases.getDevice.execute(c.get("principal"), c.req.valid("param").code);
    return c.json(view, 200);
  });

  app.openapi(deviceApproveRoute, async (c) => {
    const body = c.req.valid("json") ?? {};
    const view = await c
      .get("container")
      .useCases.approveDevice.execute(c.get("principal"), c.req.valid("param").code, body);
    return c.json(view, 200);
  });

  app.openapi(deviceDenyRoute, async (c) => {
    const view = await c
      .get("container")
      .useCases.denyDevice.execute(c.get("principal"), c.req.valid("param").code);
    return c.json(view, 200);
  });
}

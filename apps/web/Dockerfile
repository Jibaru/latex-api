# syntax=docker/dockerfile:1.7
# latex-api web: landing page + documentation (Next.js, standalone output).
# The API is a separate image; both sit behind one domain (web at `/` and `/docs`, api at `/v1`).

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.13.2 --activate

# ---- prune the monorepo to what the web app needs (includes packages/openapi)
FROM base AS pruner
WORKDIR /repo
RUN pnpm add -g turbo@2
COPY . .
RUN turbo prune @latex-api/web --docker

# ---- install + build (generates the API reference pages from openapi.json first)
FROM base AS builder
WORKDIR /repo
COPY --from=pruner /repo/out/json/ .
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/out/full/ .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
ARG NEXT_PUBLIC_API_URL=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm --filter @latex-api/web build

# ---- runtime
FROM node:22-slim AS runner
ENV NODE_ENV=production PORT=3001 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:3001/ -o /dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]

# syntax=docker/dockerfile:1.7
# latex-api: Next.js API server. The TeX toolchain lives in a separate image
# (ghcr.io/jibaru/latex-compiler) that this server launches per job via the Docker socket.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.13.2 --activate

# ---- prune the monorepo to what the api needs
FROM base AS pruner
WORKDIR /repo
RUN pnpm add -g turbo@2
COPY . .
RUN turbo prune @latex-api/api --docker

# ---- install + build
FROM base AS builder
WORKDIR /repo
COPY --from=pruner /repo/out/json/ .
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
ARG API_VERSION=0.0.0-dev
ENV API_VERSION=$API_VERSION
RUN pnpm --filter @latex-api/api build

# ---- runtime
FROM node:22-slim AS runner
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1 \
    DATA_DIR=/data TEMPLATES_DIR=/app/templates
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini curl && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data
COPY --from=builder --chown=node:node /repo/apps/api/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/api/.next/static ./apps/api/.next/static
COPY --from=builder --chown=node:node /repo/apps/api/public ./apps/api/public
COPY --chown=node:node packages/templates/templates ./templates
COPY --chown=node:node docker/seccomp ./seccomp
ARG API_VERSION=0.0.0-dev
ENV API_VERSION=$API_VERSION
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:3000/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/server.js"]

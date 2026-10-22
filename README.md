# LaTeX API

Compile LaTeX in the cloud with one HTTP call. Papers (IEEE), CVs, brochures, posters and
reports, compiled by pdflatex, xelatex or lualatex from TeX Live 2026 inside a disposable,
sandboxed container per job.

- Public instance: <https://latex-api.crafter.run> · docs at `/docs` · interactive reference at `/reference`
- OpenAPI 3.1: [`packages/openapi/openapi.json`](packages/openapi/openapi.json)
- SDK: `@jibaru/latex-api-sdk` · CLI: `@jibaru/latex-api-cli`

```bash
curl -X POST https://latex-api.crafter.run/v1/compile \
  -H "Authorization: Bearer $LATEX_API_KEY" \
  -H "Content-Type: text/x-tex" \
  --data-binary @main.tex -o main.pdf
```

## What you get

| Capability | Details |
|---|---|
| Sync and async | `POST /v1/compile` returns the PDF (≤ 60 s); `POST /v1/jobs` queues longer builds with polling, Server-Sent Events and webhooks |
| Any project shape | JSON files, multipart uploads, a zip, or a raw `.tex` body; entrypoint and engine are detected (`% !TEX program = xelatex`) |
| Structured diagnostics | Errors and warnings with file and line, plus the full log; failures are RFC 9457 problem documents |
| Templates | Ready-to-compile starters: IEEE conference/journal, Awesome-CV, AltaCV, tri-fold brochure, poster, Spanish report |
| Cache | Identical projects are served from a content-addressed cache |
| Sandbox | One container per compile: no network, read-only root, dropped capabilities, seccomp, memory/CPU/pids limits, shell escape off |

## Repository layout

```
apps/api         Next.js 16 + Hono API (OpenAPI 3.1, Scalar at /reference)
apps/web         Landing page and documentation (Fumadocs)
packages/core    Domain model, ports and use cases (hexagonal core, no runtime deps)
packages/infra   Adapters: Docker sibling compiler, filesystem, Postgres, pg-boss, zip
packages/templates  Template bundles + manifest format
packages/openapi Exported OpenAPI document
packages/sdk     TypeScript SDK (published)
packages/cli     Command-line client (published)
docker/          Compiler image (TeX Live 2026), compose files, seccomp profile
```

## Development

Requirements: Node 22, pnpm 9, Docker.

```bash
pnpm install
docker build -t latex-compiler:dev docker/compiler      # ~10 min the first time
cp apps/api/.env.example apps/api/.env                  # API_KEYS, COMPILER_IMAGE=latex-compiler:dev
pnpm --filter @latex-api/api dev                        # http://localhost:3000
pnpm --filter @latex-api/web dev                        # http://localhost:3001
pnpm test                                               # unit tests
RUN_DOCKER_TESTS=1 pnpm --filter @latex-api/infra test  # real compiler
pnpm --filter @latex-api/templates test:integration     # compile every template
```

Without `DATABASE_URL` the API keeps jobs in memory and runs them inline, which is enough for
local work. With Postgres it uses pg-boss for durable queues.

## Self-hosting

See `docker/compose.local.yaml` for a complete stack (Postgres, compiler image, API, web) and
`docker/compose.dokploy.yaml` for the production layout that pulls images from GHCR. The API
needs the Docker socket to launch compile containers and a host directory shared with them.

## License

MIT © Ignacio Rueda. Template classes keep their own licenses (see each `manifest.json`).

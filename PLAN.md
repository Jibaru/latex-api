# LaTeX API — Plan de implementación

Fecha: 2026-10-22. Estado: pendiente de confirmación final.

## 1. Decisiones cerradas

| Tema           | Decisión                                                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Producto       | Open source (MIT) self-hostable + instancia pública en `https://latex-api.crafter.run` protegida por API key                                                                                                                     |
| Repo           | `jibaru/latex-api` (personal), monorepo pnpm 9 + Turborepo 2, Biome, Vitest, Changesets                                                                                                                                          |
| Scope npm      | `@jibaru/latex-api-sdk`, `@jibaru/latex-api-cli` (binario `latex-api`). `core`, `infra`, `templates`, `openapi`, `config` internos                                                                                               |
| Topología      | Compose en Dokploy (perfil `crafter`): `web` (landing + docs), `api` (Next.js 16), `postgres`. La API lanza **un contenedor efímero por compilación** desde la imagen `ghcr.io/jibaru/latex-compiler`                            |
| Dominio        | Un solo host. `/` landing, `/docs` docs, `/v1/*` + `/openapi.json` + `/health` → `api` (Traefik por path)                                                                                                                        |
| Motor TeX      | TeX Live 2026 custom (`install-tl` scheme-small + colecciones) en `debian:trixie-slim`. pdflatex, xelatex, lualatex vía latexmk, biber. Sin shell-escape. ~500 MB comprimido                                                     |
| Ejecución      | `POST /v1/compile` síncrono (60 s) y `POST /v1/jobs` asíncrono (5 min, máx 10) sobre pg-boss                                                                                                                                     |
| Salida         | PDF + log parseado (errores/warnings con archivo, línea, mensaje). PNG preview en fase 2                                                                                                                                         |
| Entrada        | JSON files[], multipart files[], multipart zip, cuerpo crudo `text/x-tex`. URL remota en fase 2                                                                                                                                  |
| Auth           | `Authorization: Bearer <key>`; `API_KEYS="name:key,..."`; rate limit por key en memoria. Públicos: health, openapi, templates                                                                                                    |
| Playground     | Landing compila en vivo vía key `demo` del lado servidor, rate limit por IP                                                                                                                                                      |
| Persistencia   | Postgres (Dokploy) con Drizzle; pg-boss para la cola                                                                                                                                                                             |
| Artefactos     | Volumen `/data/artifacts/<jobId>/` con TTL 24 h, limpieza por job programado                                                                                                                                                     |
| Caché          | SHA-256(proyecto normalizado + engine + versión de imagen) → artefacto existente                                                                                                                                                 |
| Sandbox        | Contenedor hermano: `--network none`, rootfs RO, tmpfs `/work`, uid 65534, cap-drop ALL, no-new-privileges, seccomp Overleaf CLSI, pids 64, mem 2 GB, cpus 2, ulimits, `timeout -s KILL`. gVisor opcional vía `COMPILER_RUNTIME` |
| Contrato HTTP  | Hono + `@hono/zod-openapi` (Zod 4) montado en Next.js; OpenAPI 3.1 en `/openapi.json`; errores RFC 9457                                                                                                                          |
| Plantillas     | 7: ieee-conference, ieee-journal, cv-awesome, cv-altacv, trifold-brochure, infographic-poster, report-es                                                                                                                         |
| Docs           | Fumadocs (guías MDX) + referencia OpenAPI con cliente Scalar embebido                                                                                                                                                            |
| Landing        | Estética editorial clara (serif, guiño LaTeX) con dark mode                                                                                                                                                                      |
| CI/CD          | GitHub Actions: lint/typecheck/unit por PR; imagen compiler solo si cambia su Dockerfile; imagen api en cada push a main; integración compilando las 7 plantillas; deploy con `vps compose redeploy --profile crafter`           |
| Observabilidad | pino JSON, `GET /health`, `GET /v1/stats` protegida. Sin OTel                                                                                                                                                                    |
| Idioma         | Código, API, docs y landing en inglés                                                                                                                                                                                            |

Pendiente (no bloquea): CPU/RAM/disco del VPS `crafter` para fijar `MAX_CONCURRENT_JOBS` (default 2).

## 2. Límites v1 (todos por env, expuestos en `GET /v1/limits`)

| Env                                     | Default              |
| --------------------------------------- | -------------------- |
| `MAX_UPLOAD_BYTES`                      | 50 MB                |
| `MAX_UNPACKED_BYTES`                    | 200 MB               |
| `MAX_FILES`                             | 500                  |
| `SYNC_TIMEOUT_MS`                       | 60 000               |
| `JOB_TIMEOUT_MS` / `JOB_TIMEOUT_MAX_MS` | 300 000 / 600 000    |
| `JOB_MEMORY` / `JOB_CPUS` / `JOB_PIDS`  | 2g / 2 / 64          |
| `MAX_CONCURRENT_JOBS`                   | 2                    |
| `ARTIFACT_TTL_HOURS`                    | 24                   |
| `RATE_LIMIT_PER_KEY`                    | 60/h, 5 concurrentes |
| `DEMO_RATE_LIMIT_PER_IP`                | 5/min, 30/día        |

## 3. Estructura del monorepo

```
latex-api/
├─ apps/
│  ├─ api/                     # Next.js 16, output standalone, Dockerfile (turbo prune)
│  │  ├─ app/v1/[[...route]]/route.ts   # export { GET, POST, DELETE } = handle(app)
│  │  ├─ app/openapi.json/route.ts
│  │  ├─ app/health/route.ts
│  │  ├─ src/http/            # Hono app, rutas zod-openapi, problem details, auth, rate limit
│  │  ├─ src/container.ts     # composition root (puertos → adaptadores)
│  │  └─ instrumentation.ts   # arranca pg-boss + workers + limpieza TTL
│  └─ web/                     # Next.js 16: landing, /docs (Fumadocs), /playground
├─ packages/
│  ├─ core/                    # JIT, cero deps. domain/ application/ ports/
│  ├─ infra/                   # adaptadores: DockerSiblingCompiler, PgJobRepository, FsArtifactStore,
│  │                           # PgBossQueue, MemoryRateLimiter, LatexLogParser, ZipExtractor
│  ├─ templates/               # 7 plantillas + manifest.json + previews
│  ├─ openapi/                 # openapi.json exportado + config hey-api
│  ├─ sdk/                     # generado con @hey-api/openapi-ts, tsdown ESM, publicado
│  ├─ cli/                     # citty + clack + consola + chokidar, publicado + bun compile
│  └─ config/                  # tsconfig base, biome.json
├─ docker/
│  ├─ compiler/Dockerfile      # TeX Live 2026 custom + warm/ + seccomp/clsi-profile.json
│  └─ compose.dokploy.yaml     # web + api + postgres, volúmenes, socket docker
├─ .github/workflows/          # ci.yml, compiler-image.yml, api-image.yml, release.yml (changesets)
├─ turbo.json  pnpm-workspace.yaml  biome.json  .changeset/
```

Gotchas ya decididos: `outputFileTracingRoot` a la raíz del repo; sin `proxy.ts` sobre `/v1`; zips se streamean a disco con busboy (no `formData()`); `transpilePackages` para `core`, `infra`, `templates`; ESM-only en `sdk` y `cli`.

## 4. Dominio y puertos (`packages/core`)

Entidades y value objects:
- `Project { files: ProjectFile[], entrypoint, engine }`, `ProjectFile { path, bytes }`, `Engine = pdflatex | xelatex | lualatex`
- `CompileJob { id, status: queued|running|succeeded|failed|timed_out|cancelled, project hash, engine, options, timings, createdBy (key name), expiresAt }`
- `CompileResult { pdf?: ArtifactRef, log: ArtifactRef, diagnostics: Diagnostic[], durationMs, cached }`
- `Diagnostic { severity: error|warning|info, file?, line?, message, context? }`
- `Template { id, name, description, engine, entrypoint, files, variables: [] , tags }`

Puertos (interfaces):
- `Compiler.compile(workspace, options, signal) → RawCompileOutput`
- `JobRepository`, `JobQueue.enqueue/work`, `ArtifactStore.put/get/delete/stream`, `ProjectCache.lookup/store`
- `RateLimiter.check(key)`, `ApiKeyResolver.resolve(token)`, `TemplateRepository`, `Clock`, `IdGenerator`, `Logger`

Casos de uso:
- `CompileProject` (valida límites → normaliza → hash → caché → compila → parsea log → guarda artefactos)
- `EnqueueCompileJob`, `GetJob`, `CancelJob`, `StreamJobEvents`
- `ListTemplates`, `GetTemplate`, `CompileTemplate` (aplica overrides de archivos)
- `PurgeExpiredArtifacts`, `GetLimits`, `GetStats`

Detección de motor: parámetro explícito > manifest de plantilla > `% !TEX program = ...` en el entrypoint > `pdflatex`.

## 5. API v1

| Método | Ruta                                                                                              | Auth    | Descripción                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/compile`                                                                                     | key     | Síncrono. Entradas: JSON, multipart files, multipart zip, `text/x-tex`. Devuelve PDF (o envelope JSON con `Accept: application/json`) |
| POST   | `/v1/jobs`                                                                                        | key     | Mismas entradas, devuelve `202 { jobId, statusUrl }`                                                                                  |
| GET    | `/v1/jobs/:id`                                                                                    | key     | Estado, diagnostics, urls de artefactos                                                                                               |
| GET    | `/v1/jobs/:id/events`                                                                             | key     | SSE: `queued`, `running`, `log` (chunks), `done`, `error`                                                                             |
| GET    | `/v1/jobs/:id/pdf` · `/log`                                                                       | key     | Descarga de artefactos                                                                                                                |
| DELETE | `/v1/jobs/:id`                                                                                    | key     | Cancelar / borrar                                                                                                                     |
| GET    | `/v1/templates` · `/v1/templates/:id` · `/v1/templates/:id/files/*` · `/v1/templates/:id/archive` | público | Catálogo y descarga                                                                                                                   |
| POST   | `/v1/templates/:id/compile`                                                                       | key     | Compila plantilla con overrides `{ files?, engine? }`                                                                                 |
| GET    | `/v1/limits`                                                                                      | público | Límites efectivos                                                                                                                     |
| GET    | `/v1/stats`                                                                                       | key     | Métricas básicas                                                                                                                      |
| GET    | `/health` · `/openapi.json`                                                                       | público |                                                                                                                                       |
| POST   | `/v1/demo/compile`                                                                                | ninguna | Solo JSON texto, usado por el playground; rate limit por IP                                                                           |

Opciones de compilación: `engine`, `entrypoint`, `timeoutMs` (≤ máx), `passes` (auto por latexmk), `bibliography: auto|bibtex|biber|none`, `webhookUrl` (jobs).

Errores: `application/problem+json` con `type: https://latex-api.crafter.run/docs/errors#<code>`, códigos `compile_failed` (422, incluye `diagnostics`), `timeout` (408/504), `payload_too_large` (413), `invalid_project` (400), `unauthorized` (401), `rate_limited` (429 + `Retry-After`), `template_not_found` (404), `job_not_found` (404), `internal` (500).

## 6. Pipeline de compilación (adaptador `DockerSiblingCompiler`)

1. Workspace en `/data/work/<jobId>/` (tmpfs si cabe): escribir archivos validados (rechazar `..`, absolutos, symlinks, NUL; cap de entradas y bytes al descomprimir).
2. `docker run --rm --init --network none --user 65534:65534 --read-only --tmpfs /tmp:... -v work:/work --memory 2g --memory-swap 2g --cpus 2 --pids-limit 64 --cap-drop ALL --security-opt no-new-privileges --security-opt seccomp=clsi-profile.json --ulimit cpu=... --ulimit fsize=... [--runtime $COMPILER_RUNTIME] ghcr.io/jibaru/latex-compiler:<tag> timeout -s KILL <s> latexmk -<engine> -interaction=nonstopmode -halt-on-error -file-line-error -output-directory=/work/out <entrypoint>` vía dockerode (grupo de procesos matado al abortar la señal).
3. Recoger `out/*.pdf`, `out/*.log`, código de salida; parsear log (file-line-error + heurísticas de `Overfull`, `Undefined control sequence`, `Missing $`, `File not found`, `Package X Error`).
4. Guardar artefactos, registrar caché, limpiar workspace.

Imagen `latex-compiler`: scheme-small + `collection-pictures collection-latexextra collection-bibtexextra collection-luatex collection-fontsrecommended collection-langspanish ieeetran fontawesome5 fontawesome6 academicons simpleicons roboto sourcesans lato`, fontconfig + luaotfload pre-calentados, `shell_escape=f`, `openout_any=p`, sin docs/src, usuario `tex`. Nunca `collection-publishers` (arrastra 2.3 GB de fuentes).

## 7. Despliegue (Dokploy, perfil `crafter`)

- Proyecto `latex-api`, entorno `production`: Postgres (`vps pg create`), Compose desde `docker/compose.dokploy.yaml` referenciando `ghcr.io/jibaru/latex-api:<sha>` y `ghcr.io/jibaru/latex-api-web:<sha>`.
- `api` monta `/var/run/docker.sock` (único servicio con acceso), volumen `latex-data:/data`, env `COMPILER_IMAGE`, `DATABASE_URL`, `API_KEYS`, `DEMO_API_KEY`, límites. `HOSTNAME=0.0.0.0`, `PORT=3000`.
- La imagen del compilador se pre-descarga en el VPS en el deploy (`docker pull` desde el `api` al arrancar si falta).
- Dominio: `crafters domain add latex-api --ip 95.111.248.246`, luego `vps domain add latex-api.crafter.run --compose <id> --service web --port 3000` y `--service api --path /v1`, `/openapi.json`, `/health`, `/docs`→web.
- Deploy desde Actions: `vps compose redeploy <composeId> --profile crafter` (o actualizar tag por `vps compose env`).

## 8. CLI (`@jibaru/latex-api-cli`, fase 2 pero contrato fijado)

`latex-api login | compile [path] [--engine] [--entrypoint] [-o out.pdf] [--watch] [--json] | templates list | templates init <id> [dir] | jobs get <id> | jobs logs <id> | limits`. Config en `~/.config/latex-api/config.json`; overrides `LATEX_API_KEY`, `LATEX_API_URL`. Sube directorios como zip (respeta `.latexapiignore`/`.gitignore`), usa `/v1/jobs` + SSE cuando hay `--watch`, imprime diagnostics con colores.

## 9. Fases y entregables

1. **Fundación**: monorepo, tooling, `core` con entidades/puertos/casos de uso y tests unitarios, imagen `latex-compiler` construida y probada local con las 7 plantillas.
2. **API**: Hono en Next.js, auth, límites, `CompileProject` síncrono con `DockerSiblingCompiler`, parser de log, OpenAPI + Scalar local, Dockerfile api.
3. **Async**: Postgres + Drizzle + pg-boss, jobs, SSE, caché, TTL, stats, health.
4. **Plantillas**: `packages/templates`, manifests, previews, endpoints, tests de integración en CI.
5. **SDK**: generación hey-api, tests contra API local, publicación con Changesets.
6. **Web**: landing editorial, playground, docs Fumadocs + referencia OpenAPI, página de errores y límites.
7. **Deploy**: Compose en Dokploy, dominio, CI/CD completo, smoke tests en producción.
8. **CLI**: comandos, binarios Bun, release en GitHub.

## 10. Limitaciones que documentaremos

Sin `-shell-escape` (minted, TikZ externalize, gnuplot); sin red durante la compilación; clases fuera de TeX Live deben subirse (las de las plantillas ya vienen); fuentes personalizadas se suben y se referencian por archivo; biber/biblatex fijados a TeX Live 2026; timeouts y memoria por job; artefactos expiran a las 24 h.

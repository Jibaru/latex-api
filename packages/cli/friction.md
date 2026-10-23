# friction.md: latex-api CLI 0.2.0 (cli-build working log)

Kept during the build, folded into [CASE.md](CASE.md) at the end.

## Phase 0: contract origin

**Defined.** We own the API (`apps/api`) and its OpenAPI 3.1 document (`packages/openapi/openapi.json`, 25 paths), and the SDK is generated from it. No `surface-recon` was needed. The contract written before Phase 1:

| Entity | Fields that matter | Operations | Irreversible |
|---|---|---|---|
| Identity (`/v1/me`) | `user {id,email?} \| null`, `principal {name, kind, via?, tokenId?}` | read | - |
| ApiToken | `id, name, prefix, origin (dashboard\|cli\|api), status (active\|expired\|revoked), createdAt, expiresAt?, lastUsedAt?, revokedAt?`; secret only in the create response | list, create (secret once), revoke | revoke |
| Device authorization | `deviceCode, userCode, verificationUri(Complete), expiresIn, interval`; poll: 428 `authorization_pending`/`slow_down`, 400 `access_denied`/`expired_token`, 200 `{token, tokenId, name, expiresAt?, user}` | start, poll | consuming the code |
| Job | the OpenAPI `Job` | create (sync via /compile, async via /jobs), get, list, wait, log, pdf, cancel | cancel (only stops work) |
| Template | the OpenAPI `Template` | list, get, archive, preview, compile | - |
| Profile (local) | `{baseUrl, user?, tokenId?, tokenPrefix?, createdAt}`, secret in keychain/file | list, get, use, set, rename, remove | remove deletes the local secret |

Errors are RFC 9457 `application/problem+json` with `code`.

## Phase 1: distribution

npm, built to Node (`#!/usr/bin/env node`, `engines.node >=20`), because the audience is JS developers and agents with `npx`. The repo already ships Bun-compiled binaries from `scripts/build-binaries.sh`; kept, and made to work (embedded skill, keychain fallback) rather than treated as primary.

## Phase 2: surface decisions

- Noun-verb with an enforced verb list (`test/naming.test.ts`). `compile` stays the top-level shorthand. `health`, `limits`, `stats` stay as top-level read-only leaves (an explicit allowlist in the test) instead of `server health` etc.: three short reads did not justify a noun nobody types.
- `auth token`, `auth status`, `jobs logs`, `jobs pdf` are sub-resource leaves (implicit get). The first naming test treated `token` as a verb and failed because `token` is also a noun group; split into VERBS and LEAF_NOUNS.
- `--json` means output only. Global flags (`--json`, `--profile`, `--quiet`, `--help`, `--version`) are pulled out of argv before dispatch, so they work in any position.
- Raw-output exceptions, kept deliberately small: `auth token` and `skill get` print the payload even when piped (their whole purpose is piping); `--json` gives the envelope. `jobs logs` follows the envelope rule.
- `auth login` in machine mode streams two envelopes (pending, then final). Considered and rejected: pending info only on stderr (an agent reading stdout would never see the code it must relay). `--no-wait` + `--resume` exists for agents that must hand control back to the human before polling.
- Doctor and degraded health return `ok:false` envelopes with the details in `error.details`, so `ok` always mirrors exit code 0. The alternative (`ok:true, data.healthy:false`, exit 3) breaks the one rule agents rely on.
- `nextSteps` lives in `meta` (stdout envelope), not as NDJSON on stderr (see next-steps rejection below). In human mode it is one muted `next:` line on stderr.
- Not adopted from compounding-surface: `--deliver` (PDF destinations are files, `-o` covers it) and `feedback` (no upstream channel exists). `--fields`: outputs are small and `schema` documents them; `jq` covers it.

## Phase 3: cligentic blocks (read from GitHub, not installed)

The canonical cligentic skill was read with `gh api` and its "without installing" branch followed: raw block sources from `Railly/cligentic/registry/**`, copied into `src/blocks/` as owned code with a provenance header. No `components.json`, no `registries` entry in package.json.

| Block | Decision | Reason |
|---|---|---|
| `detect` | hybrid → `src/blocks/detect.ts` | Kept `isWsl`/`isCi`/`isHeadlessLinux`/`hasCommand`. `shouldColor()` only looked at stdout; a stderr banner must not color when stderr is piped, so color is decided per stream. `detectMode` replaced by `isMachine()` in `output.ts`. |
| `style` | hybrid → `src/blocks/style.ts` | Semantic names and `visibleWidth`/`padVisible`/`truncateVisible` kept. Palette is picocolors `createColors(enabled)` because the owner asked for picocolors; added `sanitize()` for network text. |
| `banner` | hybrid → `src/blocks/banner.ts` | Same block-letter renderer and gradient. Writes only when stderr is a TTY (the block printed a plain fallback into captured stderr). |
| `atomic-write` | hybrid → `src/blocks/atomic-write.ts` | On Windows the block unlinks the target before rename, leaving a window with no file; replaced with a short EPERM/EBUSY rename retry. |
| `open-url` | hybrid → `src/blocks/open-url.ts` | Same decision order and never-throw verdict. Windows path interpolated the URL into a PowerShell `Start-Process "<url>"` string; replaced with `rundll32 url.dll,FileProtocolHandler <url>` (no shell parsing of a server-provided URL). |
| `prompt-secret` | hybrid → `src/blocks/prompt.ts` | Prompt and mask written to stderr instead of stdout (stdout carries data). Used by `auth login --with-token` on a terminal. |
| `trust-ladder` | hybrid → `src/gate.ts` + `confirm()` in `prompt.ts` | Only the T2 half of `approveGate`: `--yes` passes, machine mode/no TTY throws `confirmation_required`, otherwise ask on stderr. T3 intent tokens rejected: the worst outcome is a revoked token recreated in seconds. |
| `doctor` | hybrid → `src/commands/doctor.ts` | Same run-isolated-checks pattern; four states (pass/fail/warn/skip) plus hints; result goes through this CLI's envelope, not `emit()`. |
| `global-flags` | hybrid (pattern) → `extractGlobals()` in `app.ts` | Same idea of one parsed globals object. Rejected its `CLI_JSON`/`CLI_PROFILE` env names (we have `LATEX_API_*`), a global `--dry-run` (only on mutations), `--no-input` (non-TTY detection already refuses prompts), `--verbose`. |
| `xdg-paths` | hybrid (pattern) → `homeDir()`/`appPaths()` in `config.ts` | `{APP}_HOME` override adopted as `LATEX_API_HOME`. macOS `~/Library/Application Support` rejected: the owner specified `~/.config/latex-api` and 0.1 already used it. No state/cache split needed. |
| `json-mode` | reject | Emits arrays as NDJSON and bare values, errors as `{ok:false,error:string}`. That conflicts with the single envelope the owner specified; a published contract outranks a shared block. |
| `next-steps` | reject | Writes NDJSON hints to stderr. The envelope already has `meta.nextSteps`, which an agent reads from the same line as the data. |
| `error-map` | reject | `AppError.toJSON()` shape (`{ok,code,name,error,hint}`) conflicts with the envelope; `CliError` + `toCliError()` map problem+json codes and HTTP status to the documented exit codes. |
| `config` | reject | `{defaults, profiles}` merge shape differs from the owner's `{version, currentProfile, profiles}`, and it silently swallows corrupt JSON (we fail with `config_invalid`). |
| `session` | reject | One `current.json` session; this CLI needs one secret per profile, in the keychain first. |
| `api-key-wizard` | reject | Interactive @clack prompt on stdout; the device flow replaces pasting keys, and `--with-token` reads stdin. |
| `skill-installer-prompt` | reject | Spawns `npx skills add` (network, interactive). The skill ships inside the package; `skill install` writes it locally with a version check. |
| `killswitch` | reject | No command moves money or touches third parties. |
| `audit-log`, `audit-lifecycle` | reject | Token revocation is recorded server-side (`revokedAt`, visible in `token list` and the dashboard). The job ledger keeps the two-phase idea where it matters (`submitted` before waiting, `finished` after). |
| `telemetry` | reject | Not requested and would need a consent design. |
| `copy-clipboard` | reject | Would put secrets in a shared buffer; `auth token \| <tool>` is explicit. |
| `notify-os` | reject | Not needed for the surface. |
| `argv` | reject | citty already parses arguments. |

## Phase 4: safety, sized to the damage

| Command | Effect | Gate |
|---|---|---|
| reads (`get`, `list`, `status`, `doctor`, `schema`, ...) | none | none |
| `profile set/use/rename`, `skill install`, `templates init` | local, reversible | none; `skill install` and `templates init` refuse to overwrite without `--force` |
| `auth login`, `token create` | creates a credential (revocable) | none |
| `jobs cancel` | stops one job | none (the command is the intent) |
| `auth logout` | revokes the CLI-created token | none (the command is the intent); dashboard tokens are never revoked by logout |
| `token revoke` | irreversible | T2: prompt on TTY, `--yes` otherwise, `--dry-run` runs the real lookup (`GET /v1/tokens`) |
| `profile remove` | deletes the local secret | T2: same, plus `--dry-run` |

Secrets: never in config.json (asserted in tests), never accepted as argv (`secret_in_argv`), keychain first. Network text is sanitized (control chars and escapes stripped) before it reaches a terminal or an envelope message.

## Phase 5: wired check (grep for call sites)

`await approve(` in `token.ts` and `profile.ts`; `args["dry-run"]` read in both; `appendLedger(` at 7 sites (compile, jobs create/wait/cancel, templates compile); `readLedger(` in `jobs list --local`; `store.set/delete/rename` in login, logout, profile rename/remove and the migration; `args["keep-token"]` read in logout; `--timeout` parsed in login. No definition-only features.

## Friction, in order of appearance

1. **citty dispatch.** `runCommand` picks the subcommand as the first argv token not starting with `-`, so `latex-api --profile staging token list` would dispatch to a command called `staging`. Wrote a small dispatcher (`app.ts`) that extracts global flags first and walks our own tree; citty is used for `parseArgs` and `renderUsage` only.
2. **citty ignores unknown flags** (`strict: false`). Added `findUnknownFlag()`; a typo is `unknown_flag`, exit 2.
3. **citty usage colors** depend only on `NO_COLOR=1`/`CI`, not on the TTY, so `--help | cat` carried ANSI. Usage is stripped unless stdout should be colored.
4. **citty puts named positionals in `_` too**, so `schema token create` filtered on "token token create". Caught by an envelope test.
5. **consola and @clack/prompts write to stdout** (info, success, prompts). Both removed: stdout is data.
6. **picocolors enables color on win32 even when piped** (`isColorSupported` includes `platform === "win32"`). Fixed by `createColors(shouldColor(stream))`.
7. **Bundler constant-folding.** `const specifier = "@napi-rs/keyring"; import(specifier)` was folded back to a literal by tsdown. Used `["@napi-rs","keyring"].join("/")` so the import stays runtime-resolved.
8. **Bun binary + native module.** In a compiled binary the keychain import fails and the file fallback is used (verified). But when the binary's cwd contains `node_modules/@napi-rs/keyring` the import succeeds and the real keychain is used: behaviour depends on cwd. Harmless (either store works and `doctor` reports which), documented.
9. **`skill get` in the binary** failed because `dist/skill/SKILL.md` does not exist inside it. Added a `?raw` rolldown plugin in `tsdown.config.ts` that embeds the file; disk copy still preferred.
10. **Production device endpoint during the build:** `POST /v1/auth/device` answered 401, then plain-text 404, then 200 as the backend deploy rolled out. A 401 on a public route was misleading, so the CLI maps 401/404 on *start* to `device_flow_unavailable` with a `--with-token` hint.
11. **Backend bug found:** `POST /v1/auth/device/token` returns `500 internal` for a pending code instead of 428 `authorization_pending` (request ids `61014c55-a7e9-40d5-bfce-7d04c82e0ea1`, `51df7998-df12-435b-ac2c-8299866723f6`, server `main-06b84fa`). The CLI treats 5xx as transient (5 retries, bounded by `--timeout`), so it never hangs; the approved path was verified against a local stub.
12. **No TTY in the agent shell.** The human path (colors, tables, banner, spinner) can't be seen through the tool's pipes. Covered in-process with fake TTY sinks and `FORCE_COLOR` (`test/output.test.ts`), and added `LATEX_API_OUTPUT=human|json` (precedent: cligentic `detect`'s `NO_JSON`) to view human output from the real linked binary. The banner and the animated spinner were only verified in-process.
13. **Git Bash + `MSYS_NO_PATHCONV=1`** passed `LATEX_API_HOME=/c/...` to a native exe verbatim, which resolved it to `C:\c\...`. A verification artifact, not a CLI bug; use Windows paths for env vars given to native executables.
14. **`pnpm --filter X build typecheck test`** runs only `build` and passes `typecheck test` as arguments (the SDK's tsdown then fails on missing entry files). Ran the three scripts separately.
15. **Changesets vs a manual bump.** The owner asked for 0.2.0 in package.json and changeset entries. Changesets computes from package.json, so a later `changeset version` would produce 0.3.0. Publishing with `pnpm release` (`changeset publish`) publishes 0.2.0 as-is; the pending changeset files should then be deleted or consumed deliberately.

## Where the skill was thin or wrong for this build

- `json-contract.md` allows `nextSteps` "on stderr or in meta"; cligentic's `next-steps` block puts them on stderr as NDJSON. For an envelope-first CLI, stderr hints split one answer across two streams. `meta` was the right home.
- `human-output.md` says to adopt `style` by default but its 256-color palette conflicts with an owner who names picocolors; the semantic layer is what mattered, the escape codes are replaceable.
- The skill's TTY-smoke advice assumes a terminal is available to the builder. In an agent harness there is none; an output-mode override env var was the cheapest way to see the human view through the shipped binary.

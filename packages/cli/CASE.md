---
cli: latex-api
target: the LaTeX API (own service; OpenAPI 3.1, 25 paths) for compiling LaTeX to PDF
origin: defined
built: 2026-10-22
status: internal
distribution: npm
---

# latex-api

## What it does

Compiles a `.tex` file or a project folder to PDF on a hosted TeX Live and writes it locally, and manages everything around that: browser sign-in from the terminal (device code), personal API tokens, named profiles with keychain-backed secrets, async jobs with `--wait` and a local ledger, templates, and an agent skill versioned with the CLI.

## Contract origin

Defined: the API, its OpenAPI document and the SDK generated from it live in the same monorepo. The entities and operations were written down before any code (`friction.md`, Phase 0). The classification held. The one part that behaved like a discovered contract was the device-flow backend, built in parallel: its start endpoint went 401 → 404 → 200 during the build and its poll endpoint returned 500 for pending codes in production. The CLI's handling of both (start 401/404 → `device_flow_unavailable`; poll 5xx → bounded retries) came from observing the live server, not the spec.

## Distribution choice

npm, built to Node with a `#!/usr/bin/env node` shebang, `engines.node >=20`; the audience is JS developers and agents running `npx`. The existing Bun-compiled release binaries were kept as a secondary target, which forced two changes: the skill is embedded in the bundle (`?raw` plugin in `tsdown.config.ts`), and the native keychain module is imported with a runtime-built specifier so a binary falls back to `credentials.json` instead of failing.

## Blocks adopted

Read from the cligentic repository (not installed) and copied into `packages/cli/src/blocks/` with provenance headers. The full table with reasons is in `friction.md`.

| Block | Verdict | Short reason |
|---|---|---|
| detect | hybrid | color decided per stream; env via a runtime seam |
| style | hybrid | semantic names + visible-width helpers kept; picocolors palette (owner's choice) |
| banner | hybrid | stderr-only and only on a TTY |
| atomic-write | hybrid | rename retry on Windows instead of unlink-then-rename |
| open-url | hybrid | `rundll32` instead of interpolating the URL into PowerShell |
| prompt-secret | hybrid | prompt on stderr, not stdout |
| trust-ladder | hybrid | T2 gate only; T3 intent tokens too heavy for a revocable token |
| doctor | hybrid | four check states with hints, through the envelope |
| global-flags, xdg-paths | hybrid (pattern) | `LATEX_API_*` names, `~/.config` kept on macOS |
| json-mode, next-steps, error-map | reject | output shapes conflict with the owner's single envelope |
| config, session | reject | profile/secret model differs (per-profile keychain secrets) |
| api-key-wizard, skill-installer-prompt | reject | device flow and the bundled skill replace them |
| killswitch, audit-log, audit-lifecycle, telemetry, copy-clipboard, notify-os, argv | reject | no consequential local writes / not needed / citty already parses |

## What broke

- citty's dispatcher treated a global flag's value as a subcommand name, ignored unknown flags, colored `--help` into pipes, and listed named positionals in `_`. Replaced dispatch with `app.ts`; citty kept for parsing and usage text.
- consola, @clack/prompts and picocolors-on-Windows all wrote to (or colored) stdout when it was piped. Removed the first two, made color per-stream.
- tsdown folded a "dynamic" import specifier into a literal; fixed with a built string.
- `skill get` failed inside the Bun binary (no `dist/` on disk); fixed by embedding.
- A run of the Bun binary from inside the package directory loaded the real keychain (cwd-dependent native resolution) and wrote a Windows Credential Manager entry during verification; deleted, and documented as cwd-dependent behaviour.
- Found in production, outside this package: `POST /v1/auth/device/token` returns 500 for pending codes.

## What I would do differently

- Start from the dispatcher, not from citty's `runCommand`; global flags in any position and unknown-flag errors are agent-first requirements that a framework default quietly breaks.
- Write the contract-shape validator for tests (`checkShape` in `test/helpers.ts`) first. Checking every command's envelope against the shape `schema` publishes caught fixture and contract drift immediately and is the reason the contract can't silently rot.
- Decide the versioning mechanism (manual bump vs changesets) before touching versions; doing both creates a double-bump trap.

## Evidence

- Code: `packages/cli/src/` (dispatcher `app.ts`, contracts in `command.ts`, envelope `output.ts`, profiles `config.ts`, secrets `credentials.ts`, device flow `device.ts`, gate `gate.ts`, ledger `ledger.ts`, schema `schema.ts`, skill `skill.ts`, blocks `blocks/`), SDK additions in `packages/sdk/src/index.ts`.
- Skill: `skills/latex-api/SKILL.md` (repo root), copied to `dist/skill/SKILL.md` and embedded in the bundle.
- Tests: CLI 92 passed + 4 opt-in integration skipped (11 files: config/precedence/migration, credential fallback, device polling, per-command envelope shapes and exit codes, auth flows, naming, skill/version, human output); SDK 37 passed + 4 skipped.
- Package: `@jibaru/latex-api-cli@0.2.0` (not published), SDK `@jibaru/latex-api-sdk@0.2.0`.
- Local state: `%APPDATA%\latex-api` (Windows) or `~/.config/latex-api`: `config.json`, `credentials.json` (fallback only), `jobs.jsonl`, `pending-login.json` (during a sign-in). No audit log by decision.

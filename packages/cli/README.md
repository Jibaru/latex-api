# @jibaru/latex-api-cli

Command-line client for the [LaTeX API](https://github.com/jibaru/latex-api), built for people and for agents. Compile a folder or a `.tex` file to PDF on a hosted TeX Live, sign in from the terminal, manage personal API tokens and profiles, run long compiles as jobs, and scaffold projects from templates. No local LaTeX installation needed.

```bash
npm install -g @jibaru/latex-api-cli     # installs `latex-api` and the short alias `ltx`
npx @jibaru/latex-api-cli --help         # or run it ad hoc
```

Requires Node 20+. Standalone binaries (no Node) are attached to [GitHub Releases](https://github.com/jibaru/latex-api/releases).

## Quick start

```bash
latex-api auth login            # opens the browser, you approve a code, the token is stored
latex-api compile paper/        # zips the folder, compiles it, writes paper/main.pdf
latex-api compile thesis.tex -o out/thesis.pdf --engine xelatex --watch
```

A `.tex` file is sent on its own (`text/x-tex`), the fastest path for self-contained documents. If it references other files (`\input`, `\include`, `\includegraphics`, `\bibliography`, `\addbibresource`) the CLI prints a hint; pass `--with-siblings` to zip its folder, or compile the directory. Directories are zipped without `.git`, `node_modules` and build artifacts; add a `.latexapiignore` (gitignore syntax) to exclude more.

## Signing in

| How | Command |
|---|---|
| Browser approval (device code) | `latex-api auth login` (`--no-browser` to only print the URL; never blocks when no browser exists) |
| Start now, finish later | `latex-api auth login --no-wait`, approve in the browser, then `latex-api auth login --resume` |
| Token from the dashboard | `printf %s "$TOKEN" \| latex-api auth login --with-token` (stdin only; a token passed as an argument is refused) |
| CI and scripts | set `LATEX_API_TOKEN`; nothing is stored |

`auth status` calls `/v1/me` and shows the user, profile, token prefix and where the secret lives. `auth logout` revokes the token on the server when it was created by `auth login` (dashboard tokens are left alone; `--keep-token` keeps any token valid) and deletes the local copy. `auth token` prints the active secret for piping (`curl -H "Authorization: Bearer $(latex-api auth token)" …`).

**Non-interactive `auth login`.** When stdout is not a terminal (an agent, a pipe) the command writes two JSON envelopes, one per line: first `data.status: "pending"` with `userCode` and `verificationUriComplete` to relay to a human, then, after approval, `data.status: "approved"`. It polls for at most `--timeout` seconds (default 600) with progress on stderr, then fails with `login_timeout` (exit 3). With `--no-wait` only the pending envelope is written and the process exits; `auth login --resume` finishes the same sign-in. This keeps a single command usable both by an agent that can wait and by one that must hand control back to a human.

### Where things are stored

| What | Where |
|---|---|
| Profiles (identifiers only: URL, user id/email, token id and prefix) | `~/.config/latex-api/config.json` (`$XDG_CONFIG_HOME`), `%APPDATA%\latex-api\config.json` on Windows |
| Secrets | OS keychain (service `latex-api`, account = profile name) via `@napi-rs/keyring`; when the keychain is unavailable (headless Linux, CI, containers, compiled binaries) a `credentials.json` with mode `0600` next to the config |
| Local job ledger | `jobs.jsonl` next to the config |

`LATEX_API_HOME` moves all of it (tests, sandboxes). `LATEX_API_CREDENTIAL_STORE=file|keychain|auto` forces a store. A 0.1 config (`{ baseUrl, apiKey }`) is migrated on first run: the URL becomes profile `default` and the key moves to the credential store.

### Profiles and precedence

```bash
latex-api profile set staging --url http://localhost:3999
latex-api auth login --profile staging
latex-api profile use staging
latex-api profile list | get [name] | rename <from> <to> | remove <name> [--yes] [--dry-run]
```

Each setting resolves on its own, highest first:

| Setting | Order |
|---|---|
| Profile | `--profile` > `LATEX_API_PROFILE` > current profile > `default` |
| Server URL | `LATEX_API_URL` > the profile's URL > `https://latex-api.crafter.run` |
| Token | `LATEX_API_TOKEN` > `LATEX_API_KEY` (deprecated, warns once) > the profile's stored secret |

An unknown profile named by `--profile` or `LATEX_API_PROFILE` is an error (`profile_not_found`, exit 4) rather than a silent fallback.

## Output for agents and scripts

JSON is automatic whenever stdout is not a terminal, or forced with `--json`. stdout then carries exactly one envelope per line; everything else (progress, warnings, the banner) goes to stderr.

```json
{ "ok": true, "data": { "...": "..." }, "meta": { "profile": "default", "baseUrl": "https://latex-api.crafter.run", "nextSteps": ["latex-api jobs logs 7f1c…"] } }
{ "ok": false, "error": { "code": "compile_failed", "message": "LaTeX reported errors", "hint": "Fix the errors in error.details.diagnostics …", "details": { "diagnostics": [] } }, "meta": { "profile": "default" } }
```

- `latex-api schema [command]` prints a versioned description of every command: positionals, flags, the `data` shape, exit codes, whether it needs auth and whether it writes. It is generated from the same definitions that run the commands.
- No command prompts without a terminal. Destructive commands (`token revoke`, `profile remove`) ask on a terminal and otherwise fail with `confirmation_required` (exit 2) until `--yes` is given; both support `--dry-run`, which performs the real lookup.
- Unknown flags are errors (`unknown_flag`, exit 2), not silently ignored.
- Exceptions to "JSON when piped": `auth token` and `skill get` print the raw secret / Markdown; add `--json` for the envelope. `auth login` and `compile --watch` stream several envelopes (NDJSON).
- `LATEX_API_OUTPUT=human` keeps the human view when piping (e.g. into `less -R`); `--json` always wins.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | LaTeX reported errors; a job failed, timed out or was cancelled |
| `2` | Usage: bad flag or argument, missing file, refusing to overwrite, confirmation required |
| `3` | Not signed in, token rejected or forbidden, network or server error |
| `4` | Not found: job, token, template or profile |
| `5` | Conflict or rate limited (HTTP 409/429), e.g. too many tokens, job already finished |

## Commands

```
latex-api compile [path]                     the shorthand for most work
latex-api auth login|status|logout|token
latex-api token list|create|revoke
latex-api profile list|get|use|set|rename|remove
latex-api jobs create|get|list|wait|logs|cancel|pdf
latex-api templates list|get|init|preview|compile
latex-api skill get|install
latex-api doctor | schema | health | limits | stats
```

Global flags: `--json`, `--profile <name>`, `-q/--quiet`, `-h/--help`, `-v/--version`. Every command answers `--help` with its flags, output, exit codes and examples.

### `compile [path=.]`

| Option | Description |
|---|---|
| `--engine pdflatex\|xelatex\|lualatex` | Engine; otherwise the `% !TEX program = ...` comment or pdflatex |
| `--with-siblings` | For a `.tex` argument: zip its folder (that file as entrypoint) |
| `--entrypoint <file>` | Main file relative to the project directory |
| `-o, --output <file>` | PDF path (default: `<entrypoint>.pdf` next to the source) |
| `--timeout <ms>` | Compile timeout, capped by the server |
| `--bibliography auto\|bibtex\|biber\|none` | Bibliography tool |
| `--force` | Skip the server-side cache |
| `-w, --watch` | Recompile on changes; in machine mode one envelope per compile |
| `--open` | Open the PDF with the default viewer |

On LaTeX errors it exits 1. On a terminal you get a compact report (`file:line: error: message`, errors first, then the log URL); in machine mode the same diagnostics are in `error.details.diagnostics`.

### `jobs` (asynchronous compiles)

```bash
latex-api jobs create thesis/ --wait -o thesis.pdf   # submit, follow, download
latex-api jobs create paper/ --webhook https://example.com/hook
latex-api jobs list [--limit 20]                     # your jobs on the server
latex-api jobs list --local                          # this machine's ledger, works offline
latex-api jobs wait <id> -o paper.pdf                # resume after an interrupted --wait
latex-api jobs get|logs|pdf|cancel <id>
```

Every submission is appended to the ledger before waiting, so an interrupted `--wait` is recoverable with `jobs wait <id>` instead of a second submission.

### `token`

```bash
latex-api token list
latex-api token create --name ci --expires-in-days 30   # default 90 days; --no-expiry for none
latex-api token revoke <id> --dry-run
latex-api token revoke <id> --yes
```

The secret from `token create` is printed once (in machine mode inside `data.token`).

### `templates`

```bash
latex-api templates list
latex-api templates get ieee-conference
latex-api templates init cv-awesome my-cv            # refuses a non-empty directory without --force
latex-api templates preview cv-awesome -o cv.pdf
latex-api templates compile cv-awesome ./my-cv -o cv.pdf
```

### `doctor`

Runs `config`, `profile`, `credential` (and where it is stored), `credential_valid` (a real `/v1/me` call), `api_reachable` (`/health`), `compiler` and `cli_version` (npm latest, skipped offline). Each check is `pass|fail|warn|skip` with a hint; any `fail` gives `ok: false`, `error.code: "doctor_failed"`, the checks in `error.details.checks`, and exit 2, 3 or 4 depending on the first failure.

### `skill`

The agent skill ships with the CLI: `latex-api skill get` prints the `SKILL.md` for this exact version, and `latex-api skill install` writes it where an agent reads it:

| `--target` | Location |
|---|---|
| `claude` (default) | `~/.claude/skills/latex-api/SKILL.md`, or `./.claude/skills/...` with `--project` |
| `agents` | `./.agents/skills/latex-api/SKILL.md`, or `~/.agents/...` with `--global` |
| `cursor` | `./.cursor/rules/latex-api.mdc` |
| any directory | `<dir>/latex-api/SKILL.md` |

A different or edited copy is never overwritten without `--force` (exit 5). The same file is installable from the repository with `npx skills add jibaru/latex-api`.

### `health`, `limits`, `stats`

Server health (a degraded server is `server_degraded`, exit 3), effective limits (upload size, timeouts, rate limits, engines) and your usage.

## CI

```yaml
- run: npx -y @jibaru/latex-api-cli compile paper --entrypoint main.tex -o dist/paper.pdf
  env:
    LATEX_API_TOKEN: ${{ secrets.LATEX_API_TOKEN }}
```

## Building binaries

`bash scripts/build-binaries.sh` compiles `dist/cli.mjs` with `bun build --compile` for Linux, macOS and Windows. The skill is embedded in the bundle. The native keychain module is resolved at runtime rather than embedded, so a binary normally stores secrets in `credentials.json` (mode 0600); `latex-api doctor` reports which store is in use.

## License

MIT

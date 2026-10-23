# @jibaru/latex-api-cli

Command-line client for the [LaTeX API](https://github.com/jibaru/latex-api). Compile a folder or a `.tex` file to PDF on a remote TeX Live, watch for changes, run long compiles as jobs with a live log, and scaffold projects from templates. No local LaTeX installation needed.

```bash
npm install -g @jibaru/latex-api-cli     # installs `latex-api` and the short alias `ltx`
npx @jibaru/latex-api-cli --help         # or run it ad hoc
```

Requires Node 20+. Standalone binaries (no Node) are attached to [GitHub Releases](https://github.com/jibaru/latex-api/releases).

## Quick start

```bash
latex-api login                 # asks for the server URL (default https://latex-api.crafter.run) and your API key
latex-api compile paper/        # zips the folder, compiles it, writes paper/main.pdf
latex-api compile thesis.tex -o out/thesis.pdf --engine xelatex --watch
```

A `.tex` file is sent on its own (`text/x-tex`), which is the fastest path for self-contained documents. If it references other files (`\input`, `\include`, `\includegraphics`, `\bibliography`, `\addbibresource`) the CLI prints a hint; pass `--with-siblings` to zip its whole folder instead, or compile the directory. Directories are zipped with `.git`, `node_modules` and build artifacts (`.aux`, `.log`, `.synctex.gz`, ...) left out; add a `.latexapiignore` file with gitignore-like patterns to exclude more (a 413 from the server tells you how big the upload was and what the limit is).

## Configuration

| Source                                                                                               | Precedence                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------- |
| `LATEX_API_URL`, `LATEX_API_KEY` environment variables                                               | highest                         |
| `~/.config/latex-api/config.json` (`$XDG_CONFIG_HOME`), `%APPDATA%\latex-api\config.json` on Windows | written by `login`, mode `0600` |
| Default URL `https://latex-api.crafter.run`                                                          | lowest                          |

`LATEX_API_CONFIG_DIR` overrides the config directory. Public endpoints (`templates`, `limits`, `health`) work without a key.

## Commands

### `login [--url <baseUrl>] [--key <apiKey>] [--no-verify]`

Prompts for anything missing, validates the key by calling `/v1/limits` and `/v1/stats`, then stores both values. `logout` deletes the file.

### `compile [path=.] [options]`

| Option                                     | Description                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `--engine pdflatex\|xelatex\|lualatex`     | Engine; otherwise the `% !TEX program = ...` comment or pdflatex                              |
| `--with-siblings`                          | For a `.tex` argument: zip its parent folder (that file as entrypoint) instead of only the file |
| `--entrypoint <file>`                      | Main file relative to the project directory (default: `main.tex` or the single `.tex`)        |
| `-o, --output <file>`                      | PDF path (default: `<entrypoint>.pdf` next to the source)                                     |
| `--timeout <ms>`                           | Compile timeout, capped by the server                                                         |
| `--bibliography auto\|bibtex\|biber\|none` | Bibliography tool                                                                             |
| `--force`                                  | Skip the server-side content cache                                                            |
| `--json`                                   | Print the job envelope (status, diagnostics, timings, URLs) as JSON; the PDF is still written |
| `-w, --watch`                              | Recompile on changes (300 ms debounce), ignoring the output PDF and build artifacts           |
| `--open`                                   | Open the PDF with the default viewer                                                          |

On LaTeX errors the command prints a compact report (`file:line: error: message`, errors first, up to 20 entries, then the log URL) and exits with code 1:

```
✖ LaTeX reported errors
sections/intro.tex:3: error: Undefined control sequence.
main.tex:40: warning: Overfull \hbox (12pt too wide)
1 error, 1 warning
Full log: https://latex-api.crafter.run/v1/jobs/7f1c.../log
```

### `jobs` (asynchronous compiles, up to 5 minutes)

```bash
latex-api jobs create paper/ --webhook https://example.com/hook   # prints the job id
latex-api jobs wait <id> -o paper.pdf      # streams the compiler log (SSE), then downloads the PDF
latex-api jobs get <id> [--json]
latex-api jobs logs <id>
latex-api jobs pdf <id> -o file.pdf
latex-api jobs cancel <id>
```

`jobs create` accepts the same options as `compile` plus `--webhook <url>`.

### `templates`

```bash
latex-api templates list [--json]                 # table of ids, categories, engines
latex-api templates init ieee-conference [dir]    # downloads the files into ./ieee-conference (refuses non-empty dirs unless --force)
latex-api templates preview cv-awesome -o cv.pdf  # rendered PDF of the untouched template
latex-api templates compile cv-awesome ./my-cv -o cv.pdf   # compiles the template with the files in ./my-cv layered on top
```

### `limits`, `stats`, `health`

Show the server's effective limits (`--json` available), usage statistics (needs a key) and the health check. `health` exits with code 3 when the server reports `degraded`.

### `--version`, `--help`

Every command and sub-command answers `--help`.

## Exit codes

| Code | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| `0`  | Success                                                           |
| `1`  | LaTeX reported errors, the job failed, timed out or was cancelled |
| `2`  | Usage error: bad flag, missing path, refusing to overwrite        |
| `3`  | Network, authentication (401), rate limit (429) or server error   |

## Scripting

```bash
# CI: fail the build on LaTeX errors, keep the PDF as an artifact
LATEX_API_KEY=$KEY latex-api compile paper --entrypoint main.tex -o dist/paper.pdf || exit 1

# Machine-readable output
latex-api compile paper --json | jq .job.result.warnings
latex-api templates list --json | jq -r '.templates[].id'
```

## Building binaries

`bash scripts/build-binaries.sh` compiles `dist/cli.mjs` with `bun build --compile` into `release/latex-api-{linux-x64,linux-arm64,darwin-x64,darwin-arm64,windows-x64}` plus a checksum file.

## License

MIT

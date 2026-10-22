# @latex-api/templates

Ready-to-compile LaTeX projects served by `GET /v1/templates` and compiled by
`POST /v1/templates/:id/compile`. Every template is self-contained: no
shell-escape, no network access and no external images are needed, so each
one compiles inside the `latex-compiler` sandbox as-is.

| id                   | engine   | category | class / origin                              |
| -------------------- | -------- | -------- | ------------------------------------------- |
| `ieee-conference`    | pdflatex | paper    | IEEEtran (conference)                       |
| `ieee-journal`       | pdflatex | paper    | IEEEtran (journal, with biographies)        |
| `cv-awesome`         | lualatex | cv       | Awesome-CV (posquit0, LPPL 1.3c / CC BY-SA) |
| `cv-altacv`          | pdflatex | cv       | AltaCV (LianTze Lim, LPPL 1.3)              |
| `trifold-brochure`   | pdflatex | brochure | `leaflet` class + TikZ                      |
| `infographic-poster` | pdflatex | poster   | `tikzposter` + pgfplots                     |
| `report-es`          | pdflatex | report   | `report` class, Spanish babel               |

## Layout

```
templates/<id>/
  manifest.json      # metadata, see below
  <entrypoint>.tex   # first line: % !TEX program = <engine>
  ...                # any other files the project needs (sections, .bib, .cls, fonts)
```

Everything inside `templates/<id>/` except `manifest.json` is shipped to the
compiler verbatim and listed by the API as the template's files.

## `manifest.json`

The schema is `TemplateManifest` in `packages/core/src/domain/template.ts`:

```jsonc
{
  "id": "report-es",                    // must equal the directory name, /^[a-z0-9][a-z0-9-]{1,63}$/
  "name": "Technical report (Spanish)",
  "description": "One or two sentences shown in the catalogue.",
  "category": "report",                 // paper | cv | brochure | poster | report | letter | other
  "engine": "pdflatex",                 // pdflatex | xelatex | lualatex
  "entrypoint": "main.tex",             // relative path of the file to compile
  "tags": ["spanish", "report"],
  "license": "Human readable license of the class/template (e.g. LPPL 1.3c).",
  "source": "https://...",              // optional: where the class/template comes from
  "variables": [],                      // reserved for future placeholder substitution
  "editable": ["main.tex", "refs.bib"], // files users are expected to edit, entrypoint first
  "preview": "preview.png"              // optional, relative path of a shipped preview image
}
```

Rules:

- `id` is the directory name and is immutable once published.
- `entrypoint` and every path in `editable` must exist.
- Only packages available in the compiler image may be used (TeX Live
  `scheme-small` + the collections pictures, latexextra, bibtexextra, luatex,
  fontsrecommended, langspanish, mathscience, binextra, plus `ieeetran`,
  `fontawesome5/6`, `academicons`, `simpleicons`, `roboto`, `sourcesans`,
  `lato`, `raleway`, `fira`, `firamath`, `inter`, `montserrat`, `cm-super`,
  `lm-math`, `xits`, `libertinus-fonts`, `gnu-freefont`, `biblatex-ieee`,
  `biblatex-apa`). No `minted`, `svg`, `epstopdf` or anything else that needs
  `-shell-escape`.
- Third-party classes must be redistributable; keep their license text next to
  the `.cls` and summarise it in `manifest.license`.
- Do not commit build artifacts (`.pdf`, `.aux`, `.log`, ...).

## Adding a template

1. Create `templates/<id>/` with the entrypoint (`% !TEX program = <engine>` as
   first line), supporting files and a `manifest.json`.
2. Keep the prose users will edit in the entrypoint or in clearly named section
   files and list them in `manifest.editable`.
3. Run the integration test, which compiles every template with the Docker
   image, prints a results table and removes the generated artifacts:

   ```sh
   docker build -t latex-compiler:dev docker/compiler
   pnpm --filter @latex-api/templates test:integration
   # or a single template:
   node packages/templates/scripts/compile-all.mjs <id>
   ```

   Environment variables: `COMPILER_IMAGE` (default `latex-compiler:dev`),
   `COMPILE_TIMEOUT_S` (default 180), `KEEP_ARTIFACTS=1` to keep the PDF and
   log for inspection.
4. Add the template to the table above.

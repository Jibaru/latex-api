# @jibaru/latex-api-sdk

TypeScript client for the [LaTeX API](https://github.com/jibaru/latex-api): compile LaTeX projects to PDF over HTTP with pdflatex, xelatex or lualatex. Works in Node 20+, browsers, edge runtimes and workers (anything with `fetch`). ESM only.

```bash
npm install @jibaru/latex-api-sdk
# pnpm add @jibaru/latex-api-sdk / bun add @jibaru/latex-api-sdk
```

## Quick start

```ts
import { LatexApi } from "@jibaru/latex-api-sdk";

const api = new LatexApi({ apiKey: process.env.LATEX_API_TOKEN });

const { pdf, jobId, cached, warnings } = await api.compile({
  source: String.raw`\documentclass{article}\begin{document}Hello, world.\end{document}`,
});
// pdf is a Uint8Array
```

The default base URL is the public instance `https://latex-api.crafter.run`. Point `baseUrl` at your own deployment to self-host. In Node, `LATEX_API_URL` and `LATEX_API_TOKEN` (or the deprecated `LATEX_API_KEY`) are read automatically when the options are omitted. `token` is accepted as an alias of `apiKey`.

```ts
const api = new LatexApi({
  baseUrl: "https://latex.example.com", // default: https://latex-api.crafter.run
  apiKey: "...", // optional for public endpoints (templates, limits, health)
  fetch: customFetch, // optional, defaults to globalThis.fetch
  userAgent: "my-app/1.0", // optional, sent outside browsers
});
```

## Compiling

`compile()` is synchronous: it waits for the result (up to the server's sync timeout, 60 s by default) and resolves with the PDF. Three input shapes pick the transport for you:

```ts
// 1. Several files: sent as JSON (binary content is base64-encoded)
await api.compile({
  files: [
    { path: "main.tex", content: "\\documentclass{article}..." },
    { path: "sections/intro.tex", content: "..." },
    { path: "figures/plot.png", content: pngBytes }, // Uint8Array
  ],
  entrypoint: "main.tex", // guessed when there is a single .tex or a main.tex
  engine: "xelatex", // pdflatex | xelatex | lualatex; `% !TEX program = ...` is honored
  options: { timeoutMs: 60_000, bibliography: "auto", force: false },
});

// 2. A single document: sent as text/x-tex
await api.compile({ source: texString, engine: "lualatex" });

// 3. A zip of the project: sent as application/zip
await api.compile({ zip: zipBytes, entrypoint: "paper/main.tex" });
```

Ask for the job envelope instead of the bytes when you want diagnostics, timings and artifact URLs:

```ts
const { job } = await api.compile(input, { accept: "json" });
job.status; // "succeeded"
job.result?.warnings; // number
job.result?.diagnostics; // [{ severity, message, file, line }]
job.result?.pdfUrl; // download later with api.jobs.pdf(job.id)
```

### Node: write straight to disk, zip a folder

```ts
import { LatexApi, packDirectory } from "@jibaru/latex-api-sdk";

const zip = await packDirectory("./paper", { ignore: ["drafts/"] });
await api.compileToFile({ zip, entrypoint: "main.tex" }, "./out/paper.pdf");
```

`packDirectory` skips `.git`, `node_modules` and LaTeX build artifacts (`.aux`, `.log`, `.synctex.gz`, `.fdb_latexmk`, ...) and honors a `.latexapiignore` file in the folder with gitignore-like patterns (`*.bak`, `drafts/`, `!keep.log`). Both helpers import `node:fs` lazily, so the rest of the package stays browser-safe.

## Error handling

Every non-2xx response throws a `LatexApiError` carrying the RFC 9457 problem document. LaTeX failures throw the `CompileFailedError` subclass with structured diagnostics.

```ts
import { CompileFailedError, LatexApiError } from "@jibaru/latex-api-sdk";

try {
  await api.compile({ source });
} catch (error) {
  if (error instanceof CompileFailedError) {
    for (const d of error.diagnostics) {
      console.error(`${d.file ?? "?"}:${d.line ?? "?"}: ${d.severity}: ${d.message}`);
    }
    console.error("Full log:", error.logUrl); // or await api.jobs.log(error.jobId!)
  } else if (error instanceof LatexApiError) {
    error.status; // HTTP status, 0 for network failures
    error.code; // unauthorized | rate_limited | payload_too_large | timeout | ...
    error.problem; // the parsed problem+json body
    error.retryAfterSeconds; // set on 429
    error.retryable; // true for 0, 429 and 5xx
  }
}
```

Error codes: `invalid_project`, `invalid_request`, `payload_too_large`, `compile_failed`, `timeout`, `unauthorized`, `rate_limited`, `template_not_found`, `job_not_found`, `job_not_cancellable`, `internal`; plus client-side `network_error`, `wait_timeout` and `aborted`.

## Async jobs

For long documents use jobs: they run for up to 5 minutes, can be cancelled, stream their log, and can call a webhook when they finish.

```ts
const job = await api.jobs.create({
  zip,
  options: { webhookUrl: "https://example.com/hooks/latex" },
});

// Stream progress (Server-Sent Events, with automatic fallback to polling)
const done = await api.jobs.wait(job.id, {
  timeoutMs: 5 * 60_000,
  onEvent: (event) => {
    if (event.type === "log") process.stdout.write(event.chunk);
  },
});

if (done.status === "succeeded") {
  const pdf = await api.jobs.pdf(job.id);
} else {
  console.error(done.error?.message, done.result?.diagnostics);
  console.error(await api.jobs.log(job.id));
}
```

Lower-level pieces: `jobs.get(id)`, `jobs.cancel(id)`, `jobs.log(id)` and `jobs.events(id)`, an async iterable of `{ type: "queued" | "running" | "log" | "done" | "error" | "ping", ... }` events. The SSE parser is built on `fetch` body streams, so it works in browsers and Node without `EventSource`.

```ts
for await (const event of api.jobs.events(job.id, { signal })) {
  console.log(event.type, event);
}
```

## Account, tokens and device sign-in

```ts
const { user, principal } = await api.me(); // validates the token; principal.tokenId identifies it

const tokens = await api.tokens.list(); // secrets are never returned
const { token, apiToken } = await api.tokens.create({ name: "ci", expiresInDays: 90 }); // `null` = never expires
await api.tokens.revoke(apiToken.id);

const jobs = await api.jobs.list({ limit: 20 }); // the caller's recent jobs
```

Device sign-in (what `latex-api auth login` uses). The calls send no credential:

```ts
const anon = new LatexApi({ apiKey: "" });
const start = await anon.auth.startDevice({ clientName: "my-tool" });
console.log(`Open ${start.verificationUriComplete} and confirm ${start.userCode}`);
let interval = start.interval;
for (;;) {
  await new Promise((r) => setTimeout(r, interval * 1000));
  const result = await anon.auth.pollDevice(start.deviceCode); // throws access_denied / expired_token
  if (result.status === "approved") break;
  interval = result.interval ?? (result.status === "slow_down" ? interval + 2 : interval);
}
```

## Templates

```ts
const templates = await api.templates.list();        // Template[]
const ieee = await api.templates.get("ieee-conference");
const main = await api.templates.file("ieee-conference", "main.tex"); // Uint8Array
const zip = await api.templates.archive("ieee-conference");           // Uint8Array (zip)
const preview = await api.templates.preview("ieee-conference");       // Uint8Array (pdf)

// Compile with your overrides: files replace or extend the template files
const { pdf } = await api.templates.compile("cv-awesome", {
  files: [{ path: "cv.tex", content: myCv }],
});
const job = await api.templates.createJob("report-es", { files: [...] });
```

## Meta

```ts
await api.limits(); // upload size, file count, timeouts, engines (public)
await api.stats(); // usage statistics (needs a key)
await api.health(); // { status: "ok" | "degraded", version, checks }
```

## Runtimes

### Browser

```ts
const api = new LatexApi({ apiKey }); // keys in browsers are visible to users: prefer a server proxy
const { pdf } = await api.compile({ source });
const url = URL.createObjectURL(new Blob([pdf], { type: "application/pdf" }));
```

### Next.js server action

```ts
"use server";
import { CompileFailedError, LatexApi } from "@jibaru/latex-api-sdk";

const api = new LatexApi({ apiKey: process.env.LATEX_API_TOKEN });

export async function renderInvoice(tex: string) {
  try {
    const { pdf } = await api.compile({ source: tex });
    return { ok: true as const, pdf: Buffer.from(pdf).toString("base64") };
  } catch (error) {
    if (error instanceof CompileFailedError) {
      return { ok: false as const, diagnostics: error.diagnostics };
    }
    throw error;
  }
}
```

### Cancellation

Every method accepts `{ signal }`:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 10_000);
await api.compile(input, { signal: controller.signal });
```

## Generated client

The package is built on a client generated with `@hey-api/openapi-ts` from the API's OpenAPI 3.1 document. It is exposed for one-to-one access to every operation:

```ts
import { createClient, createConfig, getV1Templates } from "@jibaru/latex-api-sdk/raw";

const client = createClient(createConfig({ baseUrl: "https://latex-api.crafter.run" }));
const { data, error } = await getV1Templates({ client });
```

Regenerate after changing the API with `pnpm --filter @jibaru/latex-api-sdk generate`.

## License

MIT

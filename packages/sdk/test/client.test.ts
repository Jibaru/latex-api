import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { CompileFailedError, type JobEvent, LatexApi, LatexApiError } from "../src/index";
import { frame, json, makeJob, PDF, pdfResponse, problem, sseResponse, stubFetch } from "./helpers";

const TEX = "\\documentclass{article}\\begin{document}Hello\\end{document}";

function api(responder: Parameters<typeof stubFetch>[0], opts: { apiKey?: string } = {}) {
  const stub = stubFetch(responder);
  const client = new LatexApi({
    baseUrl: "https://api.test/",
    apiKey: "apiKey" in opts ? opts.apiKey : "secret",
    fetch: stub.fetch,
    userAgent: "test-agent/1.0",
  });
  return { client, calls: stub.calls };
}

describe("LatexApi.compile", () => {
  it("sends JSON for file projects and returns the PDF with headers", async () => {
    const { client, calls } = api(() => pdfResponse());
    const result = await client.compile({
      files: [
        { path: "main.tex", content: TEX },
        { path: "figures/logo.png", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
      ],
      entrypoint: "main.tex",
      engine: "xelatex",
      options: { timeoutMs: 30_000, bibliography: "biber", force: true },
    });

    expect(result.pdf).toEqual(PDF);
    expect(result.jobId).toBe("11111111-1111-4111-8111-111111111111");
    expect(result.cached).toBe(false);
    expect(result.warnings).toBe(2);

    const req = calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.url.href).toBe("https://api.test/v1/compile");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(req.headers.get("authorization")).toBe("Bearer secret");
    expect(req.headers.get("accept")).toContain("application/pdf");
    expect(req.headers.get("user-agent")).toBe("test-agent/1.0");
    expect(req.json()).toEqual({
      files: [
        { path: "main.tex", content: TEX },
        { path: "figures/logo.png", content: "iVBORw==", encoding: "base64" },
      ],
      entrypoint: "main.tex",
      engine: "xelatex",
      options: { timeoutMs: 30_000, bibliography: "biber", force: true },
    });
  });

  it("returns the job envelope when accept is json", async () => {
    const job = makeJob({ status: "succeeded", mode: "sync" });
    const { client, calls } = api(() => json({ job }));
    const result = await client.compile(
      { files: [{ path: "main.tex", content: TEX }] },
      { accept: "json" },
    );
    expect(result.job.status).toBe("succeeded");
    expect(result.pdf).toBeUndefined();
    expect(calls[0]!.headers.get("accept")).toBe("application/json");
  });

  it("sends zips as application/zip with query options", async () => {
    const zip = zipSync({ "main.tex": new TextEncoder().encode(TEX) });
    const { client, calls } = api(() => pdfResponse({ "x-compile-cached": "true" }));
    const result = await client.compile({
      zip,
      entrypoint: "main.tex",
      engine: "lualatex",
      options: { timeoutMs: 5000, bibliography: "none", force: true },
    });
    expect(result.cached).toBe(true);
    const req = calls[0]!;
    expect(req.headers.get("content-type")).toBe("application/zip");
    expect(req.body).toEqual(zip);
    expect(Object.fromEntries(req.url.searchParams)).toEqual({
      entrypoint: "main.tex",
      engine: "lualatex",
      timeoutMs: "5000",
      bibliography: "none",
      force: "true",
    });
  });

  it("sends single sources as text/x-tex", async () => {
    const { client, calls } = api(() => pdfResponse());
    await client.compile({ source: TEX, engine: "pdflatex" });
    const req = calls[0]!;
    expect(req.headers.get("content-type")).toContain("text/x-tex");
    expect(req.text).toBe(TEX);
    expect(req.url.search).toBe("?engine=pdflatex");
  });

  it("falls back to multipart when a raw body needs a webhook", async () => {
    const zip = zipSync({ "main.tex": new TextEncoder().encode(TEX) });
    const { client, calls } = api(() => json({ job: makeJob() }, 202));
    await client.jobs.create({
      zip,
      entrypoint: "main.tex",
      options: { webhookUrl: "https://hook.test/x" },
    });
    const req = calls[0]!;
    expect(req.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    const form = req.formData!;
    const project = form.get("project") as File;
    expect(project.name).toBe("project.zip");
    expect(new Uint8Array(await project.arrayBuffer())).toEqual(zip);
    expect(form.get("entrypoint")).toBe("main.tex");
    expect(JSON.parse(form.get("options") as string)).toEqual({
      webhookUrl: "https://hook.test/x",
    });
  });

  it("rejects malformed inputs before sending anything", async () => {
    const { client, calls } = api(() => pdfResponse());
    await expect(client.compile({ files: [] })).rejects.toThrow(TypeError);
    await expect(client.compile({ source: "" })).rejects.toThrow(TypeError);
    await expect(client.compile({ zip: new Uint8Array() })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("forwards abort signals", async () => {
    const controller = new AbortController();
    const { client } = api(
      (req) =>
        new Promise((_, reject) => {
          const fail = () => reject(new DOMException("aborted", "AbortError"));
          if (req.signal.aborted) fail();
          else req.signal.addEventListener("abort", fail, { once: true });
        }),
    );
    const pending = client.compile({ source: TEX }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    const error = (await pending.catch((e: unknown) => e)) as LatexApiError;
    expect(error).toBeInstanceOf(LatexApiError);
    expect(error.code).toBe("network_error");
  });
});

describe("problem details", () => {
  it("throws LatexApiError with the parsed problem on 401", async () => {
    const { client } = api(() => problem(401, "unauthorized"), { apiKey: undefined });
    const error = await client.compile({ source: TEX }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LatexApiError);
    const e = error as LatexApiError;
    expect(e.status).toBe(401);
    expect(e.code).toBe("unauthorized");
    expect(e.problem?.detail).toBe("detail for unauthorized");
    expect(e.message).toContain("unauthorized");
    expect(e.retryable).toBe(false);
  });

  it("throws CompileFailedError with diagnostics on 422", async () => {
    const diagnostics = [
      { severity: "error", message: "Undefined control sequence.", file: "./main.tex", line: 3 },
      { severity: "warning", message: "Overfull \\hbox", file: "./main.tex", line: 9 },
    ];
    const { client } = api(() =>
      problem(422, "compile_failed", {
        jobId: "job-1",
        diagnostics,
        errors: 1,
        warnings: 1,
        logUrl: "https://api.test/v1/jobs/job-1/log",
      }),
    );
    const error = await client.compile({ source: "\\foo" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompileFailedError);
    expect(error).toBeInstanceOf(LatexApiError);
    const e = error as CompileFailedError;
    expect(e.status).toBe(422);
    expect(e.code).toBe("compile_failed");
    expect(e.jobId).toBe("job-1");
    expect(e.diagnostics).toEqual(diagnostics);
    expect(e.logUrl).toBe("https://api.test/v1/jobs/job-1/log");
    expect(e.errors).toBe(1);
    expect(e.warnings).toBe(1);
  });

  it("parses retry-after on 429", async () => {
    const { client } = api(() => problem(429, "rate_limited", {}, { "retry-after": "17" }));
    const error = (await client.compile({ source: TEX }).catch((e: unknown) => e)) as LatexApiError;
    expect(error.code).toBe("rate_limited");
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(17);
    expect(error.retryable).toBe(true);
  });

  it("flags 2xx responses whose body cannot be parsed", async () => {
    const { client } = api(() => pdfResponse({ "content-type": "application/pdf" }));
    const error = (await client
      .compile({ source: TEX }, { accept: "json" })
      .catch((e: unknown) => e)) as LatexApiError;
    expect(error).toBeInstanceOf(LatexApiError);
    expect(error.status).toBe(200);
    expect(error.code).toBe("unexpected_response");
    expect(error.message).toMatch(/Unexpected 200 response/);
  });

  it("wraps non-problem bodies and network failures", async () => {
    const { client } = api(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const error = (await client.limits().catch((e: unknown) => e)) as LatexApiError;
    expect(error.status).toBe(502);
    expect(error.code).toBe("http_502");
    expect(error.problem).toBeUndefined();

    const offline = api(() => {
      throw new TypeError("fetch failed");
    });
    const netError = (await offline.client.limits().catch((e: unknown) => e)) as LatexApiError;
    expect(netError.status).toBe(0);
    expect(netError.code).toBe("network_error");
    expect(netError.message).toBe("fetch failed");
  });
});

describe("jobs", () => {
  it("creates, gets, cancels and downloads artifacts", async () => {
    const job = makeJob();
    const { client, calls } = api((req) => {
      if (req.method === "POST") return json({ job }, 202);
      if (req.method === "DELETE") return json({ job: { ...job, status: "cancelled" } });
      if (req.url.pathname.endsWith("/pdf")) return pdfResponse();
      if (req.url.pathname.endsWith("/log")) {
        return new Response("This is pdfTeX", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      return json({ job: { ...job, status: "running" } });
    });
    const created = await client.jobs.create({ files: [{ path: "main.tex", content: TEX }] });
    expect(created.id).toBe(job.id);
    expect(calls[0]!.url.pathname).toBe("/v1/jobs");
    expect((await client.jobs.get(job.id)).status).toBe("running");
    expect(calls[1]!.url.pathname).toBe(`/v1/jobs/${job.id}`);
    expect((await client.jobs.cancel(job.id)).status).toBe("cancelled");
    expect(calls[2]!.method).toBe("DELETE");
    expect(await client.jobs.pdf(job.id)).toEqual(PDF);
    expect(await client.jobs.log(job.id)).toBe("This is pdfTeX");
  });

  it("surfaces 404 as job_not_found", async () => {
    const { client } = api(() => problem(404, "job_not_found"));
    const error = (await client.jobs.get("nope").catch((e: unknown) => e)) as LatexApiError;
    expect(error.status).toBe(404);
    expect(error.code).toBe("job_not_found");
  });

  it("streams events over SSE", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const { client, calls } = api(() =>
      sseResponse([
        `: comment\n`,
        frame("queued", { type: "queued", jobId: id, at: "t0" }, 1),
        `event: log\ndata: {"type":"log","jobId":"${id}","at":"t1",\ndata: "chunk":"line one"}\n\n`,
        "event: ping\ndata: 2026-10-22T00:00:00.000Z\n\n",
        frame("done", { type: "done", jobId: id, at: "t2", status: "succeeded" }, 3),
        frame("queued", { type: "queued", jobId: id, at: "never" }),
      ]),
    );
    const events: JobEvent[] = [];
    for await (const event of client.jobs.events(id)) events.push(event);
    expect(events.map((e) => e.type)).toEqual(["queued", "log", "ping", "done"]);
    expect(events[1]).toEqual({ type: "log", jobId: id, at: "t1", chunk: "line one" });
    expect(calls[0]!.headers.get("accept")).toBe("text/event-stream");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer secret");
  });

  it("waits via SSE and resolves with the final job", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    let gets = 0;
    const { client, calls } = api((req) => {
      if (req.url.pathname.endsWith("/events")) {
        return sseResponse([
          frame("running", { type: "running", jobId: id, at: "t1" }),
          frame("log", { type: "log", jobId: id, at: "t1", chunk: "Output written" }),
          frame("done", { type: "done", jobId: id, at: "t2", status: "succeeded" }),
        ]);
      }
      gets += 1;
      return json({ job: makeJob({ status: gets === 1 ? "queued" : "succeeded" }) });
    });
    const seen: string[] = [];
    const job = await client.jobs.wait(id, { onEvent: (e) => seen.push(e.type), pollMs: 50 });
    expect(job.status).toBe("succeeded");
    expect(seen).toEqual(["running", "log", "done"]);
    expect(calls.filter((c) => c.url.pathname.endsWith("/events"))).toHaveLength(1);
    expect(gets).toBe(2);
  });

  it("falls back to polling when the event stream is unavailable", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const statuses = ["queued", "running", "running", "failed"] as const;
    let gets = 0;
    const { client, calls } = api((req) => {
      if (req.url.pathname.endsWith("/events")) return new Response("nope", { status: 502 });
      const status = statuses[Math.min(gets, statuses.length - 1)]!;
      gets += 1;
      return json({
        job: makeJob({
          status,
          error: status === "failed" ? { reason: "compile_failed", message: "boom" } : undefined,
        }),
      });
    });
    const seen: JobEvent[] = [];
    const job = await client.jobs.wait(id, { pollMs: 10, onEvent: (e) => seen.push(e) });
    expect(job.status).toBe("failed");
    expect(seen.map((e) => e.type)).toEqual(["running", "error"]);
    expect(seen.at(-1)).toMatchObject({ type: "error", status: "failed", message: "boom" });
    expect(calls.filter((c) => c.url.pathname.endsWith("/events"))).toHaveLength(1);
  });

  it("polls when the stream closes without a terminal event", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    let gets = 0;
    const { client } = api((req) => {
      if (req.url.pathname.endsWith("/events")) {
        return sseResponse([frame("running", { type: "running", jobId: id, at: "t1" })]);
      }
      gets += 1;
      return json({ job: makeJob({ status: gets >= 3 ? "succeeded" : "running" }) });
    });
    const job = await client.jobs.wait(id, { pollMs: 10 });
    expect(job.status).toBe("succeeded");
    expect(gets).toBeGreaterThanOrEqual(3);
  });

  it("times out and honours abort signals while waiting", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const { client } = api((req) => {
      if (req.url.pathname.endsWith("/events")) return new Response("nope", { status: 500 });
      return json({ job: makeJob({ status: "running" }) });
    });
    const timeout = (await client.jobs
      .wait(id, { pollMs: 10, timeoutMs: 60 })
      .catch((e: unknown) => e)) as LatexApiError;
    expect(timeout).toBeInstanceOf(LatexApiError);
    expect(timeout.code).toBe("wait_timeout");

    const controller = new AbortController();
    const pending = client.jobs.wait(id, { pollMs: 10, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const aborted = (await pending.catch((e: unknown) => e)) as LatexApiError;
    expect(aborted.code).toBe("aborted");
  });

  it("does not poll when the job is unknown", async () => {
    const { client, calls } = api(() => problem(404, "job_not_found"));
    await expect(client.jobs.wait("missing", { pollMs: 10 })).rejects.toMatchObject({
      status: 404,
    });
    expect(calls).toHaveLength(1);
  });
});

describe("templates and meta", () => {
  const template = {
    id: "ieee-conference",
    name: "IEEE conference paper",
    description: "Two-column IEEEtran paper",
    category: "paper",
    engine: "pdflatex",
    entrypoint: "main.tex",
    tags: ["ieee", "paper"],
    license: "LPPL-1.3c",
    variables: [],
    files: [{ path: "main.tex", size: 1234 }],
    links: {
      self: "https://api.test/v1/templates/ieee-conference",
      archive: "https://api.test/v1/templates/ieee-conference/archive",
      preview: "https://api.test/v1/templates/ieee-conference/preview",
      compile: "https://api.test/v1/templates/ieee-conference/compile",
    },
  };

  it("lists and reads templates without sending credentials", async () => {
    const { client, calls } = api((req) => {
      if (req.url.pathname === "/v1/templates") return json({ templates: [template] });
      if (req.url.pathname === "/v1/templates/ieee-conference") return json({ template });
      if (req.url.pathname.endsWith("/files/sections%2Fintro.tex")) {
        return new Response("intro", { headers: { "content-type": "text/plain" } });
      }
      if (req.url.pathname.endsWith("/archive")) {
        return new Response(zipSync({ "ieee-conference/main.tex": new Uint8Array([1]) }), {
          headers: { "content-type": "application/zip" },
        });
      }
      return problem(404, "template_not_found");
    });
    const list = await client.templates.list();
    expect(list.map((t) => t.id)).toEqual(["ieee-conference"]);
    expect(calls[0]!.headers.get("authorization")).toBeNull();
    expect((await client.templates.get("ieee-conference")).name).toBe(template.name);
    expect(
      new TextDecoder().decode(
        await client.templates.file("ieee-conference", "sections/intro.tex"),
      ),
    ).toBe("intro");
    expect((await client.templates.archive("ieee-conference")).byteLength).toBeGreaterThan(20);
    await expect(client.templates.get("nope")).rejects.toMatchObject({
      code: "template_not_found",
    });
  });

  it("compiles templates with overrides and creates template jobs", async () => {
    const { client, calls } = api((req) =>
      req.url.pathname.endsWith("/jobs") ? json({ job: makeJob() }, 202) : pdfResponse(),
    );
    const result = await client.templates.compile("ieee-conference", {
      files: [{ path: "main.tex", content: "override" }],
      engine: "xelatex",
    });
    expect(result.pdf).toEqual(PDF);
    expect(calls[0]!.url.pathname).toBe("/v1/templates/ieee-conference/compile");
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    expect(calls[0]!.json()).toEqual({
      files: [{ path: "main.tex", content: "override" }],
      engine: "xelatex",
    });

    const job = await client.templates.createJob("ieee-conference");
    expect(job.id).toBeTruthy();
    expect(calls[1]!.url.pathname).toBe("/v1/templates/ieee-conference/jobs");
    expect(calls[1]!.json()).toEqual({});
  });

  it("reads limits, stats and health", async () => {
    const { client, calls } = api((req) => {
      if (req.url.pathname === "/v1/limits") return json({ maxFiles: 500, engines: ["pdflatex"] });
      if (req.url.pathname === "/v1/stats") return json({ queueDepth: 1 });
      return json({ status: "degraded", version: "0.1.0", checks: { docker: { ok: false } } }, 503);
    });
    expect((await client.limits()).maxFiles).toBe(500);
    expect(calls[0]!.headers.get("authorization")).toBeNull();
    expect((await client.stats()).queueDepth).toBe(1);
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer secret");
    const health = await client.health();
    expect(health.status).toBe("degraded");
    expect(calls[2]!.url.pathname).toBe("/health");
  });

  it("uses the public instance and env defaults", () => {
    const client = new LatexApi({ fetch: stubFetch(() => json({})).fetch });
    expect(client.baseUrl).toBe(
      process.env.LATEX_API_URL?.replace(/\/+$/, "") ?? "https://latex-api.crafter.run",
    );
  });
});

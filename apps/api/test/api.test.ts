import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auth, TEX, testContainer } from "./helpers";

type Ctx = Awaited<ReturnType<typeof testContainer>>;

describe("HTTP API", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await testContainer();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it("serves openapi.json, health and limits without auth", async () => {
    const doc = await ctx.app.request("/openapi.json");
    expect(doc.status).toBe(200);
    const json = (await doc.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(json.openapi).toBe("3.1.0");
    expect(Object.keys(json.paths)).toEqual(
      expect.arrayContaining([
        "/v1/compile",
        "/v1/jobs",
        "/v1/jobs/{id}",
        "/v1/templates",
        "/v1/limits",
        "/health",
      ]),
    );
    const health = await ctx.app.request("/health");
    expect(health.status).toBe(200);
    const limits = await ctx.app.request("/v1/limits");
    expect(limits.status).toBe(200);
    expect(((await limits.json()) as { engines: string[] }).engines).toContain("lualatex");
  });

  it("rejects missing or bad keys with a problem document", async () => {
    const res = await ctx.app.request("/v1/compile", {
      method: "POST",
      body: TEX,
      headers: { "content-type": "text/x-tex" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as { code: string; type: string };
    expect(body.code).toBe("unauthorized");
    const bad = await ctx.app.request("/v1/stats", { headers: { authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
  });

  it("compiles raw text/x-tex and returns a PDF", async () => {
    const res = await ctx.app.request("/v1/compile?engine=xelatex", {
      method: "POST",
      body: TEX,
      headers: { ...auth, "content-type": "text/x-tex" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-job-id")).toMatch(/[0-9a-f-]{36}/);
    expect(res.headers.get("x-compile-cached")).toBe("false");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    expect(ctx.compiler.calls[0]?.workspace.engine).toBe("xelatex");
  });

  it("compiles JSON projects and returns the envelope when asked", async () => {
    const res = await ctx.app.request("/v1/compile", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        files: [
          { path: "main.tex", content: "% !TEX program = lualatex\n\\input{a}" },
          { path: "a.tex", content: "SGk=", encoding: "base64" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const { job } = (await res.json()) as {
      job: { status: string; engine: string; result: { pdfUrl: string; logUrl: string } };
    };
    expect(job.status).toBe("succeeded");
    expect(job.engine).toBe("lualatex");
    expect(job.result.pdfUrl).toMatch(/^http:\/\/api\.test\/v1\/jobs\/.+\/pdf$/);

    const pdf = await ctx.app.request(job.result.pdfUrl.replace("http://api.test", ""), {
      headers: auth,
    });
    expect(pdf.status).toBe(200);
    const log = await ctx.app.request(job.result.logUrl.replace("http://api.test", ""), {
      headers: auth,
    });
    expect(await log.text()).toContain("Output written");

    const second = await ctx.app.request("/v1/compile", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        files: [
          { path: "main.tex", content: "% !TEX program = lualatex\n\\input{a}" },
          { path: "a.tex", content: "Hi" },
        ],
      }),
    });
    expect(second.headers.get("x-compile-cached")).toBe("true");
  });

  it("accepts multipart files and zip uploads", async () => {
    const form = new FormData();
    form.append("files", new Blob([TEX]), "main.tex");
    form.append("files", new Blob(["x"]), "sections/intro.tex");
    form.append("engine", "pdflatex");
    const multi = await ctx.app.request("/v1/compile", {
      method: "POST",
      headers: { ...auth, accept: "application/json" },
      body: form,
    });
    expect(multi.status).toBe(200);
    expect(ctx.compiler.calls.at(-1)?.workspace.entrypoint).toBe("main.tex");

    const zip = zipSync({
      "proj/main.tex": new TextEncoder().encode(TEX),
      "proj/refs.bib": new Uint8Array(),
    });
    const zipped = await ctx.app.request("/v1/compile?entrypoint=main.tex", {
      method: "POST",
      headers: { ...auth, "content-type": "application/zip" },
      body: zip,
    });
    expect(zipped.status).toBe(200);
    expect(zipped.headers.get("content-type")).toBe("application/pdf");

    const zipForm = new FormData();
    zipForm.append("project", new Blob([zip]), "project.zip");
    const zipMulti = await ctx.app.request("/v1/compile", {
      method: "POST",
      headers: auth,
      body: zipForm,
    });
    expect(zipMulti.status).toBe(200);
  });

  it("returns 422 problem details with diagnostics on LaTeX errors", async () => {
    ctx.compiler.behaviour = () => ({
      exitCode: 12,
      timedOut: false,
      log: "(./main.tex\n./main.tex:1: Undefined control sequence.\nl.1 \\foo\n)",
      stdout: "",
      durationMs: 3,
    });
    const res = await ctx.app.request("/v1/compile", {
      method: "POST",
      body: "\\foo",
      headers: { ...auth, "content-type": "text/x-tex" },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      code: string;
      diagnostics: Array<{ line: number }>;
      logUrl: string;
      jobId: string;
    };
    expect(body.code).toBe("compile_failed");
    expect(body.diagnostics[0]?.line).toBe(1);
    expect(body.logUrl).toContain(body.jobId);
  });

  it("validates bodies and limits", async () => {
    const res = await ctx.app.request("/v1/compile", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ files: [] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_request");

    const traversal = await ctx.app.request("/v1/compile", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ files: [{ path: "../x.tex", content: "" }] }),
    });
    expect(traversal.status).toBe(400);
    expect(((await traversal.json()) as { code: string }).code).toBe("invalid_project");

    const big = await ctx.app.request("/v1/compile", {
      method: "POST",
      headers: { ...auth, "content-type": "text/x-tex", "content-length": String(10 ** 9) },
      body: TEX,
    });
    expect(big.status).toBe(413);
  });

  it("runs async jobs, streams events and downloads artifacts", async () => {
    const created = await ctx.app.request("/v1/jobs", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "main.tex", content: TEX }],
        options: { timeoutMs: 1000 },
      }),
    });
    expect(created.status).toBe(202);
    const { job } = (await created.json()) as {
      job: { id: string; status: string; links: { self: string; events: string } };
    };
    expect(created.headers.get("location")).toBe(job.links.self);
    expect(["queued", "running", "succeeded"]).toContain(job.status);

    const events = await ctx.app.request(`/v1/jobs/${job.id}/events`, { headers: auth });
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const text = await events.text();
    expect(text).toContain("event: done");

    const got = await ctx.app.request(`/v1/jobs/${job.id}`, { headers: auth });
    const body = (await got.json()) as { job: { status: string; result: { pages: number } } };
    expect(body.job.status).toBe("succeeded");
    expect(body.job.result.pages).toBe(1);

    const hidden = await ctx.app.request(`/v1/jobs/${job.id}`, {
      headers: { authorization: "Bearer other-secret" },
    });
    expect(hidden.status).toBe(404);
    const missing = await ctx.app.request("/v1/jobs/00000000-0000-4000-8000-000000000000", {
      headers: auth,
    });
    expect(missing.status).toBe(404);
    const cancel = await ctx.app.request(`/v1/jobs/${job.id}`, { method: "DELETE", headers: auth });
    expect(cancel.status).toBe(409);
  });

  it("lists, serves and compiles templates", async () => {
    const list = await ctx.app.request("/v1/templates");
    expect(list.status).toBe(200);
    const { templates } = (await list.json()) as {
      templates: Array<{ id: string; files: Array<{ path: string }> }>;
    };
    expect(templates.map((t) => t.id)).toEqual(["hello"]);
    expect(templates[0]!.files.map((f) => f.path)).toEqual(["main.tex", "body.tex"]);

    const file = await ctx.app.request("/v1/templates/hello/files/body.tex");
    expect(await file.text()).toBe("Hello");
    const archive = await ctx.app.request("/v1/templates/hello/archive");
    expect(archive.headers.get("content-type")).toBe("application/zip");
    expect((await archive.arrayBuffer()).byteLength).toBeGreaterThan(50);
    expect((await ctx.app.request("/v1/templates/nope")).status).toBe(404);

    const compiled = await ctx.app.request("/v1/templates/hello/compile", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ files: [{ path: "body.tex", content: "Changed" }] }),
    });
    expect(compiled.status).toBe(200);
    const { job } = (await compiled.json()) as { job: { templateId: string } };
    expect(job.templateId).toBe("hello");
    const ws = ctx.compiler.calls.at(-1)!.workspace;
    expect(ws.entrypoint).toBe("main.tex");

    const preview = await ctx.app.request("/v1/templates/hello/preview");
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("application/pdf");
  });

  it("rate limits the demo endpoint per IP", async () => {
    ctx.container.config.limits.demoRateLimitPerMinute = 2;
    const call = () =>
      ctx.app.request("/v1/demo/compile", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({ source: TEX }),
      });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const third = await call();
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBeTruthy();
  });

  it("exposes stats to authenticated keys", async () => {
    const res = await ctx.app.request("/v1/stats", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { compilerVersion: string; queueDepth: number };
    expect(body.compilerVersion).toBe("fake-compiler");
  });
});

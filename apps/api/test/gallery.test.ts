import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminSession, auth, bobSession, session, TEX, testContainer } from "./helpers";

type Ctx = Awaited<ReturnType<typeof testContainer>>;
const json = { "content-type": "application/json" };

interface Item {
  id: string;
  name: string;
  stars: number;
  starred: boolean;
  tags: string[];
  hidden: boolean;
  author: { name: string };
  license: { id: string };
  links: { archive: string; thumbnail: string };
}

function body(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "Tesis UNTELS",
    description: "Plantilla de tesis universitaria en español con normas APA 7 y capítulos.",
    category: "report",
    tags: ["Tesis", "español", "apa"],
    acceptLicense: true,
    files: [{ path: "main.tex", content: TEX }],
    ...overrides,
  });
}

describe("public template gallery", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await testContainer();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  async function publish(headers = session, overrides: Record<string, unknown> = {}) {
    const res = await ctx.app.request("/v1/gallery", {
      method: "POST",
      headers: { ...headers, ...json },
      body: body(overrides),
    });
    return { res, json: (await res.json()) as { template: Item; code?: string } };
  }

  it("publishes a compiling template and serves its files", async () => {
    const { res, json: out } = await publish();
    expect(res.status).toBe(201);
    expect(out.template).toMatchObject({
      name: "Tesis UNTELS",
      tags: ["tesis", "espanol", "apa"],
      license: { id: "CC-BY-4.0" },
      stars: 0,
      hidden: false,
    });
    expect(out.template.id).toMatch(/^gt_/);

    const list = (await (await ctx.app.request("/v1/gallery")).json()) as {
      items: Item[];
      total: number;
    };
    expect(list.total).toBe(1);

    const zip = await ctx.app.request(`/v1/gallery/${out.template.id}/archive`);
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    const thumb = await ctx.app.request(`/v1/gallery/${out.template.id}/thumbnail`);
    expect(thumb.headers.get("content-type")).toBe("image/png");
    const detail = (await (await ctx.app.request(`/v1/gallery/${out.template.id}`)).json()) as {
      template: { downloads: number };
    };
    expect(detail.template.downloads).toBe(1);
  });

  it("accepts a multipart zip upload with comma-separated tags", async () => {
    const form = new FormData();
    form.append(
      "project",
      new Blob([zipSync({ "main.tex": new TextEncoder().encode(TEX) })], {
        type: "application/zip",
      }),
      "project.zip",
    );
    form.append("name", "Paper corto");
    form.append("description", "Un artículo corto de dos páginas con bibliografía.");
    form.append("category", "paper");
    form.append("tags", "paper, corto");
    form.append("acceptLicense", "true");
    const res = await ctx.app.request("/v1/gallery", {
      method: "POST",
      headers: session,
      body: form,
    });
    const out = (await res.json()) as { template: Item; detail?: string };
    expect(res.status, out.detail).toBe(201);
    expect(out.template.tags).toEqual(["paper", "corto"]);
  });

  it("rejects templates that do not compile, without a license, or from non-users", async () => {
    ctx.compiler.behaviour = () => ({
      exitCode: 12,
      timedOut: false,
      log: "(./main.tex\n./main.tex:1: Undefined control sequence.\nl.1 \\foo\n)",
      stdout: "",
      durationMs: 5,
    });
    const broken = await publish();
    expect(broken.res.status).toBe(422);
    expect(broken.json.code).toBe("compile_failed");

    expect((await publish(session, { acceptLicense: false })).res.status).toBe(400);
    expect((await publish(auth)).res.status).toBe(403);
    const total = (await (await ctx.app.request("/v1/gallery")).json()) as { total: number };
    expect(total.total).toBe(0);
  });

  it("stars, sorts by stars and reports starred flags to the caller", async () => {
    const a = (await publish(session, { name: "Plantilla A" })).json.template;
    const b = (await publish(session, { name: "Plantilla B" })).json.template;
    const star = await ctx.app.request(`/v1/gallery/${b.id}/star`, {
      method: "PUT",
      headers: bobSession,
    });
    expect(await star.json()).toEqual({ stars: 1, starred: true });
    // Starring twice does not double count.
    await ctx.app.request(`/v1/gallery/${b.id}/star`, { method: "PUT", headers: bobSession });

    const asBob = (await (
      await ctx.app.request("/v1/gallery?sort=stars", { headers: bobSession })
    ).json()) as { items: Item[] };
    expect(asBob.items.map((t) => t.id)).toEqual([b.id, a.id]);
    expect(asBob.items[0]).toMatchObject({ stars: 1, starred: true });

    const anon = (await (await ctx.app.request("/v1/gallery")).json()) as { items: Item[] };
    expect(anon.items[0]?.starred).toBe(false);

    const mine = (await (
      await ctx.app.request("/v1/gallery?starred=true", { headers: bobSession })
    ).json()) as { total: number };
    expect(mine.total).toBe(1);

    const unstar = await ctx.app.request(`/v1/gallery/${b.id}/star`, {
      method: "DELETE",
      headers: bobSession,
    });
    expect(await unstar.json()).toEqual({ stars: 0, starred: false });
  });

  it("searches by keyword and filters by tags", async () => {
    await publish(session, {
      name: "Currículum moderno",
      description: "CV de una página con foto, habilidades y experiencia laboral.",
      category: "cv",
      tags: ["cv", "moderno"],
    });
    await publish(session, {
      name: "Póster científico",
      description: "Póster A0 con gráficos y tres columnas.",
      category: "poster",
      tags: ["poster"],
    });

    const q = (await (await ctx.app.request("/v1/gallery?q=curriculum")).json()) as {
      items: Item[];
      total: number;
    };
    expect(q.total).toBe(1);
    expect(q.items[0]?.name).toBe("Currículum moderno");

    // Function words ("de") are not keyword matches.
    const unrelated = (await (
      await ctx.app.request(`/v1/gallery?q=${encodeURIComponent("receta de cocina")}`)
    ).json()) as { total: number };
    expect(unrelated.total).toBe(0);

    const tagged = (await (await ctx.app.request("/v1/gallery?tags=poster")).json()) as {
      items: Item[];
    };
    expect(tagged.items.map((t) => t.name)).toEqual(["Póster científico"]);

    const tags = (await (await ctx.app.request("/v1/gallery/tags")).json()) as {
      tags: Array<{ tag: string; count: number }>;
    };
    expect(tags.tags.map((t) => t.tag)).toEqual(expect.arrayContaining(["cv", "poster"]));
  });

  it("lets only the author edit and delete, and moderators hide", async () => {
    const t = (await publish()).json.template;
    const patch = (headers: Record<string, string>, data: unknown) =>
      ctx.app.request(`/v1/gallery/${t.id}`, {
        method: "PATCH",
        headers: { ...headers, ...json },
        body: JSON.stringify(data),
      });

    expect((await patch(bobSession, { name: "Robada" })).status).toBe(403);
    const edited = await patch(session, { tags: ["thesis"] });
    expect(((await edited.json()) as { template: Item }).template.tags).toEqual(["thesis"]);

    expect((await patch(session, { hidden: true })).status).toBe(403);
    expect((await patch(adminSession, { hidden: true })).status).toBe(200);
    // Hidden: gone for the public, still visible to its author.
    expect((await ctx.app.request(`/v1/gallery/${t.id}`)).status).toBe(404);
    expect((await ctx.app.request(`/v1/gallery/${t.id}`, { headers: session })).status).toBe(200);

    const del = (headers: Record<string, string>) =>
      ctx.app.request(`/v1/gallery/${t.id}`, { method: "DELETE", headers });
    expect((await del(bobSession)).status).toBe(404);
    expect((await del(session)).status).toBe(204);
    expect((await ctx.app.request(`/v1/gallery/${t.id}`, { headers: session })).status).toBe(404);
  });

  it("never compares vectors from another model and re-indexes them", async () => {
    await publish();
    const deps = ctx.container.galleryDeps;
    const original = deps.embedder;
    // A different model with the same dimensions: old vectors must not be used for ranking.
    deps.embedder = {
      model: "other-model",
      embedPassage: (t) => original.embedPassage(t),
      embedQuery: (t) => original.embedQuery(t),
    };
    expect(await ctx.container.useCases.reindexGallery.execute()).toBe(1);
    expect(await ctx.container.useCases.reindexGallery.execute()).toBe(0);
    const [row] = await deps.gallery.candidates({});
    expect(row?.embeddingModel).toBe("other-model");
  });

  it("records one report per user and refuses self-reports", async () => {
    const t = (await publish()).json.template;
    const report = (headers: Record<string, string>) =>
      ctx.app.request(`/v1/gallery/${t.id}/report`, {
        method: "POST",
        headers: { ...headers, ...json },
        body: JSON.stringify({ reason: "Contenido copiado de otra plantilla" }),
      });
    expect((await report(bobSession)).status).toBe(200);
    expect((await report(session)).status).toBe(409);
    const asAdmin = (await (
      await ctx.app.request(`/v1/gallery/${t.id}`, { headers: adminSession })
    ).json()) as { template: { reports: number; canModerate: boolean } };
    expect(asAdmin.template).toMatchObject({ reports: 1, canModerate: true });
  });
});

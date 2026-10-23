import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIgnoreMatcher, listDirectoryFiles, packDirectory, parseSse } from "../src/index";

describe("createIgnoreMatcher", () => {
  const ignored = createIgnoreMatcher([
    "*.aux",
    "build/",
    "/root-only.tex",
    "figures/**/*.tmp",
    "!keep.aux",
    "docs/*.md",
    "#comment",
    "",
  ]);

  it("matches gitignore-like globs", () => {
    expect(ignored("main.aux")).toBe(true);
    expect(ignored("sections/intro.aux")).toBe(true);
    expect(ignored("keep.aux")).toBe(false);
    expect(ignored("main.tex")).toBe(false);
    expect(ignored("build", true)).toBe(true);
    expect(ignored("build", false)).toBe(false);
    expect(ignored("src/build", true)).toBe(true);
    expect(ignored("root-only.tex")).toBe(true);
    expect(ignored("sub/root-only.tex")).toBe(false);
    expect(ignored("figures/a/b/c.tmp")).toBe(true);
    expect(ignored("figures/c.tmp")).toBe(true);
    expect(ignored("other/c.tmp")).toBe(false);
    expect(ignored("docs/readme.md")).toBe(true);
    expect(ignored("docs/deep/readme.md")).toBe(false);
    expect(ignored("#comment")).toBe(false);
  });

  it("normalizes Windows separators", () => {
    expect(ignored("sections\\intro.aux")).toBe(true);
  });
});

describe("packDirectory", () => {
  let dir: string;
  const write = async (rel: string, content: string | Uint8Array) => {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  };
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "latex-sdk-pack-"));
    await write("main.tex", "\\input{sections/intro}");
    await write("sections/intro.tex", "Hi");
    await write("refs.bib", "@article{a}");
    await write("figures/logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    await write("main.aux", "junk");
    await write("main.log", "junk");
    await write("main.synctex.gz", "junk");
    await write("build/out.pdf", "junk");
    await write(".git/HEAD", "ref");
    await write("node_modules/x/index.js", "junk");
    await write("drafts/old.tex", "old");
    await write("secret.txt", "shh");
    await write(".latexapiignore", "# ignore drafts\ndrafts/\nsecret.txt\n");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("zips the project honoring defaults, .latexapiignore and extra patterns", async () => {
    const files = await listDirectoryFiles(dir, { ignore: ["build/"] });
    expect(files.map((f) => f.path)).toEqual([
      "figures/logo.png",
      "main.tex",
      "refs.bib",
      "sections/intro.tex",
    ]);

    const seen: string[] = [];
    const zip = await packDirectory(dir, { ignore: ["build/"], onFile: (p) => seen.push(p) });
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual([
      "figures/logo.png",
      "main.tex",
      "refs.bib",
      "sections/intro.tex",
    ]);
    expect(new TextDecoder().decode(entries["sections/intro.tex"])).toBe("Hi");
    expect(entries["figures/logo.png"]).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(seen).toHaveLength(4);
  });

  it("honors the root .gitignore unless disabled, and .latexapiignore can re-include", async () => {
    await write("literatura/pdfs/paper.pdf", "big");
    await write(".gitignore", "literatura/pdfs/\nrefs.bib\n");
    let paths = (await listDirectoryFiles(dir)).map((f) => f.path);
    expect(paths).not.toContain("literatura/pdfs/paper.pdf");
    expect(paths).not.toContain("refs.bib");
    expect(paths).toContain(".gitignore");

    await write(".latexapiignore", "drafts/\nsecret.txt\n!refs.bib\n");
    paths = (await listDirectoryFiles(dir)).map((f) => f.path);
    expect(paths).toContain("refs.bib");

    paths = (await listDirectoryFiles(dir, { gitignore: false })).map((f) => f.path);
    expect(paths).toContain("literatura/pdfs/paper.pdf");
  });

  it("fails on empty or missing directories", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "latex-sdk-empty-"));
    await expect(packDirectory(empty)).rejects.toThrow(/no files/);
    await expect(packDirectory(path.join(dir, "missing"))).rejects.toThrow(/not a directory/);
    await fs.rm(empty, { recursive: true, force: true });
  });
});

describe("parseSse", () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  }

  it("handles split chunks, CRLF, comments, multi-line data and retry", async () => {
    const messages = [];
    const stream = streamOf([
      "event: que",
      'ued\r\ndata: {"a":1}\r\n\r\n',
      ": keep-alive\n\nretry: 5000\nid: 7\ndata: one\ndata: two\n\n",
      "data: last without blank line",
    ]);
    for await (const m of parseSse(stream)) messages.push(m);
    expect(messages).toEqual([
      { event: "queued", data: '{"a":1}' },
      { event: "message", data: "one\ntwo", id: "7", retry: 5000 },
      { event: "message", data: "last without blank line", id: "7", retry: 5000 },
    ]);
  });

  it("ignores frames without data", async () => {
    const messages = [];
    for await (const m of parseSse(streamOf(["event: ping\n\n", "data: x\n\n"]))) messages.push(m);
    expect(messages).toEqual([{ event: "message", data: "x" }]);
  });
});

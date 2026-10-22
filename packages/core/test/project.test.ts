import { describe, expect, it } from "vitest";
import {
  createProject,
  DEFAULT_LIMITS,
  detectEngineFromSource,
  InvalidProjectError,
  normalizeProjectPath,
  PayloadTooLargeError,
  projectHash,
} from "../src/index.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("normalizeProjectPath", () => {
  it("normalizes separators and leading ./", () => {
    expect(normalizeProjectPath("./sections\\intro.tex")).toBe("sections/intro.tex");
    expect(normalizeProjectPath("a//b/./c.tex")).toBe("a/b/c.tex");
  });

  it("rejects traversal and absolute paths", () => {
    expect(() => normalizeProjectPath("../etc/passwd")).toThrow(InvalidProjectError);
    expect(() => normalizeProjectPath("a/../../b")).toThrow(InvalidProjectError);
    expect(() => normalizeProjectPath("/etc/passwd")).toThrow(InvalidProjectError);
    expect(() => normalizeProjectPath("C:\\Windows\\x")).toThrow(InvalidProjectError);
    expect(() => normalizeProjectPath("a\u0000b")).toThrow(InvalidProjectError);
    expect(() => normalizeProjectPath("")).toThrow(InvalidProjectError);
  });
});

describe("detectEngineFromSource", () => {
  it("reads magic comments", () => {
    expect(detectEngineFromSource("% !TEX program = xelatex\n\\documentclass{article}")).toBe(
      "xelatex",
    );
    expect(detectEngineFromSource("%!TEX TS-program = lualatex")).toBe("lualatex");
    expect(detectEngineFromSource("% !TeX program = pdflatex")).toBe("pdflatex");
    expect(detectEngineFromSource("\\documentclass{article}")).toBeUndefined();
  });
});

describe("createProject", () => {
  it("guesses main.tex and defaults to pdflatex", () => {
    const project = createProject(
      {
        files: [
          { path: "refs.bib", content: enc("") },
          { path: "main.tex", content: enc("\\documentclass{article}") },
        ],
      },
      DEFAULT_LIMITS,
    );
    expect(project.entrypoint).toBe("main.tex");
    expect(project.engine).toBe("pdflatex");
    expect(project.engineExplicit).toBe(false);
    expect(project.files.map((f) => f.path)).toEqual(["main.tex", "refs.bib"]);
  });

  it("uses the single tex file as entrypoint and the magic comment as engine", () => {
    const project = createProject(
      { files: [{ path: "cv.tex", content: enc("% !TEX program = lualatex\n") }] },
      DEFAULT_LIMITS,
    );
    expect(project.entrypoint).toBe("cv.tex");
    expect(project.engine).toBe("lualatex");
  });

  it("fails when the entrypoint is ambiguous", () => {
    expect(() =>
      createProject(
        {
          files: [
            { path: "a.tex", content: enc("") },
            { path: "b.tex", content: enc("") },
          ],
        },
        DEFAULT_LIMITS,
      ),
    ).toThrow(/entrypoint/);
  });

  it("validates entrypoint membership, engine names and duplicates", () => {
    expect(() =>
      createProject(
        { files: [{ path: "main.tex", content: enc("") }], entrypoint: "x.tex" },
        DEFAULT_LIMITS,
      ),
    ).toThrow(InvalidProjectError);
    expect(() =>
      createProject(
        { files: [{ path: "main.tex", content: enc("") }], engine: "tex" },
        DEFAULT_LIMITS,
      ),
    ).toThrow(InvalidProjectError);
    expect(() =>
      createProject(
        {
          files: [
            { path: "main.tex", content: enc("") },
            { path: "./Main.tex", content: enc("") },
          ],
        },
        DEFAULT_LIMITS,
      ),
    ).toThrow(/Duplicate/);
  });

  it("enforces limits", () => {
    const limits = { ...DEFAULT_LIMITS, maxFiles: 1, maxUnpackedBytes: 10, maxFileBytes: 10 };
    expect(() =>
      createProject(
        {
          files: [
            { path: "main.tex", content: enc("") },
            { path: "b.tex", content: enc("") },
          ],
        },
        limits,
      ),
    ).toThrow(PayloadTooLargeError);
    expect(() =>
      createProject({ files: [{ path: "main.tex", content: enc("0123456789ab") }] }, limits),
    ).toThrow(PayloadTooLargeError);
  });

  it("hashes deterministically regardless of input order", () => {
    const a = createProject(
      {
        files: [
          { path: "b.tex", content: enc("B") },
          { path: "main.tex", content: enc("A") },
        ],
      },
      DEFAULT_LIMITS,
    );
    const b = createProject(
      {
        files: [
          { path: "main.tex", content: enc("A") },
          { path: "b.tex", content: enc("B") },
        ],
      },
      DEFAULT_LIMITS,
    );
    expect(projectHash(a, "v1")).toBe(projectHash(b, "v1"));
    expect(projectHash(a, "v1")).not.toBe(projectHash(a, "v2"));
    const c = createProject(
      {
        files: [
          { path: "main.tex", content: enc("A") },
          { path: "b.tex", content: enc("C") },
        ],
      },
      DEFAULT_LIMITS,
    );
    expect(projectHash(a, "v1")).not.toBe(projectHash(c, "v1"));
  });
});

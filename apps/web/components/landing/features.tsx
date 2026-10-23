const features = [
  {
    title: "Sync and async",
    body: "POST /v1/compile waits for the PDF. POST /v1/jobs returns at once; poll it, stream it over SSE or get a webhook.",
  },
  {
    title: "Whole projects",
    body: "JSON files, multipart uploads, a zip or a raw .tex body. Sections, .bib files, images, classes and fonts travel with the document.",
  },
  {
    title: "Three engines",
    body: "pdfLaTeX, XeLaTeX and LuaLaTeX from TeX Live 2026, driven by latexmk with biber and bibtex available.",
  },
  {
    title: "Structured diagnostics",
    body: "The log is parsed into errors, warnings and info with file, line and context. A failed compile is a 422 you can act on.",
  },
  {
    title: "Content-addressed cache",
    body: "Identical input on the same compiler version returns the previous PDF instantly, flagged with X-Compile-Cached.",
  },
  {
    title: "Templates",
    body: "Seven ready projects: IEEE papers, two résumés, a brochure, a poster and a Spanish report. Compile them with your own files on top.",
  },
  {
    title: "Sandboxed compiles",
    body: "A throwaway container per job: no network, read-only filesystem, seccomp profile, cgroup CPU, memory and process limits.",
  },
  {
    title: "OpenAPI 3.1, SDK and CLI",
    body: "A typed TypeScript SDK and a CLI with watch mode are generated from the same contract you can read at /openapi.json.",
  },
  {
    title: "Self-hostable, MIT",
    body: "Docker Compose with Postgres and the compiler image. Bring your own keys, limits and, if you like, gVisor.",
  },
];

export function Features() {
  return (
    <section aria-labelledby="features-title" className="border-t border-rule">
      <div className="wrap py-20 lg:py-28">
        <h2 id="features-title" className="heading max-w-[22ch] text-3xl sm:text-4xl">
          Everything a build server needs, nothing it does not
        </h2>
        <dl className="mt-12 grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="border-t border-rule pt-4">
              <dt className="font-serif text-xl font-medium">{f.title}</dt>
              <dd className="mt-2 text-[0.95rem] leading-relaxed text-ink-2">{f.body}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

const steps = [
  {
    title: "Send files",
    body: "JSON, multipart, a zip or a raw .tex body. Pick the engine or let the % !TEX comment decide.",
  },
  {
    title: "Isolated container",
    body: "Each compile starts a fresh TeX Live 2026 container: no network, read-only root, CPU, memory and process limits.",
  },
  {
    title: "PDF + diagnostics",
    body: "latexmk runs as many passes as needed. The log is parsed into errors and warnings with file and line.",
  },
];

/** Three columns, one hairline, geometry only; labels are HTML so they stay readable on phones. */
function Diagram() {
  return (
    <svg
      viewBox="0 0 960 120"
      className="h-auto w-full text-ink"
      role="img"
      aria-label="Files flow into an isolated container and come out as a PDF with diagnostics"
    >
      <g fill="none" stroke="currentColor" strokeWidth="1.25">
        {/* files */}
        <path d="M60 30h48l16 16v44H60z" />
        <path d="M108 30v16h16" />
        <path d="M84 44h48l16 16v44H84z" opacity="0.5" />
        <path d="M132 44v16h16" opacity="0.5" />
        {/* arrow */}
        <path d="M200 60h100" />
        <path d="M292 54l8 6-8 6" />
        {/* container */}
        <rect x="380" y="22" width="200" height="76" rx="2" />
        <rect x="392" y="34" width="176" height="52" rx="1" strokeDasharray="3 4" />
        <text
          x="480"
          y="66"
          textAnchor="middle"
          fontFamily="var(--font-mono)"
          fontSize="13"
          fill="currentColor"
          stroke="none"
        >
          latexmk
        </text>
        {/* arrow */}
        <path d="M660 60h100" />
        <path d="M752 54l8 6-8 6" />
        {/* pdf */}
        <path d="M840 26h48l16 16v52h-64z" />
        <path d="M888 26v16h16" />
        <path d="M852 58h40M852 70h40M852 82h24" opacity="0.6" />
        {/* diagnostics mark */}
        <circle cx="912" cy="88" r="9" fill="var(--paper)" />
        <path
          d="M912 83v6M912 92v1"
          strokeLinecap="round"
          stroke="var(--accent)"
          strokeWidth="1.75"
        />
      </g>
    </svg>
  );
}

export function HowItWorks() {
  return (
    <section aria-labelledby="how-title" className="border-t border-rule">
      <div className="wrap py-20 lg:py-28">
        <h2 id="how-title" className="heading text-3xl sm:text-4xl">
          How it works
        </h2>
        <div className="mt-12 hidden sm:block">
          <Diagram />
        </div>
        <ol className="mt-6 grid gap-10 sm:grid-cols-3 sm:gap-8">
          {steps.map((step, i) => (
            <li key={step.title} className="border-t border-rule pt-5">
              <h3 className="font-serif text-xl font-medium">
                <span className="mr-2 text-accent" aria-hidden="true">
                  {i + 1}.
                </span>
                {step.title}
              </h3>
              <p className="mt-2 max-w-[32ch] text-[0.95rem] leading-relaxed text-ink-2">
                {step.body}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

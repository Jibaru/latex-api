"use client";

import { ArrowSquareOutIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { playgroundSource } from "@/lib/samples";
import { apiBase } from "@/lib/shared";

const Editor = dynamic(() => import("./editor"), {
  ssr: false,
  loading: () => <div className="h-full animate-pulse bg-paper-2" aria-hidden="true" />,
});

type Engine = "pdflatex" | "xelatex" | "lualatex";

interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
  line?: number;
  context?: string;
}

interface Problem {
  status: number;
  code: string;
  title: string;
  detail?: string;
  diagnostics?: Diagnostic[];
  logUrl?: string;
  jobId?: string;
}

type State =
  | { kind: "idle" }
  | { kind: "compiling" }
  | {
      kind: "done";
      pdfUrl: string;
      jobId: string | null;
      cached: string | null;
      warnings: string | null;
      ms: number;
    }
  | { kind: "failed"; problem: Problem }
  | { kind: "limited"; retryAfter: number | null; detail?: string }
  | { kind: "error"; message: string };

const engines: Engine[] = ["pdflatex", "xelatex", "lualatex"];

export function Playground() {
  const [source, setSource] = useState(playgroundSource);
  const [engine, setEngine] = useState<Engine>("pdflatex");
  const [state, setState] = useState<State>({ kind: "idle" });
  const lastUrl = useRef<string | null>(null);
  const engineId = useId();

  useEffect(() => {
    return () => {
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
    };
  }, []);

  const compile = useCallback(async () => {
    setState({ kind: "compiling" });
    const started = performance.now();
    try {
      const res = await fetch(`${apiBase}/v1/demo/compile`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/pdf" },
        body: JSON.stringify({ source, engine }),
      });

      if (res.status === 200) {
        const blob = await res.blob();
        if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
        const pdfUrl = URL.createObjectURL(blob);
        lastUrl.current = pdfUrl;
        setState({
          kind: "done",
          pdfUrl,
          jobId: res.headers.get("x-job-id"),
          cached: res.headers.get("x-compile-cached"),
          warnings: res.headers.get("x-compile-warnings"),
          ms: Math.round(performance.now() - started),
        });
        return;
      }

      if (res.status === 429) {
        const retry = Number(res.headers.get("retry-after"));
        let detail: string | undefined;
        try {
          detail = ((await res.json()) as Problem).detail;
        } catch {
          /* body may be empty */
        }
        setState({ kind: "limited", retryAfter: Number.isFinite(retry) ? retry : null, detail });
        return;
      }

      let problem: Problem;
      try {
        problem = (await res.json()) as Problem;
      } catch {
        problem = { status: res.status, code: "unknown", title: `HTTP ${res.status}` };
      }
      setState({ kind: "failed", problem });
    } catch (err) {
      setState({
        kind: "error",
        message:
          err instanceof Error && err.name !== "TypeError"
            ? err.message
            : "Could not reach the API. Check your connection and try again.",
      });
    }
  }, [source, engine]);

  const busy = state.kind === "compiling";

  return (
    <div className="plate">
      <div className="plate-inner">
        <form
          className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-rule px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void compile();
          }}
        >
          <label htmlFor={engineId} className="flex items-center gap-2 text-[0.85rem] text-ink-2">
            Engine
            <select
              id={engineId}
              name="engine"
              value={engine}
              onChange={(e) => setEngine(e.target.value as Engine)}
              className="border border-rule-strong bg-paper px-2 py-1.5 font-mono text-[0.8rem] text-ink"
            >
              {engines.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="btn btn-primary min-w-[7rem] px-4 py-1.5 text-[0.85rem]"
            aria-busy={busy}
            aria-disabled={busy}
          >
            {busy ? "Compiling…" : "Compile"}
          </button>
          <p
            className="ml-auto text-[0.8rem] text-ink-2 tabular-nums"
            aria-live="polite"
            role="status"
          >
            <Status state={state} />
          </p>
        </form>

        <div className="grid lg:grid-cols-2">
          <div className="h-[380px] min-w-0 overscroll-contain border-b border-rule lg:h-[560px] lg:border-r lg:border-b-0">
            <Editor value={source} onChange={setSource} ariaLabel="LaTeX source" />
          </div>
          <div className="h-[460px] min-w-0 overscroll-contain lg:h-[560px]">
            <Output state={state} />
          </div>
        </div>
      </div>
    </div>
  );
}

const seconds = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function Status({ state }: { state: State }) {
  switch (state.kind) {
    case "idle":
      return <>No API key needed. 5 compiles a minute, 30 a day.</>;
    case "compiling":
      return <>Starting a container and running latexmk…</>;
    case "done":
      return (
        <>
          Compiled in {seconds.format(state.ms / 1000)}
          {" s"}
          {state.cached === "true" ? ", served from cache" : ""}.
        </>
      );
    case "failed":
      return <>{state.problem.title}.</>;
    case "limited":
      return <>Rate limited.</>;
    case "error":
      return <>Request failed.</>;
  }
}

function Output({ state }: { state: State }) {
  if (state.kind === "done") {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule px-4 py-2 font-mono text-[0.72rem] text-ink-2">
          <span>
            X-Job-Id <span className="text-ink">{state.jobId ?? "n/a"}</span>
          </span>
          <span>
            X-Compile-Cached <span className="text-ink">{state.cached ?? "n/a"}</span>
          </span>
          <span>
            X-Compile-Warnings <span className="text-ink">{state.warnings ?? "n/a"}</span>
          </span>
          <span className="ml-auto flex gap-3">
            <a
              href={state.pdfUrl}
              target="_blank"
              rel="noreferrer"
              className="quiet-link inline-flex items-center gap-1"
            >
              <ArrowSquareOutIcon size={14} aria-hidden="true" /> Open
            </a>
            <a
              href={state.pdfUrl}
              download="playground.pdf"
              className="quiet-link inline-flex items-center gap-1"
            >
              <DownloadSimpleIcon size={14} aria-hidden="true" /> Download
            </a>
          </span>
        </div>
        <iframe
          src={state.pdfUrl}
          title="Compiled PDF"
          className="min-h-0 w-full flex-1 bg-paper-3"
        />
      </div>
    );
  }

  if (state.kind === "failed") {
    const { problem } = state;
    const diagnostics = problem.diagnostics ?? [];
    return (
      <section
        className="h-full overflow-auto overscroll-contain p-5"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable from the keyboard
        tabIndex={0}
        aria-label="Compile diagnostics"
      >
        <h3 className="font-serif text-xl font-medium">
          {problem.title}{" "}
          <span className="badge ml-1 align-middle">
            {problem.status} {problem.code}
          </span>
        </h3>
        {problem.detail ? <p className="mt-1 text-[0.9rem] text-ink-2">{problem.detail}</p> : null}
        {diagnostics.length > 0 ? (
          <ol className="mt-5 flex flex-col gap-3">
            {withKeys(diagnostics).map(({ d, key }) => (
              <li
                key={key}
                className="grid grid-cols-[auto_1fr] gap-x-3 border-l-2 pl-3"
                style={{ borderColor: severityColor(d.severity) }}
              >
                <span
                  className="font-mono text-[0.72rem] uppercase"
                  style={{ color: severityColor(d.severity) }}
                >
                  {d.severity}
                </span>
                <span className="font-mono text-[0.72rem] text-ink-2">
                  {d.file ?? "main.tex"}
                  {d.line ? `:${d.line}` : ""}
                </span>
                <p className="col-span-2 text-[0.9rem]">{d.message}</p>
                {d.context ? (
                  <pre className="col-span-2 mt-1 overflow-x-auto bg-code p-2 font-mono text-[0.72rem] leading-relaxed text-ink-2">
                    {d.context}
                  </pre>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
        {problem.logUrl ? (
          <p className="mt-5 text-[0.85rem]">
            <a href={problem.logUrl} className="link" target="_blank" rel="noreferrer">
              Open the full LaTeX log
            </a>
          </p>
        ) : null}
      </section>
    );
  }

  if (state.kind === "limited") {
    return (
      <Message title="Take a short break">
        The playground allows 5 compiles a minute and 30 a day per address.
        {state.retryAfter ? ` Try again in ${state.retryAfter} s.` : ""}
        {state.detail ? ` (${state.detail})` : ""} For more, use an API key with{" "}
        <code className="font-mono">/v1/compile</code>.
      </Message>
    );
  }

  if (state.kind === "error") {
    return <Message title="Something went wrong">{state.message}</Message>;
  }

  return (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <p className="max-w-[28ch] font-serif text-lg text-ink-2">
        {state.kind === "compiling"
          ? "Typesetting…"
          : "The PDF appears here. Edit the source and press Compile."}
      </p>
    </div>
  );
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-[40ch]">
        <h3 className="font-serif text-xl font-medium">{title}</h3>
        <p className="mt-2 text-[0.9rem] leading-relaxed text-ink-2">{children}</p>
      </div>
    </div>
  );
}

/** Stable keys from the diagnostic itself; identical repeats get a counter suffix. */
function withKeys(diagnostics: Diagnostic[]): { d: Diagnostic; key: string }[] {
  const seen = new Map<string, number>();
  return diagnostics.map((d) => {
    const base = `${d.severity}:${d.file ?? ""}:${d.line ?? ""}:${d.message}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { d, key: n === 0 ? base : `${base}#${n}` };
  });
}

function severityColor(severity: Diagnostic["severity"]): string {
  if (severity === "error") return "var(--accent)";
  if (severity === "warning") return "var(--warn)";
  return "var(--ink-3)";
}

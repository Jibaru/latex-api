import { sampleCli, sampleCurl, sampleJavaScript, samplePython } from "@/lib/samples";
import { Code } from "./code";

const tabs = [
  { id: "curl", label: "curl", lang: "bash", code: sampleCurl },
  { id: "js", label: "JavaScript", lang: "javascript", code: sampleJavaScript },
  { id: "cli", label: "CLI", lang: "bash", code: sampleCli },
  { id: "py", label: "Python", lang: "python", code: samplePython },
] as const;

/**
 * Tabs driven by a radio group: arrow keys switch, labels are the visible tabs,
 * CSS shows the matching panel. Zero client JavaScript.
 */
export function CodeTabs() {
  return (
    <section aria-labelledby="code-title" className="border-t border-rule">
      <div className="wrap py-20 lg:py-28">
        <h2 id="code-title" className="heading text-3xl sm:text-4xl">
          Call it from anywhere
        </h2>
        <fieldset className="code-tabs relative mt-10 m-0 min-w-0 border-0 p-0">
          <legend className="sr-only">Language of the example</legend>
          {tabs.map((t, i) => (
            <input
              key={t.id}
              type="radio"
              name="code-sample"
              id={`code-${t.id}`}
              defaultChecked={i === 0}
              aria-label={`${t.label} example`}
            />
          ))}
          <div className="code-tab-list flex gap-4 border-b border-rule">
            {tabs.map((t) => (
              <label
                key={t.id}
                htmlFor={`code-${t.id}`}
                className="px-1 pt-2.5 pb-3 font-mono text-[0.82rem] tracking-wide"
              >
                {t.label}
              </label>
            ))}
          </div>
          <div className="code-tab-panels mt-5">
            {tabs.map((t) => (
              <div key={t.id} className="code-tab-panel">
                <Code code={t.code} lang={t.lang} />
              </div>
            ))}
          </div>
        </fieldset>
        <p className="mt-5 max-w-[60ch] text-[0.9rem] text-ink-2">
          The SDK is <code className="font-mono">@jibaru/latex-api-sdk</code>, the CLI is{" "}
          <code className="font-mono">@jibaru/latex-api-cli</code>. Both are generated from the
          OpenAPI document and published under MIT.
        </p>
      </div>
    </section>
  );
}

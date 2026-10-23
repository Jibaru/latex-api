import { Playground } from "@/components/playground/playground";

export function PlaygroundSection() {
  return (
    <section id="playground" aria-labelledby="playground-title" className="border-t border-rule">
      <div className="wrap py-20 lg:py-28">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <h2 id="playground-title" className="heading text-3xl sm:text-4xl">
            Try it in the browser
          </h2>
          <p className="max-w-[44ch] text-[0.95rem] text-ink-2">
            This calls <code className="font-mono">POST /v1/demo/compile</code> on the public
            instance. Errors come back as diagnostics with line numbers.
          </p>
        </div>
        <div className="mt-10">
          <Playground />
        </div>
      </div>
    </section>
  );
}

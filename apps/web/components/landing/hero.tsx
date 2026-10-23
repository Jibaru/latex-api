import { ArrowRightIcon } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { heroCurl } from "@/lib/samples";
import { Code } from "./code";

export function Hero() {
  return (
    <section className="wrap grid gap-12 pt-14 pb-20 lg:grid-cols-12 lg:items-center lg:gap-10 lg:pt-20 lg:pb-28">
      <div className="min-w-0 lg:col-span-6">
        <h1 className="display rise text-[2.75rem] sm:text-6xl lg:text-[4.25rem]">
          Compile LaTeX in the cloud. <em className="italic text-accent">One HTTP call.</em>
        </h1>
        <p className="lede rise rise-2 mt-6 max-w-[34rem]">
          Send a .tex file or a whole project; get back a PDF and every error as structured JSON.
        </p>
        <div className="rise rise-3 mt-9 flex flex-wrap items-center gap-3">
          <Link href="/sign-up" className="btn btn-primary">
            Get a free API token
            <ArrowRightIcon size={16} weight="regular" aria-hidden="true" />
          </Link>
          <Link href="/docs" className="btn btn-secondary">
            Read the docs
          </Link>
          <a href="#playground" className="link px-2 py-2.5 text-[0.95rem]">
            Try the playground
          </a>
        </div>
      </div>
      <div className="rise rise-2 min-w-0 lg:col-span-6">
        <Code code={heroCurl} lang="bash" label="sh" />
        <p className="mt-3 text-[0.85rem] text-ink-2">
          Use a personal token from your dashboard, or run <code>latex-api auth login</code>. The
          response body is the PDF; errors arrive as problem+json with line numbers.
        </p>
      </div>
    </section>
  );
}

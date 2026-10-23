import { currentUser } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import Link from "next/link";
import { JobsTable } from "@/components/account/jobs-table";
import { type ApiError, type ApiToken, apiAsUser, type JobSummary } from "@/lib/account";
import { siteUrl } from "@/lib/shared";

export const metadata: Metadata = { title: "Dashboard" };

const curl = [
  `curl -X POST ${siteUrl}/v1/compile \\`,
  '  -H "Authorization: Bearer $LATEX_API_TOKEN" \\',
  '  -H "Content-Type: text/x-tex" \\',
  "  --data-binary @main.tex -o main.pdf",
].join("\n");

const cli = [
  "npm i -g @jibaru/latex-api-cli",
  "latex-api auth login",
  "latex-api compile ./paper",
].join("\n");

export default async function DashboardPage() {
  const user = await currentUser();
  const [jobs, tokens] = await Promise.all([
    apiAsUser<{ jobs: JobSummary[] }>("/v1/jobs?limit=15").catch((e: unknown) => e as ApiError),
    apiAsUser<{ tokens: ApiToken[] }>("/v1/tokens").catch((e: unknown) => e as ApiError),
  ]);
  const active = tokens instanceof Error ? [] : tokens.tokens.filter((t) => t.status === "active");
  const name =
    user?.firstName ?? user?.username ?? user?.primaryEmailAddress?.emailAddress ?? "there";

  return (
    <div className="space-y-16">
      <header>
        <p className="smallcaps">Dashboard</p>
        <h1 className="display mt-3 text-4xl sm:text-5xl">Hello, {name}.</h1>
        <p className="lede mt-4 max-w-[44rem]">
          {active.length === 0
            ? "Create an API token or sign the CLI in to start compiling."
            : `You have ${active.length} active ${active.length === 1 ? "token" : "tokens"}.`}
        </p>
      </header>

      <section aria-labelledby="start-title" className="grid gap-6 lg:grid-cols-2">
        <h2 id="start-title" className="sr-only">
          Get started
        </h2>
        <article className="plate">
          <div className="plate-inner flex h-full flex-col p-6">
            <p className="smallcaps">From the terminal</p>
            <h3 className="heading mt-2 text-2xl">Sign the CLI in</h3>
            <p className="mt-3 text-[0.95rem] text-ink-2">
              The CLI shows a code and you approve it here. The token it receives lasts until you
              revoke it.
            </p>
            <pre className="mt-5 overflow-x-auto bg-code p-4 font-mono text-[0.85rem] leading-relaxed">
              <code>{cli}</code>
            </pre>
            <Link href="/dashboard/cli" className="link mt-auto pt-4 text-[0.9rem]">
              Profiles, agents and the skill
            </Link>
          </div>
        </article>
        <article className="plate">
          <div className="plate-inner flex h-full flex-col p-6">
            <p className="smallcaps">From code or CI</p>
            <h3 className="heading mt-2 text-2xl">Create an API token</h3>
            <p className="mt-3 text-[0.95rem] text-ink-2">
              Send it as a bearer token. Give CI tokens an expiry; your own machine can have none.
            </p>
            <pre className="mt-5 overflow-x-auto bg-code p-4 font-mono text-[0.85rem] leading-relaxed">
              <code>{curl}</code>
            </pre>
            <div className="mt-auto pt-5">
              <Link href="/dashboard/tokens" className="btn btn-primary">
                Manage tokens
              </Link>
            </div>
          </div>
        </article>
      </section>

      <section aria-labelledby="jobs-title">
        <div className="flex items-baseline justify-between gap-4 border-b border-rule pb-3">
          <h2 id="jobs-title" className="heading text-2xl">
            Recent jobs
          </h2>
          <span className="text-[0.85rem] text-ink-3">Kept for 24 hours</span>
        </div>
        {jobs instanceof Error ? (
          <p role="alert" className="mt-6 text-[0.95rem] text-ink-2">
            Could not load jobs: {jobs.message}
          </p>
        ) : (
          <JobsTable jobs={jobs.jobs} />
        )}
      </section>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "CLI" };

const blocks: Array<{ title: string; body: string; code: string }> = [
  {
    title: "Install and sign in",
    body: "The browser opens on this site; approve the code and the CLI stores a personal token in your OS keychain.",
    code: "npm i -g @jibaru/latex-api-cli\nlatex-api auth login\nlatex-api auth status",
  },
  {
    title: "Use a token from this dashboard",
    body: "For CI or a server, create a token under API tokens and pipe it in. It never lands in your shell history.",
    code: 'echo "$LATEX_API_TOKEN" | latex-api auth login --with-token\n# or just export it\nexport LATEX_API_TOKEN=lta_…',
  },
  {
    title: "Several accounts or servers",
    body: "Profiles keep their own URL and token. Pick one per command or switch the default.",
    code: "latex-api profile set work --url https://latex-api.crafter.run\nlatex-api auth login --profile work\nlatex-api profile use work\nlatex-api compile ./thesis --profile personal",
  },
  {
    title: "Let your agent drive it",
    body: "Every command speaks JSON when piped. Install the skill that matches your CLI version.",
    code: "latex-api skill install --target claude\nlatex-api schema\nlatex-api compile ./paper --json",
  },
];

export default function CliPage() {
  return (
    <div>
      <p className="smallcaps">Command line</p>
      <h1 className="display mt-3 text-4xl sm:text-5xl">The latex-api CLI</h1>
      <p className="lede mt-4 max-w-[44rem]">
        Compile folders, watch for changes, start from templates and manage tokens without leaving
        the terminal. Built for people and for coding agents.
      </p>
      <div className="mt-12 grid gap-6 md:grid-cols-2">
        {blocks.map((b) => (
          <article key={b.title} className="plate">
            <div className="plate-inner h-full p-6">
              <h2 className="heading text-xl">{b.title}</h2>
              <p className="mt-2 text-[0.93rem] text-ink-2">{b.body}</p>
              <pre className="mt-4 overflow-x-auto bg-code p-4 font-mono text-[0.83rem] leading-relaxed">
                <code>{b.code}</code>
              </pre>
            </div>
          </article>
        ))}
      </div>
      <p className="mt-10 text-[0.95rem] text-ink-2">
        Full reference in the{" "}
        <Link href="/docs/cli" className="link">
          CLI docs
        </Link>
        . Revoke any CLI sign-in from{" "}
        <Link href="/dashboard/tokens" className="link">
          API tokens
        </Link>
        .
      </p>
    </div>
  );
}

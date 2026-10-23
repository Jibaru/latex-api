import type { ReactNode } from "react";
import { Footer } from "@/components/landing/footer";
import { Masthead } from "@/components/landing/masthead";

/** Two-column editorial frame for the sign-in and sign-up pages. */
export function AuthShell({
  title,
  lede,
  children,
}: {
  title: string;
  lede: string;
  children: ReactNode;
}) {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Masthead />
      <main
        id="main"
        className="wrap grid flex-1 gap-12 py-16 lg:grid-cols-[1fr_auto] lg:items-start lg:py-24"
      >
        <div className="max-w-[34rem]">
          <p className="smallcaps">Account</p>
          <h1 className="display mt-4 text-5xl sm:text-6xl">{title}</h1>
          <p className="lede mt-6">{lede}</p>
          <ul className="mt-10 space-y-4 border-t border-rule pt-8 text-[0.95rem] text-ink-2">
            <li>
              <span className="mr-2 font-serif text-accent">§</span>
              Personal API tokens that last until you revoke them, or until a date you choose.
            </li>
            <li>
              <span className="mr-2 font-serif text-accent">§</span>
              Sign the CLI in with <code>latex-api auth login</code>: approve it here, no copy and
              paste.
            </li>
            <li>
              <span className="mr-2 font-serif text-accent">§</span>
              Your jobs, PDFs and logs in one place. Artifacts are kept for 24 hours.
            </li>
          </ul>
        </div>
        <div className="flex justify-center lg:justify-end">{children}</div>
      </main>
      <Footer />
    </>
  );
}

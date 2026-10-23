import type { Metadata } from "next";
import { CreateTokenForm } from "@/components/account/create-token-form";
import { TokensTable } from "@/components/account/tokens-table";
import { type ApiError, type ApiToken, apiAsUser } from "@/lib/account";

export const metadata: Metadata = { title: "API tokens" };

export default async function TokensPage() {
  const res = await apiAsUser<{ tokens: ApiToken[] }>("/v1/tokens").catch(
    (e: unknown) => e as ApiError,
  );

  return (
    <div className="grid gap-14 lg:grid-cols-[22rem_1fr] lg:gap-16">
      <section aria-labelledby="new-title">
        <p className="smallcaps">Personal access</p>
        <h1 id="new-title" className="display mt-3 text-4xl">
          API tokens
        </h1>
        <p className="mt-4 text-[0.95rem] leading-relaxed text-ink-2">
          A token acts as you. It works until you revoke it, or until the expiry you set. The secret
          is shown once, right after you create it.
        </p>
        <CreateTokenForm />
      </section>

      <section aria-labelledby="list-title">
        <div className="flex items-baseline justify-between gap-4 border-b border-rule pb-3">
          <h2 id="list-title" className="heading text-2xl">
            Your tokens
          </h2>
          <span className="text-[0.85rem] text-ink-3">CLI sign-ins appear here too</span>
        </div>
        {res instanceof Error ? (
          <p role="alert" className="mt-6 text-[0.95rem] text-ink-2">
            Could not load tokens: {res.message}
          </p>
        ) : (
          <TokensTable tokens={res.tokens} />
        )}
      </section>
    </div>
  );
}

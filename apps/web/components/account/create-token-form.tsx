"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { type CreateTokenState, createToken } from "@/app/dashboard/tokens/actions";

const initial: CreateTokenState = { status: "idle" };

export function CreateTokenForm() {
  const [state, action, pending] = useActionState(createToken, initial);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === "created") formRef.current?.reset();
  }, [state]);

  return (
    <div className="mt-8">
      <form ref={formRef} action={action} className="space-y-5">
        <div>
          <label htmlFor="token-name" className="block text-[0.9rem] font-medium">
            Name
          </label>
          <input
            id="token-name"
            name="name"
            required
            maxLength={80}
            autoComplete="off"
            placeholder="GitHub Actions, laptop, thesis build…"
            className="mt-2 w-full border border-rule-strong bg-paper px-3 py-2.5 text-[0.95rem] placeholder:text-ink-3 focus-visible:border-accent"
          />
        </div>
        <div>
          <label htmlFor="token-expiry" className="block text-[0.9rem] font-medium">
            Expires
          </label>
          <select
            id="token-expiry"
            name="expiry"
            defaultValue="never"
            className="mt-2 w-full border border-rule-strong bg-paper px-3 py-2.5 text-[0.95rem] focus-visible:border-accent"
          >
            <option value="never">Never (until revoked)</option>
            <option value="7">In 7 days</option>
            <option value="30">In 30 days</option>
            <option value="90">In 90 days</option>
            <option value="365">In 1 year</option>
          </select>
        </div>
        <button
          type="submit"
          className="btn btn-primary w-full"
          aria-disabled={pending}
          disabled={pending}
        >
          {pending ? "Creating…" : "Create token"}
        </button>
        <p aria-live="polite" className="min-h-[1.25rem] text-[0.88rem] text-accent">
          {state.status === "error" ? state.message : ""}
        </p>
      </form>
      {state.status === "created" ? (
        <SecretReveal secret={state.secret} name={state.token.name} />
      ) : null}
    </div>
  );
}

function SecretReveal({ secret, name }: { secret: string; name: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="status" className="plate mt-2">
      <div className="plate-inner p-4">
        <p className="smallcaps">Copy it now</p>
        <p className="mt-2 text-[0.9rem] text-ink-2">
          This is the only time the secret for <strong className="text-ink">{name}</strong> is
          shown.
        </p>
        <code className="mt-3 block break-all bg-code p-3 font-mono text-[0.82rem]">{secret}</code>
        <button
          type="button"
          className="btn btn-secondary mt-3 w-full"
          onClick={async () => {
            await navigator.clipboard.writeText(secret);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy token"}
        </button>
        <p className="mt-3 text-[0.82rem] text-ink-3">
          Use it with <code>latex-api auth login --with-token</code> or as{" "}
          <code>LATEX_API_TOKEN</code>.
        </p>
      </div>
    </div>
  );
}

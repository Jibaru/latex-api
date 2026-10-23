import { currentUser } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "@/components/landing/footer";
import { Masthead } from "@/components/landing/masthead";
import { ApiError, apiAsUser, type DeviceRequest } from "@/lib/account";
import { relativeTime } from "@/lib/time";
import { approveDevice, denyDevice } from "./actions";

export const metadata: Metadata = { title: "Authorize the CLI", robots: { index: false } };
export const dynamic = "force-dynamic";

const CODE = /^[A-Z2-9]{4}-?[A-Z2-9]{4}$/;

function normalize(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.length === 8 && CODE.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4)}` : undefined;
}

export default async function AuthorizeCliPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; result?: string }>;
}) {
  const params = await searchParams;
  const code = normalize(params.code);
  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress;

  let device: DeviceRequest | undefined;
  let lookupError: string | undefined;
  if (code) {
    try {
      device = await apiAsUser<DeviceRequest>(`/v1/auth/device/${code}`);
    } catch (error) {
      lookupError =
        error instanceof ApiError && error.status === 404
          ? "That code does not exist or has expired. Run `latex-api auth login` again."
          : "We could not look up that code right now.";
    }
  }

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Masthead />
      <main id="main" className="wrap flex flex-1 justify-center py-16 lg:py-24">
        <div className="w-full max-w-[34rem]">
          <p className="smallcaps">Command line</p>
          <h1 className="display mt-3 text-4xl sm:text-5xl">Authorize the CLI</h1>
          {!code ? (
            <EnterCode invalid={Boolean(params.code)} />
          ) : lookupError ? (
            <Notice tone="error" title="Code not found">
              {lookupError}
            </Notice>
          ) : device ? (
            <Decision device={device} result={params.result} email={email} />
          ) : null}
        </div>
      </main>
      <Footer />
    </>
  );
}

function EnterCode({ invalid }: { invalid: boolean }) {
  return (
    <form method="get" className="mt-8 space-y-4">
      <p className="lede">Type the code your terminal is showing.</p>
      <label htmlFor="code" className="sr-only">
        Device code
      </label>
      <input
        id="code"
        name="code"
        required
        autoComplete="one-time-code"
        inputMode="text"
        placeholder="WDJB-MJHT"
        aria-invalid={invalid || undefined}
        className="w-full border border-rule-strong bg-paper px-4 py-3 text-center font-mono text-2xl uppercase tracking-[0.3em] placeholder:text-ink-3 focus-visible:border-accent"
      />
      {invalid ? <p className="text-[0.9rem] text-accent">Codes look like ABCD-EFGH.</p> : null}
      <button type="submit" className="btn btn-primary w-full">
        Continue
      </button>
    </form>
  );
}

function Decision({
  device,
  result,
  email,
}: {
  device: DeviceRequest;
  result?: string;
  email?: string;
}) {
  if (result === "approved" || device.status === "approved" || device.status === "consumed") {
    return (
      <Notice tone="ok" title="You're signed in">
        Return to your terminal; it will finish on its own. The new token is listed under{" "}
        <Link href="/dashboard/tokens" className="link">
          API tokens
        </Link>
        , where you can revoke it any time.
      </Notice>
    );
  }
  if (result === "denied" || device.status === "denied") {
    return (
      <Notice tone="error" title="Sign-in denied">
        The CLI on {device.hostname ?? "that machine"} will stop waiting. Nothing was created.
      </Notice>
    );
  }
  if (device.status === "expired") {
    return (
      <Notice tone="error" title="This code expired">
        Codes are valid for 10 minutes. Run <code>latex-api auth login</code> again.
      </Notice>
    );
  }
  const failed = result?.startsWith("error:");

  return (
    <div className="mt-8">
      <p className="lede">Confirm that this is you signing in from the terminal.</p>
      <dl className="mt-8 grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 border-y border-rule py-6 text-[0.95rem]">
        <dt className="text-ink-3">Code</dt>
        <dd className="font-mono tracking-[0.2em]">{device.userCode}</dd>
        <dt className="text-ink-3">Client</dt>
        <dd>{device.clientName}</dd>
        {device.hostname ? (
          <>
            <dt className="text-ink-3">Machine</dt>
            <dd>
              {device.hostname}
              {device.platform ? <span className="text-ink-3"> · {device.platform}</span> : null}
            </dd>
          </>
        ) : null}
        <dt className="text-ink-3">Requested</dt>
        <dd>{relativeTime(device.createdAt)}</dd>
        <dt className="text-ink-3">Account</dt>
        <dd>{email ?? "you"}</dd>
      </dl>
      <p className="mt-4 text-[0.88rem] text-ink-3">
        Only approve if you just ran <code>latex-api auth login</code> and the code matches your
        terminal.
      </p>

      <form action={approveDevice} className="mt-8 space-y-5">
        <input type="hidden" name="code" value={device.userCode} />
        <div>
          <label htmlFor="expiry" className="block text-[0.9rem] font-medium">
            Token lifetime
          </label>
          <select
            id="expiry"
            name="expiry"
            defaultValue="never"
            className="mt-2 w-full border border-rule-strong bg-paper px-3 py-2.5 text-[0.95rem] focus-visible:border-accent"
          >
            <option value="never">Until I revoke it</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">1 year</option>
          </select>
        </div>
        <div>
          <label htmlFor="tokenName" className="block text-[0.9rem] font-medium">
            Token name <span className="font-normal text-ink-3">(optional)</span>
          </label>
          <input
            id="tokenName"
            name="tokenName"
            maxLength={80}
            placeholder={device.hostname ? `CLI on ${device.hostname}` : device.clientName}
            className="mt-2 w-full border border-rule-strong bg-paper px-3 py-2.5 text-[0.95rem] placeholder:text-ink-3 focus-visible:border-accent"
          />
        </div>
        {failed ? (
          <p role="alert" className="text-[0.9rem] text-accent">
            That did not work ({result?.slice(6)}). Try again, or restart the login from the
            terminal.
          </p>
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row">
          <button type="submit" className="btn btn-primary flex-1">
            Authorize
          </button>
          <button type="submit" formAction={denyDevice} className="btn btn-secondary flex-1">
            Deny
          </button>
        </div>
      </form>
    </div>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "ok" | "error";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className="mt-8 border-l-2 py-1 pl-5"
      style={{ borderColor: tone === "ok" ? "var(--ok)" : "var(--accent)" }}
    >
      <h2 className="heading text-2xl">{title}</h2>
      <p className="mt-3 text-[0.98rem] leading-relaxed text-ink-2">{children}</p>
    </div>
  );
}

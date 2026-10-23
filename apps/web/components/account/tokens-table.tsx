import { revokeToken } from "@/app/dashboard/tokens/actions";
import type { ApiToken } from "@/lib/account";
import { formatDate, relativeTime } from "@/lib/time";

const originLabel: Record<ApiToken["origin"], string> = {
  dashboard: "Dashboard",
  cli: "CLI sign-in",
  api: "API",
};

export function TokensTable({ tokens }: { tokens: ApiToken[] }) {
  if (tokens.length === 0) {
    return (
      <p className="mt-6 text-[0.95rem] text-ink-2">
        No tokens yet. Create one here, or run <code>latex-api auth login</code>.
      </p>
    );
  }
  const sorted = [...tokens].sort(
    (a, b) => Number(a.status !== "active") - Number(b.status !== "active"),
  );
  return (
    <ul className="divide-y divide-rule">
      {sorted.map((t) => (
        <li
          key={t.id}
          className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className={t.status === "active" ? "" : "opacity-60"}>
            <p className="font-medium">
              {t.name}
              {t.status !== "active" ? (
                <span className="badge ml-2 align-middle">{t.status}</span>
              ) : null}
            </p>
            <p className="mt-1 font-mono text-[0.82rem] text-ink-2">{t.prefix}…</p>
            <p className="mt-1.5 text-[0.85rem] text-ink-3">
              {originLabel[t.origin]} · created {formatDate(t.createdAt)} ·{" "}
              {t.lastUsedAt ? `used ${relativeTime(t.lastUsedAt)}` : "never used"} ·{" "}
              {t.revokedAt
                ? `revoked ${formatDate(t.revokedAt)}`
                : t.expiresAt
                  ? `${t.status === "expired" ? "expired" : "expires"} ${formatDate(t.expiresAt)}`
                  : "no expiry"}
            </p>
          </div>
          {t.status === "active" ? (
            <form action={revokeToken}>
              <input type="hidden" name="id" value={t.id} />
              <button
                type="submit"
                className="btn btn-secondary px-4 py-2 text-[0.85rem] hover:border-accent hover:text-accent"
              >
                Revoke
              </button>
            </form>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

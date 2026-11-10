import { MagnifyingGlassIcon, PlusIcon } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import Link from "next/link";
import { GalleryCard } from "@/components/gallery/card";
import {
  CATEGORIES,
  type GallerySort,
  galleryTags,
  searchGallery,
  sessionToken,
} from "@/lib/gallery";

export const metadata: Metadata = {
  title: "Template gallery",
  description:
    "LaTeX templates shared by the community: theses, papers, CVs, posters and brochures. Search by meaning, star your favourites and compile them in the cloud.",
};

const PAGE_SIZE = 24;

type Params = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Builds a /gallery URL keeping the current filters, with overrides (undefined removes). */
function href(current: Params, overrides: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const key of ["q", "tag", "category", "sort", "view"]) {
    const value = key in overrides ? overrides[key] : one(current[key]);
    if (value) params.set(key, value);
  }
  if (overrides.page) params.set("page", overrides.page);
  const qs = params.toString();
  return qs ? `/gallery?${qs}` : "/gallery";
}

export default async function GalleryPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const q = one(params.q)?.trim() || undefined;
  const tag = one(params.tag) || undefined;
  const category = one(params.category) || undefined;
  const view = one(params.view);
  const sortParam = one(params.sort) as GallerySort | undefined;
  const sort =
    sortParam && ["stars", "recent", "relevance"].includes(sortParam) ? sortParam : undefined;
  const page = Math.max(1, Number(one(params.page)) || 1);
  const signedIn = Boolean(await sessionToken());

  const [result, tags] = await Promise.all([
    searchGallery({
      q,
      tags: tag ? [tag] : undefined,
      category,
      sort,
      mine: view === "mine" && signedIn,
      starred: view === "starred" && signedIn,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    galleryTags(20),
  ]);
  const data = result.data;
  const effectiveSort = data?.sort ?? sort ?? (q ? "relevance" : "stars");
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const sorts: Array<{ id: GallerySort; label: string }> = [
    ...(q ? [{ id: "relevance" as const, label: "Best match" }] : []),
    { id: "stars", label: "Most starred" },
    { id: "recent", label: "Newest" },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-[62ch]">
          <p className="smallcaps">Community</p>
          <h1 className="heading mt-2 text-4xl sm:text-5xl">Template gallery</h1>
          <p className="mt-4 text-[1.05rem] leading-relaxed text-ink-2">
            Theses, papers, résumés and posters shared by people who already fought with LaTeX.
            Every template here compiled in our sandbox before it was published, and all of them are
            free to reuse under{" "}
            <a href="https://creativecommons.org/licenses/by/4.0/" className="link">
              CC-BY 4.0
            </a>
            .
          </p>
        </div>
        <Link href="/gallery/new" className="btn btn-primary inline-flex items-center gap-2">
          <PlusIcon size={16} aria-hidden="true" />
          Publish a template
        </Link>
      </div>

      <search className="mt-10 block">
        <form action="/gallery" method="get" className="flex gap-2">
          <label htmlFor="gallery-q" className="sr-only">
            Search templates
          </label>
          <div className="relative flex-1">
            <MagnifyingGlassIcon
              size={18}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
            />
            <input
              id="gallery-q"
              name="q"
              type="search"
              defaultValue={q}
              maxLength={300}
              placeholder="Describe it: “tesis con normas APA”, “CV for a data scientist”…"
              className="w-full border border-rule-strong bg-paper py-3 pl-10 pr-3 text-[0.95rem] placeholder:text-ink-3 focus-visible:border-accent"
            />
          </div>
          {category ? <input type="hidden" name="category" value={category} /> : null}
          {tag ? <input type="hidden" name="tag" value={tag} /> : null}
          {view ? <input type="hidden" name="view" value={view} /> : null}
          <button type="submit" className="btn btn-secondary">
            Search
          </button>
        </form>
      </search>

      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 text-[0.88rem]">
        <nav aria-label="Category" className="flex flex-wrap gap-x-3 gap-y-1">
          <Link
            href={href(params, { category: undefined, page: undefined })}
            aria-current={!category ? "page" : undefined}
            className={!category ? "text-ink underline underline-offset-4" : "quiet-link"}
          >
            All
          </Link>
          {CATEGORIES.map((c) => (
            <Link
              key={c.id}
              href={href(params, { category: c.id, page: undefined })}
              aria-current={category === c.id ? "page" : undefined}
              className={category === c.id ? "text-ink underline underline-offset-4" : "quiet-link"}
            >
              {c.label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-y border-rule py-3 text-[0.88rem]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink-3">Sort</span>
          {sorts.map((s) => (
            <Link
              key={s.id}
              href={href(params, { sort: s.id, page: undefined })}
              aria-current={effectiveSort === s.id ? "true" : undefined}
              className={`px-2 py-1 ${effectiveSort === s.id ? "bg-code text-ink" : "quiet-link"}`}
            >
              {s.label}
            </Link>
          ))}
        </div>
        {signedIn ? (
          <div className="flex items-center gap-2">
            {[
              { id: undefined, label: "Everyone" },
              { id: "starred", label: "Starred" },
              { id: "mine", label: "Mine" },
            ].map((v) => (
              <Link
                key={v.label}
                href={href(params, { view: v.id, page: undefined })}
                aria-current={view === v.id ? "true" : undefined}
                className={`px-2 py-1 ${view === v.id ? "bg-code text-ink" : "quiet-link"}`}
              >
                {v.label}
              </Link>
            ))}
          </div>
        ) : null}
      </div>

      {tags.length ? (
        <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="Popular tags">
          {tag ? (
            <li>
              <Link href={href(params, { tag: undefined, page: undefined })} className="badge">
                ✕ {tag}
              </Link>
            </li>
          ) : null}
          {tags
            .filter((t) => t.tag !== tag)
            .map((t) => (
              <li key={t.tag}>
                <Link
                  href={href(params, { tag: t.tag, page: undefined })}
                  className="badge hover:text-ink"
                >
                  {t.tag} <span className="text-ink-3">{t.count}</span>
                </Link>
              </li>
            ))}
        </ul>
      ) : null}

      {!data ? (
        <p className="mt-12 text-ink-2">
          The gallery is not reachable right now. Try again shortly.
        </p>
      ) : data.items.length === 0 ? (
        <div className="mt-12 max-w-[56ch]">
          <p className="font-serif text-xl">
            {q ? `Nothing matches “${q}” yet.` : "No templates here yet."}
          </p>
          <p className="mt-2 text-ink-2">
            {q
              ? "Try describing the document differently, or remove a filter."
              : "Be the first: publish a template that compiles and others can start from it."}
          </p>
        </div>
      ) : (
        <>
          <p className="mt-6 text-[0.85rem] text-ink-3" aria-live="polite">
            {data.total} {data.total === 1 ? "template" : "templates"}
            {q && !data.semantic ? " · keyword matches only" : ""}
          </p>
          <ul className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {data.items.map((item) => (
              <GalleryCard key={item.id} item={item} />
            ))}
          </ul>
          {pages > 1 ? (
            <nav
              aria-label="Pages"
              className="mt-10 flex items-center justify-center gap-4 text-[0.9rem]"
            >
              {page > 1 ? (
                <Link href={href(params, { page: String(page - 1) })} className="quiet-link">
                  ← Previous
                </Link>
              ) : null}
              <span className="text-ink-3">
                Page {page} of {pages}
              </span>
              {page < pages ? (
                <Link href={href(params, { page: String(page + 1) })} className="quiet-link">
                  Next →
                </Link>
              ) : null}
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}

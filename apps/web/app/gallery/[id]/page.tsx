import {
  ArrowLeftIcon,
  DownloadSimpleIcon,
  FileTextIcon,
  StarIcon,
} from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ReportForm } from "@/components/gallery/report-form";
import { formatBytes, formatDate, getGalleryTemplate, sessionToken } from "@/lib/gallery";
import { removeTemplate, setHidden, toggleStar } from "../actions";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const { data } = await getGalleryTemplate(id);
  if (!data) return { title: "Template not found" };
  const t = data.template;
  return {
    title: `${t.name} · Template gallery`,
    description: t.description.slice(0, 160),
    openGraph: { images: [{ url: t.links.thumbnail, width: 600 }] },
  };
}

export default async function GalleryTemplatePage({ params }: Props) {
  const { id } = await params;
  const { data } = await getGalleryTemplate(id);
  if (!data) notFound();
  const t = data.template;
  const signedIn = Boolean(await sessionToken());

  return (
    <div>
      <Link href="/gallery" className="quiet-link inline-flex items-center gap-1.5 text-[0.88rem]">
        <ArrowLeftIcon size={14} aria-hidden="true" />
        Gallery
      </Link>

      <div className="mt-6 grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <a
          href={t.links.pdf}
          target="_blank"
          rel="noreferrer"
          className="plate block self-start bg-white"
        >
          {/* biome-ignore lint/performance/noImgElement: thumbnails come from the API */}
          <img
            src={t.links.thumbnail}
            alt={`First page of ${t.name}`}
            className="w-full border border-rule"
          />
          <span className="sr-only">Open the PDF (new tab)</span>
        </a>

        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="smallcaps">{t.category}</span>
            <span className="badge">{t.engine}</span>
            {t.hidden ? <span className="badge text-accent">hidden</span> : null}
          </div>
          <h1 className="heading mt-3 text-3xl sm:text-4xl">{t.name}</h1>
          <p className="mt-2 text-[0.92rem] text-ink-2">
            by <span className="text-ink">{t.author.name}</span> · published{" "}
            {formatDate(t.createdAt)}
            {t.version > 1 ? ` · v${t.version}, updated ${formatDate(t.updatedAt)}` : ""}
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            {signedIn ? (
              <form action={toggleStar}>
                <input type="hidden" name="id" value={t.id} />
                <input type="hidden" name="starred" value={String(t.starred)} />
                <button
                  type="submit"
                  aria-pressed={t.starred}
                  className={`btn inline-flex items-center gap-2 ${t.starred ? "btn-primary" : "btn-secondary"}`}
                >
                  <StarIcon size={16} weight={t.starred ? "fill" : "regular"} aria-hidden="true" />
                  {t.starred ? "Starred" : "Star"} · {t.stars}
                </button>
              </form>
            ) : (
              <Link
                href={`/sign-in?redirect_url=${encodeURIComponent(`/gallery/${t.id}`)}`}
                className="btn btn-secondary inline-flex items-center gap-2"
              >
                <StarIcon size={16} aria-hidden="true" />
                Star · {t.stars}
              </Link>
            )}
            <a href={t.links.archive} className="btn btn-secondary inline-flex items-center gap-2">
              <DownloadSimpleIcon size={16} aria-hidden="true" />
              Download zip
            </a>
            <a
              href={t.links.pdf}
              target="_blank"
              rel="noreferrer"
              className="quiet-link inline-flex items-center gap-1.5 px-2 py-2 text-[0.9rem]"
            >
              <FileTextIcon size={16} aria-hidden="true" />
              PDF
            </a>
          </div>

          <p className="mt-6 whitespace-pre-line leading-relaxed text-ink-2">{t.description}</p>

          {t.tags.length ? (
            <ul className="mt-5 flex flex-wrap gap-1.5" aria-label="Tags">
              {t.tags.map((tag) => (
                <li key={tag}>
                  <Link
                    href={`/gallery?tag=${encodeURIComponent(tag)}`}
                    className="badge hover:text-ink"
                  >
                    {tag}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}

          <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-rule pt-5 text-[0.88rem] sm:grid-cols-4">
            <div>
              <dt className="text-ink-3">Files</dt>
              <dd>{t.fileCount}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Size</dt>
              <dd>{formatBytes(t.totalBytes)}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Pages</dt>
              <dd>{t.pages ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Downloads</dt>
              <dd>{t.downloads}</dd>
            </div>
          </dl>

          <section className="mt-8" aria-labelledby="use-title">
            <h2 id="use-title" className="font-serif text-xl">
              Use it
            </h2>
            <pre className="mt-3 overflow-x-auto bg-code p-4 font-mono text-[0.82rem] leading-relaxed">
              {`npm i -g @jibaru/latex-api-cli
latex-api gallery use ${t.id} ${t.slug}
latex-api compile ${t.slug} --entrypoint ${t.entrypoint}`}
            </pre>
            <p className="mt-3 text-[0.85rem] text-ink-3">
              Shared under{" "}
              <a href={t.license.url} className="link">
                {t.license.name}
              </a>
              : reuse and adapt it freely, crediting {t.author.name}.
            </p>
          </section>

          {t.canEdit || t.canModerate ? (
            <section className="mt-10 border-t border-rule pt-6" aria-labelledby="manage-title">
              <h2 id="manage-title" className="smallcaps">
                {t.canEdit ? "Your template" : "Moderation"}
              </h2>
              {t.canModerate && t.reports !== undefined ? (
                <p className="mt-2 text-[0.88rem] text-ink-2">
                  {t.reports} {t.reports === 1 ? "report" : "reports"}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-3">
                {t.canEdit ? (
                  <Link href={`/gallery/new?update=${t.id}`} className="btn btn-secondary">
                    Publish a new version
                  </Link>
                ) : null}
                {t.canModerate ? (
                  <form action={setHidden}>
                    <input type="hidden" name="id" value={t.id} />
                    <input type="hidden" name="hidden" value={String(!t.hidden)} />
                    <button type="submit" className="btn btn-secondary">
                      {t.hidden ? "Unhide" : "Hide"}
                    </button>
                  </form>
                ) : null}
                <details>
                  <summary className="btn btn-secondary cursor-pointer list-none text-accent">
                    Delete…
                  </summary>
                  <form action={removeTemplate} className="mt-3">
                    <input type="hidden" name="id" value={t.id} />
                    <p className="text-[0.85rem] text-ink-2">
                      Its {t.stars} {t.stars === 1 ? "star" : "stars"} and downloads are lost.
                    </p>
                    <button type="submit" className="btn btn-primary mt-2">
                      Delete permanently
                    </button>
                  </form>
                </details>
              </div>
            </section>
          ) : signedIn ? (
            <ReportForm id={t.id} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

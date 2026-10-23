import {
  ArrowSquareOutIcon,
  DownloadSimpleIcon,
  FileTextIcon,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { fetchTemplates } from "@/lib/api";
import { apiBase } from "@/lib/shared";

const categoryLabel: Record<string, string> = {
  paper: "Paper",
  cv: "Résumé",
  brochure: "Brochure",
  poster: "Poster",
  report: "Report",
  letter: "Letter",
  other: "Other",
};

export async function Templates() {
  const { data: templates } = await fetchTemplates();

  return (
    <section id="templates" aria-labelledby="templates-title" className="border-t border-rule">
      <div className="wrap py-20 lg:py-28">
        <div className="max-w-[60ch]">
          <h2 id="templates-title" className="heading text-3xl sm:text-4xl">
            Start from a template
          </h2>
          <p className="mt-4 text-[1.05rem] leading-relaxed text-ink-2">
            Every template compiles inside the sandbox as shipped. Download the zip, or send only
            the files you changed to{" "}
            <code className="font-mono text-[0.9em]">/v1/templates/:id/compile</code>.
          </p>
        </div>
        <ul className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <li key={t.id} className="plate flex">
              <article className="plate-inner flex w-full flex-col p-5">
                <div className="flex items-center justify-between gap-3">
                  <span className="smallcaps">{categoryLabel[t.category] ?? t.category}</span>
                  <span className="badge">{t.engine}</span>
                </div>
                <h3 className="mt-3 font-serif text-[1.35rem] font-medium leading-tight">
                  {t.name}
                </h3>
                <p className="mt-2 flex-1 text-[0.9rem] leading-relaxed text-ink-2">
                  {t.description}
                </p>
                <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 border-t border-rule pt-4 text-[0.85rem]">
                  <a
                    href={`${apiBase}/v1/templates/${t.id}/preview`}
                    className="quiet-link inline-flex items-center gap-1.5 py-1.5"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <FileTextIcon size={15} weight="light" aria-hidden="true" />
                    Preview PDF
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                  <a
                    href={`${apiBase}/v1/templates/${t.id}/archive`}
                    className="quiet-link inline-flex items-center gap-1.5 py-1.5"
                  >
                    <DownloadSimpleIcon size={15} weight="light" aria-hidden="true" />
                    Download zip
                  </a>
                  <Link
                    href={`/docs/templates#${t.id}`}
                    className="quiet-link inline-flex items-center gap-1.5 py-1.5"
                  >
                    <ArrowSquareOutIcon size={15} weight="light" aria-hidden="true" />
                    Open in docs
                  </Link>
                </div>
              </article>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

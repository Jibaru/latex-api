"use client";

import { useActionState } from "react";
import { type PublishState, publishTemplate } from "@/app/gallery/actions";

const initial: PublishState = { status: "idle" };

const CATEGORIES = [
  ["report", "Report or thesis"],
  ["paper", "Paper"],
  ["cv", "Résumé / CV"],
  ["poster", "Poster"],
  ["brochure", "Brochure"],
  ["letter", "Letter"],
  ["other", "Other"],
] as const;

const field =
  "mt-2 w-full border border-rule-strong bg-paper px-3 py-2.5 text-[0.95rem] placeholder:text-ink-3 focus-visible:border-accent";

export function PublishForm({
  existing,
}: {
  existing?: {
    id: string;
    name: string;
    description: string;
    category: string;
    tags: string;
    entrypoint: string;
  };
}) {
  const [state, action, pending] = useActionState(publishTemplate, initial);
  return (
    <form action={action} className="mt-8 space-y-6">
      {existing ? <input type="hidden" name="replaceId" value={existing.id} /> : null}
      <div>
        <label htmlFor="pub-files" className="block text-[0.9rem] font-medium">
          Project
        </label>
        <input
          id="pub-files"
          name="files"
          type="file"
          required
          multiple
          accept=".zip,.tex,.bib,.cls,.sty,.png,.jpg,.jpeg,.pdf,.svg"
          aria-describedby="pub-files-hint"
          className={`${field} file:mr-3 file:border-0 file:bg-code file:px-3 file:py-1.5`}
        />
        <p id="pub-files-hint" className="mt-1.5 text-[0.82rem] text-ink-3">
          A .zip keeps your folders. Up to 20 MB; leave out PDFs and build files.
        </p>
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <label htmlFor="pub-name" className="block text-[0.9rem] font-medium">
            Name
          </label>
          <input
            id="pub-name"
            name="name"
            required={!existing}
            minLength={3}
            maxLength={80}
            defaultValue={existing?.name}
            placeholder="Tesis UNTELS (APA 7)"
            className={field}
          />
        </div>
        <div>
          <label htmlFor="pub-category" className="block text-[0.9rem] font-medium">
            Category
          </label>
          <select
            id="pub-category"
            name="category"
            defaultValue={existing?.category ?? "report"}
            className={field}
          >
            {CATEGORIES.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="pub-description" className="block text-[0.9rem] font-medium">
          Description
        </label>
        <textarea
          id="pub-description"
          name="description"
          required={!existing}
          minLength={20}
          maxLength={1000}
          rows={4}
          defaultValue={existing?.description}
          placeholder="What it is for, what it includes (chapters, bibliography style, fonts), and anything people should change first."
          className={field}
        />
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <label htmlFor="pub-tags" className="block text-[0.9rem] font-medium">
            Tags
          </label>
          <input
            id="pub-tags"
            name="tags"
            maxLength={220}
            defaultValue={existing?.tags}
            placeholder="tesis, apa, español"
            aria-describedby="pub-tags-hint"
            className={field}
          />
          <p id="pub-tags-hint" className="mt-1.5 text-[0.82rem] text-ink-3">
            Comma-separated, up to 8.
          </p>
        </div>
        <div>
          <label htmlFor="pub-entrypoint" className="block text-[0.9rem] font-medium">
            Main file <span className="font-normal text-ink-3">(optional)</span>
          </label>
          <input
            id="pub-entrypoint"
            name="entrypoint"
            maxLength={200}
            defaultValue={existing?.entrypoint}
            placeholder="main.tex"
            className={field}
          />
        </div>
      </div>
      <label className="flex items-start gap-3 text-[0.9rem] leading-relaxed">
        <input
          type="checkbox"
          name="acceptLicense"
          required
          className="mt-1 size-4 accent-[var(--accent)]"
        />
        <span>
          I can share these files and publish them under{" "}
          <a
            href="https://creativecommons.org/licenses/by/4.0/"
            target="_blank"
            rel="noreferrer"
            className="link"
          >
            CC-BY 4.0
          </a>
          : anyone may reuse and adapt them, crediting me. They contain no private data.
        </span>
      </label>
      <button
        type="submit"
        className="btn btn-primary w-full"
        disabled={pending}
        aria-disabled={pending}
      >
        {pending ? "Compiling and publishing…" : existing ? "Publish new version" : "Publish"}
      </button>
      <div aria-live="polite">
        {state.status === "error" ? (
          <div className="border-l-2 border-accent pl-4 text-[0.9rem]">
            <p className="text-accent">{state.message}</p>
            {state.diagnostics?.length ? (
              <ul className="mt-2 space-y-1 font-mono text-[0.8rem] text-ink-2">
                {state.diagnostics.map((d) => (
                  <li key={`${d.file}:${d.line}:${d.message}`}>
                    {d.file ? `${d.file}${d.line ? `:${d.line}` : ""}: ` : ""}
                    {d.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </form>
  );
}

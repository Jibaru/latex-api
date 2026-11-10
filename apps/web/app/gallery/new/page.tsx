import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PublishForm } from "@/components/gallery/publish-form";
import { getGalleryTemplate } from "@/lib/gallery";

export const metadata: Metadata = { title: "Publish a template" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function NewGalleryTemplatePage({ searchParams }: Props) {
  const params = await searchParams;
  const update = typeof params.update === "string" ? params.update : undefined;
  const { userId } = await auth();
  if (!userId) {
    redirect(
      `/sign-in?redirect_url=${encodeURIComponent(update ? `/gallery/new?update=${update}` : "/gallery/new")}`,
    );
  }
  const existing = update ? (await getGalleryTemplate(update)).data?.template : undefined;
  if (update && !existing?.canEdit) redirect(`/gallery/${update}`);

  return (
    <div className="max-w-[44rem]">
      <Link
        href={existing ? `/gallery/${existing.id}` : "/gallery"}
        className="quiet-link text-[0.88rem]"
      >
        ← {existing ? existing.name : "Gallery"}
      </Link>
      <h1 className="heading mt-4 text-3xl sm:text-4xl">
        {existing ? "Publish a new version" : "Publish a template"}
      </h1>
      <p className="mt-4 leading-relaxed text-ink-2">
        Upload a <strong className="text-ink">.zip</strong> of your project (or its .tex files). We
        compile it in the sandbox first; only templates that produce a PDF are published, with a
        preview of the first page. From a terminal:{" "}
        <code className="font-mono text-[0.88em]">latex-api gallery publish ./my-template</code>.
      </p>
      <PublishForm
        existing={
          existing
            ? {
                id: existing.id,
                name: existing.name,
                description: existing.description,
                category: existing.category,
                tags: existing.tags.join(", "),
                entrypoint: existing.entrypoint,
              }
            : undefined
        }
      />
    </div>
  );
}

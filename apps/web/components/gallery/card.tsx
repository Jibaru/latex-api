import { StarIcon } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { formatDate, type GalleryItem } from "@/lib/gallery";

export function GalleryCard({ item }: { item: GalleryItem }) {
  return (
    <li className="plate flex">
      <article className="plate-inner flex w-full flex-col">
        <Link
          href={`/gallery/${item.id}`}
          className="group block border-b border-rule bg-white"
          aria-label={item.name}
        >
          <div className="aspect-[4/3] overflow-hidden">
            {/* biome-ignore lint/performance/noImgElement: thumbnails come from the API, not next/image */}
            <img
              src={item.links.thumbnail}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.02]"
            />
          </div>
        </Link>
        <div className="flex flex-1 flex-col p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="smallcaps">{item.category}</span>
            <span
              className={`inline-flex items-center gap-1 text-[0.85rem] ${item.starred ? "text-accent" : "text-ink-2"}`}
              title={item.starred ? "You starred this" : undefined}
            >
              <StarIcon size={14} weight={item.starred ? "fill" : "regular"} aria-hidden="true" />
              {item.stars}
              <span className="sr-only"> stars</span>
            </span>
          </div>
          <h3 className="mt-2 font-serif text-[1.2rem] font-medium leading-tight">
            <Link href={`/gallery/${item.id}`} className="hover:text-accent">
              {item.name}
            </Link>
            {item.hidden ? <span className="badge ml-2 align-middle">hidden</span> : null}
          </h3>
          <p className="mt-1 text-[0.82rem] text-ink-3">
            {item.author.name} · {formatDate(item.createdAt)}
          </p>
          <p className="mt-2 line-clamp-3 flex-1 text-[0.88rem] leading-relaxed text-ink-2">
            {item.description}
          </p>
          {item.tags.length ? (
            <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Tags">
              {item.tags.map((tag) => (
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
        </div>
      </article>
    </li>
  );
}

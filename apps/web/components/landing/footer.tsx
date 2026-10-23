import Link from "next/link";
import { appName, githubUrl } from "@/lib/shared";

export function Footer() {
  return (
    <footer className="border-t border-rule">
      <div className="wrap flex flex-col gap-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <p className="font-serif text-[1.05rem]">
          <span aria-hidden="true" className="mr-2 text-accent">
            §
          </span>
          {appName}
        </p>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 text-[0.9rem]">
          <a href={githubUrl} className="quiet-link py-2">
            GitHub
          </a>
          <Link href="/docs" className="quiet-link py-2">
            Docs
          </Link>
          <a href="/reference" className="quiet-link py-2">
            API reference
          </a>
          <a href="/health" className="quiet-link py-2">
            Status
          </a>
        </nav>
        <p className="text-[0.85rem] text-ink-2">Built by Jibaru · MIT</p>
      </div>
    </footer>
  );
}

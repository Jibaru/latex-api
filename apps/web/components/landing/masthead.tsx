import { GithubLogoIcon } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { appName, githubUrl } from "@/lib/shared";
import { ThemeToggle } from "./theme-toggle";

const items = [
  { href: "/docs", label: "Docs", phone: true },
  { href: "/reference", label: "Reference", phone: false },
  { href: "#templates", label: "Templates", phone: false },
  { href: "#playground", label: "Playground", phone: true },
];

export function Masthead() {
  return (
    <header className="border-b border-rule">
      <div className="wrap flex h-16 items-center justify-between gap-4">
        <Link
          href="/"
          className="flex items-baseline gap-2 py-2 font-serif text-[1.15rem] font-medium tracking-tight text-ink"
        >
          <span aria-hidden="true" className="text-accent">
            §
          </span>
          {appName}
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-0.5 sm:gap-1">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`quiet-link px-2 py-2.5 text-[0.9rem] ${item.phone ? "" : "hidden md:inline-block"}`}
            >
              {item.label}
            </Link>
          ))}
          <a
            href={githubUrl}
            className="quiet-link inline-flex size-11 items-center justify-center"
          >
            <GithubLogoIcon size={19} weight="light" aria-hidden="true" />
            <span className="sr-only">GitHub repository</span>
          </a>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}

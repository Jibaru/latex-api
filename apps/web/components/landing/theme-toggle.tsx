"use client";

import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useTheme } from "next-themes";

/**
 * The icon and the accessible label are switched by the `.dark` class in CSS, so the
 * server and the first client render agree without waiting for the theme to be read.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <button
      type="button"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      className={`inline-flex size-11 items-center justify-center border border-transparent text-ink-2 transition-colors duration-300 hover:border-rule-strong hover:text-ink ${className ?? ""}`}
    >
      <SunIcon size={18} weight="light" className="hidden dark:block" aria-hidden="true" />
      <MoonIcon size={18} weight="light" className="dark:hidden" aria-hidden="true" />
      <span className="sr-only dark:hidden">Switch to dark mode</span>
      <span className="sr-only hidden dark:inline">Switch to light mode</span>
    </button>
  );
}

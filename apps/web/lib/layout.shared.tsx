import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName, githubUrl } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="font-serif text-[1.05rem] font-medium tracking-tight">{appName}</span>
      ),
      url: "/",
    },
    githubUrl,
    links: [
      { text: "Playground", url: "/#playground" },
      { text: "Interactive reference", url: "/reference" },
    ],
  };
}

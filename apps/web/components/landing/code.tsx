import { highlight } from "fumadocs-core/highlight";

interface CodeProps {
  code: string;
  lang: "bash" | "javascript" | "typescript" | "python" | "latex" | "json";
  label?: string;
  className?: string;
}

/** Server-rendered, syntax-highlighted code. No client JS. */
export async function Code({ code, lang, label, className }: CodeProps) {
  const rendered = await highlight(code, {
    lang,
    themes: { light: "vitesse-light", dark: "vitesse-dark" },
    defaultColor: false,
  });

  return (
    <figure className={`plate ${className ?? ""}`}>
      {label ? (
        <figcaption className="flex items-center justify-between px-3 pt-1 pb-2">
          <span className="font-mono text-[0.72rem] text-ink-2">{label}</span>
        </figcaption>
      ) : null}
      <div className="plate-inner code-block">{rendered}</div>
    </figure>
  );
}

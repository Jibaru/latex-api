import { ImageResponse } from "next/og";
import { appName } from "@/lib/shared";

export const alt = `${appName}: compile LaTeX in the cloud. One HTTP call.`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

async function loadSerif(): Promise<ArrayBuffer | undefined> {
  try {
    const css = await fetch(
      "https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400&display=swap",
      { headers: { "user-agent": "Mozilla/5.0" } },
    ).then((r) => r.text());
    const url = /src: url\((.+?)\) format\('(?:truetype|opentype)'\)/.exec(css)?.[1];
    if (!url) return undefined;
    return await fetch(url).then((r) => r.arrayBuffer());
  } catch {
    return undefined;
  }
}

export default async function Image() {
  const serif = await loadSerif();
  const family = serif ? "Newsreader" : "serif";

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "64px 72px",
        background: "#f6f2ea",
        color: "#2a2622",
        fontFamily: family,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 30 }}>
        <span style={{ color: "#a7311c" }}>§</span>
        <span>{appName}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div
          style={{
            fontSize: 88,
            lineHeight: 1.02,
            letterSpacing: -2,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <span>Compile LaTeX in the cloud.</span>
          <span style={{ color: "#a7311c" }}>One HTTP call.</span>
        </div>
        <div style={{ fontSize: 30, color: "#5b5650", marginTop: 8 }}>
          PDF out, structured diagnostics in JSON, sandboxed TeX Live 2026.
        </div>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          borderTop: "1px solid #c9c1b3",
          paddingTop: 20,
          fontSize: 24,
          color: "#5b5650",
        }}
      >
        <span>latex-api.crafter.run</span>
        <span>Open source, MIT</span>
      </div>
    </div>,
    {
      ...size,
      fonts: serif
        ? [{ name: "Newsreader", data: serif, style: "normal", weight: 400 }]
        : undefined,
    },
  );
}

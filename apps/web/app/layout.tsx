import { ClerkProvider } from "@clerk/nextjs";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from "next/font/google";
import { clerkAppearance } from "@/lib/clerk";
import { appName, siteUrl } from "@/lib/shared";
import "./global.css";

const serif = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  variable: "--font-serif-stack",
  display: "swap",
});

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans-stack",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono-stack",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: `${appName}: compile LaTeX in the cloud`,
    template: `%s | ${appName}`,
  },
  description:
    "Compile LaTeX in the cloud with one HTTP call. Sync and async jobs, multi-file projects, three engines, structured diagnostics, templates and a sandboxed TeX Live 2026. Open source, self-hostable.",
  applicationName: appName,
  openGraph: {
    type: "website",
    siteName: appName,
    url: siteUrl,
    title: `${appName}: compile LaTeX in the cloud`,
    description: "One HTTP call in, a PDF and structured diagnostics out.",
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f2ea" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1a17" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${serif.variable} ${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        <ClerkProvider appearance={clerkAppearance}>
          <RootProvider
            theme={{ defaultTheme: "system", enableSystem: true, disableTransitionOnChange: true }}
          >
            {children}
          </RootProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}

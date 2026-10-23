import type { ClerkProvider } from "@clerk/nextjs";
import type { ComponentProps } from "react";

type Appearance = NonNullable<ComponentProps<typeof ClerkProvider>["appearance"]>;

/**
 * Clerk components follow the same paper-and-ink tokens as the rest of the site, so they
 * switch with the theme without a second palette.
 */
export const clerkAppearance: Appearance = {
  variables: {
    colorPrimary: "var(--accent)",
    colorPrimaryForeground: "var(--accent-ink)",
    colorBackground: "var(--paper)",
    colorForeground: "var(--ink)",
    colorMuted: "var(--paper-2)",
    colorMutedForeground: "var(--ink-2)",
    colorInput: "var(--paper)",
    colorInputForeground: "var(--ink)",
    colorBorder: "var(--rule-strong)",
    colorNeutral: "var(--ink)",
    colorDanger: "var(--accent)",
    colorRing: "var(--accent)",
    colorShadow: "transparent",
    fontFamily: "var(--font-sans-stack), system-ui, sans-serif",
    fontFamilyButtons: "var(--font-sans-stack), system-ui, sans-serif",
    borderRadius: "0.125rem",
  },
  elements: {
    card: { boxShadow: "none", border: "1px solid var(--rule)" },
    headerTitle: {
      fontFamily: "var(--font-serif-stack), Georgia, serif",
      fontWeight: 500,
      fontSize: "1.5rem",
    },
    footer: { background: "var(--paper-2)" },
    formButtonPrimary: { boxShadow: "none", textTransform: "none" },
  },
};

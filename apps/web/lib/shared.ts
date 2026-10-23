export const appName = "LaTeX API";
export const siteUrl = "https://latex-api.crafter.run";
export const githubUrl = "https://github.com/jibaru/latex-api";
export const docsRoute = "/docs";

/**
 * Base URL of the API as seen from the browser and from the server.
 * Empty string means "same origin": in production the web app and the API
 * are served from one host (web at `/` and `/docs`, API at `/v1`).
 */
export const apiBase = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

/** Absolute API base for server-side fetches (same-origin is not available on the server). */
export function serverApiBase(): string {
  if (apiBase) return apiBase;
  if (process.env.API_INTERNAL_URL) return process.env.API_INTERNAL_URL.replace(/\/$/, "");
  return siteUrl;
}

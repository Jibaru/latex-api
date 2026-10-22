import { ApiReference } from "@scalar/nextjs-api-reference";

export const runtime = "nodejs";

export const GET = ApiReference({
  url: "/openapi.json",
  pageTitle: "LaTeX API Reference",
  theme: "kepler",
  hideClientButton: false,
});

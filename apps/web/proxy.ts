import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Public-first: the landing page and docs stay public; the account area and the CLI
 * approval page need a session. API routes (/v1, /openapi.json, ...) never reach this app.
 */
const isProtected = createRouteMatcher(["/dashboard(.*)", "/cli/authorize(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) await auth.protect();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|pdf)).*)",
  ],
};

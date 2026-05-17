/**
 * Route guard. Insights is the public landing (mirrors the role the
 * legacy Dashboard used to play); every other authed page redirects
 * to /login when the user has no session. Per-page role gating is
 * handled inside the page component itself.
 *
 * Edge-runtime safe: imports `authConfig` (no DB), not `auth.ts` (uses
 * better-sqlite3 which the Edge runtime can't load).
 */
import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";

const { auth } = NextAuth(authConfig);

// `/dashboard` stays public so legacy bookmarks still resolve even
// though it's no longer in the sidebar.
const PUBLIC_PATHS = new Set<string>(["/", "/login", "/dashboard", "/insights", "/guide"]);

export default auth((req) => {
  const path = req.nextUrl.pathname;
  // Public-mode escape hatch — set DISABLE_AUTH=true in Vercel to let
  // every page render unauthenticated while the auth flow is broken.
  // TEMPORARY. Remove the moment NextAuth is working again.
  if (process.env.DISABLE_AUTH === "true") return;
  if (PUBLIC_PATHS.has(path)) return;
  // Never redirect API routes — they should return their own JSON status
  // codes (401/403/404). Each route owns its auth check.
  if (path.startsWith("/api/")) return;
  if (path.startsWith("/_next")) return;

  if (!req.auth) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", path);
    return Response.redirect(loginUrl);
  }
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

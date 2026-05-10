/**
 * Route guard. The Dashboard is public (matches the Streamlit version);
 * every other authed page redirects to /login when the user has no session.
 * Per-page role gating is handled inside the page component itself.
 *
 * Edge-runtime safe: imports `authConfig` (no DB), not `auth.ts` (uses
 * better-sqlite3 which the Edge runtime can't load).
 */
import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";

const { auth } = NextAuth(authConfig);

const PUBLIC_PATHS = new Set<string>(["/", "/login", "/dashboard"]);

export default auth((req) => {
  const path = req.nextUrl.pathname;
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

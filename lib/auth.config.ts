/**
 * Edge-safe NextAuth config — used by middleware (which runs on the Edge
 * runtime where Node-only modules like better-sqlite3 are not allowed).
 *
 * The Credentials provider's `authorize()` callback (the only DB-touching
 * part of auth) is added in `lib/auth.ts`, which runs on the Node runtime
 * (server components and API routes). Middleware only needs to read the
 * JWT cookie, which doesn't require any provider's authorize fn.
 */
import type { NextAuthConfig } from "next-auth";
import type { Role } from "@/lib/access";

const isProd = process.env.NODE_ENV === "production";

export const authConfig = {
  // 8-hour JWT sessions. Picked over 30-day default because the tracker is
  // an internal Ops tool — daily re-auth is a fair price for tighter
  // exposure if a token leaks.
  session: { strategy: "jwt", maxAge: 60 * 60 * 8, updateAge: 60 * 60 },
  pages:   { signIn: "/login" },
  // Trust the forwarded host header. Required on Vercel — without this,
  // NextAuth v5 throws MissingCSRF on POST /api/auth/callback/credentials
  // because the Host header (the Vercel proxy domain) doesn't match the
  // request URL host that NextAuth expects.
  // https://authjs.dev/getting-started/migrating-to-v5#trust-host
  trustHost: true,
  // Bind the secret EXPLICITLY rather than relying on NextAuth's env
  // auto-discovery. The symptom of not doing this on Vercel: cookies
  // get encrypted with one auto-generated secret on the function that
  // issued the login, then decrypted on a different function instance
  // that generated its own — resulting in
  //   "JWTSessionError: no matching decryption secret"
  // on every request after sign-in.
  //
  // Reads AUTH_SECRET (v5 canonical name) first, then NEXTAUTH_SECRET
  // (v4 / Vercel-defaulted name) so existing prod env vars keep working.
  secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
  /**
   * Pin cookie defaults so a future NextAuth upgrade can't quietly weaken
   * them. `__Secure-` prefix is enforced by browsers when cookies declare
   * `secure: true` — together they make the cookie HTTPS-only.
   */
  cookies: {
    sessionToken: {
      name: isProd
        ? "__Secure-next-auth.session-token"
        : "next-auth.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: isProd,
      },
    },
    callbackUrl: {
      name: isProd
        ? "__Secure-next-auth.callback-url"
        : "next-auth.callback-url",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: isProd,
      },
    },
    csrfToken: {
      name: isProd
        ? "__Host-next-auth.csrf-token"
        : "next-auth.csrf-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: isProd,
      },
    },
  },
  // Providers are populated in `lib/auth.ts` — middleware doesn't need them.
  providers: [],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // Persist role + username on the token so middleware can read them
        // without hitting the DB.
        token.role = user.role;
        token.username = user.username;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        // The JWT augmentation in next-auth.d.ts adds `role` + `username`,
        // but the Edge build of next-auth's types resolves these as `{}`
        // before our augmentation kicks in. Cast to keep the runtime
        // assignment intact without losing the augmentation in consumers.
        if (token.role)     session.user.role     = token.role     as Role;
        if (token.username) session.user.username = token.username as string;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;

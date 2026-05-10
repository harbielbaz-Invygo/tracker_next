/**
 * NextAuth.js v5 (Auth.js) configuration — Node-runtime only.
 * Username + password against the local users table.
 * Mirrors `tracker_v1/auth.py` role model: admin | partnership | ops.
 *
 * Edge-safe shared config lives in `./auth.config.ts`. Middleware imports
 * that file directly so it doesn't pull in `better-sqlite3`.
 */
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { authConfig } from "./auth.config";
// Side-effect import: validates NEXTAUTH_SECRET / NEXTAUTH_URL / DATABASE_URL
// at process boot. Hard-fails in production if any are missing.
import "@/lib/env";

// Re-export pure access-control rules. Client components and the Edge
// runtime should import these from `@/lib/access` directly to avoid
// pulling NextAuth + better-sqlite3 into their bundles.
export { ALL_VIEWS, ACCESS, canAccess } from "./access";
export type { Role, ViewName } from "./access";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const username = String(credentials?.username ?? "").trim();
        const password = String(credentials?.password ?? "");
        if (!username || !password) return null;

        const [user] = await db.select().from(users).where(eq(users.username, username));
        if (!user) return null;

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return null;

        return {
          id: String(user.id),
          name: user.name ?? user.username,
          email: user.email ?? undefined,
          role: user.role,
          username: user.username,
        };
      },
    }),
  ],
});

/**
 * NextAuth (Auth.js) module augmentation.
 *
 * Adds the custom `role` and `username` fields we set in the JWT/session
 * callbacks (see `lib/auth.config.ts`) so consumers get full type safety
 * — letting us drop every `@ts-expect-error` previously needed.
 */
import type { DefaultSession } from "next-auth";
import type { Role } from "@/lib/access";

declare module "next-auth" {
  interface User {
    role: Role;
    username: string;
  }
  interface Session {
    user: DefaultSession["user"] & {
      id?: string;
      role: Role;
      username: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    /** Numeric user id (as string) — mirrors `users.id`. Persisted
     *  through the jwt callback so server gates can resolve the
     *  signed-in account without a DB lookup. */
    userId?: string;
    role?: Role;
    username?: string;
  }
}

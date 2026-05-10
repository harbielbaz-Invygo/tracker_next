/**
 * Centralised, validated environment variables.
 *
 * Imported once at the top of `lib/db/index.ts` and `lib/auth.ts` so the
 * boot process fails fast and loud when a required variable is missing
 * or set to an obviously-insecure development value.
 *
 * Rules:
 *   - DATABASE_URL is required everywhere.
 *   - NEXTAUTH_SECRET must be ≥32 chars (`openssl rand -base64 32`).
 *   - NEXTAUTH_URL must be a full URL (used by NextAuth for callbacks).
 *   - The well-known dev secret is rejected outright in non-development.
 *   - In production, missing/invalid env exits the process. In dev,
 *     it logs and continues so `next dev` doesn't blow up while you
 *     fix .env.
 */
import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /**
   * Turso auth token. Required when DATABASE_URL starts with `libsql://`,
   * unused for local `file:` URLs. Validated as optional here; lib/db
   * throws a precise error if a remote URL is paired with no token.
   */
  TURSO_AUTH_TOKEN: z.string().optional(),
  NEXTAUTH_SECRET: z.string().min(32,
    "NEXTAUTH_SECRET must be at least 32 chars. Generate with `openssl rand -base64 32`"),
  NEXTAUTH_URL: z.string().url("NEXTAUTH_URL must be a full URL (e.g. http://localhost:3000)"),
});

export type Env = z.infer<typeof Env>;

const parsed = Env.safeParse(process.env);

// Log validation failures once per Node process. Next.js dev re-imports
// modules on HMR; without this guard the same error would print on every
// edit. The flag lives on globalThis because `import` returns cached
// module-instances per worker but globalThis persists across re-evaluations.
declare global {
  // eslint-disable-next-line no-var
  var __envValidationLogged: boolean | undefined;
}

if (!parsed.success && !globalThis.__envValidationLogged) {
  globalThis.__envValidationLogged = true;
  // eslint-disable-next-line no-console
  console.error("❌ Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`   • ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  // eslint-disable-next-line no-console
  console.error(
    "   Tip: create a `.env.local` file in tracker_next/ with these vars so " +
    "you don't have to set them in every shell. (See README / chat for the recipe.)",
  );
  if (process.env.NODE_ENV === "production") {
    process.exit(1);
  }
}

// Reject the documented dev value in any non-development env.
if (
  process.env.NODE_ENV !== "development" &&
  process.env.NEXTAUTH_SECRET === "dev-secret-change-me"
) {
  // eslint-disable-next-line no-console
  console.error(
    "❌ NEXTAUTH_SECRET is set to the documented dev value `dev-secret-change-me`.\n" +
    "   Generate a real secret: `openssl rand -base64 32` and put it in .env.\n" +
    "   Refusing to start.",
  );
  process.exit(1);
}

/**
 * Validated, typed environment. Falls back to a permissive shape only
 * when validation failed in non-production (so dev keeps booting).
 */
export const env: Env = parsed.success
  ? parsed.data
  : ({
      NODE_ENV: (process.env.NODE_ENV as Env["NODE_ENV"]) ?? "development",
      DATABASE_URL: process.env.DATABASE_URL ?? "file:./data/tracker.db",
      TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
      NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET ?? "",
      NEXTAUTH_URL: process.env.NEXTAUTH_URL ?? "http://localhost:3000",
    } as Env);

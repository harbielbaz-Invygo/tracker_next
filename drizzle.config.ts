/**
 * Drizzle Kit config — used by `npm run db:push`, `db:studio`, `db:generate`.
 *
 * Single dialect ("turso") covers both backends:
 *   - "file:..."     → local SQLite via libSQL client
 *   - "libsql://..." → remote Turso (auth token required)
 *
 * The runtime driver in `lib/db/index.ts` mirrors this — both paths use
 * the same `@libsql/client` so the SQL dialect stays consistent.
 */
import { readFileSync, existsSync } from "node:fs";
import type { Config } from "drizzle-kit";

/**
 * Auto-load `.env.local` (then `.env`) if present. Drizzle-kit doesn't
 * do this on its own — without it, `npm run db:push` silently fails when
 * env vars aren't already set in the shell.
 */
for (const envFile of [".env.local", ".env"]) {
  if (!existsSync(envFile)) continue;
  const content = readFileSync(envFile, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key]) continue; // shell value wins
    const v = rawValue.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
    process.env[key] = v;
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is required.\n" +
    "  • Local dev:  DATABASE_URL=file:./data/tracker.db (in .env.local)\n" +
    "  • Turso:      DATABASE_URL=libsql://<your-db>.turso.io  +  TURSO_AUTH_TOKEN=...",
  );
}

const isRemote = url.startsWith("libsql://") || url.startsWith("https://") || url.startsWith("wss://");

const config = {
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "turso" as const,
  dbCredentials: isRemote
    ? { url, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url },
};

export default config satisfies Config;

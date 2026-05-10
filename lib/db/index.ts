/**
 * Database client — libSQL driver (works for both local SQLite and Turso).
 *
 * URL prefix selects the backend:
 *   - "file:..."     → local SQLite via libSQL client (dev, scripts)
 *   - "libsql://..." → remote Turso (prod / preview on Vercel)
 *
 * The libSQL client uses the same SQLite SQL dialect — no schema changes
 * needed. Drizzle's `db.transaction(...)` callback is async with this
 * driver, so all transactional routes (`api/intake/create`,
 * `api/batch-action`) use `await tx.insert(...)` / `await tx.update(...)`
 * inside the body.
 *
 * Auth token is required when DATABASE_URL is `libsql://...`. Read from
 * TURSO_AUTH_TOKEN; ignored for `file:` URLs.
 */
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";
import { env } from "@/lib/env";

function isFileUrl(url: string): boolean {
  return url.startsWith("file:") || !url.includes("://");
}

function isLibsqlUrl(url: string): boolean {
  return url.startsWith("libsql://") || url.startsWith("https://") || url.startsWith("wss://");
}

let client: Client;

if (isFileUrl(env.DATABASE_URL)) {
  // Local file — make sure the directory exists so a fresh checkout works.
  const dbPath = env.DATABASE_URL.replace(/^file:/, "");
  if (dbPath && dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  client = createClient({ url: env.DATABASE_URL });
} else if (isLibsqlUrl(env.DATABASE_URL)) {
  if (!env.TURSO_AUTH_TOKEN) {
    throw new Error(
      "DATABASE_URL is a remote libSQL URL but TURSO_AUTH_TOKEN is unset.\n" +
      "  - Local dev: use `file:./data/tracker.db` instead.\n" +
      "  - Production: set TURSO_AUTH_TOKEN in your environment (Vercel → Project → Settings → Environment Variables).",
    );
  }
  client = createClient({ url: env.DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
} else {
  throw new Error(
    `Unrecognised DATABASE_URL: ${env.DATABASE_URL.slice(0, 24)}…\n` +
    "Expected `file:./path` (local) or `libsql://…` (Turso).",
  );
}

export const db = drizzle(client, { schema });
export { schema };

// ──────────────────────────────────────────────────────────────────
// Graceful shutdown
// ──────────────────────────────────────────────────────────────────
//
// File-backed libSQL keeps file handles open until close() — on SIGTERM
// we want a clean close so the WAL is checkpointed. For remote Turso the
// client is HTTP-based; close() just tears down the keep-alive sockets.
// Skipped during Next.js build (no server lifecycle).
if (typeof process !== "undefined" && process.env.NEXT_PHASE !== "phase-production-build") {
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.info(`[db] received ${signal}, closing connection…`);
    try { client.close(); } catch { /* already closed */ }
    setTimeout(() => process.exit(0), 50);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT",  () => shutdown("SIGINT"));
}

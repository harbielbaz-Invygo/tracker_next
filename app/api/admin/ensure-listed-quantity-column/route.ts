/**
 * POST/GET /api/admin/ensure-listed-quantity-column
 *
 * Defensive migration for partial App Listing. Adds `listed_quantity` to
 * the `batches` table (how many of a batch's cars are actually live
 * in-app) and backfills it from the existing all-or-nothing flag:
 *   listed_quantity = requested_quantity  WHERE app_listed_at IS NOT NULL
 *   listed_quantity = 0                    otherwise
 * so every already-listed batch reads as fully listed.
 *
 * Partial listing then means 0 < listed_quantity < requested_quantity.
 *
 * Off the Drizzle schema (raw SQL, tolerant) — batches is read via
 * `select().from(batches)` in several loaders, so a declared un-migrated
 * column would 500 them.
 *
 * GET  → status (column exists? how many batches partly/fully listed)
 * POST → ALTER TABLE if missing + backfill + counts
 *
 * Admin-only.
 */
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const ALTER_SQL = `ALTER TABLE batches ADD COLUMN listed_quantity INTEGER NOT NULL DEFAULT 0`;
const BACKFILL_SQL = `
  UPDATE batches
     SET listed_quantity = requested_quantity
   WHERE app_listed_at IS NOT NULL
     AND listed_quantity = 0
`;

interface Report {
  columnExisted: boolean;
  columnCreated: boolean;
  rowsBackfilled: number;
  batchesFullyListed: number;
  batchesPartlyListed: number;
  totalBatches: number;
  dryRun: boolean;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  try {
    const rows = await db.all<{ name: string }>(
      sql.raw(`SELECT name FROM pragma_table_info('${table}') WHERE name='${column}'`),
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function buildReport(write: boolean): Promise<Report> {
  const existed = await columnExists("batches", "listed_quantity");
  let created = false;
  let backfilled = 0;
  if (write) {
    if (!existed) {
      await db.run(sql.raw(ALTER_SQL));
      created = true;
    }
    const res = await db.run(sql.raw(BACKFILL_SQL));
    backfilled = Number((res as { rowsAffected?: number }).rowsAffected ?? 0);
  }

  const ok = existed || created;
  let fully = 0, partly = 0, total = 0;
  if (ok) {
    const tot = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM batches`);
    total = Number(tot[0]?.n ?? 0);
    const f = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM batches WHERE listed_quantity >= requested_quantity AND requested_quantity > 0`);
    fully = Number(f[0]?.n ?? 0);
    const p = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM batches WHERE listed_quantity > 0 AND listed_quantity < requested_quantity`);
    partly = Number(p[0]?.n ?? 0);
  }

  return {
    columnExisted: existed,
    columnCreated: created,
    rowsBackfilled: backfilled,
    batchesFullyListed: fully,
    batchesPartlyListed: partly,
    totalBatches: total,
    dryRun: !write,
  };
}

export async function GET() {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  const report = await buildReport(false);
  return NextResponse.json({ ok: true, ...report });
}

export async function POST(_req: NextRequest) {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  try {
    return NextResponse.json({ ok: true, ...(await buildReport(true)) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return apiError(`Ensure failed: ${msg}`, 500);
  }
}

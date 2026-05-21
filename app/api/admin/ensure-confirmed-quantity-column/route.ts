/**
 * POST /api/admin/ensure-confirmed-quantity-column
 *
 * Defensive migration: adds the `confirmed_quantity` column to the
 * `batches` table if it's missing, then reports how many rows have a
 * non-zero value (i.e. ops has captured a partial-or-full dealer
 * confirmation for that batch).
 *
 * Background: the Confirmation chip on /action-center-flow now lets
 * ops record "dealer confirmed 5 of 10 cars" before VINs arrive. We
 * persist that count so the per-batch reliability scorer can spot
 * dealers who over-confirm vs. what they actually ship.
 *
 * GET  → status check (column exists? row counts)
 * POST → ALTER TABLE if missing + counts
 *
 * Admin-only.
 */
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const ALTER_SQL = `
  ALTER TABLE batches ADD COLUMN confirmed_quantity INTEGER NOT NULL DEFAULT 0
`;

interface Report {
  columnExisted: boolean;
  columnCreated: boolean;
  batchesWithConfirmation: number;
  totalBatches:            number;
  dryRun:                  boolean;
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
  const existed = await columnExists("batches", "confirmed_quantity");
  let created = false;
  if (!existed && write) {
    await db.run(sql.raw(ALTER_SQL));
    created = true;
  }

  const ok = existed || created;
  let withConfirmation = 0;
  let total = 0;
  if (ok) {
    const tot = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM batches`);
    total = Number(tot[0]?.n ?? 0);
    const wc = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM batches WHERE confirmed_quantity > 0`,
    );
    withConfirmation = Number(wc[0]?.n ?? 0);
  }

  return {
    columnExisted:           existed,
    columnCreated:           created,
    batchesWithConfirmation: withConfirmation,
    totalBatches:            total,
    dryRun:                  !write,
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
    const report = await buildReport(true);
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return apiError(`Ensure failed: ${msg}`, 500);
  }
}

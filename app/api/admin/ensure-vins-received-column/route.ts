/**
 * POST /api/admin/ensure-vins-received-column
 *
 * Defensive migration: adds the `vins_received_quantity` column to the
 * `batches` table if it's missing, then reports how many rows have a
 * non-zero value (i.e. dealer has actually shared VINs for that batch).
 *
 * Background: ops captures VIN reception per batch — the dealer sometimes
 * only ships N out of M VINs in the first round. That partial count caps
 * how many cars can be Mark-as-delivered later.
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
  ALTER TABLE batches ADD COLUMN vins_received_quantity INTEGER NOT NULL DEFAULT 0
`;

interface Report {
  columnExisted:  boolean;
  columnCreated:  boolean;
  batchesWithVins: number;
  totalBatches:    number;
  dryRun:          boolean;
}

async function columnExists(): Promise<boolean> {
  try {
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM pragma_table_info('batches') WHERE name='vins_received_quantity'`,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function buildReport(write: boolean): Promise<Report> {
  const existed = await columnExists();
  let created = false;

  if (!existed && write) {
    await db.run(sql.raw(ALTER_SQL));
    created = true;
  }

  const exists = existed || created;
  let withVins = 0;
  let total = 0;
  if (exists) {
    const tot = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM batches`);
    total = Number(tot[0]?.n ?? 0);
    const wv = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM batches WHERE vins_received_quantity > 0`,
    );
    withVins = Number(wv[0]?.n ?? 0);
  }

  return {
    columnExisted:  existed,
    columnCreated:  created,
    batchesWithVins: withVins,
    totalBatches:    total,
    dryRun:          !write,
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

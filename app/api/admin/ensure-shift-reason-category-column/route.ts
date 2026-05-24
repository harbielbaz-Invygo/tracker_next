/**
 * POST /api/admin/ensure-shift-reason-category-column
 *
 * Defensive migration for Audit 3 #4 — adds the
 * `delay_reason_category` column to `batch_date_revisions` so every
 * shift event can be tagged with a reason category. Drives the
 * "Avoidable delays" breakdown on /insights and lets ops separate
 * dealer-supply slips (often unavoidable) from internal-specs slips
 * (usually avoidable).
 *
 * Column intentionally not declared on the Drizzle schema — written
 * + read via raw SQL with try/catch on missing-column. Same pattern
 * as batches.confirmed_quantity / batch_forecasts.submitted_by_
 * stakeholder_id so a pre-migration DB doesn't 500 every query.
 *
 * Allowed values (text, no SQL CHECK constraint — enforced in API):
 *   dealer_supply / internal_specs / customs / logistics /
 *   demand_change / other / null
 *
 * Admin-only.
 */
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const ALTER_SQL = `
  ALTER TABLE batch_date_revisions ADD COLUMN delay_reason_category TEXT
`;

interface Report {
  columnExisted: boolean;
  columnCreated: boolean;
  revisionsWithCategory: number;
  totalRevisions:        number;
  dryRun:                boolean;
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
  const existed = await columnExists("batch_date_revisions", "delay_reason_category");
  let created = false;
  if (!existed && write) {
    await db.run(sql.raw(ALTER_SQL));
    created = true;
  }

  const ok = existed || created;
  let withCategory = 0;
  let total = 0;
  if (ok) {
    const tot = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM batch_date_revisions`);
    total = Number(tot[0]?.n ?? 0);
    const wc = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM batch_date_revisions WHERE delay_reason_category IS NOT NULL`,
    );
    withCategory = Number(wc[0]?.n ?? 0);
  }

  return {
    columnExisted:         existed,
    columnCreated:         created,
    revisionsWithCategory: withCategory,
    totalRevisions:        total,
    dryRun:                !write,
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

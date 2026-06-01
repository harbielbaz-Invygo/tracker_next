/**
 * POST /api/admin/ensure-shift-phase-column
 *
 * Defensive migration for Audit 3 #6 — adds the `phase_at_shift`
 * column to `batch_date_revisions` so every shift event can be
 * attributed to the phase that owned the batch at the moment ops
 * shifted the date. Drives the "By phase" breakdown of customer-
 * days-lost on Insights, and lets leadership separate
 * internal-phase-driven slips (specs / PO signing / app listing
 * not done) from external-phase ones (VIN chase, logistics) and
 * pre-PO Partnership slips (forecast → PO signing drift).
 *
 * Column intentionally not declared on the Drizzle schema — written
 * + read via raw SQL with try/catch on missing-column. Same pattern
 * as `delay_reason_category` and `batches.confirmed_quantity` so a
 * pre-migration DB doesn't 500 every query.
 *
 * Allowed values (text, no SQL CHECK constraint — enforced in API):
 *   pre_po / internal / external / null
 *
 * Phase derivation (handled by /api/batch-shift, not this route):
 *   - lifecycleState === "pre_po"        → "pre_po"
 *   - appListedAt == null                → "internal" (internal-phase
 *                                          work, including app listing,
 *                                          still pending)
 *   - else                               → "external"
 *
 * Admin-only.
 */
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const ALTER_SQL = `
  ALTER TABLE batch_date_revisions ADD COLUMN phase_at_shift TEXT
`;

interface Report {
  columnExisted: boolean;
  columnCreated: boolean;
  revisionsWithPhase: number;
  totalRevisions:     number;
  dryRun:             boolean;
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
  const existed = await columnExists("batch_date_revisions", "phase_at_shift");
  let created = false;
  if (!existed && write) {
    await db.run(sql.raw(ALTER_SQL));
    created = true;
  }

  const ok = existed || created;
  let withPhase = 0;
  let total = 0;
  if (ok) {
    const tot = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM batch_date_revisions`);
    total = Number(tot[0]?.n ?? 0);
    const wp = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM batch_date_revisions WHERE phase_at_shift IS NOT NULL`,
    );
    withPhase = Number(wp[0]?.n ?? 0);
  }

  return {
    columnExisted:      existed,
    columnCreated:      created,
    revisionsWithPhase: withPhase,
    totalRevisions:     total,
    dryRun:             !write,
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

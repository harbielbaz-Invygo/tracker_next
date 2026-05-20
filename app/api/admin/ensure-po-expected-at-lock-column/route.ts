/**
 * POST /api/admin/ensure-po-expected-at-lock-column
 *
 * Adds `batches.po_expected_date_at_lock` if missing AND backfills
 * existing rows by copying `dealer_promised_delivery_date` (the
 * current PO Expected Date). The backfill is safe because the
 * column is null on every legacy row — the COALESCE only writes
 * where there's nothing to clobber.
 *
 * The locked column captures the FIRST partnership-dealer
 * agreement so dealer renegotiations (Shift) don't erase the
 * original commitment. Foundation for PO Reliability scoring
 * alongside Ops Reliability.
 *
 * Admin-only. GET reports the state; POST writes.
 */
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const ALTER_SQL = `
  ALTER TABLE batches ADD COLUMN po_expected_date_at_lock TEXT
`;
const BACKFILL_SQL = `
  UPDATE batches
  SET po_expected_date_at_lock = dealer_promised_delivery_date
  WHERE po_expected_date_at_lock IS NULL
`;

interface Report {
  columnExisted:    boolean;
  columnCreated:    boolean;
  rowsBackfilled:   number;
  totalBatches:     number;
  batchesWithLock:  number;
  dryRun:           boolean;
}

async function columnExists(): Promise<boolean> {
  try {
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM pragma_table_info('batches') WHERE name='po_expected_date_at_lock'`,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function countNullLocks(): Promise<number> {
  const rows = await db.all<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM batches WHERE po_expected_date_at_lock IS NULL`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function buildReport(write: boolean): Promise<Report> {
  const existed = await columnExists();
  let created = false;
  if (!existed && write) {
    await db.run(sql.raw(ALTER_SQL));
    created = true;
  }
  const exists = existed || created;

  let backfilled = 0;
  if (exists && write) {
    const before = await countNullLocks();
    await db.run(sql.raw(BACKFILL_SQL));
    const after = await countNullLocks();
    backfilled = Math.max(0, before - after);
  }

  let total = 0;
  let locked = 0;
  if (exists) {
    const tot = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM batches`);
    total = Number(tot[0]?.n ?? 0);
    const lk = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM batches WHERE po_expected_date_at_lock IS NOT NULL`,
    );
    locked = Number(lk[0]?.n ?? 0);
  }

  return {
    columnExisted:   existed,
    columnCreated:   created,
    rowsBackfilled:  backfilled,
    totalBatches:    total,
    batchesWithLock: locked,
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

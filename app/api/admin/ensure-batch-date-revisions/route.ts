/**
 * POST /api/admin/ensure-batch-date-revisions
 *
 * Defensive migration: creates the `batch_date_revisions` table if
 * it's missing, then reports the current row count + a per-batch
 * breakdown so admin can verify shifts are actually being recorded.
 *
 * Background: ops reported "I shifted twice but the Window Controls
 * Shift History still says 'no shifts yet'". The most likely cause
 * is that the table never got migrated onto this Turso DB — the
 * shift API silently logs a warning and continues without writing
 * a row when the table is absent.
 *
 * GET  → status check (counts only)
 * POST → CREATE TABLE IF NOT EXISTS + counts
 *
 * Admin-only.
 */
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS batch_date_revisions (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id                INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    revised_at              TEXT DEFAULT CURRENT_TIMESTAMP,
    revised_by              TEXT,
    previous_projected_date TEXT NOT NULL,
    new_projected_date      TEXT NOT NULL,
    delay_days              INTEGER NOT NULL,
    bookings_at_shift       INTEGER NOT NULL DEFAULT 0,
    reason                  TEXT
  )
`;
const CREATE_BY_BATCH_IDX_SQL = `
  CREATE INDEX IF NOT EXISTS batch_date_revisions_batch_idx
  ON batch_date_revisions(batch_id)
`;
const CREATE_BY_REVISED_AT_IDX_SQL = `
  CREATE INDEX IF NOT EXISTS batch_date_revisions_revised_at_idx
  ON batch_date_revisions(revised_at)
`;

interface Report {
  tableExisted: boolean;
  tableCreated: boolean;
  rowCount:     number;
  byBatch:      { batchCode: string | null; batchId: number; count: number }[];
  dryRun:       boolean;
}

async function tableExists(): Promise<boolean> {
  try {
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='batch_date_revisions'`,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function buildReport(write: boolean): Promise<Report> {
  const existed = await tableExists();
  let created = false;

  if (!existed && write) {
    await db.run(sql.raw(CREATE_TABLE_SQL));
    await db.run(sql.raw(CREATE_BY_BATCH_IDX_SQL));
    await db.run(sql.raw(CREATE_BY_REVISED_AT_IDX_SQL));
    created = true;
  }

  const exists = existed || created;
  let rowCount = 0;
  let byBatch: Report["byBatch"] = [];
  if (exists) {
    const counts = await db.all<{ batch_id: number; n: number; batch_code: string | null }>(
      sql`SELECT r.batch_id AS batch_id, COUNT(*) AS n, b.batch_code AS batch_code
          FROM batch_date_revisions r
          LEFT JOIN batches b ON b.id = r.batch_id
          GROUP BY r.batch_id
          ORDER BY n DESC`,
    );
    rowCount = counts.reduce((acc, r) => acc + Number(r.n), 0);
    byBatch = counts.map((r) => ({
      batchId:   Number(r.batch_id),
      batchCode: r.batch_code ?? null,
      count:     Number(r.n),
    }));
  }

  return {
    tableExisted: existed,
    tableCreated: created,
    rowCount,
    byBatch,
    dryRun:       !write,
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

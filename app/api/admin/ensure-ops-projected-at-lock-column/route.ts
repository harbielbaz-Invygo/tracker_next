/**
 * POST /api/admin/ensure-ops-projected-at-lock-column
 *
 * Adds `batches.ops_projected_delivery_date_at_lock` if missing.
 * Captures the FIRST ops-projected delivery date entered via the
 * Action Center → External Phase "Set Ops expected date" CTA — the
 * operations equivalent of `partnership_confidence_at_lock`.
 *
 * Defaults to NULL on every existing row; ops fills it the first
 * time they project a date for the batch.
 *
 * Admin-only. GET reports the current state without writing.
 */
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const ALTER_SQL = `
  ALTER TABLE batches ADD COLUMN ops_projected_delivery_date_at_lock TEXT
`;

interface Report {
  columnExisted: boolean;
  columnCreated: boolean;
  totalBatches:  number;
  batchesLocked: number;
  dryRun:        boolean;
}

async function columnExists(): Promise<boolean> {
  try {
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM pragma_table_info('batches') WHERE name='ops_projected_delivery_date_at_lock'`,
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
  let total = 0;
  let locked = 0;
  if (exists) {
    const tot = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM batches`);
    total = Number(tot[0]?.n ?? 0);
    const lk = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM batches WHERE ops_projected_delivery_date_at_lock IS NOT NULL`,
    );
    locked = Number(lk[0]?.n ?? 0);
  }
  return {
    columnExisted: existed,
    columnCreated: created,
    totalBatches:  total,
    batchesLocked: locked,
    dryRun:        !write,
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

/**
 * POST/GET /api/admin/ensure-po-redistribution-log
 *
 * Creates the `po_redistribution_log` audit table for car redistribution
 * — a lightweight record of every "move cars between windows" action:
 * who, when, why (reason), and the before/after per-window allocation.
 *
 * Purely additive + data-safe: a new table, no ALTER/drop, idempotent.
 *
 * GET  → status (table exists? row count)
 * POST → create table + index
 *
 * Admin-only.
 */
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS po_redistribution_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id           INTEGER NOT NULL,
    reason          TEXT    NOT NULL DEFAULT '',
    before_json     TEXT,
    after_json      TEXT,
    redistributed_by TEXT,
    created_at      TEXT    DEFAULT (CURRENT_TIMESTAMP)
  )
`;
const INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS po_redistribution_log_po_idx
    ON po_redistribution_log (po_id)
`;

async function tableExists(): Promise<boolean> {
  try {
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='po_redistribution_log'`,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function buildReport(write: boolean) {
  const existed = await tableExists();
  let created = false;
  if (write && !existed) {
    await db.run(sql.raw(CREATE_SQL));
    await db.run(sql.raw(INDEX_SQL));
    created = true;
  }
  let rowCount = 0;
  if (existed || created) {
    const n = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM po_redistribution_log`);
    rowCount = Number(n[0]?.n ?? 0);
  }
  return { tableExisted: existed, tableCreated: created, rowCount, dryRun: !write };
}

export async function GET() {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  return NextResponse.json({ ok: true, ...(await buildReport(false)) });
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

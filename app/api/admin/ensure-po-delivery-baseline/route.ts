/**
 * POST/GET /api/admin/ensure-po-delivery-baseline
 *
 * Foundation for the car-redistribution feature (frozen baseline). Creates
 * the `po_delivery_baseline` table — the immutable snapshot of each PO's
 * original delivery plan (one row per window: date + planned car count) —
 * and backfills it for every existing PO that doesn't have one yet.
 *
 * Purely additive + data-safe: a new table, no ALTER/drop of existing
 * data, idempotent. New POs snapshot their baseline at intake; this
 * endpoint covers POs created before the feature shipped.
 *
 * GET  → status (table exists? POs with/without a baseline)
 * POST → create table + index + backfill
 *
 * Admin-only.
 */
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";
import { snapshotPoBaseline } from "@/lib/po-baseline";

export const runtime = "nodejs";

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS po_delivery_baseline (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id       INTEGER NOT NULL,
    window_date TEXT    NOT NULL,
    quantity    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    DEFAULT (CURRENT_TIMESTAMP)
  )
`;
const INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS po_delivery_baseline_po_idx
    ON po_delivery_baseline (po_id)
`;

async function tableExists(): Promise<boolean> {
  try {
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='po_delivery_baseline'`,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

interface Report {
  tableExisted:    boolean;
  tableCreated:    boolean;
  totalPos:        number;
  posWithBaseline: number;
  backfilled:      number;
  dryRun:          boolean;
}

async function buildReport(write: boolean): Promise<Report> {
  const existed = await tableExists();
  let created = false;
  if (write && !existed) {
    await db.run(sql.raw(CREATE_SQL));
    await db.run(sql.raw(INDEX_SQL));
    created = true;
  }

  const ok = existed || created;
  let totalPos = 0;
  let posWithBaseline = 0;
  let backfilled = 0;

  if (ok) {
    const tot = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM pos`);
    totalPos = Number(tot[0]?.n ?? 0);

    if (write) {
      // Snapshot every PO that doesn't have a baseline yet (idempotent).
      const poRows = await db.all<{ id: number }>(sql`SELECT id FROM pos`);
      for (const p of poRows) {
        const before = await db.all(
          sql`SELECT 1 FROM po_delivery_baseline WHERE po_id = ${p.id} LIMIT 1`,
        );
        if (before.length > 0) continue;
        await snapshotPoBaseline(p.id);
        const after = await db.all(
          sql`SELECT 1 FROM po_delivery_baseline WHERE po_id = ${p.id} LIMIT 1`,
        );
        if (after.length > 0) backfilled++;
      }
    }

    const withBase = await db.all<{ n: number }>(
      sql`SELECT COUNT(DISTINCT po_id) AS n FROM po_delivery_baseline`,
    );
    posWithBaseline = Number(withBase[0]?.n ?? 0);
  }

  return {
    tableExisted:    existed,
    tableCreated:    created,
    totalPos,
    posWithBaseline,
    backfilled,
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

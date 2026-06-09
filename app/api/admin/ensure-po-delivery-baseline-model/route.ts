/**
 * POST/GET /api/admin/ensure-po-delivery-baseline-model
 *
 * Per-(window × model) frozen baseline — the foundation for per-model car
 * redistribution. Creates `po_delivery_baseline_model` (one row per
 * PO/window/model with the original planned car count) and backfills it
 * for every existing PO from its current batches.
 *
 * Purely additive + data-safe: new table, no ALTER/drop, idempotent.
 *
 * GET  → status (table exists? POs with/without a per-model baseline)
 * POST → create table + index + backfill
 *
 * Admin-only.
 */
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";
import { snapshotPoBaselineModel } from "@/lib/po-baseline";

export const runtime = "nodejs";

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS po_delivery_baseline_model (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id       INTEGER NOT NULL,
    window_date TEXT    NOT NULL,
    model       TEXT    NOT NULL DEFAULT '',
    year        INTEGER NOT NULL DEFAULT 0,
    quantity    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    DEFAULT (CURRENT_TIMESTAMP)
  )
`;
const INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS po_delivery_baseline_model_po_idx
    ON po_delivery_baseline_model (po_id)
`;

async function tableExists(): Promise<boolean> {
  try {
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='po_delivery_baseline_model'`,
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

  const ok = existed || created;
  let totalPos = 0;
  let posWithBaseline = 0;
  let backfilled = 0;

  if (ok) {
    const tot = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM pos`);
    totalPos = Number(tot[0]?.n ?? 0);

    if (write) {
      const poRows = await db.all<{ id: number }>(sql`SELECT id FROM pos`);
      for (const p of poRows) {
        const before = await db.all(
          sql`SELECT 1 FROM po_delivery_baseline_model WHERE po_id = ${p.id} LIMIT 1`,
        );
        if (before.length > 0) continue;
        await snapshotPoBaselineModel(p.id);
        const after = await db.all(
          sql`SELECT 1 FROM po_delivery_baseline_model WHERE po_id = ${p.id} LIMIT 1`,
        );
        if (after.length > 0) backfilled++;
      }
    }

    const withBase = await db.all<{ n: number }>(
      sql`SELECT COUNT(DISTINCT po_id) AS n FROM po_delivery_baseline_model`,
    );
    posWithBaseline = Number(withBase[0]?.n ?? 0);
  }

  return { tableExisted: existed, tableCreated: created, totalPos, posWithBaseline, backfilled, dryRun: !write };
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

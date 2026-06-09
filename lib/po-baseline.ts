/**
 * PO delivery baseline — the FROZEN promise (Idea 1: frozen baseline +
 * working allocation).
 *
 * At intake we snapshot each delivery window's planned {date, car count}
 * into `po_delivery_baseline`. That snapshot is **immutable** — ops can
 * later redistribute cars across windows (the "working allocation"), but
 * PO reliability is always scored against this frozen baseline so a moved
 * car can never erase a missed commitment.
 *
 * The table is read/written via raw SQL and is NOT declared on the Drizzle
 * schema, so a deploy never 500s before the ensure-* migration runs, and
 * a code rollback leaves it dormant (data-safe). Every function here is
 * tolerant of the table being absent.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export interface BaselineWindow {
  windowDate: string;
  quantity: number;
}

/** Per-(window × model) frozen baseline — the per-model promise. */
export interface BaselineModelWindow {
  windowDate: string;
  model: string;
  year: number;
  quantity: number;
}

/**
 * Freeze a PO's delivery plan as its reliability baseline — one row per
 * delivery window (availability date) with the original planned car count
 * (sum of that window's batch requested quantities).
 *
 * Idempotent + immutable: if any baseline rows already exist for the PO,
 * this is a no-op (the promise is frozen once). Tolerant of the table not
 * being migrated yet.
 */
export async function snapshotPoBaseline(poId: number): Promise<void> {
  if (!Number.isInteger(poId) || poId <= 0) return;
  try {
    const existing = await db.all(
      sql`SELECT 1 FROM po_delivery_baseline WHERE po_id = ${poId} LIMIT 1`,
    );
    if (existing.length > 0) return; // already frozen — never overwrite

    const rows = await db.all<{ window_date: string; qty: number }>(sql`
      SELECT w.availability_date         AS window_date,
             COALESCE(SUM(b.requested_quantity), 0) AS qty
        FROM waves w
        JOIN batches b ON b.wave_id = w.id
       WHERE w.po_id = ${poId}
       GROUP BY w.id, w.availability_date
    `);
    for (const r of rows) {
      if (!r.window_date) continue;
      await db.run(sql`
        INSERT INTO po_delivery_baseline (po_id, window_date, quantity)
        VALUES (${poId}, ${r.window_date}, ${Number(r.qty) || 0})
      `);
    }
  } catch {
    /* po_delivery_baseline not migrated yet — no-op. */
  }
}

/**
 * Freeze a PO's plan per (window × model) — one row per window/model with
 * the original planned car count. Immutable + idempotent (skips if any
 * per-model baseline already exists). Tolerant of the un-migrated table.
 */
export async function snapshotPoBaselineModel(poId: number): Promise<void> {
  if (!Number.isInteger(poId) || poId <= 0) return;
  try {
    const existing = await db.all(
      sql`SELECT 1 FROM po_delivery_baseline_model WHERE po_id = ${poId} LIMIT 1`,
    );
    if (existing.length > 0) return;
    const rows = await db.all<{ window_date: string; model: string; year: number; qty: number }>(sql`
      SELECT w.availability_date AS window_date,
             b.model             AS model,
             b.year              AS year,
             COALESCE(SUM(b.requested_quantity), 0) AS qty
        FROM waves w
        JOIN batches b ON b.wave_id = w.id
       WHERE w.po_id = ${poId}
       GROUP BY w.id, w.availability_date, b.model, b.year
    `);
    for (const r of rows) {
      if (!r.window_date) continue;
      await db.run(sql`
        INSERT INTO po_delivery_baseline_model (po_id, window_date, model, year, quantity)
        VALUES (${poId}, ${r.window_date}, ${r.model ?? ""}, ${Number(r.year) || 0}, ${Number(r.qty) || 0})
      `);
    }
  } catch {
    /* po_delivery_baseline_model not migrated yet — no-op. */
  }
}

/** Bulk-read every PO's per-(window × model) baseline, grouped by po_id. */
export async function getAllPoBaselinesModel(): Promise<Map<number, BaselineModelWindow[]>> {
  const out = new Map<number, BaselineModelWindow[]>();
  try {
    const rows = await db.all<{ po_id: number; window_date: string; model: string; year: number; quantity: number }>(sql`
      SELECT po_id, window_date, model, year, quantity
        FROM po_delivery_baseline_model
       ORDER BY window_date, model
    `);
    for (const r of rows) {
      const arr = out.get(Number(r.po_id)) ?? [];
      arr.push({
        windowDate: String(r.window_date),
        model: String(r.model ?? ""),
        year: Number(r.year) || 0,
        quantity: Number(r.quantity) || 0,
      });
      out.set(Number(r.po_id), arr);
    }
  } catch {
    /* not migrated — empty. */
  }
  return out;
}

/**
 * Bulk-read every PO's frozen baseline windows, grouped by po_id. One
 * query for the whole Action Center tree. Tolerant → empty Map when the
 * table isn't migrated.
 */
export async function getAllPoBaselines(): Promise<Map<number, BaselineWindow[]>> {
  const out = new Map<number, BaselineWindow[]>();
  try {
    const rows = await db.all<{ po_id: number; window_date: string; quantity: number }>(sql`
      SELECT po_id, window_date, quantity
        FROM po_delivery_baseline
       ORDER BY window_date
    `);
    for (const r of rows) {
      const arr = out.get(Number(r.po_id)) ?? [];
      arr.push({ windowDate: String(r.window_date), quantity: Number(r.quantity) || 0 });
      out.set(Number(r.po_id), arr);
    }
  } catch {
    /* not migrated — empty. */
  }
  return out;
}

/**
 * Read a PO's frozen baseline windows, ordered by date. Tolerant → []
 * when the table isn't migrated or the PO was never snapshotted.
 */
export async function getPoBaseline(poId: number): Promise<BaselineWindow[]> {
  if (!Number.isInteger(poId) || poId <= 0) return [];
  try {
    const rows = await db.all<{ window_date: string; quantity: number }>(sql`
      SELECT window_date, quantity
        FROM po_delivery_baseline
       WHERE po_id = ${poId}
       ORDER BY window_date
    `);
    return rows.map((r) => ({
      windowDate: String(r.window_date),
      quantity: Number(r.quantity) || 0,
    }));
  } catch {
    return [];
  }
}

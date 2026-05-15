/**
 * POST /api/admin/run-forecast-migration
 *
 * Applies the schema additions from PR #118 that `drizzle-kit push`
 * skipped because of the unrelated `vin_received_at_intake` warning.
 * Mirrors `scripts/migrate-forecast.ts` step-for-step but runs in the
 * Vercel runtime so it picks up DATABASE_URL + TURSO_AUTH_TOKEN
 * natively — no need to copy secrets out of the dashboard.
 *
 * Admin-only. Idempotent — each step checks for existence first.
 *
 * Returns a JSON summary so the operator can see what changed:
 *   {
 *     ok: true,
 *     actions: [
 *       { step: "add column parent_forecast_batch_id", status: "added" | "exists" },
 *       …
 *     ],
 *   }
 *
 * Delete this file after confirming the migration ran on each env.
 *
 * Run from an admin session in browser devtools:
 *   await fetch("/api/admin/run-forecast-migration", { method: "POST" }).then(r => r.json())
 */
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";

type Step = { step: string; status: "added" | "exists" };

export async function POST() {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;

  const actions: Step[] = [];

  try {
    // ── 1+2. batches columns ────────────────────────────────────
    const batchesCols = await db.all<{ name: string }>(
      sql.raw("PRAGMA table_info(batches)"),
    );
    const colNames = new Set(batchesCols.map((c) => c.name));

    if (colNames.has("parent_forecast_batch_id")) {
      actions.push({ step: "add column batches.parent_forecast_batch_id", status: "exists" });
    } else {
      await db.run(sql.raw("ALTER TABLE batches ADD COLUMN parent_forecast_batch_id INTEGER"));
      actions.push({ step: "add column batches.parent_forecast_batch_id", status: "added" });
    }

    if (colNames.has("forecast_superseded_at")) {
      actions.push({ step: "add column batches.forecast_superseded_at", status: "exists" });
    } else {
      await db.run(sql.raw("ALTER TABLE batches ADD COLUMN forecast_superseded_at TEXT"));
      actions.push({ step: "add column batches.forecast_superseded_at", status: "added" });
    }

    // ── 3. batch_forecasts table + indexes ──────────────────────
    const beforeForecasts = await db.all<{ name: string }>(
      sql.raw("SELECT name FROM sqlite_master WHERE type='table' AND name='batch_forecasts'"),
    );
    const hadForecastsTable = beforeForecasts.length > 0;
    await db.run(sql.raw(`
      CREATE TABLE IF NOT EXISTS batch_forecasts (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id             INTEGER NOT NULL UNIQUE
                               REFERENCES batches(id) ON DELETE CASCADE,
        submitted_at         TEXT NOT NULL,
        submitted_by_user_id INTEGER NOT NULL REFERENCES users(id),
        created_at           TEXT DEFAULT (CURRENT_TIMESTAMP),
        updated_at           TEXT DEFAULT (CURRENT_TIMESTAMP)
      )
    `));
    actions.push({
      step:   "create table batch_forecasts",
      status: hadForecastsTable ? "exists" : "added",
    });

    await db.run(sql.raw("CREATE INDEX IF NOT EXISTS batch_forecasts_batch_idx        ON batch_forecasts(batch_id)"));
    await db.run(sql.raw("CREATE INDEX IF NOT EXISTS batch_forecasts_submitted_by_idx ON batch_forecasts(submitted_by_user_id)"));
    await db.run(sql.raw("CREATE INDEX IF NOT EXISTS batch_forecasts_submitted_at_idx ON batch_forecasts(submitted_at)"));
    actions.push({ step: "ensure 3 indexes on batch_forecasts", status: "added" });

    // ── 4. Pre-PO App Listing action_type ───────────────────────
    const existing = await db.all<{ id: number }>(
      sql.raw("SELECT id FROM action_types WHERE name = 'Pre-PO App Listing' LIMIT 1"),
    );
    if (existing.length > 0) {
      actions.push({ step: "insert action_type Pre-PO App Listing", status: "exists" });
    } else {
      const ops = await db.all<{ id: number }>(
        sql.raw("SELECT id FROM departments WHERE name = 'Operations' LIMIT 1"),
      );
      const deptId = ops[0]?.id ?? null;
      if (deptId == null) {
        await db.run(sql.raw(`
          INSERT INTO action_types (name, waiting_label, done_label, default_department_id, sort_order, offset_days, offset_anchor)
          VALUES ('Pre-PO App Listing', 'Pre-PO list pending', 'Pre-PO listed', NULL, 0, 0, 'submission')
        `));
      } else {
        await db.run(sql.raw(`
          INSERT INTO action_types (name, waiting_label, done_label, default_department_id, sort_order, offset_days, offset_anchor)
          VALUES ('Pre-PO App Listing', 'Pre-PO list pending', 'Pre-PO listed', ${deptId}, 0, 0, 'submission')
        `));
      }
      actions.push({ step: "insert action_type Pre-PO App Listing", status: "added" });
    }

    return NextResponse.json({ ok: true, actions });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      actions,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}

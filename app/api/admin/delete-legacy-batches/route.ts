/**
 * POST /api/admin/delete-legacy-batches — purge pre-restructure batches.
 *
 * Phase 5a — explicit user-approved data drop. Removes every batch row
 * where wave_id IS NULL (i.e. batches that pre-date the scope-aware
 * restructure and therefore aren't visible in the current Action Center).
 *
 * Most child tables have ON DELETE CASCADE on batches.id, so the cascade
 * handles batch_actions, batch_vin_stages, batch_delivery_legs,
 * batch_color_matrix, batch_date_revisions, milestones, vehicles, and
 * batch_forecasts automatically. `alerts.batch_id` is the lone exception
 * (no cascade on that FK) — handled explicitly here.
 *
 * GET — returns a dry-run report so admin can preview what would be
 *       deleted without writing.
 * POST — performs the delete and returns the same shape with counts.
 *
 * Admin-only. Single-use. Will be deleted in a follow-up PR once the
 * cutover lands cleanly in prod.
 */
import { isNull, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { batches } from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

/**
 * Count / delete rows in the dormant legacy `alerts` table that reference
 * the given batch ids, via raw SQL. The alert engine was removed (Phase
 * 4b) so the table is no longer modelled, but its non-cascading batch_id
 * FK means leftover rows must still be cleared before deleting a batch.
 * Tolerant of the table being absent.
 */
async function countLegacyAlerts(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  try {
    const list = sql.join(ids.map((n) => sql`${n}`), sql`, `);
    const rows = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM alerts WHERE batch_id IN (${list})`,
    );
    return Number(rows[0]?.n ?? 0);
  } catch { return 0; }
}

export const runtime = "nodejs";

interface DeleteReport {
  /** Batches matching wave_id IS NULL. */
  legacyBatchCount: number;
  /** Sample of batch codes that would be / were deleted (up to 50). */
  sampleBatchCodes: string[];
  /** Alerts that reference one of those batches (no cascade FK). */
  legacyAlertCount: number;
  /** True if this was a dry-run (GET) rather than a write (POST). */
  dryRun: boolean;
  /** When write=true: batches actually deleted. */
  deleted: number;
}

async function buildReport(write: boolean): Promise<DeleteReport> {
  const legacy = await db
    .select({ id: batches.id, batchCode: batches.batchCode })
    .from(batches)
    .where(isNull(batches.waveId));
  const ids = legacy.map((b) => b.id);

  const legacyAlertCount = await countLegacyAlerts(ids);

  let deleted = 0;
  if (write && ids.length > 0) {
    await db.transaction(async (tx) => {
      // The dormant alerts table has no ON DELETE CASCADE on batch_id —
      // clear any leftover rows first (raw SQL, tolerant of absence).
      if (legacyAlertCount > 0) {
        const list = sql.join(ids.map((n) => sql`${n}`), sql`, `);
        try {
          await tx.run(sql`DELETE FROM alerts WHERE batch_id IN (${list})`);
        } catch { /* table absent — nothing to clean up */ }
      }
      // Everything else (batch_actions, batch_vin_stages,
      // batch_delivery_legs, batch_color_matrix, batch_date_revisions,
      // milestones, vehicles, batch_forecasts) has ON DELETE CASCADE
      // pointing at batches.id, so the libSQL engine handles them
      // automatically when we drop the parent rows.
      const result = await tx.delete(batches).where(isNull(batches.waveId));
      deleted = (result as { rowsAffected?: number }).rowsAffected ?? ids.length;
    });
  }

  return {
    legacyBatchCount: ids.length,
    sampleBatchCodes: legacy.slice(0, 50).map((b) => b.batchCode),
    legacyAlertCount,
    dryRun:           !write,
    deleted,
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
    return apiError(`Delete failed: ${msg}`, 500);
  }
}

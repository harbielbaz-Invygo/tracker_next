/**
 * POST /api/admin/cleanup-empty-waves
 *
 * Retro-prune: deletes every wave that has no batches under it.
 * After PR auto-prune-empty-waves, /api/batch-shift drops an empty
 * wave automatically when the last batch shifts out. This endpoint
 * cleans up the empty waves left over from BEFORE that fix — the
 * 2026-08-04-style placeholders ops sees floating between live
 * windows.
 *
 * For each orphan wave, we also delete any wave-scope action rows
 * that point at it (actions.scope_id is an integer with no FK
 * cascade, so the rows would otherwise leak).
 *
 * Idempotent.
 *
 * GET  → dry-run report (counts + sample wave IDs/dates)
 * POST → perform the prune
 *
 * Admin-only. Safe to re-run; safe to delete this endpoint once
 * ops confirms a clean run.
 */
import { eq, and, inArray, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  waves, batches, actions as actionsTable, pos,
} from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

interface CleanupReport {
  scannedWaves:    number;
  emptyWaveIds:    number[];
  /** Wave summaries for the report — useful when previewing. */
  emptyWaves:      {
    id: number;
    poNumber: string | null;
    availabilityDate: string;
  }[];
  deletedActions:  number;
  deletedWaves:    number;
  dryRun:          boolean;
}

async function buildReport(write: boolean): Promise<CleanupReport> {
  // Pull every wave + its parent PO number for the report. Cheap
  // join; total wave count is small in practice.
  const allWaves = await db
    .select({
      id:               waves.id,
      poId:             waves.poId,
      availabilityDate: waves.availabilityDate,
      poNumber:         pos.poNumber,
    })
    .from(waves)
    .leftJoin(pos, eq(pos.id, waves.poId));

  // For each wave, count batches still pointing at it.
  // Using a single GROUP BY to avoid N+1 — small dataset either way.
  const counts = await db.all<{ wave_id: number; n: number }>(
    sql`SELECT wave_id, COUNT(*) AS n FROM batches WHERE wave_id IS NOT NULL GROUP BY wave_id`,
  );
  const liveByWave = new Map<number, number>();
  for (const r of counts) liveByWave.set(Number(r.wave_id), Number(r.n));

  const empty = allWaves.filter((w) => (liveByWave.get(w.id) ?? 0) === 0);
  const emptyWaveIds = empty.map((w) => w.id);

  let deletedActions = 0;
  let deletedWaves   = 0;

  if (write && emptyWaveIds.length > 0) {
    await db.transaction(async (tx) => {
      const r1 = await tx.delete(actionsTable).where(and(
        eq(actionsTable.scope, "wave"),
        inArray(actionsTable.scopeId, emptyWaveIds),
      ));
      deletedActions = (r1 as { rowsAffected?: number }).rowsAffected ?? 0;

      const r2 = await tx.delete(waves).where(inArray(waves.id, emptyWaveIds));
      deletedWaves = (r2 as { rowsAffected?: number }).rowsAffected ?? emptyWaveIds.length;
    });
  }

  return {
    scannedWaves:   allWaves.length,
    emptyWaveIds,
    emptyWaves:     empty.slice(0, 50).map((w) => ({
      id:               w.id,
      poNumber:         w.poNumber ?? null,
      availabilityDate: w.availabilityDate,
    })),
    deletedActions,
    deletedWaves,
    dryRun:         !write,
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
    return apiError(`Cleanup failed: ${msg}`, 500);
  }
}

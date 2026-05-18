/**
 * POST /api/admin/cleanup-orphan-pos — purge pos/waves/actions rows
 * whose batches have all been deleted.
 *
 * Settings → Batches → Delete only removes rows from `batches`. The
 * new scope-aware tables (pos, waves, actions) aren't children of
 * batches (waves.po_id → pos.id is the only FK pointing INTO them),
 * so they stay behind as orphans and block re-uploading the same PO.
 *
 * This endpoint walks every `pos` row, checks whether any batch row
 * still references one of its waves, and deletes the entire pos +
 * its waves + its po/wave-scope actions when nothing remains.
 *
 * Idempotent. Admin-only. Safe to re-run.
 */
import { eq, and, inArray, notInArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  pos, waves, actions as actionsTable, batches,
} from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

interface CleanupReport {
  scannedPos: number;
  scannedWaves: number;
  orphanPoIds:    number[];
  orphanWaveIds:  number[];
  /** Actions deleted (sum of wave-scope + po-scope rows tied to orphans). */
  deletedActions: number;
  /** Wave rows actually removed (via pos.id cascade). */
  deletedWaves:   number;
  /** PO rows actually removed. */
  deletedPos:     number;
  dryRun: boolean;
}

async function buildReport(write: boolean): Promise<CleanupReport> {
  const allPos   = await db.select({ id: pos.id }).from(pos);
  const allWaves = await db.select({ id: waves.id, poId: waves.poId }).from(waves);

  // Set of wave ids that still have at least one batch row pointing at them.
  const liveBatchRows = await db
    .select({ waveId: batches.waveId })
    .from(batches);
  const liveWaveIds = new Set<number>();
  for (const r of liveBatchRows) {
    if (r.waveId != null) liveWaveIds.add(r.waveId);
  }

  // PO is "orphan" when none of its waves are in the live set.
  const wavesByPo = new Map<number, number[]>();
  for (const w of allWaves) {
    const arr = wavesByPo.get(w.poId) ?? [];
    arr.push(w.id);
    wavesByPo.set(w.poId, arr);
  }
  const orphanPoIds: number[] = [];
  const orphanWaveIds: number[] = [];
  for (const p of allPos) {
    const waveIds = wavesByPo.get(p.id) ?? [];
    const hasLive = waveIds.some((wid) => liveWaveIds.has(wid));
    if (!hasLive) {
      orphanPoIds.push(p.id);
      orphanWaveIds.push(...waveIds);
    }
  }

  let deletedActions = 0;
  let deletedWaves   = 0;
  let deletedPos     = 0;

  if (write && orphanPoIds.length > 0) {
    await db.transaction(async (tx) => {
      // Actions don't have FK cascade pointing back to pos/waves, so
      // delete those first.
      if (orphanWaveIds.length > 0) {
        const r1 = await tx.delete(actionsTable).where(and(
          eq(actionsTable.scope, "wave"),
          inArray(actionsTable.scopeId, orphanWaveIds),
        ));
        deletedActions += (r1 as { rowsAffected?: number }).rowsAffected ?? 0;
      }
      const r2 = await tx.delete(actionsTable).where(and(
        eq(actionsTable.scope, "po"),
        inArray(actionsTable.scopeId, orphanPoIds),
      ));
      deletedActions += (r2 as { rowsAffected?: number }).rowsAffected ?? 0;

      // waves.po_id has ON DELETE CASCADE, so removing pos rows
      // takes the waves with them. We still report waveCount so
      // admin sees the magnitude.
      deletedWaves = orphanWaveIds.length;
      const r3 = await tx.delete(pos).where(inArray(pos.id, orphanPoIds));
      deletedPos = (r3 as { rowsAffected?: number }).rowsAffected ?? orphanPoIds.length;
    });
  }
  // Silence unused-import lint: notInArray was retained in case a
  // future variant of the cleanup wants to delete ONLY the orphans.
  void notInArray;

  return {
    scannedPos:    allPos.length,
    scannedWaves:  allWaves.length,
    orphanPoIds,
    orphanWaveIds,
    deletedActions,
    deletedWaves,
    deletedPos,
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
    return apiError(`Cleanup failed: ${msg}`, 500);
  }
}

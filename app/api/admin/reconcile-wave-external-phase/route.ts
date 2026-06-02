/**
 * POST /api/admin/reconcile-wave-external-phase
 *
 * Backfill for the wave-scope External-Phase reconciliation. Windows
 * delivered BEFORE lib/closure-cascade.ts started settling the bulk
 * roll-up layer still carry stale "waiting" wave-scope action rows
 * (VIN, Plate, Tracking, …) even though every batch under them has
 * delivered. Those phantom rows leaked into the Action Center Inbox as
 * an "Awaiting VIN from dealer" head (worked around on the display side
 * in #291) and leave the data inconsistent.
 *
 * This admin endpoint walks every fully-delivered window (all batches
 * closed with closureReason='delivered') and flips its pending
 * wave-scope actions to `done` via the same helper the live cascade
 * uses, so the cleanup and the going-forward behaviour can never drift.
 *
 * Idempotent — re-running settles nothing once the windows are clean
 * (the helper only touches waiting/blocked rows). Safe to re-run.
 *
 * GET  → dry-run report (counts + sample window availability dates)
 * POST → perform the reconciliation
 *
 * Admin-only. Can be removed once existing prod windows are cleaned up.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  batches, waves, actions as actionsTable,
} from "@/lib/db/schema";
import { reconcileWaveExternalActionsOnDelivery } from "@/lib/closure-cascade";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

interface ReconcileReport {
  wavesScanned: number;
  /** Windows where every batch is closed with closureReason='delivered'. */
  fullyDeliveredWaveCount: number;
  /** Pending (waiting/blocked) wave-scope action rows sitting on those
   *  fully-delivered windows — the stale data this backfill clears. */
  staleWaveActionCount: number;
  /** Sample availability dates of windows needing cleanup (<= 50). */
  sampleWindows: string[];
  /** How many wave-scope rows were actually flipped to done. */
  reconciled: number;
  dryRun: boolean;
}

/**
 * Identify fully-delivered windows. Returns the wave ids plus a map
 * to their availability date for the sample report.
 */
async function findFullyDeliveredWaves(): Promise<{
  waveIds: number[];
  availabilityByWave: Map<number, string>;
}> {
  const allWaves = await db
    .select({ id: waves.id, availabilityDate: waves.availabilityDate })
    .from(waves);
  const availabilityByWave = new Map(
    allWaves.map((w) => [w.id, w.availabilityDate]),
  );

  // Pull every wave-linked batch's closure state once, then group.
  const batchRows = await db
    .select({
      waveId:        batches.waveId,
      closedAt:      batches.closedAt,
      closureReason: batches.closureReason,
    })
    .from(batches)
    .where(isNotNull(batches.waveId));

  const byWave = new Map<number, { closedAt: string | null; closureReason: string | null }[]>();
  for (const b of batchRows) {
    if (b.waveId == null) continue;
    const arr = byWave.get(b.waveId) ?? [];
    arr.push({ closedAt: b.closedAt, closureReason: b.closureReason });
    byWave.set(b.waveId, arr);
  }

  const waveIds: number[] = [];
  for (const [waveId, rows] of byWave) {
    if (rows.length === 0) continue;
    const fullyDelivered = rows.every(
      (r) => r.closedAt != null && r.closureReason === "delivered",
    );
    if (fullyDelivered) waveIds.push(waveId);
  }
  return { waveIds, availabilityByWave };
}

async function buildReport(write: boolean): Promise<ReconcileReport> {
  const allWaves = await db.select({ id: waves.id }).from(waves);
  const { waveIds, availabilityByWave } = await findFullyDeliveredWaves();

  // Pending wave-scope action rows on the fully-delivered windows.
  // Defensive: the scope-aware `actions` table is migration-pending on
  // older DBs — treat a missing table as "nothing stale".
  let stalePending: { id: number; scopeId: number }[] = [];
  if (waveIds.length > 0) {
    try {
      stalePending = await db
        .select({ id: actionsTable.id, scopeId: actionsTable.scopeId })
        .from(actionsTable)
        .where(and(
          eq(actionsTable.scope, "wave"),
          inArray(actionsTable.scopeId, waveIds),
          inArray(actionsTable.status, ["waiting", "blocked"]),
        ));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/no such (table|column)/i.test(msg)) throw err;
      stalePending = [];
    }
  }

  // Windows that actually have stale rows — the cleanup targets.
  const windowsNeedingCleanup = Array.from(
    new Set(stalePending.map((r) => r.scopeId)),
  );
  const sampleWindows = windowsNeedingCleanup
    .slice(0, 50)
    .map((id) => availabilityByWave.get(id) ?? `wave#${id}`);

  let reconciled = 0;
  if (write && stalePending.length > 0) {
    const nowIso = new Date().toISOString();
    // One transaction for the whole backfill so a mid-run failure
    // leaves no half-reconciled windows.
    await db.transaction(async (tx) => {
      for (const waveId of windowsNeedingCleanup) {
        const ids = await reconcileWaveExternalActionsOnDelivery(tx, waveId, nowIso);
        reconciled += ids.length;
      }
    });
  }

  return {
    wavesScanned:            allWaves.length,
    fullyDeliveredWaveCount: waveIds.length,
    staleWaveActionCount:    stalePending.length,
    sampleWindows,
    reconciled,
    dryRun:                  !write,
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
    return apiError(`Reconcile failed: ${msg}`, 500);
  }
}

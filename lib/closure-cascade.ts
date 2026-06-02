/**
 * Closure cascade — propagate batch closure / re-open up the
 * Batch → Wave → PO hierarchy.
 *
 * Why this exists: the schema has `waves.closed_at` and `pos.closed_at`
 * columns, but no code path wrote them. POs and Delivery Windows
 * stayed "open" forever, breaking cycle-time math, dashboard
 * counters, and the on-time-rate denominator.
 *
 * Rules:
 *  - A batch is "closed" iff `batches.closed_at` is non-null.
 *    Closure reason doesn't matter for the rollup — delivered (full),
 *    delivered (partial), and cancelled all count.
 *  - A wave closes when every batch under it is closed. Its
 *    `closed_at` is the MAX (latest) batch closure date.
 *  - A PO closes when every wave under it is closed. Its `closed_at`
 *    is the MAX (latest) wave closure date.
 *  - Re-opening is symmetric: if any batch under a wave un-closes,
 *    the wave's `closed_at` clears; if any wave under a PO un-closes,
 *    the PO's clears.
 *
 * Pre-PO batches (lifecycle='pre_po') don't have a wave linkage so
 * they don't participate in this cascade. Forecast cancellation
 * lives in its own endpoint and never touches a wave/PO.
 *
 * Called from `/api/batch-close` and `/api/scope-action` (when ops
 * flips the Delivery action, which auto-toggles `batches.closedAt`).
 *
 * Wave-scope action reconciliation
 * ================================
 * Closing the last batch in a wave also settles that window's
 * External-Phase work. The wave-scope `actions` rows (VIN, Plate,
 * Tracking, Inspection, …) are a bulk roll-up layer mirroring the
 * per-batch copies; when ops ticks the work per-batch (not at the
 * wave level) those wave-scope copies are never marked done. A fully
 * delivered window therefore keeps stale "waiting" wave-scope rows,
 * which leaked into the Action Center Inbox as a phantom "Awaiting VIN
 * from dealer" head (worked around on the display side in #291). When
 * this cascade detects a wave became fully *delivered* it reconciles
 * those wave-scope rows to `done` so the underlying data is consistent
 * — see `reconcileWaveExternalActionsOnDelivery` below.
 */
import { and, eq, inArray } from "drizzle-orm";
import { batches, waves, pos, actions as actionsTable } from "@/lib/db/schema";

// Drizzle transactions are driver-specific generics; we just need the
// CRUD surface so a loose alias keeps callers simple.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

interface BatchClosureRow { id: number; closedAt: string | null }
interface WaveClosureRow  { id: number; closedAt: string | null }

/**
 * Walk up from a single batch, opening or closing its parent wave +
 * PO as appropriate. Called AFTER the batch's `closedAt` has been
 * mutated to its new value.
 *
 * Idempotent: re-running with the same state produces no extra
 * writes.
 */
export async function cascadeBatchClosureUp(
  tx: Tx,
  batchId: number,
  nowIso: string,
): Promise<{ waveClosed: boolean; poClosed: boolean; reconciledWaveActionIds: number[] }> {
  // 1. Resolve the batch's wave. Pre-PO batches have no wave —
  //    the cascade doesn't apply.
  const [parent] = await tx
    .select({ waveId: batches.waveId })
    .from(batches)
    .where(eq(batches.id, batchId))
    .limit(1);
  if (!parent || parent.waveId == null) {
    return { waveClosed: false, poClosed: false, reconciledWaveActionIds: [] };
  }
  const waveId: number = parent.waveId;

  // 2. Aggregate every batch in the wave (small set — JS scan is fine).
  const batchesInWave: BatchClosureRow[] = await tx
    .select({ id: batches.id, closedAt: batches.closedAt })
    .from(batches)
    .where(eq(batches.waveId, waveId));
  const openInWave = batchesInWave.filter((b) => b.closedAt == null);
  const latestBatchClose = batchesInWave
    .map((b) => b.closedAt)
    .filter((d): d is string => d != null)
    .sort()
    .at(-1) ?? null;

  // 3. Load the wave's current closedAt + poId.
  const [waveRow] = await tx
    .select({ closedAt: waves.closedAt, poId: waves.poId })
    .from(waves)
    .where(eq(waves.id, waveId))
    .limit(1);
  if (!waveRow) return { waveClosed: false, poClosed: false, reconciledWaveActionIds: [] };

  // 4. Wave-level write. Idempotent — skip when the target value
  //    already matches.
  let waveClosed: boolean;
  if (openInWave.length === 0 && batchesInWave.length > 0) {
    waveClosed = true;
    if (waveRow.closedAt !== latestBatchClose) {
      await tx.update(waves).set({
        closedAt:  latestBatchClose,
        updatedAt: nowIso,
      }).where(eq(waves.id, waveId));
    }
  } else {
    waveClosed = false;
    if (waveRow.closedAt != null) {
      await tx.update(waves).set({
        closedAt:  null,
        updatedAt: nowIso,
      }).where(eq(waves.id, waveId));
    }
  }

  // 4b. Wave-scope External-Phase reconciliation. When this wave just
  //     became fully *delivered*, settle its stale wave-scope action
  //     rows so the bulk roll-up layer matches the per-batch reality.
  //     Gated on `waveClosed` (all batches closed is a precondition);
  //     the helper applies the stricter "all delivered" check itself.
  const reconciledWaveActionIds = waveClosed
    ? await reconcileWaveExternalActionsOnDelivery(tx, waveId, nowIso)
    : [];

  // 5. PO-level rollup. Use the freshly-written wave state (no extra
  //    SELECT) when checking the PO.
  const poId: number = waveRow.poId;
  const allWavesInPo: WaveClosureRow[] = await tx
    .select({ id: waves.id, closedAt: waves.closedAt })
    .from(waves)
    .where(eq(waves.poId, poId));
  const wavesForCheck = allWavesInPo.map((w) =>
    w.id === waveId
      ? { id: w.id, closedAt: waveClosed ? latestBatchClose : null }
      : w,
  );
  const openInPo = wavesForCheck.filter((w) => w.closedAt == null);
  const latestWaveClose = wavesForCheck
    .map((w) => w.closedAt)
    .filter((d): d is string => d != null)
    .sort()
    .at(-1) ?? null;

  const [poRow] = await tx
    .select({ closedAt: pos.closedAt })
    .from(pos)
    .where(eq(pos.id, poId))
    .limit(1);
  if (!poRow) return { waveClosed, poClosed: false, reconciledWaveActionIds };

  let poClosed: boolean;
  if (openInPo.length === 0 && wavesForCheck.length > 0) {
    poClosed = true;
    if (poRow.closedAt !== latestWaveClose) {
      await tx.update(pos).set({
        closedAt:  latestWaveClose,
        updatedAt: nowIso,
      }).where(eq(pos.id, poId));
    }
  } else {
    poClosed = false;
    if (poRow.closedAt != null) {
      await tx.update(pos).set({
        closedAt:  null,
        updatedAt: nowIso,
      }).where(eq(pos.id, poId));
    }
  }

  return { waveClosed, poClosed, reconciledWaveActionIds };
}

/**
 * Reconcile a wave's bulk roll-up External-Phase actions when the
 * window has fully delivered.
 *
 * Fires only when EVERY batch under the wave is closed with
 * `closureReason='delivered'` — a window with any open or cancelled
 * batch is left untouched (cancellations abandon the dealer handoff
 * rather than complete it, and an open batch still has work to do).
 *
 * Effect: every wave-scope action still `waiting`/`blocked` flips to
 * `done`, stamped at the window's last batch-close date (noon UTC, the
 * same convention `/api/batch-close` uses for the Delivery action).
 * `done` and `skipped` rows are left alone, so the call is idempotent
 * and never un-skips work ops explicitly opted out of.
 *
 * Reconciliation is forward-only: re-opening a delivered batch does
 * NOT revert these rows, mirroring how a re-opened batch's own
 * batch-scope External-Phase rows also stay `done` (Delivery's
 * dependency-revert only touches its descendants, and External-Phase
 * actions are its parents).
 *
 * Defensive: the `actions` table is migration-pending on older DBs, so
 * a missing-table/column error degrades to a no-op rather than failing
 * the closure that already succeeded.
 *
 * Returns the ids of every wave-scope action this reconciliation
 * settled (empty when the window isn't fully delivered or had nothing
 * pending). Safe to call standalone — used by the admin backfill
 * endpoint to clean up windows delivered before this cascade existed.
 */
export async function reconcileWaveExternalActionsOnDelivery(
  tx: Tx,
  waveId: number,
  nowIso: string,
): Promise<number[]> {
  // Only a genuinely fully-delivered window settles its roll-up layer.
  const batchesInWave: { closedAt: string | null; closureReason: string | null }[] =
    await tx
      .select({ closedAt: batches.closedAt, closureReason: batches.closureReason })
      .from(batches)
      .where(eq(batches.waveId, waveId));
  if (batchesInWave.length === 0) return [];
  const fullyDelivered = batchesInWave.every(
    (b) => b.closedAt != null && b.closureReason === "delivered",
  );
  if (!fullyDelivered) return [];

  // Stamp completion at the window's last delivery date — keeps the
  // roll-up action's completedAt aligned with when the window actually
  // finished, not when this reconciliation happened to run.
  const latestClose = batchesInWave
    .map((b) => b.closedAt)
    .filter((d): d is string => d != null)
    .sort()
    .at(-1) ?? nowIso.slice(0, 10);
  const completedAtIso = `${latestClose}T12:00:00Z`;

  try {
    const pending: { id: number }[] = await tx
      .select({ id: actionsTable.id })
      .from(actionsTable)
      .where(and(
        eq(actionsTable.scope, "wave"),
        eq(actionsTable.scopeId, waveId),
        inArray(actionsTable.status, ["waiting", "blocked"]),
      ));
    if (pending.length === 0) return [];
    const ids = pending.map((r) => r.id);
    await tx.update(actionsTable).set({
      status:      "done",
      completedAt: completedAtIso,
      updatedAt:   nowIso,
    }).where(inArray(actionsTable.id, ids));
    return ids;
  } catch (err) {
    // Pre-migration DB without the scope-aware `actions` table → no-op.
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such (table|column)/i.test(msg)) return [];
    throw err;
  }
}

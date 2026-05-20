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
 */
import { eq } from "drizzle-orm";
import { batches, waves, pos } from "@/lib/db/schema";

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
): Promise<{ waveClosed: boolean; poClosed: boolean }> {
  // 1. Resolve the batch's wave. Pre-PO batches have no wave —
  //    the cascade doesn't apply.
  const [parent] = await tx
    .select({ waveId: batches.waveId })
    .from(batches)
    .where(eq(batches.id, batchId))
    .limit(1);
  if (!parent || parent.waveId == null) {
    return { waveClosed: false, poClosed: false };
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
  if (!waveRow) return { waveClosed: false, poClosed: false };

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
  if (!poRow) return { waveClosed, poClosed: false };

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

  return { waveClosed, poClosed };
}

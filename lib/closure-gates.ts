/**
 * Closure-gate helpers — server-side enforcement of the rules the
 * Action Center already shows in tooltips on locked client buttons.
 *
 * Why: the UI gates were the only thing stopping a Mark-as-Listed
 * before Internal Phase, or a Mark-as-Delivered with no VINs / no
 * app listing / pending External-Phase actions. A direct fetch() or
 * a future bulk script bypassed all of it.
 *
 * Used by:
 *   - /api/batch-app-listing  (only when SET, not when CLEARED)
 *   - /api/batch-close        (only when reason='delivered')
 *   - /api/scope-action       (only when target is the Delivery
 *                              batch-scope action being flipped done)
 *
 * Cancellation / un-listing / re-opens are intentionally NOT gated:
 * those are corrective actions that ops needs to be able to fire
 * regardless of state.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  batches, pos,
  actions as actionsTable,
  actionTypes,
} from "@/lib/db/schema";

// Drizzle transactions are driver-specific generics; we just need
// the CRUD surface, so a loose alias keeps callers simple.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

export interface GateResult {
  ok: boolean;
  reason: string;
}

/**
 * Gate for "this batch can be marked as app-listed".
 * Mirrors the client-side AppListedBulkCta rule:
 *   - batch exists, is post_po, has a poNumber
 *   - every PO-scope action is done or skipped (no waiting/blocked)
 *
 * Pre-PO batches and legacy batches with no `pos` row default to
 * "allow" — the constraint only applies inside the scope-aware
 * model where Internal Phase actions actually live.
 */
export async function checkBatchListingGate(
  tx: Tx,
  batchId: number,
): Promise<GateResult> {
  const [batch] = await tx
    .select({
      id: batches.id,
      lifecycleState: batches.lifecycleState,
      poNumber: batches.poNumber,
    })
    .from(batches)
    .where(eq(batches.id, batchId))
    .limit(1);
  if (!batch) {
    return { ok: false, reason: `Batch ${batchId} not found.` };
  }
  if (batch.lifecycleState !== "post_po") {
    // Pre-PO listing flows through the action_type "Pre-PO App
    // Listing", not the batches.app_listed_at column. Don't gate.
    return { ok: true, reason: "Pre-PO batch — gate not applied." };
  }
  if (!batch.poNumber) {
    return { ok: true, reason: "Batch has no PO linkage — gate not applied." };
  }

  // Resolve the parent PO. Legacy batches whose `pos` row was never
  // created (pre-restructure data) get a permissive default.
  const [po] = await tx
    .select({ id: pos.id })
    .from(pos)
    .where(eq(pos.poNumber, batch.poNumber))
    .limit(1);
  if (!po) {
    return { ok: true, reason: "Legacy PO — gate not applied." };
  }

  // Count PO-scope actions that are still pending (waiting / blocked).
  // 'done' and 'skipped' both count as settled per Review #1's
  // "explicitly skipped" carve-out.
  const pending = await tx
    .select({ id: actionsTable.id })
    .from(actionsTable)
    .where(and(
      eq(actionsTable.scope, "po"),
      eq(actionsTable.scopeId, po.id),
      inArray(actionsTable.status, ["waiting", "blocked"]),
    ));
  if (pending.length > 0) {
    return {
      ok: false,
      reason: `${pending.length} Internal-Phase action${pending.length === 1 ? "" : "s"} still pending on PO ${batch.poNumber}.`,
    };
  }

  return { ok: true, reason: "Internal Phase complete." };
}

/**
 * Gate for "this batch can be marked as delivered".
 * Mirrors the client-side BatchRow deliveryGate, in the same order
 * so error messages are identical to what ops sees in the tooltip:
 *   1. batch exists and isn't already closed
 *   2. Internal Phase done (PO-scope actions settled)
 *   3. External Phase done (batch-scope, excluding Delivery itself)
 *   4. batches.app_listed_at IS NOT NULL
 *   5. batches.vins_received_quantity > 0
 *
 * Returns ok=true when every check passes. Cancellation and re-open
 * never call this — they're corrective and intentionally ungated.
 */
export async function checkBatchDeliveryGate(
  tx: Tx,
  batchId: number,
): Promise<GateResult> {
  const [batch] = await tx
    .select()
    .from(batches)
    .where(eq(batches.id, batchId))
    .limit(1);
  if (!batch) return { ok: false, reason: `Batch ${batchId} not found.` };
  if (batch.closedAt) return { ok: false, reason: "Batch already closed." };

  // (2) Internal Phase — defer to the listing gate; same rule.
  const listing = await checkBatchListingGate(tx, batchId);
  if (!listing.ok) return listing;

  // (3) External Phase — batch-scope actions, excluding Delivery
  // itself (Delivery IS the action being flipped). 'skipped' counts
  // as settled.
  const deliveryTypeRow = await tx
    .select({ id: actionTypes.id })
    .from(actionTypes)
    .where(eq(actionTypes.name, "Delivery"))
    .limit(1);
  const deliveryTypeId = deliveryTypeRow[0]?.id ?? null;

  // Pull all batch-scope actions for this batch (small set).
  const batchScopeActions = await tx
    .select({
      id:           actionsTable.id,
      status:       actionsTable.status,
      actionTypeId: actionsTable.actionTypeId,
    })
    .from(actionsTable)
    .where(and(
      eq(actionsTable.scope, "batch"),
      eq(actionsTable.scopeId, batchId),
    ));
  const externalPending = batchScopeActions.filter(
    (a: { status: string; actionTypeId: number }) =>
      a.actionTypeId !== deliveryTypeId
      && (a.status === "waiting" || a.status === "blocked"),
  );
  if (externalPending.length > 0) {
    return {
      ok: false,
      reason: `${externalPending.length} External-Phase action${externalPending.length === 1 ? "" : "s"} still pending on this batch.`,
    };
  }

  // (4) App-listed.
  if (!batch.appListedAt) {
    return { ok: false, reason: "Batch not yet app-listed." };
  }

  // (4b) Partial listing — every car must be listed before a full
  // delivery/close. The remainder must be listed, or moved to another
  // window / cancelled (which shrinks requested down to the listed count).
  // listed_quantity is off-schema → raw read, tolerant (skipped when the
  // ensure-listed-quantity-column migration hasn't run).
  try {
    const lrows = await tx.all(sql`SELECT listed_quantity AS lq FROM batches WHERE id = ${batchId}`);
    const listedQty = Number((lrows as { lq?: number }[])[0]?.lq ?? 0);
    const requested = (batch as { requestedQuantity?: number }).requestedQuantity ?? 0;
    if (listedQty < requested) {
      const pending = requested - listedQty;
      return {
        ok: false,
        reason: `${pending} car${pending === 1 ? "" : "s"} not yet listed — list them, or move/cancel the remainder, before delivering.`,
      };
    }
  } catch { /* listed_quantity un-migrated — binary app_listed_at check above stands */ }

  // (5) VINs received.
  const vins = (batch as { vinsReceivedQuantity?: number | null }).vinsReceivedQuantity ?? 0;
  if (vins <= 0) {
    return { ok: false, reason: "No VINs received yet." };
  }

  return { ok: true, reason: `Up to ${vins} car${vins === 1 ? "" : "s"} deliverable.` };
}


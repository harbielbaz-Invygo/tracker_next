/**
 * PO closure outcome — derived, not stored (Audit 1 #4).
 *
 * The closure cascade already sets `pos.closedAt` when every batch
 * under a PO is closed. What ops + leadership *also* need is a single
 * categorical answer to "did this PO end well?" The four batch-level
 * closureReasons (`delivered` / `cancelled`) and the per-batch qty
 * delta (`deliveredQuantity` vs `requestedQuantity`) combine into:
 *
 *   open                   — at least one batch still open
 *   delivered_in_full      — every batch closed `delivered` AND
 *                            Σ delivered ≥ Σ requested across them
 *   partly_delivered       — some batches delivered, but
 *                            Σ delivered < Σ requested (cancellations
 *                            or remainder splits absorbed the gap)
 *   cancelled_mid_flight   — no batch closed `delivered`
 *
 * Pure function, no DB calls. Surfaced as a badge on the PO row in
 * the Insights PO Reliability tab + Action Center tree.
 */

export type PoClosureOutcome =
  | "open"
  | "delivered_in_full"
  | "partly_delivered"
  | "cancelled_mid_flight";

export interface PoClosureBatch {
  closedAt:          string | null;
  closureReason:     "delivered" | "cancelled" | null;
  requestedQuantity: number;
  deliveredQuantity: number;
}

export function derivePoClosureOutcome(batches: PoClosureBatch[]): PoClosureOutcome {
  if (batches.length === 0) return "open";
  // Any batch still open → the PO itself is open.
  if (batches.some((b) => b.closedAt == null)) return "open";

  const anyDelivered = batches.some((b) => b.closureReason === "delivered");
  if (!anyDelivered) return "cancelled_mid_flight";

  const totalReq = batches.reduce((s, b) => s + (b.requestedQuantity ?? 0), 0);
  const totalDel = batches.reduce(
    (s, b) => s + (b.closureReason === "delivered" ? (b.deliveredQuantity ?? 0) : 0),
    0,
  );
  if (totalReq > 0 && totalDel >= totalReq) return "delivered_in_full";
  return "partly_delivered";
}

/** Display string for badges. */
export function poClosureOutcomeLabel(o: PoClosureOutcome): string {
  switch (o) {
    case "open":                 return "open";
    case "delivered_in_full":    return "✓ delivered in full";
    case "partly_delivered":     return "⚠ partly delivered";
    case "cancelled_mid_flight": return "🚫 cancelled mid-flight";
  }
}

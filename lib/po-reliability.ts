/**
 * PO Signed Reliability Score (Review #4 R1-R3, R5, R6).
 *
 * For each closed PO, compute a 0-100 composite score from five
 * components plus a sibling "Ops" score that uses the locked Ops
 * projection instead of the locked PO commitment.
 *
 *   Date         — closedAt vs the locked Expected Date
 *   Qty          — deliveredCars / requestedCars  (excludes remainder
 *                  batches from the denominator — remainders are a
 *                  continuation of the same commitment)
 *   Color        — sum(deliveredQty per color) / sum(requestedQty per
 *                  color) across the PO's batches; falls back to
 *                  confirmedQty when delivered is unavailable
 *   Cancellation — fraction of cars cancelled (car-weighted, not
 *                  batch-count) → component = (100 − rate)
 *   Stability    — penalty for each shift event — 20 points per shift
 *                  capped at 100 (≥ 5 shifts = 0)
 *
 * Default weights are 40 / 25 / 15 / 10 / 10. Tunable later via
 * Settings (R20).
 *
 * Two parallel scores per PO:
 *
 *   POReliability  — uses poExpectedDateAtLock      (dealer-partnership)
 *   OpsReliability — uses opsProjectedDeliveryDateAtLock (ops's bet)
 *
 *   opsAddedValue = opsReliability − poReliability  → positive means
 *                   ops's first projection was closer to reality than
 *                   the original PO commitment.
 *
 * Pure functions — no DB access. Caller fetches the inputs and feeds
 * shaped batch summaries in. Keeps this module testable.
 */

export interface ReliabilityBatch {
  /** batchCode is checked for the `-R\d+$` suffix that marks a
   *  remainder batch — remainders contribute deliveredQuantity but
   *  not requestedQuantity to keep the denominator honest. */
  batchCode: string;
  requestedQuantity: number;
  deliveredQuantity: number;
  closedAt: string | null;           // ISO yyyy-mm-dd
  closureReason: "delivered" | "cancelled" | null;
  poExpectedDateAtLock: string | null;
  opsProjectedDeliveryDateAtLock: string | null;
  /** Fallback when poExpectedDateAtLock is null on legacy rows. */
  dealerPromisedDeliveryDate: string;
  /** Fallback when opsProjectedDeliveryDateAtLock is null. */
  currentProjectedDeliveryDate: string | null;
  shiftCount: number;
  colors: { color: string; requested: number; confirmed: number; delivered: number }[];
}

export interface ReliabilityComponents {
  date:         number; // 0-100
  qty:          number;
  color:        number;
  cancellation: number; // (100 − cancellationRate)
  stability:    number;
}

export interface PoReliabilityScore {
  composite:     number;        // 0-100
  components:    ReliabilityComponents;
  /** Days off — closure vs the relevant locked Expected Date. Signed:
   *  negative = early, positive = late. Null when no closure. */
  dateVarianceDays: number | null;
  /** Helpful raw numbers for the UI breakdown. */
  raw: {
    closedBatches:      number;
    totalBatches:       number;
    cancelledBatches:   number;
    cancelledCars:      number;
    requestedCars:      number;
    deliveredCars:      number;
    shiftCount:         number;
  };
}

export const RELIABILITY_WEIGHTS = {
  date:         0.40,
  qty:          0.25,
  color:        0.15,
  cancellation: 0.10,
  stability:    0.10,
} as const;

/**
 * Maximum signed slip (days) at which the date component goes to 0.
 * 30 days is a reasonable cap for monthly car cycles — extend if your
 * lead times typically exceed a month.
 */
const DATE_VARIANCE_CAP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHIFT_PENALTY = 20; // points per shift

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function daysBetween(later: string, earlier: string): number {
  return Math.round(
    (new Date(later).getTime() - new Date(earlier).getTime()) / DAY_MS,
  );
}

function isRemainderCode(code: string): boolean {
  return /-R\d+$/.test(code);
}

/**
 * Compose a 0-100 score from the weighted components. Defaults clamp
 * each component into [0, 100] so a single component can't push the
 * composite negative or over 100.
 */
function compose(c: ReliabilityComponents): number {
  return Math.round(
    clamp(c.date,         0, 100) * RELIABILITY_WEIGHTS.date +
    clamp(c.qty,          0, 100) * RELIABILITY_WEIGHTS.qty +
    clamp(c.color,        0, 100) * RELIABILITY_WEIGHTS.color +
    clamp(c.cancellation, 0, 100) * RELIABILITY_WEIGHTS.cancellation +
    clamp(c.stability,    0, 100) * RELIABILITY_WEIGHTS.stability,
  );
}

/**
 * Compute a single reliability score from PO batches using the
 * chosen "Expected Date" anchor. Used for both the PO Reliability
 * (anchor = poExpectedDateAtLock) and Ops Reliability (anchor =
 * opsProjectedDeliveryDateAtLock) flavours.
 */
function scoreAgainst(
  batches: ReliabilityBatch[],
  anchor: "po" | "ops",
): PoReliabilityScore {
  if (batches.length === 0) {
    // No batches — treat as 100% (no failure to measure) but with
    // zero confidence. The caller decides whether to surface.
    return {
      composite: 100,
      components: { date: 100, qty: 100, color: 100, cancellation: 100, stability: 100 },
      dateVarianceDays: null,
      raw: {
        closedBatches: 0, totalBatches: 0,
        cancelledBatches: 0, cancelledCars: 0,
        requestedCars: 0, deliveredCars: 0,
        shiftCount: 0,
      },
    };
  }

  const closed    = batches.filter((b) => b.closedAt != null);
  const cancelled = batches.filter((b) => b.closureReason === "cancelled");
  const originals = batches.filter((b) => !isRemainderCode(b.batchCode));

  const requestedCars = originals.reduce((s, b) => s + b.requestedQuantity, 0);
  const deliveredCars = batches.reduce((s, b) => s + (b.deliveredQuantity ?? 0), 0);
  const cancelledCars = cancelled.reduce((s, b) => s + b.requestedQuantity, 0);
  const totalShifts   = batches.reduce((s, b) => s + b.shiftCount, 0);

  // ── Date component
  // Latest closure across the PO's batches anchors against the
  // earliest at-lock date (the original commitment). When no batch
  // has closed yet, return 100 with a null variance flag — the
  // caller will mark this as "open / projected only" via the
  // `dateVarianceDays === null` signal.
  let dateComp = 100;
  let dateVariance: number | null = null;
  if (closed.length > 0) {
    const latestClose = closed
      .map((b) => b.closedAt!)
      .sort()
      .at(-1)!;
    const anchorDate = (() => {
      const dates = batches
        .map((b) =>
          anchor === "po"
            ? b.poExpectedDateAtLock ?? b.dealerPromisedDeliveryDate
            : b.opsProjectedDeliveryDateAtLock ?? b.currentProjectedDeliveryDate
                ?? b.dealerPromisedDeliveryDate,
        )
        .filter((d): d is string => !!d);
      return dates.length === 0 ? null : dates.slice().sort()[0];
    })();

    if (anchorDate) {
      dateVariance = daysBetween(latestClose, anchorDate);
      // 0 days late or early → 100. Linear decay until DATE_VARIANCE_CAP_DAYS.
      // Symmetric: "5 days early" and "5 days late" both score the same.
      // (Most ops teams penalise late more than early — tunable later.)
      const abs = Math.abs(dateVariance);
      dateComp = Math.max(0, 100 - (abs / DATE_VARIANCE_CAP_DAYS) * 100);
    }
  }

  // ── Qty component — delivered cars across all batches (remainders
  //    include their delivered count, since those cars belong to the
  //    original PO commitment) divided by ORIGINAL requested cars.
  const qtyComp = requestedCars === 0
    ? 100
    : clamp((deliveredCars / requestedCars) * 100, 0, 100);

  // ── Color component — sum across all batch_color_matrix rows on
  //    the PO. Uses delivered when realised, otherwise confirmed
  //    (R7 — earlier proxy when delivered isn't populated yet).
  const colorTotals = batches.flatMap((b) => b.colors);
  const colorRequested = colorTotals.reduce((s, c) => s + c.requested, 0);
  const colorDelivered = colorTotals.reduce((s, c) => s + c.delivered, 0);
  const colorConfirmed = colorTotals.reduce((s, c) => s + c.confirmed, 0);
  const colorComp = colorRequested === 0
    ? 100
    : clamp(
        ((closed.length === batches.length && colorDelivered > 0
          ? colorDelivered
          : colorConfirmed) / colorRequested) * 100,
        0, 100,
      );

  // ── Cancellation component — car-weighted, not batch-count.
  //    cancellationRate = cancelledCars / requestedCars * 100.
  //    Component = 100 − rate.
  const cancellationRate = requestedCars === 0
    ? 0
    : (cancelledCars / requestedCars) * 100;
  const cancellationComp = clamp(100 - cancellationRate, 0, 100);

  // ── Stability component — penalty for each shift, capped at 100.
  //    R3: a PO that shifted 5 times should NOT score the same as
  //    one that hit on the first projection, even if both land on
  //    the same final date.
  const stabilityComp = clamp(100 - totalShifts * SHIFT_PENALTY, 0, 100);

  const components: ReliabilityComponents = {
    date:         dateComp,
    qty:          qtyComp,
    color:        colorComp,
    cancellation: cancellationComp,
    stability:    stabilityComp,
  };

  return {
    composite: compose(components),
    components,
    dateVarianceDays: dateVariance,
    raw: {
      closedBatches:    closed.length,
      totalBatches:     batches.length,
      cancelledBatches: cancelled.length,
      cancelledCars,
      requestedCars,
      deliveredCars,
      shiftCount:       totalShifts,
    },
  };
}

/**
 * Compute both PO and Ops reliability for one PO. The pair surfaces
 * "did ops know better than the original PO commitment?" via
 * `opsAddedValue = opsReliability.composite − poReliability.composite`.
 */
export function computePoReliability(batches: ReliabilityBatch[]): {
  po:            PoReliabilityScore;
  ops:           PoReliabilityScore;
  opsAddedValue: number;
} {
  const po  = scoreAgainst(batches, "po");
  const ops = scoreAgainst(batches, "ops");
  return {
    po,
    ops,
    opsAddedValue: ops.composite - po.composite,
  };
}

/**
 * Roll up many PO scores into a single dealer-level number. Simple
 * mean across the dealer's closed POs. Returns null when the dealer
 * has no closed POs (small-sample guard handled by the caller via
 * the `closedPoCount` it returns alongside).
 */
export function aggregateDealerReliability(
  scores: { composite: number }[],
): { mean: number | null; n: number } {
  if (scores.length === 0) return { mean: null, n: 0 };
  const sum = scores.reduce((s, x) => s + x.composite, 0);
  return { mean: Math.round(sum / scores.length), n: scores.length };
}

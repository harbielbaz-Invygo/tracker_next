/**
 * PO Signed Reliability Score (Review #4 R1-R3, R5, R6 + Audit 4 fixes).
 *
 * For each closed PO, compute a 0-100 composite score from five
 * components plus a sibling "Ops" score that uses the locked Ops
 * projection instead of the locked PO commitment.
 *
 *   Date         — per-batch closedAt vs the locked Expected Date,
 *                  asymmetric (late hurts more than early), car-weighted
 *                  average across the PO's closed batches
 *   Qty          — deliveredCars / requestedCars  (excludes remainder
 *                  batches from the denominator — remainders are a
 *                  continuation of the same commitment)
 *   Color        — sum(deliveredQty per color) / sum(requestedQty per
 *                  color) across the PO's batches; falls back to
 *                  confirmedQty when delivered is unavailable
 *   Cancellation — fraction of cars cancelled (car-weighted, not
 *                  batch-count) → component = (100 − rate)
 *   Stability    — magnitude-aware: penalty scales with the cumulative
 *                  |delayDays| across all shift events when available,
 *                  falls back to flat per-shift penalty otherwise
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
 * Audit 4 changes (vs. the original Review #4 implementation):
 *   • Date component is per-batch (not earliest-anchor vs latest-close)
 *     so multi-wave POs don't conflate wave-1 early with wave-3 late.
 *   • Date penalty is asymmetric — late slip decays steeper than early.
 *   • Date component is car-weighted across the PO's closed batches.
 *   • Stability uses cumulative |delayDays| when available, so a single
 *     2-day shift no longer scores the same as a single 60-day shift.
 *   • Score surfaces `closureCoverage` so UIs can label partial-coverage
 *     POs instead of showing them at the same authority as fully-closed.
 *   • aggregateDealerReliability supports a car-weighted rollup so a
 *     dealer with one tiny perfect PO + one large failed PO doesn't
 *     read as "mostly fine".
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
  /** Count of shift events on the batch (kept for backward compat). */
  shiftCount: number;
  /**
   * Sum of |delayDays| across all shift events on this batch. When
   * supplied, the stability component uses magnitude instead of count,
   * so a 60-day shift is correctly weighted heavier than a 2-day one.
   * Pass undefined to fall back to `shiftCount × SHIFT_PENALTY`.
   */
  revisionDeltaDaysTotal?: number;
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
  /** Days off — weighted-mean across closed batches. Signed: negative =
   *  early, positive = late. Null when no closure. */
  dateVarianceDays: number | null;
  /** Min and max per-batch variance — surfaces the spread for multi-
   *  wave POs (a `-5/+12` range tells a different story than `+3.5`
   *  weighted-mean alone). Null when fewer than 2 closed batches. */
  dateVarianceRange: { min: number; max: number; n: number } | null;
  /**
   * 0..1 — fraction of the PO's batches that have actually closed.
   * UIs should treat low coverage as low-confidence (the components
   * that depend on closure — date, parts of color — are imputed when
   * coverage < 1 and shouldn't be read as equally authoritative as a
   * fully-closed PO's score).
   */
  closureCoverage: number;
  /** Helpful raw numbers for the UI breakdown. */
  raw: {
    closedBatches:      number;
    totalBatches:       number;
    cancelledBatches:   number;
    cancelledCars:      number;
    requestedCars:      number;
    deliveredCars:      number;
    shiftCount:         number;
    /** Sum of |delayDays| when revisionDeltaDaysTotal was supplied. */
    shiftDeltaDaysTotal: number;
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
 * Maximum LATE slip (days) at which the date component goes to 0.
 * 30 days is reasonable for monthly car cycles.
 */
const LATE_VARIANCE_CAP_DAYS = 30;

/**
 * Maximum EARLY slip (days) at which the date component goes to 0.
 * Early delivery is far less disruptive than late — many dealers welcome
 * it (floorplan can absorb), so we decay over a longer window. A PO that
 * arrives 30 days early should still score reasonably well; a PO 30 days
 * LATE should score 0.
 */
const EARLY_VARIANCE_CAP_DAYS = 60;

/**
 * Days of early delivery that incur ZERO penalty. Anything inside this
 * grace window scores 100 on date — distinct from "exactly on time".
 */
const EARLY_GRACE_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fallback per-shift penalty when no magnitude is provided. */
const SHIFT_PENALTY = 20;
/** Magnitude-aware penalty: points off per day of cumulative |delayDays|. */
const SHIFT_DAY_PENALTY = 2;

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
 * Asymmetric decay: positive variance (late) is penalised by a steeper
 * slope than negative variance (early). Early deliveries inside the
 * grace window incur zero penalty.
 */
function dateScoreFromVariance(varianceDays: number): number {
  if (varianceDays >= 0) {
    return Math.max(0, 100 - (varianceDays / LATE_VARIANCE_CAP_DAYS) * 100);
  }
  const earlyDays = -varianceDays;
  if (earlyDays <= EARLY_GRACE_DAYS) return 100;
  return Math.max(0, 100 - (earlyDays / EARLY_VARIANCE_CAP_DAYS) * 100);
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
      dateVarianceRange: null,
      closureCoverage: 0,
      raw: {
        closedBatches: 0, totalBatches: 0,
        cancelledBatches: 0, cancelledCars: 0,
        requestedCars: 0, deliveredCars: 0,
        shiftCount: 0, shiftDeltaDaysTotal: 0,
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
  const shiftDeltaDaysTotal = batches.reduce(
    (s, b) => s + (b.revisionDeltaDaysTotal ?? 0),
    0,
  );
  const closureCoverage = batches.length === 0
    ? 0
    : closed.length / batches.length;

  // ── Date component (Audit 4 — per-batch, asymmetric, car-weighted)
  //
  // Each closed batch contributes its own (closedAt − anchorAtLock)
  // variance scored under the asymmetric decay. The batch-level scores
  // are then averaged weighted by requestedQuantity so a wave of 50
  // cars carries more weight than a 5-car remainder.
  //
  // When no batch has closed yet, return 100 with a null variance flag.
  // The caller can interpret `closureCoverage = 0` to decide whether to
  // surface the score at all.
  const pickAnchor = (b: ReliabilityBatch): string | null =>
    anchor === "po"
      ? b.poExpectedDateAtLock ?? b.dealerPromisedDeliveryDate ?? null
      : b.opsProjectedDeliveryDateAtLock
        ?? b.currentProjectedDeliveryDate
        ?? b.dealerPromisedDeliveryDate
        ?? null;

  let dateComp = 100;
  let dateVariance: number | null = null;
  let dateVarianceRange: { min: number; max: number; n: number } | null = null;
  if (closed.length > 0) {
    const perBatch: { variance: number; score: number; weight: number }[] = [];
    for (const b of closed) {
      const anchorDate = pickAnchor(b);
      if (!anchorDate || !b.closedAt) continue;
      const variance = daysBetween(b.closedAt, anchorDate);
      const score    = dateScoreFromVariance(variance);
      // Weight by requested cars — bigger commitments carry more
      // weight. Floor at 1 to keep zero-qty rows from being ignored.
      const weight = Math.max(1, b.requestedQuantity);
      perBatch.push({ variance, score, weight });
    }
    if (perBatch.length > 0) {
      const totalWeight = perBatch.reduce((s, x) => s + x.weight, 0);
      const weightedScore = perBatch.reduce(
        (s, x) => s + x.score * x.weight, 0,
      );
      const weightedVariance = perBatch.reduce(
        (s, x) => s + x.variance * x.weight, 0,
      );
      dateComp = weightedScore / totalWeight;
      dateVariance = Math.round((weightedVariance / totalWeight) * 10) / 10;
      if (perBatch.length >= 2) {
        const variances = perBatch.map((x) => x.variance);
        dateVarianceRange = {
          min: Math.min(...variances),
          max: Math.max(...variances),
          n:   perBatch.length,
        };
      }
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

  // ── Stability component (Audit 4 — magnitude-aware when available).
  //
  //   If callers populate `revisionDeltaDaysTotal` on at least one
  //   batch, use the cumulative |delayDays| as the penalty driver
  //   (2 points per day → 50 cumulative days zeroes out the score).
  //   This means a single 60-day shift is correctly worse than ten
  //   2-day shifts. When no batch carries the magnitude data (older
  //   call sites), fall back to the original flat per-shift penalty.
  const hasMagnitude = batches.some((b) => b.revisionDeltaDaysTotal != null);
  const stabilityComp = hasMagnitude
    ? clamp(100 - shiftDeltaDaysTotal * SHIFT_DAY_PENALTY, 0, 100)
    : clamp(100 - totalShifts * SHIFT_PENALTY, 0, 100);

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
    dateVarianceRange,
    closureCoverage,
    raw: {
      closedBatches:    closed.length,
      totalBatches:     batches.length,
      cancelledBatches: cancelled.length,
      cancelledCars,
      requestedCars,
      deliveredCars,
      shiftCount:       totalShifts,
      shiftDeltaDaysTotal,
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
 * Roll up many PO scores into dealer-level numbers (Audit 4).
 *
 * Returns BOTH:
 *   - `mean`            — simple unweighted average across the dealer's
 *                         POs (legacy behaviour, kept for backward
 *                         compatibility on small-N executive views)
 *   - `carWeightedMean` — weighted by `requestedCars` per PO, so one
 *                         large failed PO can't be masked by a handful
 *                         of tiny perfect ones. This is the number
 *                         leadership should trust.
 *
 * Pass per-PO `requestedCars` when you want the weighted rollup;
 * if you only pass `composite`, the weighted mean falls back to the
 * unweighted mean.
 */
export function aggregateDealerReliability(
  scores: { composite: number; requestedCars?: number }[],
): {
  mean: number | null;
  carWeightedMean: number | null;
  n: number;
  totalCars: number;
} {
  if (scores.length === 0) {
    return { mean: null, carWeightedMean: null, n: 0, totalCars: 0 };
  }
  const sum = scores.reduce((s, x) => s + x.composite, 0);
  const mean = Math.round(sum / scores.length);

  const totalCars = scores.reduce((s, x) => s + (x.requestedCars ?? 0), 0);
  const weightedMean = totalCars > 0
    ? Math.round(
        scores.reduce(
          (s, x) => s + x.composite * (x.requestedCars ?? 0), 0,
        ) / totalCars,
      )
    : mean;
  return {
    mean,
    carWeightedMean: weightedMean,
    n: scores.length,
    totalCars,
  };
}

/**
 * Delivery-confidence scorer (Audit 3 #2).
 *
 * Pure function — no DB, no Node imports — so it's safe to call from
 * client + server. Takes a small bag of per-batch signals and returns
 * a 0–100 confidence score plus a categorical level and a short list
 * of human-readable reasons (for the "🚨 Upcoming at risk" feed).
 *
 * The score is intentionally simple and inspectable. It composes four
 * normalised factors:
 *
 *   timeFactor    — runway. More days until promise = more confident.
 *   vinFactor     — post-VIN batches enter the predictable execution
 *                   zone; pre-VIN with <14d to promise is the canonical
 *                   risk signal.
 *   delayFactor   — already-overdue batches drop to 0 here (they're
 *                   late by definition; the score reflects the chance
 *                   of catching up).
 *   ageFactor     — inherits the legacy `risk` field already on every
 *                   DashboardRow, inverted into the confidence frame.
 *
 * Weights are chosen so each factor can swing the score by 20–30
 * points individually. Easy to tweak once we have real data on
 * which signals predict slips most.
 */

export interface ConfidenceInput {
  /** Days from today to the effective availability date. Negative = overdue. Null = delivered/cancelled. */
  daysToAvailability: number | null;
  /** Pre-VIN batches are inherently riskier — bigger unknown. */
  vinPhase: "pre_vin" | "post_vin";
  /** Signed; positive = already late. */
  delayDays: number;
  /**
   * Legacy 0–100 risk score from `batches.riskScore`. Higher = riskier
   * historically. Inverted into the confidence frame so the new score
   * inherits ops's accumulated judgement.
   */
  legacyRisk: number;
}

export type ConfidenceLevel = "critical" | "high" | "medium" | "low";

export interface ConfidenceResult {
  /** 0–100, higher = more confident the batch will land on promise. */
  score: number;
  level: ConfidenceLevel;
  /** Short human-readable explanations for the worst-scoring factors. */
  reasons: string[];
}

const WEIGHTS = {
  time:   0.30,
  vin:    0.30,
  delay:  0.20,
  age:    0.20,
} as const;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Pure scorer — see file comment for the model. */
export function computeDeliveryConfidence(input: ConfidenceInput): ConfidenceResult {
  const reasons: string[] = [];

  // ─── timeFactor: runway scaled 0..1 over a 30-day horizon.
  // Already-overdue clamps to 0 so timeFactor doesn't reward being late.
  const days = input.daysToAvailability ?? 30;
  const timeFactor = days <= 0 ? 0 : clamp(days / 30, 0, 1);
  if (days <= 0) {
    reasons.push("Past promised availability date");
  } else if (days < 7) {
    reasons.push(`Only ${days}d until promised date`);
  } else if (days < 14) {
    reasons.push(`${days}d to promise — getting tight`);
  }

  // ─── vinFactor: post-VIN = 1, pre-VIN scales by runway.
  // Pre-VIN with 30+ days left is fine; pre-VIN with ≤14 days is
  // increasingly the dominant risk signal.
  let vinFactor: number;
  if (input.vinPhase === "post_vin") {
    vinFactor = 1;
  } else if (days <= 7) {
    vinFactor = 0.1;
    reasons.push(`No VIN with ≤7d to promise`);
  } else if (days <= 14) {
    vinFactor = 0.35;
    reasons.push(`No VIN with ≤14d to promise`);
  } else if (days <= 30) {
    vinFactor = 0.55;
  } else {
    vinFactor = 0.75;
  }

  // ─── delayFactor: already-late batches drop to 0.
  let delayFactor: number;
  if (input.delayDays <= 0) {
    delayFactor = 1;
  } else if (input.delayDays <= 3) {
    delayFactor = 0.6;
    reasons.push(`Already +${input.delayDays}d late`);
  } else if (input.delayDays <= 7) {
    delayFactor = 0.3;
    reasons.push(`Already +${input.delayDays}d late`);
  } else {
    delayFactor = 0;
    reasons.push(`Already +${input.delayDays}d late`);
  }

  // ─── ageFactor: invert the legacy risk score (0..100 → 1..0).
  const ageFactor = clamp(1 - input.legacyRisk / 100, 0, 1);
  if (input.legacyRisk >= 80) {
    reasons.push(`High historical risk score (${input.legacyRisk})`);
  }

  const weighted =
    timeFactor  * WEIGHTS.time +
    vinFactor   * WEIGHTS.vin +
    delayFactor * WEIGHTS.delay +
    ageFactor   * WEIGHTS.age;
  const score = Math.round(clamp(weighted * 100, 0, 100));

  const level: ConfidenceLevel =
    score < 30 ? "critical" :
    score < 50 ? "high" :
    score < 75 ? "medium" :
    "low";

  return { score, level, reasons };
}

/**
 * Insights page data layer — pulls together the dashboard + reports
 * data into a single payload for the unified `/insights` view.
 *
 * Deliberately a thin wrapper: it just calls the two existing data
 * functions in parallel and computes a few derived hero metrics on
 * top. Anything more sophisticated belongs in the underlying source
 * modules so other views can benefit.
 */
import { gte, or, isNull, eq, and, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batches, batchForecasts, users, batchActions, actionTypes,
  batchDateRevisions, batchDeliveryLegs, pos,
  actions as actionsTable,
} from "@/lib/db/schema";
import { getDashboardRows, type DashboardRow } from "@/lib/dashboard-data";
import { getPerformanceReport, type PerformanceReport } from "@/lib/reports-data";
import { computeDeliveryConfidence, type ConfidenceLevel } from "@/lib/delivery-confidence";
import { getExcusedActionIds } from "@/lib/delay-justifications";
import { withDbRetry } from "@/lib/db-retry";
import type { ReportPeriod } from "@/lib/reports-period";

export interface InsightsHero {
  /** North Star — total customer-days lost across all affected batches. */
  customerDaysLost: number;
  /**
   * Weekly customer-days-lost trend, last 12 weeks (oldest first).
   * Each entry is the sum of bookingsAtShift × delayDays across
   * shift events in that week. 0 in weeks with no shift events.
   * Drives the sparkline next to the Customer-days-lost hero tile.
   * (Audit 3 #7.)
   */
  customerDaysLostWeekly: number[];
  /** Open batches in the system. */
  activeBatches: number;
  /** Pre-VIN batches with ≤ 14 days to availability — needs ops attention now. */
  preVinCritical: number;
  /**
   * % of delivered batches that landed on or before promised. Null when
   * nothing has been delivered yet (avoid showing 0% on a fresh setup).
   *
   * NOTE: this is the NARROW rate — cancellations are excluded from
   * the denominator. See `commitmentHonorRate` below (Audit 5 #3) for
   * the broader trust signal that counts cancellations as misses.
   */
  onTimeRate: number | null;
  /**
   * Audit 5 #3 — Commitment honor rate including cancellations.
   *   deliveredOnTime / (deliveredOnTime + deliveredLate + cancelled)
   * A dealer who cancels 40% of POs and delivers the rest on time gets
   * a 60% honor rate (vs. 100% raw on-time rate). The number leadership
   * should track to expose cancellation drag.
   */
  commitmentHonorRate: number | null;
  /**
   * On-time rate per week, last 12 weeks (oldest first). null in
   * weeks with no deliveries. Drives the sparkline next to the
   * On-time rate hero tile. (Audit 3 #10.)
   */
  onTimeRateWeekly: (number | null)[];
  /** Cancelled batches count — surfaces dealer commitment breaches. */
  cancelled: number;
  /** Sum of revision counts across affected batches — trust erosion signal. */
  rePromisesIssued: number;
  /**
   * Audit 5 #5 — Re-promises BEFORE customers booked (bookingsAtShift = 0
   * at the moment of the shift). Internal-only churn; ops adjusting
   * dates while the batch is still pre-listing. Operationally normal.
   * Null when `batch_date_revisions` hasn't been migrated yet.
   */
  rePromisesPreBooking: number | null;
  /**
   * Audit 5 #5 — Re-promises AFTER at least one customer was booked
   * against the batch (bookingsAtShift > 0). Broken promises to real
   * customers — the alarming number that drives customer-days lost.
   */
  rePromisesPostBooking: number | null;
  /**
   * Median days from PO submission → app listing across batches that
   * were listed in the period. Null until at least one batch in the
   * cohort has been listed. Primary "PO → Listed" KPI.
   */
  medianDaysToListed: number | null;
  /**
   * Audit 5 #4 — 90th-percentile days PO→Listed across the same cohort
   * as the median. Pairs with median to expose tail risk: a healthy
   * median can hide a long tail of slow batches. Null when fewer than
   * 3 samples (percentile is meaningless on tiny n).
   */
  p90DaysToListed: number | null;
  /**
   * Count of post_po batches still unlisted whose submission is older
   * than 14 days. The actionable companion to medianDaysToListed —
   * "how many are over the line today?".
   */
  unlistedOverThreshold: number;
  /**
   * Weekly median PO→Listed trend (Audit 2 #5), 12 weeks, oldest
   * first. Null in weeks with no listings. Drives the sparkline next
   * to the headline median.
   */
  medianDaysToListedWeekly: (number | null)[];
  /**
   * Audit 7 — period-over-period comparison for the three core KPIs.
   * Null when `period === "all"` (no natural prior window) or when the
   * underlying tables aren't migrated. See {@link PeriodComparison}.
   */
  comparison: PeriodComparison | null;
}

/**
 * One KPI's movement between the current window and the equal-length
 * window immediately before it.
 *
 * `current`/`prior` are the raw measures (customer-days, % on-time,
 * median days). `deltaPct` is the *relative* change (current vs prior)
 * for measures where that reads naturally (customer-days, median days);
 * the UI renders on-time as a percentage-point gap instead, straight
 * from `current - prior`. `improved` already accounts for direction —
 * lower-is-better for customer-days + median, higher-is-better for
 * on-time — so the UI just picks the colour, not the polarity.
 */
export interface KpiDelta {
  current: number | null;
  prior: number | null;
  /** Signed relative % change (current vs prior). Null when prior is 0/null. */
  deltaPct: number | null;
  /** True when the move is good news; null when undecidable (a side is null). */
  improved: boolean | null;
}

/** Period-over-period deltas for the three headline KPIs (Audit 7). */
export interface PeriodComparison {
  /** Window length label for the caption, e.g. "30d" → "vs prior 30d". */
  periodLabel: ReportPeriod;
  customerDaysLost: KpiDelta;
  onTimeRate: KpiDelta;
  medianDaysToListed: KpiDelta;
}

/**
 * Closure-and-volume snapshot — the same flavour of strip Ops sees on
 * the Action Center. Batch-count primaries with car-level subtitles.
 * Period-scoped: closed batches must have closedAt within the window,
 * open batches stay in regardless.
 */
export interface ClosureSummary {
  totalBatches: number;
  totalQuantity: number;

  listed: number;
  carsListed: number;
  /** Cars listed on a post_po batch where appListedAt is set. */
  carsListedConfirmed: number;
  /** Cars on a pre_po batch with the Pre-PO App Listing action marked done. */
  carsListedForecastOnly: number;

  delivered: number;
  carsDelivered: number;

  partlyDelivered: number;
  carsPartlyDelivered: number;
  carsPartlyRequested: number;

  cancelled: number;
  carsCancelled: number;
}

/**
 * One row per Partnership team member who has submitted at least one
 * Forecast. Drives the Trust → Forecast reliability tab.
 *
 * Definitions:
 *   - submitted    = number of Forecasts submitted by this user
 *   - fulfilled    = forecasts where the underlying batch flipped to
 *                    post_po (1:1) OR was superseded by splits (PR 3)
 *   - cancelled    = forecasts that the user / ops cancelled
 *                    (closureReason='cancelled' on the pre_po batch)
 *   - open         = pre_po batches with no closure / not superseded
 *   - avgDriftDays = mean (intakePoDate - forecastSubmittedAt) across
 *                    fulfilled forecasts. Null when no fulfilled rows.
 */
export interface ForecastReliabilityRow {
  userId: number;
  name: string;
  submitted: number;
  fulfilled: number;
  superseded: number;
  cancelled: number;
  open: number;
  /**
   * Mean (intakePoDate − forecastSubmittedAt) in days across this
   * user's fulfilled / superseded forecasts. Negative = PO arrived
   * earlier than expected; positive = late. Null when no fulfilled
   * forecasts.
   */
  avgDriftDays: number | null;
  /**
   * 90th-percentile drift across the same cohort. Pairs with avg to
   * expose tail risk — a clean average can hide a few extreme misses.
   * Null when fewer than 3 fulfilled samples (percentile is noise
   * on tiny n, matches the listing-speed p90 gate).
   */
  p90DriftDays: number | null;
  /**
   * Fraction of this user's realized (fulfilled + superseded)
   * forecasts where the dealer pivoted the car model between
   * forecast and PO. Computed by comparing the forecast row's
   * `carModel` against the linked PO batch's `model` — any
   * case-insensitive non-match counts. Null when no realized
   * forecasts have model data on both sides (legacy / unmigrated).
   */
  modelSwapRate: number | null;
  /**
   * Sum of `bookingsCount` across this user's pre-PO forecasts —
   * how many customer bookings landed against their bets while they
   * were still pre-PO. The "customer exposure" signal: a high number
   * means cancellations / mis-forecasts hurt real customers.
   */
  totalBookings: number;
}

/**
 * Audit 2 #1 — Per-action-type breakdown for the Internal Phase.
 * Answers "which stage is the bottleneck?" — the most-asked listing-
 * speed question. One row per action_type with scope='po'.
 *
 *   medianDaysFromSubmission = median of (completedAt − PO.requestedAt)
 *     across done actions of this type. Cumulative days from PO
 *     submission to this stage landing — gaps between adjacent rows
 *     reveal where time pools (e.g. SKU done day 7 but App Listing
 *     done day 11 → 4 days waiting on listing after SKU is in).
 *   avgDelayDays           = mean (completedAt − expectedDate) across
 *     done rows with both dates set. Negative = ahead, positive = late.
 *   onTimeRate             = % of done rows where completedAt ≤
 *     expectedDate. Null when no done rows had an expectedDate.
 *   openCount              = waiting + blocked rows of this type.
 *   doneCount              = done rows of this type.
 */
/**
 * Audit 2 #6 — "Stuck stages right now" widget row.
 *
 * One row per action_type that has at least one open (waiting or
 * blocked) action somewhere in the system, sorted by open count DESC.
 * Answers "what's piling up RIGHT NOW" without needing the operator
 * to drill into individual batches.
 *
 *   openCount       — waiting + blocked rows of this type
 *   blockedCount    — subset of openCount that are 'blocked' (parent
 *                     dep unmet). Useful to distinguish "nobody's
 *                     working it" from "it can't be worked yet".
 *   medianAgeDays   — median (today − action.createdAt) across open
 *                     rows. Null when no rows have a creation
 *                     timestamp.
 *   oldestAgeDays   — max age across the open rows. Spotlights the
 *                     single oldest row hidden inside an otherwise
 *                     healthy queue.
 *   scope           — "po" / "wave" / "batch" (matches actions.scope).
 *                     Lets the UI separate internal-phase pile-ups
 *                     from external-phase ones.
 */
export interface StuckStageRow {
  actionTypeId:   number;
  actionTypeName: string;
  scope:          "po" | "wave" | "batch";
  sortOrder:      number;
  openCount:      number;
  blockedCount:   number;
  medianAgeDays:  number | null;
  oldestAgeDays:  number | null;
}

export interface InternalPhaseActionStat {
  actionTypeId: number;
  actionTypeName: string;
  sortOrder: number;
  doneCount: number;
  openCount: number;
  medianDaysFromSubmission: number | null;
  avgDelayDays: number | null;
  onTimeRate: number | null;
}

/**
 * Audit 3 #1 — "🚨 Upcoming deliveries at risk" feed row.
 *
 * One per open batch whose effective availability date is within the
 * next 30 days (already-overdue batches are included too — they're the
 * highest priority by definition). Sorted by confidence score ASC so
 * the most-at-risk lands first.
 */
export interface UpcomingAtRiskRow {
  batchCode: string;
  poNumber: string | null;
  dealerName: string;
  modelYear: string;
  quantity: number;
  promisedDate: string;
  daysToAvailability: number | null;
  vinPhase: "pre_vin" | "post_vin";
  delayDays: number;
  /** 0–100, higher = more confident. */
  confidenceScore: number;
  confidenceLevel: ConfidenceLevel;
  /** Top human-readable reasons, capped to the worst 3. */
  reasons: string[];
}

export interface InsightsData {
  generatedAt: string;
  hero: InsightsHero;
  /** Full reports payload — feeds Customer Impact + Trust tabs. */
  report: PerformanceReport;
  /** Dashboard rows — feeds the Batch Explorer at the bottom. */
  batchRows: DashboardRow[];
  /** Action-Center-style closure metrics — feeds the new strip. */
  closure: ClosureSummary;
  /** Per-Partnership-user Forecast reliability — feeds the Trust tab. */
  forecastReliability: ForecastReliabilityRow[];
  /**
   * "🚨 Upcoming at risk" feed (Audit 3 #1). Open batches whose
   * effective availability date is within the next 30 days, sorted
   * by delivery-confidence score ASC. Capped to 10 rows so the
   * widget stays scannable.
   */
  upcomingAtRisk: UpcomingAtRiskRow[];
  /**
   * Per-action-type breakdown for the Internal Phase (Audit 2 #1).
   * Sorted by action_types.sortOrder so the rows read in the same
   * order ops sees the chips in the Action Center.
   */
  internalPhaseStats: InternalPhaseActionStat[];
  /**
   * "Stuck stages right now" rollup (Audit 2 #6). One row per
   * action_type with ≥ 1 open action, sorted by openCount DESC.
   * Snapshot — not period-scoped, since "right now" is the point.
   */
  stuckStages: StuckStageRow[];
}

/** Period lower-bound ISO date. Duplicated from reports-data so we
 *  don't have to widen its export surface for one helper. */
function fromIsoForPeriod(period: ReportPeriod): string | null {
  if (period === "all") return null;
  const days = { "30d": 30, "90d": 90, "6m": 183 }[period];
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function emptyClosureSummary(): ClosureSummary {
  return {
    totalBatches: 0, totalQuantity: 0,
    listed: 0, carsListed: 0, carsListedConfirmed: 0, carsListedForecastOnly: 0,
    delivered: 0, carsDelivered: 0,
    partlyDelivered: 0, carsPartlyDelivered: 0, carsPartlyRequested: 0,
    cancelled: 0, carsCancelled: 0,
  };
}

async function getClosureSummary(period: ReportPeriod): Promise<ClosureSummary> {
  const fromIso = fromIsoForPeriod(period);
  const baseQuery = db
    .select({
      id:                batches.id,
      quantity:          batches.requestedQuantity,
      deliveredQuantity: batches.deliveredQuantity,
      closedAt:          batches.closedAt,
      closureReason:     batches.closureReason,
      appListedAt:       batches.appListedAt,
      lifecycleState:    batches.lifecycleState,
    })
    .from(batches);

  // Defensive: every column above except `lifecycleState` was on
  // batches before PR 1, so this won't fail in normal operation. Kept
  // wrapped so a fresh-clone dev still loads the page even if the
  // schema hasn't been pushed yet.
  let rows: Awaited<typeof baseQuery>;
  try {
    rows = await (fromIso
      ? baseQuery.where(or(gte(batches.closedAt, fromIso), isNull(batches.closedAt)))
      : baseQuery);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table|no such column/i.test(msg)) {
      // eslint-disable-next-line no-console
      console.warn("[insights-data] closure summary skipped — schema not migrated.");
      return emptyClosureSummary();
    }
    throw err;
  }

  const totalBatches = rows.length;
  const totalQuantity = rows.reduce((acc, r) => acc + (r.quantity ?? 0), 0);

  const listed = rows.filter((r) => r.appListedAt != null).length;
  const carsListed = rows
    .filter((r) => r.appListedAt != null)
    .reduce((acc, r) => acc + (r.quantity ?? 0), 0);

  // "Confirmed" listings = appListedAt set on a post_po batch (came in
  // via the normal Intake → list flow). The mutually exclusive bucket
  // "forecast-only" requires a separate lookup: pre_po batches that
  // have a Pre-PO App Listing batch_action with status='done'. The
  // tile renders `<confirmed> confirmed · <forecast-only> forecast-only`.
  const carsListedConfirmed = rows
    .filter((r) => r.appListedAt != null && r.lifecycleState === "post_po")
    .reduce((acc, r) => acc + (r.quantity ?? 0), 0);

  // Wrapped — the action_types table is old, but the row "Pre-PO App
  // Listing" may not be seeded yet. Either case, default carsListedForecastOnly
  // to 0 and keep loading the page.
  let carsListedForecastOnly = 0;
  try {
    const prePoActionType = (await db.select({ id: actionTypes.id })
      .from(actionTypes).where(eq(actionTypes.name, "Pre-PO App Listing")).limit(1))[0];
    if (prePoActionType) {
      const forecastListed = await db
        .select({
          batchId:  batches.id,
          quantity: batches.requestedQuantity,
        })
        .from(batchActions)
        .innerJoin(batches, eq(batches.id, batchActions.batchId))
        .where(and(
          eq(batchActions.actionTypeId, prePoActionType.id),
          eq(batchActions.status, "done"),
          eq(batches.lifecycleState, "pre_po"),
        ));
      carsListedForecastOnly = forecastListed.reduce((acc, r) => acc + (r.quantity ?? 0), 0);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no such table|no such column/i.test(msg)) throw err;
    // eslint-disable-next-line no-console
    console.warn("[insights-data] Pre-PO listing lookup skipped — schema not migrated.");
  }

  const delivered = rows.filter((r) => r.closureReason === "delivered").length;
  const carsDelivered = rows.reduce((acc, r) => acc + (r.deliveredQuantity ?? 0), 0);

  const partlyRows = rows.filter(
    (r) => (r.deliveredQuantity ?? 0) > 0
        && (r.deliveredQuantity ?? 0) < (r.quantity ?? 0),
  );
  const partlyDelivered = partlyRows.length;
  const carsPartlyDelivered = partlyRows.reduce((acc, r) => acc + (r.deliveredQuantity ?? 0), 0);
  const carsPartlyRequested = partlyRows.reduce((acc, r) => acc + (r.quantity ?? 0), 0);

  const cancelled = rows.filter((r) => r.closureReason === "cancelled").length;
  const carsCancelled = rows
    .filter((r) => r.closureReason === "cancelled")
    .reduce((acc, r) => acc + (r.quantity ?? 0), 0);

  return {
    totalBatches, totalQuantity,
    listed, carsListed, carsListedConfirmed, carsListedForecastOnly,
    delivered, carsDelivered,
    partlyDelivered, carsPartlyDelivered, carsPartlyRequested,
    cancelled, carsCancelled,
  };
}

async function getForecastReliability(period: ReportPeriod): Promise<ForecastReliabilityRow[]> {
  const fromIso = fromIsoForPeriod(period);
  // Pull every forecast row joined with the underlying batch + submitter.
  // Period-scoped on submittedAt so the table answers "for forecasts
  // submitted in the last N days, how reliable was each submitter?".
  // `batches.model` is the dealer-PO-side car model for the realized
  // case (1:1 fulfilled flips the same row to post_po); compared
  // against the per-leg `car_model` captured at forecast submission
  // to detect post-link model swaps (Audit 5 follow-up).
  const baseQuery = db
    .select({
      batchId:           batches.id,
      poModel:           batches.model,
      lifecycleState:    batches.lifecycleState,
      closedAt:          batches.closedAt,
      closureReason:     batches.closureReason,
      forecastSupersededAt: batches.forecastSupersededAt,
      actualPoDate:      batches.actualPoDate,
      submittedAt:       batchForecasts.submittedAt,
      userId:            users.id,
      userName:          users.name,
      userUsername:      users.username,
    })
    .from(batchForecasts)
    .innerJoin(batches, eq(batches.id, batchForecasts.batchId))
    .innerJoin(users,   eq(users.id,   batchForecasts.submittedByUserId));

  // Defensive: batch_forecasts is new in PR 1. If the migration didn't
  // apply (or columns are missing), return [] so Insights still loads.
  let rows: Awaited<typeof baseQuery>;
  try {
    rows = await (fromIso
      ? baseQuery.where(gte(batchForecasts.submittedAt, fromIso))
      : baseQuery);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table|no such column/i.test(msg)) {
      // eslint-disable-next-line no-console
      console.warn(
        "[insights-data] Forecast reliability skipped — batch_forecasts " +
        "table or new columns missing. Run `npm run db:push`.",
      );
      return [];
    }
    throw err;
  }

  // Pull legs for the forecast batches — gives us per-row carModel
  // (for the swap-rate diff against the linked PO's model) and
  // bookingsCount (for the customer-exposure signal). Wrapped because
  // the per-row columns are new on `batch_delivery_legs`; older DBs
  // return rows without them and we treat those as zero.
  const legsByBatch = new Map<number, { carModel: string | null; bookings: number; quantity: number }[]>();
  try {
    const legRows = await db
      .select({
        batchId:       batchDeliveryLegs.batchId,
        carModel:      batchDeliveryLegs.carModel,
        bookingsCount: batchDeliveryLegs.bookingsCount,
        requestedQty:  batchDeliveryLegs.requestedQuantity,
      })
      .from(batchDeliveryLegs);
    for (const l of legRows) {
      const arr = legsByBatch.get(l.batchId) ?? [];
      arr.push({
        carModel: l.carModel ?? null,
        bookings: l.bookingsCount ?? 0,
        quantity: l.requestedQty,
      });
      legsByBatch.set(l.batchId, arr);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no such column|no such table/i.test(msg)) throw err;
    // Legacy DB without the new columns — empty map; metrics that
    // depend on legs fall back to null / zero in the aggregation.
  }

  type Acc = {
    name: string;
    submitted: number;
    fulfilled: number;
    superseded: number;
    cancelled: number;
    open: number;
    drifts: number[];
    /** Forecasts where both forecast model and PO model are known. */
    modelComparable: number;
    /** Of those, how many had any leg's model differ from the PO model. */
    modelSwapped: number;
    /** Sum of per-leg bookingsCount across this user's pre-PO forecasts. */
    bookings: number;
  };
  const byUser = new Map<number, Acc>();
  const norm = (s: string | null | undefined) =>
    (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  for (const r of rows) {
    const a = byUser.get(r.userId) ?? {
      name: r.userName ?? `@${r.userUsername ?? "user"}`,
      submitted: 0, fulfilled: 0, superseded: 0, cancelled: 0, open: 0,
      drifts: [], modelComparable: 0, modelSwapped: 0, bookings: 0,
    };
    a.submitted++;
    const legs = legsByBatch.get(r.batchId) ?? [];
    // Bookings are pre-PO only — the column gets frozen the moment a
    // forecast is linked. Counting across submitted forecasts is
    // honest: it's "total customer exposure this user generated."
    for (const leg of legs) a.bookings += leg.bookings;

    if (r.closureReason === "cancelled") {
      a.cancelled++;
    } else if (r.forecastSupersededAt) {
      a.superseded++;
    } else if (r.lifecycleState === "post_po") {
      a.fulfilled++;
      if (r.actualPoDate && r.submittedAt) {
        const drift = (new Date(r.actualPoDate).getTime() - new Date(r.submittedAt).getTime()) / 86_400_000;
        a.drifts.push(Math.round(drift));
      }
      // Model-swap diff — only meaningful in the 1:1 fulfilled case
      // where the SAME batch row carries both the forecast legs and
      // the post-PO model. Superseded forecasts produce N children
      // with their own models; surfacing that as one swap-or-not is
      // ambiguous, so we skip the comparison there. The superseded
      // count itself signals divergence at a higher resolution.
      const forecastModels = legs.map((l) => norm(l.carModel)).filter(Boolean);
      const poModel = norm(r.poModel);
      if (forecastModels.length > 0 && poModel) {
        a.modelComparable++;
        if (forecastModels.some((m) => m !== poModel)) a.modelSwapped++;
      }
    } else {
      a.open++;
    }
    byUser.set(r.userId, a);
  }

  return Array.from(byUser.entries())
    .map(([userId, a]) => {
      const avgDriftDays = a.drifts.length === 0
        ? null
        : Math.round(a.drifts.reduce((s, v) => s + v, 0) / a.drifts.length);
      // p90 gated to n≥3 — matches the listing-speed treatment so the
      // signal isn't dominated by a single outlier.
      let p90DriftDays: number | null = null;
      if (a.drifts.length >= 3) {
        const sorted = a.drifts.slice().sort((x, y) => x - y);
        const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.9 * sorted.length) - 1));
        p90DriftDays = sorted[idx];
      }
      const modelSwapRate = a.modelComparable === 0
        ? null
        : Math.round((a.modelSwapped / a.modelComparable) * 100);
      return {
        userId,
        name: a.name,
        submitted: a.submitted,
        fulfilled: a.fulfilled,
        superseded: a.superseded,
        cancelled: a.cancelled,
        open:      a.open,
        avgDriftDays,
        p90DriftDays,
        modelSwapRate,
        totalBookings: a.bookings,
      };
    })
    .sort((x, y) => y.submitted - x.submitted);
}

/**
 * Listing-speed KPI aggregate (Review #2 R1).
 *
 *   - medianDaysToListed: median of (appListedAt − requestedAt) across
 *     post_po batches whose `appListedAt` falls in the period. Null
 *     when no batch has been listed in the period.
 *   - unlistedOverThreshold: count of open post_po batches whose
 *     submission was ≥ 14 days ago and that aren't listed yet.
 *
 * Both signals come from existing columns — no schema migration.
 * Period filters use `appListedAt` for the median (the cohort is
 * "batches listed in the window") and ignore the period for the
 * overdue count (which is inherently a "right now" measurement).
 */
async function getListingSpeed(period: ReportPeriod): Promise<{
  medianDaysToListed: number | null;
  /** Audit 5 #4 — 90th percentile of the same cohort, surfaces tail risk. */
  p90DaysToListed: number | null;
  unlistedOverThreshold: number;
  /** Weekly median trend, 12 weeks oldest first. (Audit 2 #5.) */
  medianDaysToListedWeekly: (number | null)[];
}> {
  const fromIso = fromIsoForPeriod(period);
  const todayStr = new Date().toISOString().slice(0, 10);
  const THRESHOLD_DAYS = 14;

  // Defensive: the columns we need (requestedAt, appListedAt,
  // lifecycleState, closedAt) are all old enough that this query
  // shouldn't fail. Wrapped anyway to match the pattern used by
  // sibling aggregations.
  let rows: { requestedAt: string | null; appListedAt: string | null;
              lifecycleState: "pre_po" | "post_po"; closedAt: string | null }[];
  try {
    rows = await db.select({
      requestedAt:    batches.requestedAt,
      appListedAt:    batches.appListedAt,
      lifecycleState: batches.lifecycleState,
      closedAt:       batches.closedAt,
    }).from(batches);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table|no such column/i.test(msg)) {
      // eslint-disable-next-line no-console
      console.warn("[insights-data] listing speed skipped — schema not migrated.");
      return {
        medianDaysToListed: null,
        p90DaysToListed: null,
        unlistedOverThreshold: 0,
        medianDaysToListedWeekly: Array.from({ length: 12 }, () => null),
      };
    }
    throw err;
  }

  // Median computation: collect days between submission and listing
  // for post_po batches that have been listed within the period (or
  // ever, when period === "all").
  const daysSamples: number[] = [];
  let unlistedOver = 0;
  for (const r of rows) {
    if (r.lifecycleState !== "post_po") continue;
    if (!r.requestedAt) continue;

    if (r.appListedAt) {
      const listedOn = r.appListedAt.slice(0, 10);
      if (fromIso && listedOn < fromIso) continue; // out of window
      const days = Math.round(
        (new Date(listedOn).getTime() - new Date(r.requestedAt).getTime())
          / (24 * 60 * 60 * 1000),
      );
      if (days >= 0) daysSamples.push(days);
    } else if (r.closedAt == null) {
      // Open + unlisted — count toward the "overdue" companion.
      const ageDays = Math.round(
        (new Date(todayStr).getTime() - new Date(r.requestedAt).getTime())
          / (24 * 60 * 60 * 1000),
      );
      if (ageDays >= THRESHOLD_DAYS) unlistedOver++;
    }
  }

  const median = (arr: number[]): number | null => {
    if (arr.length === 0) return null;
    const sorted = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      : sorted[mid];
  };
  const medianDaysToListed = median(daysSamples);

  // Audit 2 #5 — weekly bucket the same (appListedAt − requestedAt)
  // samples. Each bucket's median is independent of the period
  // filter so the trend always reads 12 weeks back from today.
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
  const daysSinceMonday = (todayMidnight.getDay() + 6) % 7;
  const thisWeekStartMs = todayMidnight.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000;
  const bucketEdges = Array.from({ length: 12 }, (_, i) => thisWeekStartMs - (11 - i) * WEEK_MS);
  const buckets: number[][] = Array.from({ length: 12 }, () => []);
  for (const r of rows) {
    if (r.lifecycleState !== "post_po") continue;
    if (!r.requestedAt || !r.appListedAt) continue;
    const listedTs = new Date(r.appListedAt.slice(0, 10)).getTime();
    if (!Number.isFinite(listedTs)) continue;
    for (let i = 11; i >= 0; i--) {
      if (listedTs >= bucketEdges[i]) {
        const days = Math.round(
          (listedTs - new Date(r.requestedAt).getTime()) / (24 * 60 * 60 * 1000),
        );
        if (days >= 0) buckets[i].push(days);
        break;
      }
    }
  }
  const medianDaysToListedWeekly = buckets.map((b) => median(b));

  // Audit 5 #4 — nearest-rank p90 on the same cohort. Requires ≥ 3
  // samples; otherwise a single outlier becomes "p90" (noise, not signal).
  let p90DaysToListed: number | null = null;
  if (daysSamples.length >= 3) {
    const sortedAsc = daysSamples.slice().sort((a, b) => a - b);
    const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(0.9 * sortedAsc.length) - 1));
    p90DaysToListed = sortedAsc[idx];
  }

  return {
    medianDaysToListed,
    p90DaysToListed,
    unlistedOverThreshold: unlistedOver,
    medianDaysToListedWeekly,
  };
}

/**
 * Audit 5 #5 — split the re-promise count by whether customer
 * bookings existed at the moment of each shift event.
 *   pre  = revisions with bookingsAtShift = 0 (internal churn)
 *   post = revisions with bookingsAtShift > 0 (broken customer trust)
 * Period-scoped via `revisedAt` so a long-running batch contributes
 * only the shifts that fell in the window. Returns null/null on
 * pre-migration DBs; caller falls back to the unsplit headline.
 */
async function getRePromiseSplit(period: ReportPeriod): Promise<{
  pre: number | null;
  post: number | null;
}> {
  const fromIso = fromIsoForPeriod(period);
  let rows: { revisedAt: string | null; bookingsAtShift: number }[];
  try {
    rows = await db
      .select({
        revisedAt:       batchDateRevisions.revisedAt,
        bookingsAtShift: batchDateRevisions.bookingsAtShift,
      })
      .from(batchDateRevisions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(msg)) return { pre: null, post: null };
    throw err;
  }
  let pre = 0;
  let post = 0;
  for (const r of rows) {
    if (fromIso && r.revisedAt && r.revisedAt.slice(0, 10) < fromIso) continue;
    if ((r.bookingsAtShift ?? 0) > 0) post++;
    else pre++;
  }
  return { pre, post };
}

/**
 * Audit 7 — period-over-period comparison for the three core KPIs.
 *
 * Returns null for `period === "all"` (no natural prior window) and for
 * pre-migration DBs. Otherwise computes each KPI for the current window
 * `[today−N, today]` and the equal-length prior window `[today−2N,
 * today−N)` so the two never overlap (`priorTo === curFrom`).
 *
 * The measures are deliberately the *event-sourced, windowable* ones —
 * they answer "what happened during this window" rather than "what's
 * the live state", which is the only honest basis for a historical
 * comparison:
 *   • customer-days-lost — Σ(bookingsAtShift × delayDays) over shift
 *     events (`batch_date_revisions.revisedAt`). This is the same
 *     measure that drives the weekly sparkline; it can differ slightly
 *     from the batch-level headline (which folds in live projections on
 *     still-open batches), but it's the one you can window cleanly.
 *   • on-time rate — delivered batches bucketed by `closedAt`, on-time
 *     test replicated verbatim from the headline (`closedAt >
 *     promisedDate` ⇒ late).
 *   • median PO→Listed — (appListedAt − requestedAt) for post_po batches
 *     bucketed by `appListedAt`, gated at n ≥ 3 per side so a one-off
 *     doesn't masquerade as a trend.
 */
async function getPeriodComparison(period: ReportPeriod): Promise<PeriodComparison | null> {
  if (period === "all") return null;
  const days = { "30d": 30, "90d": 90, "6m": 183 }[period];
  const DAY_MS = 24 * 60 * 60 * 1000;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const todayMs = t.getTime();
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const todayStr = iso(todayMs);
  const curFrom   = iso(todayMs - days * DAY_MS);
  const priorFrom = iso(todayMs - 2 * days * DAY_MS);
  const priorTo   = curFrom; // windows abut; current owns the shared edge

  const inCur   = (d: string) => d >= curFrom && d <= todayStr;
  const inPrior = (d: string) => d >= priorFrom && d < priorTo;

  // ── customer-days-lost (revision-sourced) ──────────────────────────
  let cdlCur: number | null = 0;
  let cdlPrior: number | null = 0;
  try {
    const revisions = await db
      .select({
        revisedAt:       batchDateRevisions.revisedAt,
        delayDays:       batchDateRevisions.delayDays,
        bookingsAtShift: batchDateRevisions.bookingsAtShift,
      })
      .from(batchDateRevisions);
    for (const r of revisions) {
      if (!r.revisedAt) continue;
      const impact = (r.bookingsAtShift ?? 0) * (r.delayDays ?? 0);
      if (impact <= 0) continue;
      const d = r.revisedAt.slice(0, 10);
      if (inCur(d)) cdlCur! += impact;
      else if (inPrior(d)) cdlPrior! += impact;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no such (table|column)/i.test(msg)) throw err;
    cdlCur = null; cdlPrior = null; // pre-migration — no honest number
  }

  // ── on-time rate + median PO→Listed (batch fields, one pass) ────────
  let onCur = 0, lateCur = 0, onPrior = 0, latePrior = 0;
  const medCur: number[] = [];
  const medPrior: number[] = [];
  try {
    const rows = await db
      .select({
        closedAt:       batches.closedAt,
        closureReason:  batches.closureReason,
        promisedDate:   batches.dealerPromisedDeliveryDate,
        requestedAt:    batches.requestedAt,
        appListedAt:    batches.appListedAt,
        lifecycleState: batches.lifecycleState,
      })
      .from(batches);
    for (const b of rows) {
      // On-time: delivered batches, bucketed by the day they closed.
      if (b.closedAt && b.closureReason === "delivered" && b.promisedDate) {
        const day = b.closedAt.slice(0, 10);
        const late = b.closedAt > b.promisedDate; // verbatim from headline calc
        if (inCur(day))        { if (late) lateCur++;   else onCur++; }
        else if (inPrior(day)) { if (late) latePrior++; else onPrior++; }
      }
      // Median PO→Listed: post_po batches, bucketed by listing day.
      if (b.lifecycleState === "post_po" && b.requestedAt && b.appListedAt) {
        const day = b.appListedAt.slice(0, 10);
        const dd = Math.round(
          (new Date(day).getTime() - new Date(b.requestedAt).getTime()) / DAY_MS,
        );
        if (dd >= 0) {
          if (inCur(day)) medCur.push(dd);
          else if (inPrior(day)) medPrior.push(dd);
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no such (table|column)/i.test(msg)) throw err;
    // Leave the accumulators empty; the deltas degrade to null below.
  }

  const median = (arr: number[]): number | null => {
    if (arr.length < 3) return null; // gate noise on tiny windows
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
  };
  const rate = (on: number, late: number): number | null =>
    on + late > 0 ? Math.round((on / (on + late)) * 100) : null;

  /** Build a KpiDelta. `lowerIsBetter` flips the `improved` polarity. */
  const delta = (
    current: number | null,
    prior: number | null,
    lowerIsBetter: boolean,
  ): KpiDelta => {
    let deltaPct: number | null = null;
    let improved: boolean | null = null;
    if (current != null && prior != null) {
      if (prior !== 0) deltaPct = Math.round(((current - prior) / prior) * 100);
      if (current !== prior) improved = lowerIsBetter ? current < prior : current > prior;
      else improved = null; // dead flat — neither up nor down
    }
    return { current, prior, deltaPct, improved };
  };

  return {
    periodLabel: period,
    customerDaysLost:   delta(cdlCur, cdlPrior, true),
    onTimeRate:         delta(rate(onCur, lateCur), rate(onPrior, latePrior), false),
    medianDaysToListed: delta(median(medCur), median(medPrior), true),
  };
}

export async function getInsightsData(period: ReportPeriod = "all"): Promise<InsightsData> {
  // Both functions hit the DB; run them in parallel.
  // Same period filter is threaded into both — Insights is just the
  // union of Dashboard + Reports, so scoping them together keeps the
  // hero metrics and the underlying tables in agreement.
  const [report, batchRows, closure, forecastReliability] = await withDbRetry(() => Promise.all([
    getPerformanceReport(period),
    getDashboardRows(period),
    getClosureSummary(period),
    getForecastReliability(period),
  ]));

  // Pre-VIN critical: derived from the dashboard rows where the row is
  // pre-VIN AND its days-to-availability is ≤ 14 AND not delivered.
  const preVinCritical = batchRows.filter(
    (r) => r.vinPhase === "pre_vin"
        && r.status !== "delivered"
        && r.daysToAvailability !== null
        && r.daysToAvailability <= 14,
  ).length;

  // On-time rate from the reports totals — null when no deliveries yet.
  const totalDelivered = report.totals.deliveredOnTime + report.totals.deliveredLate;
  const onTimeRate = totalDelivered > 0
    ? Math.round((report.totals.deliveredOnTime / totalDelivered) * 100)
    : null;

  // Audit 5 #3 — commitment honor rate (cancellations as misses). The
  // denominator widens to include cancelled batches so dealers can't
  // hide cancellation drag behind a clean on-time rate.
  const totalCommitments = report.totals.deliveredOnTime
                         + report.totals.deliveredLate
                         + report.totals.cancelled;
  const commitmentHonorRate = totalCommitments > 0
    ? Math.round((report.totals.deliveredOnTime / totalCommitments) * 100)
    : null;

  // Listing-speed KPI (Review #2 R1). Median + p90 PO → Listed,
  // weekly median trend, and the count of overdue (>14d unlisted)
  // post_po batches still in flight.
  const listingSpeed = await getListingSpeed(period);

  // Audit 5 #5 — re-promise split by pre/post customer-booking. Runs
  // in parallel with the weekly-trend query since both hit the same
  // revisions table.
  const [customerDaysLostWeekly, rePromiseSplit, comparison] = await Promise.all([
    getCustomerDaysLostWeekly(),
    getRePromiseSplit(period),
    getPeriodComparison(period),
  ]);

  // Audit 3 #10 — surface the existing per-week on-time rate from
  // the report. Reshape to a plain number-or-null array matching
  // customerDaysLostWeekly's cadence.
  const onTimeRateWeekly = report.onTimeRateWeekly.map((w) => w.rate);

  const hero: InsightsHero = {
    customerDaysLost: report.customerImpact.totals.customerDaysLost,
    customerDaysLostWeekly,
    activeBatches:    report.totals.open,
    preVinCritical,
    onTimeRate,
    commitmentHonorRate,
    onTimeRateWeekly,
    cancelled:        report.totals.cancelled,
    rePromisesIssued:      report.customerImpact.totals.totalRePromises,
    rePromisesPreBooking:  rePromiseSplit.pre,
    rePromisesPostBooking: rePromiseSplit.post,
    medianDaysToListed:       listingSpeed.medianDaysToListed,
    p90DaysToListed:          listingSpeed.p90DaysToListed,
    medianDaysToListedWeekly: listingSpeed.medianDaysToListedWeekly,
    unlistedOverThreshold:    listingSpeed.unlistedOverThreshold,
    comparison,
  };

  // Audit 3 #1 — upcoming-at-risk feed. Score every open batch whose
  // effective availability date is in (-∞, +30d], sort by confidence
  // ASC (worst first), cap to 10 rows. Anything older than 30 days
  // past-due is included too — those are usually the highest priority.
  const upcomingAtRisk: UpcomingAtRiskRow[] = batchRows
    .filter((r) =>
      r.daysToAvailability != null
      && r.daysToAvailability <= 30
      // Drop closed-out batches. StatusBucket only flags "delivered"
      // for closed rows; on_track / ahead / delayed are all in flight.
      && r.status !== "delivered",
    )
    .map((r) => {
      const c = computeDeliveryConfidence({
        daysToAvailability: r.daysToAvailability,
        vinPhase:           r.vinPhase,
        delayDays:          r.delayDays,
        legacyRisk:         r.risk,
      });
      return {
        batchCode:          r.batchCode,
        poNumber:           r.poNumber,
        dealerName:         r.dealerName,
        modelYear:          r.modelYear,
        quantity:           r.quantity,
        promisedDate:       r.promisedDate,
        daysToAvailability: r.daysToAvailability,
        vinPhase:           r.vinPhase,
        delayDays:          r.delayDays,
        confidenceScore:    c.score,
        confidenceLevel:    c.level,
        reasons:            c.reasons.slice(0, 3),
      };
    })
    .sort((a, b) => a.confidenceScore - b.confidenceScore)
    .slice(0, 10);

  // Audit 2 #1 — per-action-type breakdown for the Internal Phase.
  // Cheap aggregation (small dataset); runs after the other awaits
  // since it doesn't need their results.
  const internalPhaseStats = await getInternalPhaseStats(period);

  // Audit 2 #6 — stuck-stage snapshot (right now, not period-scoped).
  const stuckStages = await getStuckStages();

  return {
    generatedAt: report.generatedAt,
    hero,
    report,
    batchRows,
    closure,
    forecastReliability,
    upcomingAtRisk,
    internalPhaseStats,
    stuckStages,
  };
}

/**
 * Weekly customer-days-lost trend (Audit 3 #7), oldest first, 12
 * weeks. Each bucket = Σ(bookingsAtShift × delayDays) of shift events
 * whose `revisedAt` falls in that week.
 *
 * Tolerant of `batch_date_revisions` being missing on a fresh DB —
 * returns 12 zeros so the sparkline renders flat instead of crashing.
 */
async function getCustomerDaysLostWeekly(): Promise<number[]> {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
  const daysSinceMonday = (todayMidnight.getDay() + 6) % 7;
  const thisWeekStartMs = todayMidnight.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000;
  const bucketEdges = Array.from({ length: 12 }, (_, i) => thisWeekStartMs - (11 - i) * WEEK_MS);
  const buckets = Array.from({ length: 12 }, () => 0);

  let rows: { revisedAt: string | null; delayDays: number; bookingsAtShift: number }[];
  try {
    rows = await db
      .select({
        revisedAt:       batchDateRevisions.revisedAt,
        delayDays:       batchDateRevisions.delayDays,
        bookingsAtShift: batchDateRevisions.bookingsAtShift,
      })
      .from(batchDateRevisions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such (table|column)/i.test(msg)) return buckets;
    throw err;
  }

  for (const r of rows) {
    if (!r.revisedAt) continue;
    const ts = new Date(r.revisedAt).getTime();
    if (!Number.isFinite(ts)) continue;
    // Find bucket whose edge ≤ ts < edge + WEEK_MS.
    for (let i = 11; i >= 0; i--) {
      if (ts >= bucketEdges[i]) {
        const impact = (r.bookingsAtShift ?? 0) * (r.delayDays ?? 0);
        // Only positive shifts (delays) count toward "lost" days.
        if (impact > 0) buckets[i] += impact;
        break;
      }
    }
  }
  return buckets;
}

/**
 * Audit 2 #1 — per-action-type breakdown for the Internal Phase.
 *
 * Joins `actions` (scope='po') with `action_types` (catalog) and the
 * `pos` row to anchor each done row's days-from-submission. Aggregates
 * in JS — same shape as the existing department/stakeholder
 * aggregators in reports-data, but keyed by action_type instead of
 * owner so the question becomes "which stage" rather than "which
 * team".
 *
 * Tolerant of fresh DBs: returns an empty array if the actions table
 * or its dependencies are missing.
 */
async function getInternalPhaseStats(period: ReportPeriod): Promise<InternalPhaseActionStat[]> {
  const fromIso = fromIsoForPeriod(period);

  // Pull every PO-scope action joined with type catalog + parent PO's
  // requestedAt (proxy for "submission date" — actions don't carry
  // their own start time, so we measure cumulative days from PO
  // submission to action completion).
  interface Row {
    id:             number;
    actionTypeId:   number;
    actionTypeName: string;
    sortOrder:      number;
    status:         "waiting" | "blocked" | "done" | "skipped";
    completedAt:    string | null;
    expectedDate:   string | null;
    requestedAt:    string;
  }
  let rows: Row[];
  try {
    // The scope-aware actions row has scopeId pointing at pos.id for
    // scope='po'. Anchor days-from-submission to the PO's parent
    // batch's requestedAt — every PO has at least one batch, and they
    // all share the same submission moment so the first batch's value
    // is sufficient. We pre-aggregate the batch lookup in JS to keep
    // the SQL simple.
    const actionRows = await db
      .select({
        id:             actionsTable.id,
        actionTypeId:   actionsTable.actionTypeId,
        actionTypeName: actionTypes.name,
        sortOrder:      actionTypes.sortOrder,
        status:         actionsTable.status,
        completedAt:    actionsTable.completedAt,
        expectedDate:   actionsTable.expectedDate,
        scopeId:        actionsTable.scopeId,
      })
      .from(actionsTable)
      .innerJoin(actionTypes, eq(actionsTable.actionTypeId, actionTypes.id))
      .where(eq(actionsTable.scope, "po"));

    // Look up each PO's earliest batch requestedAt (the "submission"
    // date). Batches link to PO via the `po_number` text column, not
    // a foreign key, so we join through (pos.id → pos.poNumber →
    // batches.poNumber).
    const submissionByPo = new Map<number, string>();
    const poRows = await db
      .select({ id: pos.id, poNumber: pos.poNumber })
      .from(pos);
    const poByNumber = new Map<string, number>();
    for (const p of poRows) poByNumber.set(p.poNumber, p.id);

    const batchRows = await db
      .select({
        poNumber:    batches.poNumber,
        requestedAt: batches.requestedAt,
      })
      .from(batches);
    for (const b of batchRows) {
      if (!b.poNumber || !b.requestedAt) continue;
      const poId = poByNumber.get(b.poNumber);
      if (poId == null) continue;
      const cur = submissionByPo.get(poId);
      if (cur == null || b.requestedAt < cur) {
        submissionByPo.set(poId, b.requestedAt);
      }
    }
    rows = actionRows.flatMap((r): Row[] => {
      const submission = submissionByPo.get(r.scopeId);
      if (!submission) return [];
      return [{
        id:             r.id,
        actionTypeId:   r.actionTypeId,
        actionTypeName: r.actionTypeName,
        sortOrder:      r.sortOrder,
        status:         r.status,
        completedAt:    r.completedAt,
        expectedDate:   r.expectedDate,
        requestedAt:    submission,
      }];
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table|no such column/i.test(msg)) {
      // eslint-disable-next-line no-console
      console.warn("[insights-data] internal-phase stats skipped — actions table missing.");
      return [];
    }
    throw err;
  }

  // Bucket by actionTypeId.
  interface Bucket {
    actionTypeId:   number;
    actionTypeName: string;
    sortOrder:      number;
    doneCount:      number;
    openCount:      number;
    daysToComplete: number[];  // (completedAt - requestedAt), only done rows
    delaySamples:   number[];  // signed (completedAt - expectedDate), only done rows with expectedDate
    onTimeHits:     number;
    onTimeTotal:    number;
  }
  const buckets = new Map<number, Bucket>();

  // Actions whose lateness an admin excused → count on-time, no delay.
  const excusedIds = await getExcusedActionIds();

  for (const r of rows) {
    let b = buckets.get(r.actionTypeId);
    if (!b) {
      b = {
        actionTypeId: r.actionTypeId,
        actionTypeName: r.actionTypeName,
        sortOrder: r.sortOrder,
        doneCount: 0, openCount: 0,
        daysToComplete: [],
        delaySamples: [],
        onTimeHits: 0, onTimeTotal: 0,
      };
      buckets.set(r.actionTypeId, b);
    }
    if (r.status === "waiting" || r.status === "blocked") {
      b.openCount++;
      continue;
    }
    if (r.status !== "done" || !r.completedAt) continue;

    // Period filter for the done-rate samples: only count completions
    // that landed inside the window. Skipped rows are excluded from
    // both done + delay buckets entirely.
    const completedOn = r.completedAt.slice(0, 10);
    if (fromIso && completedOn < fromIso) continue;
    b.doneCount++;

    const days = Math.round(
      (new Date(completedOn).getTime() - new Date(r.requestedAt).getTime())
        / (24 * 60 * 60 * 1000),
    );
    if (days >= 0) b.daysToComplete.push(days);

    if (r.expectedDate) {
      const rawDelay = Math.round(
        (new Date(completedOn).getTime() - new Date(r.expectedDate).getTime())
          / (24 * 60 * 60 * 1000),
      );
      const excused = excusedIds.has(r.id);
      const delay = excused && rawDelay > 0 ? 0 : rawDelay;
      b.delaySamples.push(delay);
      b.onTimeTotal++;
      if (excused || delay <= 0) b.onTimeHits++;
    }
  }

  function median(arr: number[]): number | null {
    if (arr.length === 0) return null;
    const sorted = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      : sorted[mid];
  }

  return Array.from(buckets.values())
    .map((b): InternalPhaseActionStat => ({
      actionTypeId:   b.actionTypeId,
      actionTypeName: b.actionTypeName,
      sortOrder:      b.sortOrder,
      doneCount:      b.doneCount,
      openCount:      b.openCount,
      medianDaysFromSubmission: median(b.daysToComplete),
      avgDelayDays:   b.delaySamples.length === 0
        ? null
        : Math.round(b.delaySamples.reduce((s, v) => s + v, 0) / b.delaySamples.length),
      onTimeRate:     b.onTimeTotal === 0 ? null : Math.round((b.onTimeHits / b.onTimeTotal) * 100),
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Audit 2 #6 — "Stuck stages right now" snapshot.
 *
 * Aggregates every open (waiting / blocked) row in the `actions`
 * table by action_type. Per type: open count, blocked-subset count,
 * median + max age in days (today − createdAt).
 *
 * Snapshot, not period-scoped — "right now" is the point. Sorted by
 * open count DESC so the biggest pile-ups land first.
 */
async function getStuckStages(): Promise<StuckStageRow[]> {
  interface Row {
    actionTypeId:   number;
    actionTypeName: string;
    sortOrder:      number;
    scope:          "po" | "wave" | "batch";
    status:         "waiting" | "blocked" | "done" | "skipped";
    createdAt:      string | null;
  }
  let rows: Row[];
  try {
    rows = await db
      .select({
        actionTypeId:   actionsTable.actionTypeId,
        actionTypeName: actionTypes.name,
        sortOrder:      actionTypes.sortOrder,
        scope:          actionsTable.scope,
        status:         actionsTable.status,
        createdAt:      actionsTable.createdAt,
      })
      .from(actionsTable)
      .innerJoin(actionTypes, eq(actionsTable.actionTypeId, actionTypes.id));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such (table|column)/i.test(msg)) return [];
    throw err;
  }

  const today = Date.now();
  interface Bucket {
    actionTypeId:   number;
    actionTypeName: string;
    sortOrder:      number;
    scope:          "po" | "wave" | "batch";
    openCount:      number;
    blockedCount:   number;
    ages:           number[];
  }
  // Key by `${typeId}|${scope}` — same action type can exist at
  // multiple scopes (e.g. "App Listing" is PO-scope here, but a
  // future redesign might add a batch-scope copy). Keep them split.
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    if (r.status !== "waiting" && r.status !== "blocked") continue;
    const key = `${r.actionTypeId}|${r.scope}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        actionTypeId:   r.actionTypeId,
        actionTypeName: r.actionTypeName,
        sortOrder:      r.sortOrder,
        scope:          r.scope,
        openCount: 0, blockedCount: 0, ages: [],
      };
      buckets.set(key, b);
    }
    b.openCount++;
    if (r.status === "blocked") b.blockedCount++;
    if (r.createdAt) {
      const ts = new Date(r.createdAt).getTime();
      if (Number.isFinite(ts)) {
        const days = Math.round((today - ts) / (24 * 60 * 60 * 1000));
        if (days >= 0) b.ages.push(days);
      }
    }
  }

  function median(arr: number[]): number | null {
    if (arr.length === 0) return null;
    const sorted = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      : sorted[mid];
  }

  return Array.from(buckets.values())
    .map((b): StuckStageRow => ({
      actionTypeId:   b.actionTypeId,
      actionTypeName: b.actionTypeName,
      scope:          b.scope,
      sortOrder:      b.sortOrder,
      openCount:      b.openCount,
      blockedCount:   b.blockedCount,
      medianAgeDays:  median(b.ages),
      oldestAgeDays:  b.ages.length === 0 ? null : Math.max(...b.ages),
    }))
    .sort((a, b) => b.openCount - a.openCount || a.sortOrder - b.sortOrder);
}

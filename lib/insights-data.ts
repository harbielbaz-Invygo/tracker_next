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
  batchDateRevisions,
} from "@/lib/db/schema";
import { getDashboardRows, type DashboardRow } from "@/lib/dashboard-data";
import { getPerformanceReport, type PerformanceReport } from "@/lib/reports-data";
import { computeDeliveryConfidence, type ConfidenceLevel } from "@/lib/delivery-confidence";
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
   */
  onTimeRate: number | null;
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
   * Median days from PO submission → app listing across batches that
   * were listed in the period. Null until at least one batch in the
   * cohort has been listed. Primary "PO → Listed" KPI.
   */
  medianDaysToListed: number | null;
  /**
   * Count of post_po batches still unlisted whose submission is older
   * than 14 days. The actionable companion to medianDaysToListed —
   * "how many are over the line today?".
   */
  unlistedOverThreshold: number;
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
  avgDriftDays: number | null;
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
  const baseQuery = db
    .select({
      batchId:           batches.id,
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

  type Acc = {
    name: string;
    submitted: number;
    fulfilled: number;
    superseded: number;
    cancelled: number;
    open: number;
    drifts: number[];
  };
  const byUser = new Map<number, Acc>();
  for (const r of rows) {
    const a = byUser.get(r.userId) ?? {
      name: r.userName ?? `@${r.userUsername ?? "user"}`,
      submitted: 0, fulfilled: 0, superseded: 0, cancelled: 0, open: 0, drifts: [],
    };
    a.submitted++;
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
    } else {
      a.open++;
    }
    byUser.set(r.userId, a);
  }

  return Array.from(byUser.entries())
    .map(([userId, a]) => ({
      userId,
      name: a.name,
      submitted: a.submitted,
      fulfilled: a.fulfilled,
      superseded: a.superseded,
      cancelled: a.cancelled,
      open:      a.open,
      avgDriftDays: a.drifts.length === 0
        ? null
        : Math.round(a.drifts.reduce((s, v) => s + v, 0) / a.drifts.length),
    }))
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
  unlistedOverThreshold: number;
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
      return { medianDaysToListed: null, unlistedOverThreshold: 0 };
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

  const medianDaysToListed = daysSamples.length === 0
    ? null
    : (() => {
        const sorted = daysSamples.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0
          ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
          : sorted[mid];
      })();

  return { medianDaysToListed, unlistedOverThreshold: unlistedOver };
}

export async function getInsightsData(period: ReportPeriod = "all"): Promise<InsightsData> {
  // Both functions hit the DB; run them in parallel.
  // Same period filter is threaded into both — Insights is just the
  // union of Dashboard + Reports, so scoping them together keeps the
  // hero metrics and the underlying tables in agreement.
  const [report, batchRows, closure, forecastReliability] = await Promise.all([
    getPerformanceReport(period),
    getDashboardRows(period),
    getClosureSummary(period),
    getForecastReliability(period),
  ]);

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

  // Listing-speed KPI (Review #2 R1). Median days PO → Listed across
  // batches that have already been listed; companion count of open
  // post_po batches still unlisted past the 14-day threshold.
  const listingSpeed = await getListingSpeed(period);

  // Audit 3 #7 — weekly customer-days-lost trend, last 12 weeks
  // (oldest first). Bucket batch_date_revisions by revisedAt.
  const customerDaysLostWeekly = await getCustomerDaysLostWeekly();

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
    onTimeRateWeekly,
    cancelled:        report.totals.cancelled,
    rePromisesIssued: report.customerImpact.totals.totalRePromises,
    medianDaysToListed:    listingSpeed.medianDaysToListed,
    unlistedOverThreshold: listingSpeed.unlistedOverThreshold,
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

  return {
    generatedAt: report.generatedAt,
    hero,
    report,
    batchRows,
    closure,
    forecastReliability,
    upcomingAtRisk,
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

/**
 * Insights page data layer — pulls together the dashboard + reports
 * data into a single payload for the unified `/insights` view.
 *
 * Deliberately a thin wrapper: it just calls the two existing data
 * functions in parallel and computes a few derived hero metrics on
 * top. Anything more sophisticated belongs in the underlying source
 * modules so other views can benefit.
 */
import { gte, or, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { batches } from "@/lib/db/schema";
import { getDashboardRows, type DashboardRow } from "@/lib/dashboard-data";
import { getPerformanceReport, type PerformanceReport } from "@/lib/reports-data";
import type { ReportPeriod } from "@/lib/reports-period";

export interface InsightsHero {
  /** North Star — total customer-days lost across all affected batches. */
  customerDaysLost: number;
  /** Open batches in the system. */
  activeBatches: number;
  /** Pre-VIN batches with ≤ 14 days to availability — needs ops attention now. */
  preVinCritical: number;
  /**
   * % of delivered batches that landed on or before promised. Null when
   * nothing has been delivered yet (avoid showing 0% on a fresh setup).
   */
  onTimeRate: number | null;
  /** Cancelled batches count — surfaces dealer commitment breaches. */
  cancelled: number;
  /** Sum of revision counts across affected batches — trust erosion signal. */
  rePromisesIssued: number;
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

  delivered: number;
  carsDelivered: number;

  partlyDelivered: number;
  carsPartlyDelivered: number;
  carsPartlyRequested: number;

  cancelled: number;
  carsCancelled: number;
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
}

/** Period lower-bound ISO date. Duplicated from reports-data so we
 *  don't have to widen its export surface for one helper. */
function fromIsoForPeriod(period: ReportPeriod): string | null {
  if (period === "all") return null;
  const days = { "30d": 30, "90d": 90, "6m": 183 }[period];
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function getClosureSummary(period: ReportPeriod): Promise<ClosureSummary> {
  const fromIso = fromIsoForPeriod(period);
  const baseQuery = db
    .select({
      quantity:          batches.requestedQuantity,
      deliveredQuantity: batches.deliveredQuantity,
      closedAt:          batches.closedAt,
      closureReason:     batches.closureReason,
      appListedAt:       batches.appListedAt,
    })
    .from(batches);

  const rows = fromIso
    ? await baseQuery.where(or(gte(batches.closedAt, fromIso), isNull(batches.closedAt)))
    : await baseQuery;

  const totalBatches = rows.length;
  const totalQuantity = rows.reduce((acc, r) => acc + (r.quantity ?? 0), 0);

  const listed = rows.filter((r) => r.appListedAt != null).length;
  const carsListed = rows
    .filter((r) => r.appListedAt != null)
    .reduce((acc, r) => acc + (r.quantity ?? 0), 0);

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
    listed, carsListed,
    delivered, carsDelivered,
    partlyDelivered, carsPartlyDelivered, carsPartlyRequested,
    cancelled, carsCancelled,
  };
}

export async function getInsightsData(period: ReportPeriod = "all"): Promise<InsightsData> {
  // Both functions hit the DB; run them in parallel.
  // Same period filter is threaded into both — Insights is just the
  // union of Dashboard + Reports, so scoping them together keeps the
  // hero metrics and the underlying tables in agreement.
  const [report, batchRows, closure] = await Promise.all([
    getPerformanceReport(period),
    getDashboardRows(period),
    getClosureSummary(period),
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

  const hero: InsightsHero = {
    customerDaysLost: report.customerImpact.totals.customerDaysLost,
    activeBatches:    report.totals.open,
    preVinCritical,
    onTimeRate,
    cancelled:        report.totals.cancelled,
    rePromisesIssued: report.customerImpact.totals.totalRePromises,
  };

  return {
    generatedAt: report.generatedAt,
    hero,
    report,
    batchRows,
    closure,
  };
}

/**
 * Insights page data layer — pulls together the dashboard + reports
 * data into a single payload for the unified `/insights` view.
 *
 * Deliberately a thin wrapper: it just calls the two existing data
 * functions in parallel and computes a few derived hero metrics on
 * top. Anything more sophisticated belongs in the underlying source
 * modules so other views can benefit.
 */
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

export interface InsightsData {
  generatedAt: string;
  hero: InsightsHero;
  /** Full reports payload — feeds Customer Impact + Trust tabs. */
  report: PerformanceReport;
  /** Dashboard rows — feeds the Batch Explorer at the bottom. */
  batchRows: DashboardRow[];
}

export async function getInsightsData(period: ReportPeriod = "all"): Promise<InsightsData> {
  // Both functions hit the DB; run them in parallel.
  // Same period filter is threaded into both — Insights is just the
  // union of Dashboard + Reports, so scoping them together keeps the
  // hero metrics and the underlying tables in agreement.
  const [report, batchRows] = await Promise.all([
    getPerformanceReport(period),
    getDashboardRows(period),
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
  };
}

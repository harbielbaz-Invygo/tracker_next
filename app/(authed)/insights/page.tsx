/**
 * Insights — the unified Dashboard + Reports view (proposal).
 *
 * Server component fetches everything in one round-trip (the data
 * layer parallelises internally) and hands the payload to the
 * client shell. Filters + Trust-tab selection are pure client state
 * inside the shell — no extra round-trips per interaction.
 *
 * Accepts `?period=30d|90d|6m|all` which scopes the entire payload
 * (hero, customer impact, dealer reliability, batch rows) to the
 * chosen window. Default = all-time.
 *
 * Lives alongside the legacy /dashboard and /reports pages so the
 * operator can compare before retiring them.
 */
import InsightsShell from "@/components/insights-shell";
import { getInsightsData } from "@/lib/insights-data";
import { getSlaMetrics } from "@/lib/sla-metrics";
import type { ReportPeriod } from "@/lib/reports-period";

export const dynamic = "force-dynamic";

const VALID_PERIODS: ReportPeriod[] = ["30d", "90d", "6m", "all"];

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const sp = await searchParams;
  const raw = sp.period;
  const period: ReportPeriod = VALID_PERIODS.includes(raw as ReportPeriod)
    ? (raw as ReportPeriod)
    : "all";
  // SLA health is a NOW snapshot (not period-scoped), fetched alongside
  // the period-scoped insights payload.
  const [data, sla] = await Promise.all([
    getInsightsData(period),
    getSlaMetrics(),
  ]);
  return <InsightsShell data={data} period={period} sla={sla} />;
}

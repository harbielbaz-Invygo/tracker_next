/**
 * Reports — operational performance.
 *
 * Aggregates per-action delays from `batch_actions.expectedDate` vs
 * `completedAt` across every batch in the system. Two stacked tables:
 * Departments + Stakeholders. Surfaces who's slow, who's reliable, and
 * which batches each owner currently has time-loss in.
 *
 * Accepts a `?period=30d|90d|6m|all` query param that filters every
 * aggregate to batches/actions whose closure/completion falls within
 * the window. Default = all-time. Param is read server-side so it
 * affects the SQL queries, not just the rendered output.
 *
 * Access: Ops + Admin (gated by AccessGate; middleware redirects guests).
 */
import AccessGate from "@/components/access-gate";
import PageHeader from "@/components/page-header";
import ReportsShell from "@/components/reports-shell";
import { getPerformanceReport, type ReportPeriod } from "@/lib/reports-data";
import { withDbRetry } from "@/lib/db-retry";

export const dynamic = "force-dynamic";

const VALID_PERIODS: ReportPeriod[] = ["30d", "90d", "6m", "all"];

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const sp = await searchParams;
  const raw = sp.period;
  const period: ReportPeriod = VALID_PERIODS.includes(raw as ReportPeriod)
    ? (raw as ReportPeriod)
    : "all";
  const report = await withDbRetry(() => getPerformanceReport(period));

  return (
    <AccessGate view="Reports">
      <div>
        <PageHeader
          view="Reports"
          subtitle={<>Performance — aggregated across every batch in the system. Delay = the gap between an action&apos;s planned date (set at Intake or auto-shifted when VIN slips) and its actual completion. Negative = ahead of plan.</>}
        />
        <ReportsShell report={report} />
      </div>
    </AccessGate>
  );
}

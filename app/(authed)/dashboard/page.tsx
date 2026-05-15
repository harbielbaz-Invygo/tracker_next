/**
 * Dashboard — public read-only view.
 *
 * Server component:
 *   1. Pulls all batch rows from SQLite via getDashboardRows().
 *   2. Computes top-line totals (active / on-track / delayed / delivered).
 *   3. Hands both off to the client shell, which owns filter + selection state.
 *
 * Selecting a row fires /api/timeline?code=... to hydrate the
 * Plan-vs-Reality SVG drawer below the table.
 *
 * Mirrors `tracker_v1/dashboard.py:view_dashboard`.
 */
import DashboardShell from "@/components/dashboard-shell";
import PageHeader from "@/components/page-header";
import { getDashboardRows, summarize, getLateDeliveriesWeekly } from "@/lib/dashboard-data";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // Pull rows + the 12-week late-deliveries trend in parallel so the
  // sparkline data lands at the same time as the table.
  const [rows, lateWeekly] = await Promise.all([
    getDashboardRows(),
    getLateDeliveriesWeekly(),
  ]);
  const totals = summarize(rows);

  if (rows.length === 0) {
    return (
      <div>
        <PageHeader
          view="Dashboard"
          subtitle="Every batch in the onboarding journey will appear here once a Pre PO Upload is submitted."
        />
        <div className="card text-center py-10">
          <p className="text-base font-medium text-midnight mb-1">No batches yet</p>
          <p className="text-sm text-ink-500">
            Submit a Pre PO Upload from the sidebar to start tracking a batch.
          </p>
        </div>
      </div>
    );
  }

  return <DashboardShell rows={rows} totals={totals} lateWeekly={lateWeekly} />;
}

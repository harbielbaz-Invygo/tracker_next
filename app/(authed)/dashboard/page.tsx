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
import { getDashboardRows, summarize } from "@/lib/dashboard-data";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const rows = await getDashboardRows();
  const totals = summarize(rows);

  if (rows.length === 0) {
    return (
      <div>
        <h1 className="text-3xl font-bold mb-1">📊 Dashboard</h1>
        <p className="text-sm text-ink-500 mb-6 max-w-prose">
          Every batch in the onboarding journey will appear here once a Pre PO Upload is submitted.
        </p>
        <div className="card text-center py-10">
          <p className="text-base font-medium text-midnight mb-1">No batches yet</p>
          <p className="text-sm text-ink-500">
            Submit a Pre PO Upload from the sidebar to start tracking a batch.
          </p>
        </div>
      </div>
    );
  }

  return <DashboardShell rows={rows} totals={totals} />;
}

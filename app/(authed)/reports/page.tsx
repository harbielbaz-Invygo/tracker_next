/**
 * Reports — operational performance.
 *
 * Aggregates per-action delays from `batch_actions.expectedDate` vs
 * `completedAt` across every batch in the system. Two stacked tables:
 * Departments + Stakeholders. Surfaces who's slow, who's reliable, and
 * which batches each owner currently has time-loss in.
 *
 * Access: Ops + Admin (gated by AccessGate; middleware redirects guests).
 */
import AccessGate from "@/components/access-gate";
import ReportsShell from "@/components/reports-shell";
import { getPerformanceReport } from "@/lib/reports-data";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const report = await getPerformanceReport();

  return (
    <AccessGate view="Reports">
      <div>
        <h1 className="text-3xl font-bold mb-1">📊 Reports</h1>
        <p className="text-sm text-ink-500 mb-6 max-w-prose">
          Performance — aggregated across every batch in the system. Delay = the
          gap between an action&apos;s planned date (set at Intake or auto-shifted
          when VIN slips) and its actual completion. Negative = ahead of plan.
        </p>
        <ReportsShell report={report} />
      </div>
    </AccessGate>
  );
}

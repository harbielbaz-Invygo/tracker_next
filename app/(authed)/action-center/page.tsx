/**
 * Action Center — Operations' daily work surface.
 *
 * Server component:
 *   1. Pulls all batches + per-batch action counts via getActionCenterRows().
 *   2. Computes top-line totals.
 *   3. Hands rows to <ActionCenterShell> (client) which owns filter state,
 *      selection, and drawer fetching.
 *
 * Mutations on the drawer (mark done / skip / save Ops confidence) call
 * the server APIs and then router.refresh() — which re-runs this server
 * component so the table reflects the new state.
 *
 * Access: Ops + Admin (enforced by middleware).
 */
import AccessGate from "@/components/access-gate";
import ActionCenterShell from "@/components/action-center-shell";
import PageHeader from "@/components/page-header";
import { getActionCenterRows, summarizeActionCenter } from "@/lib/action-center-data";
import { runAlertEngine } from "@/lib/alert-engine";

export const dynamic = "force-dynamic";

export default async function ActionCenterPage() {
  // Run the alert engine first — creates/resolves alerts in DB so the table
  // rows below reflect the current alert state.
  const alertsByBatch = await runAlertEngine();
  const rows   = await getActionCenterRows(alertsByBatch);
  const totals = summarizeActionCenter(rows);

  if (rows.length === 0) {
    return (
      <AccessGate view="Action Center">
        <div>
          <PageHeader
            view="Action Center"
            subtitle="Every batch in flight, sortable by action required and by department."
          />
          <div className="card text-center py-10">
            <p className="text-base font-medium text-midnight mb-1">No batches yet</p>
            <p className="text-sm text-ink-500">
              Submit a batch from <span className="font-medium">Intake</span> to start tracking actions here.
            </p>
          </div>
        </div>
      </AccessGate>
    );
  }

  return (
    <AccessGate view="Action Center">
      <ActionCenterShell rows={rows} totals={totals} />
    </AccessGate>
  );
}

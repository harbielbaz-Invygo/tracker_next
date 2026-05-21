/**
 * Action Center · Flow — test sandbox for the touchpoint-log workflow.
 *
 * Combines Directions A (touchpoint log), B (derived flow state),
 * and C (quick-log buttons) from the design discussion. Same data
 * layer as /action-center; the UI swaps to the new chip flow.
 *
 * Promotes to the main Action Center once the design is validated.
 */
import AccessGate from "@/components/access-gate";
import PageHeader from "@/components/page-header";
import ActionFlowShell from "@/components/action-flow-shell";
import { getActionFlowData } from "@/lib/action-flow-data";

export const dynamic = "force-dynamic";

export default async function ActionCenterFlowPage() {
  const data = await getActionFlowData();
  return (
    <AccessGate view="Action Center Flow">
      <div>
        <PageHeader
          view="Action Center Flow"
          subtitle={
            <>
              Test page. Each External-Phase chip carries a touchpoint
              log — quick-log buttons capture email / phone / WhatsApp
              outreach, the derived flow state shows whether a chip is
              fresh / waiting / stalled / escalated, and the full
              history is one click away.
            </>
          }
        />
        <ActionFlowShell data={data} />
      </div>
    </AccessGate>
  );
}

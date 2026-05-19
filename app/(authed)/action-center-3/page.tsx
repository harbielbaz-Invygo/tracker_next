/**
 * Action Center 3 — redesigned External Phase view (test page).
 *
 * Parallel to /action-center. Uses the same data layer
 * (`getActionCenterTree`) and the same mutation endpoints, but
 * rebuilds the External-Phase surface following the UI/UX brief:
 *
 *   • Shift History moved into a collapsible drawer
 *   • Delivery Window header gains a visual progress bar
 *   • Batches render as elevated cards with hover lift
 *   • External-Phase chips become a horizontal progress stepper
 *   • Status pill replaces the locked "Mark as delivered" button
 *   • Bulk actions render as a floating bar when batches are selected
 *
 * Ops + Admin only, matching the main Action Center gate.
 */
import AccessGate from "@/components/access-gate";
import PageHeader from "@/components/page-header";
import ActionCenter3Shell from "@/components/action-center-3-shell";
import { getActionCenterTree } from "@/lib/action-center-tree-data";

export const dynamic = "force-dynamic";

export default async function ActionCenter3Page() {
  const tree = await getActionCenterTree();
  return (
    <AccessGate view="Action Center">
      <div>
        <PageHeader
          view="Action Center 3"
          subtitle={
            <>
              Test page for the redesigned External-Phase surface.
              Pick a PO from the dropdown to see the new card-based layout,
              progress stepper, and status pills.
            </>
          }
        />
        <ActionCenter3Shell tree={tree} />
      </div>
    </AccessGate>
  );
}

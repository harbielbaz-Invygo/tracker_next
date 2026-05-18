/**
 * Action Center v2 — phase 3 of the scope-aware restructure.
 *
 * Parallel surface alongside the existing /action-center. Reads the new
 * pos / waves / actions tables; renders Dealer → PO tree on the left
 * and a PO-detail drawer on the right with Internal Phase ↔ VIN Chase
 * toggle. Once validated against real data, phase 3b swaps routes
 * (delete the legacy v1, rename v2 → /action-center).
 *
 * Access: Ops + Admin (same as legacy Action Center).
 */
import AccessGate from "@/components/access-gate";
import PageHeader from "@/components/page-header";
import ActionCenterTreeShell from "@/components/action-center-tree-shell";
import { getActionCenterTree } from "@/lib/action-center-tree-data";

export const dynamic = "force-dynamic";

export default async function ActionCenterV2Page() {
  const tree = await getActionCenterTree();
  return (
    <AccessGate view="Action Center">
      <div>
        <PageHeader
          view="Action Center"
          subtitle={<>v2 — Dealer ▸ PO ▸ Wave hierarchy with scope-aware actions. Parallel to /action-center while we validate. Internal-phase actions apply to the whole PO; VIN-chase actions apply per delivery wave.</>}
        />
        <ActionCenterTreeShell tree={tree} />
      </div>
    </AccessGate>
  );
}

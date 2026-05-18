/**
 * Action Center — Operations' daily work surface.
 *
 * Scope-aware: renders Dealer → PO → Wave hierarchy with three action
 * scopes (PO-wide / per-wave VIN chase / per-batch closure). Internal
 * Phase ↔ VIN Chase toggle in the drawer.
 *
 * Replaces the per-batch legacy view as of phase 3d. The legacy
 * batch_actions / batch_vin_stages tables still receive writes from
 * Intake (Phase 2 double-write) so older readers (Dashboard, Reports,
 * Slack) keep working — Phase 5 will drop the legacy tables once every
 * reader is migrated.
 *
 * Access: Ops + Admin (enforced by middleware).
 */
import AccessGate from "@/components/access-gate";
import PageHeader from "@/components/page-header";
import ActionCenterTreeShell from "@/components/action-center-tree-shell";
import { getActionCenterTree } from "@/lib/action-center-tree-data";

export const dynamic = "force-dynamic";

export default async function ActionCenterPage() {
  const tree = await getActionCenterTree();
  return (
    <AccessGate view="Action Center">
      <div>
        <PageHeader
          view="Action Center"
          subtitle={<>Dealer ▸ PO ▸ Wave hierarchy. Internal-phase actions apply to the whole PO; VIN-chase actions apply per delivery wave.</>}
        />
        <ActionCenterTreeShell tree={tree} />
      </div>
    </AccessGate>
  );
}

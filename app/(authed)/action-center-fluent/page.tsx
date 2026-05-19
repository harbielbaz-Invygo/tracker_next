/**
 * Action Center · Fluent — Fluent UI v9 surface (test page).
 *
 * Parallel to /action-center. Reuses the same data layer
 * (`getActionCenterTree`) and mutation endpoints, but renders the
 * External-Phase view with Microsoft Fluent UI v9 primitives:
 * FluentProvider, Card, Button, Badge, ProgressBar, Toolbar,
 * Dropdown, etc.
 *
 * Wrapped in FluentProvider at the shell level so child Fluent
 * components pick up the web-light theme. No other pages render
 * under a Fluent provider, so the styling stays scoped.
 */
import AccessGate from "@/components/access-gate";
import PageHeader from "@/components/page-header";
import ActionCenterFluentShell from "@/components/action-center-fluent-shell";
import { getActionCenterTree } from "@/lib/action-center-tree-data";

export const dynamic = "force-dynamic";

export default async function ActionCenterFluentPage() {
  const tree = await getActionCenterTree();
  return (
    <AccessGate view="Action Center Fluent">
      <div>
        <PageHeader
          view="Action Center Fluent"
          subtitle={
            <>
              Microsoft Fluent UI v9 take on the Action Center.
              Pick a PO and explore — same data, same mutations as
              /action-center, rendered with Fluent components.
            </>
          }
        />
        <ActionCenterFluentShell tree={tree} />
      </div>
    </AccessGate>
  );
}

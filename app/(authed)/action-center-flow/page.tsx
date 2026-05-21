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
import { getActionFlowData, type ActionFlowData } from "@/lib/action-flow-data";

export const dynamic = "force-dynamic";

export default async function ActionCenterFlowPage() {
  // Wrapped so a data-layer crash surfaces an inline diagnostic
  // instead of bubbling up as an opaque "Server Components render"
  // 500 with no clue about the root cause. Test sandbox = transparent
  // error reporting; the live /action-center doesn't get this
  // treatment because its data layer is battle-tested.
  let data: ActionFlowData | null = null;
  let error: string | null = null;
  try {
    data = await getActionFlowData();
  } catch (e) {
    error = e instanceof Error
      ? `${e.name}: ${e.message}${e.stack ? `\n\n${e.stack.split("\n").slice(0, 8).join("\n")}` : ""}`
      : String(e);
  }

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
        {error ? (
          <pre className="card text-xs text-flame-dark whitespace-pre-wrap font-mono leading-tight">
            {error}
          </pre>
        ) : data ? (
          <ActionFlowShell data={data} />
        ) : (
          <p className="text-sm text-ink-500 italic">Loading…</p>
        )}
      </div>
    </AccessGate>
  );
}

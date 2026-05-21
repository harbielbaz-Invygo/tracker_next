/**
 * Data layer for the /action-center-flow test page.
 *
 * Pulls the same Action Center tree shape, then layers per-action
 * touchpoints + a derived flow state per chip. Designed to be
 * standalone — folds back into action-center-tree-data once the
 * UX is validated.
 */
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { actionTouchpoints } from "@/lib/db/schema";
import { getActionCenterTree, type ActionCenterTree, type ScopedActionDetail } from "@/lib/action-center-tree-data";

export type Channel   = "email" | "phone" | "whatsapp" | "meeting" | "other";
export type Direction = "outbound" | "inbound" | "internal";
export type Outcome   = "no_response" | "partial" | "confirmed" | "excuse" | "counter_proposal" | "other";

export interface Touchpoint {
  id:             number;
  actionId:       number;
  channel:        Channel;
  direction:      Direction;
  outcome:        Outcome;
  note:           string | null;
  contactedAt:    string;
  nextFollowupAt: string | null;
  loggedBy:       string | null;
  escalated:      boolean;
}

/**
 * Derived per-action flow state (Direction B). Computed from the
 * action's own status + the latest touchpoint. No new column —
 * pure projection from existing data.
 *
 *   fresh              — action waiting, no touchpoints yet
 *   contacted_waiting  — outbound touchpoint logged, follow-up future
 *   stalled            — outbound logged, follow-up overdue
 *   partial_response   — last inbound was a partial outcome
 *   confirmed_pending  — last inbound said "confirmed" but chip still
 *                        in waiting (ops just hasn't flipped it yet)
 *   escalated          — most recent touchpoint marked escalated=true
 *   blocked            — action.status === 'blocked'
 *   done / skipped     — action settled
 */
export type FlowState =
  | "fresh"
  | "contacted_waiting"
  | "stalled"
  | "partial_response"
  | "confirmed_pending"
  | "escalated"
  | "blocked"
  | "done"
  | "skipped";

export function deriveFlowState(
  status: ScopedActionDetail["status"],
  latest: Touchpoint | null,
  today: string,
): FlowState {
  if (status === "done")     return "done";
  if (status === "skipped")  return "skipped";
  if (status === "blocked")  return "blocked";
  if (!latest)               return "fresh";
  if (latest.escalated)      return "escalated";
  if (latest.outcome === "confirmed") return "confirmed_pending";
  if (latest.outcome === "partial")   return "partial_response";
  // outbound waiting — check follow-up timing
  if (latest.nextFollowupAt && latest.nextFollowupAt < today) return "stalled";
  return "contacted_waiting";
}

export interface FlowAction extends ScopedActionDetail {
  touchpoints:        Touchpoint[];
  latestTouchpoint:   Touchpoint | null;
  flowState:          FlowState;
  /** Days since the latest touchpoint (null when none). */
  daysSinceLastContact: number | null;
}

/**
 * Shape passed from the server component to the client shell.
 * MUST be plain-JSON-serialisable (no Map, no functions) — Next.js
 * Server Components can't ship those across the boundary. The
 * client imports `augmentActions` separately and applies it locally.
 */
export interface ActionFlowData {
  tree: ActionCenterTree;
  /** Per-action touchpoint list, keyed by action id (stringified). */
  touchpointsByAction: Record<string, Touchpoint[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
function daysBetween(later: string, earlier: string): number {
  return Math.round(
    (new Date(later).getTime() - new Date(earlier).getTime()) / DAY_MS,
  );
}

export async function getActionFlowData(): Promise<ActionFlowData> {
  const tree = await getActionCenterTree();

  // Collect every action id we'll need — batch-scope external phase
  // chips + wave-scope external phase chips + PO-scope internal phase.
  const allActionIds: number[] = [];
  for (const d of tree.dealers) {
    for (const p of d.pos) {
      for (const a of p.actions) allActionIds.push(a.id);
      for (const w of p.waves) {
        for (const a of w.actions) allActionIds.push(a.id);
        for (const b of w.batches) for (const a of b.actions) allActionIds.push(a.id);
      }
    }
  }

  let touchpoints: Touchpoint[] = [];
  if (allActionIds.length > 0) {
    try {
      const rows = await db
        .select()
        .from(actionTouchpoints)
        .where(inArray(actionTouchpoints.actionId, allActionIds))
        .orderBy(desc(actionTouchpoints.contactedAt), desc(actionTouchpoints.id));
      touchpoints = rows.map((r) => ({
        id:             r.id,
        actionId:       r.actionId,
        channel:        r.channel as Channel,
        direction:      r.direction as Direction,
        outcome:        r.outcome as Outcome,
        note:           r.note,
        contactedAt:    r.contactedAt ?? "",
        nextFollowupAt: r.nextFollowupAt,
        loggedBy:       r.loggedBy,
        escalated:      Boolean(r.escalated),
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/no such table/i.test(msg)) throw err;
      // Table missing — surface empty state; UI will prompt the admin
      // to run /api/admin/ensure-action-touchpoints-table.
    }
  }

  const touchpointsByAction: Record<string, Touchpoint[]> = {};
  for (const t of touchpoints) {
    const key = String(t.actionId);
    const arr = touchpointsByAction[key] ?? [];
    arr.push(t);
    touchpointsByAction[key] = arr;
  }

  return {
    tree,
    touchpointsByAction,
  };
}

/**
 * Pure augmenter — server-friendly and client-friendly. The shell
 * imports this and runs it locally, since a function in
 * ActionFlowData would break the server→client serialisation
 * boundary.
 */
export function augmentActions(
  actions: ScopedActionDetail[],
  touchpointsByAction: Record<string, Touchpoint[]>,
  today: string = new Date().toISOString().slice(0, 10),
): FlowAction[] {
  return actions.map((a) => {
    const tps = touchpointsByAction[String(a.id)] ?? [];
    const latest = tps[0] ?? null;
    const daysSinceLastContact = latest
      ? daysBetween(today, latest.contactedAt.slice(0, 10))
      : null;
    return {
      ...a,
      touchpoints: tps,
      latestTouchpoint: latest,
      flowState: deriveFlowState(a.status, latest, today),
      daysSinceLastContact,
    };
  });
}

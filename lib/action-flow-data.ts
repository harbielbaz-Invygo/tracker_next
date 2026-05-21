/**
 * Server-only data layer for the /action-center-flow test page.
 *
 * Pulls the same Action Center tree shape, then layers per-action
 * touchpoints in a plain JSON-serialisable shape. The pure types +
 * helpers live in `lib/action-flow-shared.ts` so the client shell
 * can import them without pulling Node-only `db` imports into the
 * client bundle.
 */
import { desc, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { actionTouchpoints } from "@/lib/db/schema";
import { getActionCenterTree, type ActionCenterTree } from "@/lib/action-center-tree-data";
import type { Channel, Direction, Outcome, Touchpoint } from "@/lib/action-flow-shared";

// Re-export the client-safe pieces so existing imports keep working.
export {
  augmentActions,
  deriveFlowState,
  type Channel,
  type Direction,
  type Outcome,
  type Touchpoint,
  type FlowState,
  type FlowAction,
} from "@/lib/action-flow-shared";

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

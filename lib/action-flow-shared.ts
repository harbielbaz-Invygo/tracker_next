/**
 * Client-safe shared types + pure helpers for /action-center-flow.
 *
 * Anything imported by the Client Component (action-flow-shell.tsx)
 * MUST live here — `lib/action-flow-data.ts` pulls in `db` which
 * imports Node.js built-ins (`node:fs`, `node:path`), and Webpack
 * rejects those in a client bundle.
 *
 * No DB imports here. Pure types + pure functions only.
 */
import type { ScopedActionDetail } from "@/lib/action-center-tree-data";

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
 * action's own status + the latest touchpoint.
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
  if (latest.nextFollowupAt && latest.nextFollowupAt < today) return "stalled";
  return "contacted_waiting";
}

export interface FlowAction extends ScopedActionDetail {
  touchpoints:          Touchpoint[];
  latestTouchpoint:     Touchpoint | null;
  flowState:            FlowState;
  /** Days since the latest touchpoint (null when none). */
  daysSinceLastContact: number | null;
  /** Total touchpoint count across every direction. Drives the
   *  📞 N badge — "how many times we contacted the dealer". */
  contactCount:         number;
  /** Touchpoints with escalated=true. Drives the ↗ N badge. */
  escalationCount:      number;
  /**
   * Days between the earliest touchpoint and the moment confirmation
   * landed. Confirmation = first inbound `outcome=confirmed` touchpoint
   * OR the chip being marked done, whichever happened first. Null when
   * the chip hasn't been confirmed yet or no touchpoints exist.
   * Surfaces "we burned 7 days chasing this".
   */
  daysToConfirm:        number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(later: string, earlier: string): number {
  return Math.round(
    (new Date(later).getTime() - new Date(earlier).getTime()) / DAY_MS,
  );
}

/**
 * Pure augmenter — usable from server OR client. Takes the action
 * list + the per-action touchpoint index (plain JSON) and returns a
 * shape with derived FlowState and days-since-last-contact.
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

    const contactCount    = tps.length;
    const escalationCount = tps.reduce((n, t) => n + (t.escalated ? 1 : 0), 0);

    // Earliest touchpoint by contactedAt — tps is already ordered desc
    // by contactedAt at the data layer, so the last entry is oldest.
    const earliest = tps.length > 0 ? tps[tps.length - 1] : null;

    // Confirmation moment: the inbound `outcome=confirmed` touchpoint
    // wins over a generic `status=done` mark, because it records the
    // moment the dealer actually confirmed. Fall back to completedAt
    // for chips that were flipped done without a touchpoint trail.
    const confirmingTp = tps.find((t) => t.outcome === "confirmed");
    const confirmingMoment = confirmingTp?.contactedAt ?? a.completedAt ?? null;
    const daysToConfirm = (earliest && confirmingMoment)
      ? Math.max(0, daysBetween(
          confirmingMoment.slice(0, 10),
          earliest.contactedAt.slice(0, 10),
        ))
      : null;

    return {
      ...a,
      touchpoints: tps,
      latestTouchpoint: latest,
      flowState: deriveFlowState(a.status, latest, today),
      daysSinceLastContact,
      contactCount,
      escalationCount,
      daysToConfirm,
    };
  });
}

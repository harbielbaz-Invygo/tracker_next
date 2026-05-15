/**
 * Pure, client-safe predicates over `ActionCenterRow`.
 *
 * Why a separate file?
 *   `lib/action-center-data.ts` runs server-only queries via `@/lib/db`,
 *   which transitively imports `node:fs` / `node:path`. If any client
 *   ("use client") component imports a RUNTIME value from that file,
 *   webpack pulls the whole transitive graph into the client bundle and
 *   fails with `UnhandledSchemeError: node:fs is not handled by plugins`.
 *
 *   Type-only imports (`import type { ActionCenterRow }`) are erased at
 *   build time, so they're safe — but the moment we want a SHARED pure
 *   function (like `isFullySettled`) reachable from both sides, it must
 *   live in a file that doesn't import the DB layer.
 *
 *   This file does exactly that: pure predicates + a type-only import
 *   of `ActionCenterRow`. Imported by both `action-center-data.ts`
 *   (server) and `action-center-shell.tsx` (client).
 */
import type { ActionCenterRow } from "./action-center-data";

/**
 * True when every internal-phase batch_action AND every VIN chase
 * stage on the batch is in a terminal state (done or skipped).
 *
 * Note: this is the OPERATIONAL completion state — every step done or
 * explicitly skipped. It is NOT the same as `batches.closedAt`. A batch
 * is only formally CLOSED when the canonical "Delivery" action_type is
 * marked done (auto-close) or ops cancels it. A "fully settled" batch
 * is one where all work is wrapped up and ops just needs to click the
 * Delivery action to officially close.
 */
export function isFullySettled(r: ActionCenterRow): boolean {
  if (r.totalActions === 0 && r.totalVinStages === 0) return false;
  const internalSettled = r.totalActions === 0
    || r.actionsDone + r.actionsSkipped === r.totalActions;
  const vinSettled = r.totalVinStages === 0
    || r.vinStagesDone + r.vinStagesSkipped === r.totalVinStages;
  return internalSettled && vinSettled;
}

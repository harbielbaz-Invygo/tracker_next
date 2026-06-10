/**
 * Re-anchor "vin"-anchored actions once the real VIN date is known.
 *
 * Background: at intake (and in the external-phase backfill) every action
 * whose action_type has `offsetAnchor === "vin"` is created with
 * `expectedDate = null`, because the VIN date isn't known yet
 * (computeExpectedDate returns null for a vin anchor with no vin). In the
 * LEGACY batch_actions flow these were re-anchored when the "VIN" action
 * completed (see autoShiftFromVin in /api/batch-action). The scope-aware
 * `actions` table had no equivalent — so its vin-anchored rows stayed
 * `expectedDate = null` forever, which makes them unmeasurable for on-time
 * (the Action Center / Insights performance panels silently drop any
 * action with no planned date). This module restores that re-anchoring
 * for the scope-aware path, both live (on VIN completion) and as a
 * one-off backfill of historical data.
 *
 * Server-only (touches the DB). Accepts a transaction handle so callers
 * can compose it into a larger atomic mutation.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { actions as actionsTable, actionTypes, batches } from "@/lib/db/schema";
import { computeExpectedDate, addDays, daysBetween } from "@/lib/expected-date";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is this action type "the VIN action" — the step whose completion reveals
 * the real VIN date that vin-anchored steps measure from? Matched by a
 * tolerant name test rather than `=== "VIN"` because production renamed it
 * (e.g. "VIN Receiving"). The vin-ANCHORED downstream steps are identified
 * separately by `offsetAnchor === "vin"` (a stable data field, rename-proof).
 */
export function isVinActionName(name: string | null | undefined): boolean {
  return !!name && /\bvin\b/i.test(name);
}

export interface ReanchorArgs {
  /** Batch ids whose batch-scope vin-anchored actions should re-anchor. */
  batchIds?: number[];
  /** Wave ids whose wave-scope vin-anchored actions should re-anchor. */
  waveIds?: number[];
  /** The real VIN date (yyyy-mm-dd) to anchor from. */
  actualVinDate: string;
  /**
   * Backfill mode: when true, rewrite already-`done` rows too (historical
   * correction). When false (live trigger) only pending rows are touched,
   * matching the legacy "don't rewrite history" rule.
   */
  includeDone?: boolean;
  /**
   * Also slide each batch's currentProjectedDeliveryDate by the VIN delay
   * (actualVinDate − vinReceivingDate), treating the dealer's downstream
   * lead time as fixed. Mirrors the legacy autoShiftFromVin behaviour.
   */
  slideProjection?: boolean;
}

/**
 * Re-anchor vin-anchored actions to `actualVinDate`. Returns the number of
 * action rows whose expectedDate was updated.
 */
export async function reanchorVinAnchoredActions(tx: Tx, args: ReanchorArgs): Promise<number> {
  const { actualVinDate, includeDone = false, slideProjection = false } = args;
  const batchIds = args.batchIds ?? [];
  const waveIds = args.waveIds ?? [];
  if (!ISO.test(actualVinDate)) return 0;
  if (batchIds.length === 0 && waveIds.length === 0) return 0;

  // vin-anchored action types + their offsets (one lookup).
  const vinTypes = await tx
    .select({ id: actionTypes.id, offsetDays: actionTypes.offsetDays })
    .from(actionTypes)
    .where(eq(actionTypes.offsetAnchor, "vin"));
  if (vinTypes.length === 0) return 0;
  const offsetById = new Map(vinTypes.map((t) => [t.id, t.offsetDays]));
  const vinTypeIds = vinTypes.map((t) => t.id);

  const nowIso = new Date().toISOString();
  let updated = 0;

  const reanchorScope = async (scope: "batch" | "wave", scopeIds: number[]) => {
    if (scopeIds.length === 0) return;
    const rows = await tx
      .select({
        id: actionsTable.id,
        actionTypeId: actionsTable.actionTypeId,
        status: actionsTable.status,
      })
      .from(actionsTable)
      .where(and(
        eq(actionsTable.scope, scope),
        inArray(actionsTable.scopeId, scopeIds),
        inArray(actionsTable.actionTypeId, vinTypeIds),
      ));
    for (const r of rows) {
      if (!includeDone && r.status === "done") continue; // don't rewrite history (live)
      const offsetDays = offsetById.get(r.actionTypeId) ?? 0;
      const expected = computeExpectedDate({
        anchor: "vin",
        offsetDays,
        submission: "",          // unused for vin anchor
        vin: actualVinDate,
        promised: "",            // unused for vin anchor
      });
      if (!expected) continue;
      await tx.update(actionsTable)
        .set({ expectedDate: expected, updatedAt: nowIso })
        .where(eq(actionsTable.id, r.id));
      updated++;
    }
  };

  await reanchorScope("batch", batchIds);
  await reanchorScope("wave", waveIds);

  // Slide projected delivery per batch by the VIN delay (optional).
  if (slideProjection && batchIds.length > 0) {
    const batchRows = await tx
      .select({
        id: batches.id,
        vinReceivingDate: batches.vinReceivingDate,
        promised: batches.dealerPromisedDeliveryDate,
      })
      .from(batches)
      .where(inArray(batches.id, batchIds));
    for (const b of batchRows) {
      if (!b.vinReceivingDate || !b.promised) continue; // no plan → nothing to slide
      const delay = daysBetween(actualVinDate, b.vinReceivingDate);
      if (delay === 0) continue;
      await tx.update(batches)
        .set({ currentProjectedDeliveryDate: addDays(b.promised, delay), updatedAt: nowIso })
        .where(eq(batches.id, b.id));
    }
  }

  return updated;
}

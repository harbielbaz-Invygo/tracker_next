/**
 * PATCH /api/scope-action — update a row in the new scope-aware
 * `actions` table. Used by the Action Center v2 drawer to flip a
 * PO / Wave / Batch action's status.
 *
 * Body:
 *   {
 *     actionId:    number,
 *     status:      "waiting" | "blocked" | "done" | "skipped",
 *     completedAt?: string   // ISO datetime; optional override (e.g. backdated done)
 *   }
 *
 * Side effects:
 *   - status='done'  → completed_at stamped (now() unless overridden)
 *   - status≠'done'  → completed_at cleared (re-opening)
 *   - If the action is a batch-scope Delivery action being marked
 *     done, also stamp batches.closed_at + closure_reason='delivered'
 *     so the closure UI / metrics stay in sync.
 *   - Phase 3c: dependency cascade. When a parent action flips to
 *     done/skipped, every blocked child on the same (scope, scope_id)
 *     whose parents are all satisfied auto-promotes to `waiting`.
 *     When a parent leaves the done state, transitive descendants
 *     drop back to `blocked` (skipped ones left alone).
 */
import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  actions as actionsTable,
  actionTypes,
  batches,
} from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";
import { unblockDependents, cascadeRevertDependents } from "@/lib/scope-cascade";

export const runtime = "nodejs";

type Status = "waiting" | "blocked" | "done" | "skipped";
const ALLOWED: Status[] = ["waiting", "blocked", "done", "skipped"];

export async function PATCH(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => null)) as
    | { actionId?: unknown; status?: unknown; completedAt?: unknown }
    | null;
  const actionId = Number(body?.actionId);
  const status = body?.status as Status | undefined;
  const completedAtRaw = typeof body?.completedAt === "string" ? body.completedAt : null;

  if (!Number.isInteger(actionId) || actionId <= 0)
    return apiError("actionId required", 400);
  if (!status || !ALLOWED.includes(status))
    return apiError(`status must be one of ${ALLOWED.join(", ")}`, 400);

  // Pull the current row + its action_type's name to detect Delivery.
  // `status` is read so the cascade can detect the leaving-done case.
  const [current] = await db
    .select({
      id:             actionsTable.id,
      scope:          actionsTable.scope,
      scopeId:        actionsTable.scopeId,
      actionTypeId:   actionsTable.actionTypeId,
      actionTypeName: actionTypes.name,
      status:         actionsTable.status,
    })
    .from(actionsTable)
    .innerJoin(actionTypes, eq(actionsTable.actionTypeId, actionTypes.id))
    .where(eq(actionsTable.id, actionId))
    .limit(1);

  if (!current) return apiError("Action not found", 404);

  const nowIso = new Date().toISOString();
  const completedAt = status === "done"
    ? (completedAtRaw ?? nowIso)
    : null;

  const cascadeResult = await db.transaction(async (tx) => {
    await tx.update(actionsTable).set({
      status,
      completedAt,
      updatedAt: nowIso,
    }).where(eq(actionsTable.id, actionId));

    // Auto-close: Delivery action on a batch → close the batch.
    // Re-open Delivery → re-open the batch.
    if (current.scope === "batch" && current.actionTypeName === "Delivery") {
      if (status === "done") {
        const closedDate = (completedAt ?? nowIso).slice(0, 10);
        await tx.update(batches).set({
          closedAt:      closedDate,
          closureReason: "delivered",
          updatedAt:     nowIso,
        }).where(eq(batches.id, current.scopeId));
      } else {
        // Any non-done status on Delivery un-closes the batch (only
        // if it was closed as 'delivered' — don't touch 'cancelled').
        await tx.update(batches).set({
          closedAt:      null,
          closureReason: null,
          updatedAt:     nowIso,
        }).where(eq(batches.id, current.scopeId));
      }
    }

    // Phase 3c: dependency cascade. Both branches share the same tx
    // as the status flip so concurrent clicks can never observe a
    // half-promoted dependent.
    const becameDone     = status === "done";
    const becameSkipped  = status === "skipped";
    const leftDoneState  = current.status === "done" && status !== "done";

    let autoUnblockedIds: number[]   = [];
    let cascadeRevertedIds: number[] = [];

    if (becameDone || becameSkipped) {
      autoUnblockedIds = await unblockDependents(
        tx, current.scope, current.scopeId, current.actionTypeId, nowIso,
      );
    }
    if (leftDoneState) {
      cascadeRevertedIds = await cascadeRevertDependents(
        tx, current.scope, current.scopeId, current.actionTypeId, nowIso,
      );
    }

    // Cross-scope wave → batch propagation: when a wave-scope action
    // flips to done or skipped, also flip every batch-scope copy of
    // the same action_type for batches under this wave. Symmetric on
    // re-open (any non-done status). The intake flow attaches one
    // batch-scope row per wave-scope action_type per batch, so this
    // cascade keeps the two layers consistent.
    let waveToBatchPropagatedIds: number[] = [];
    if (current.scope === "wave") {
      const childBatches = await tx
        .select({ id: batches.id })
        .from(batches)
        .where(eq(batches.waveId, current.scopeId));
      const childBatchIds = childBatches.map((b) => b.id);
      if (childBatchIds.length > 0) {
        const batchCopies = await tx
          .select({ id: actionsTable.id, status: actionsTable.status })
          .from(actionsTable)
          .where(and(
            eq(actionsTable.scope, "batch"),
            eq(actionsTable.actionTypeId, current.actionTypeId),
            inArray(actionsTable.scopeId, childBatchIds),
          ));
        // Skip rows already in the target state — keeps the cascade
        // idempotent (no spurious updatedAt churn).
        const idsToFlip = batchCopies
          .filter((r) => r.status !== status)
          .map((r) => r.id);
        if (idsToFlip.length > 0) {
          await tx.update(actionsTable).set({
            status,
            completedAt,
            updatedAt: nowIso,
          }).where(inArray(actionsTable.id, idsToFlip));
          waveToBatchPropagatedIds = idsToFlip;
        }
      }
    }

    return { autoUnblockedIds, cascadeRevertedIds, waveToBatchPropagatedIds };
  });

  return NextResponse.json({
    ok: true,
    actionId,
    status,
    completedAt,
    autoUnblockedIds:        cascadeResult.autoUnblockedIds,
    cascadeRevertedIds:      cascadeResult.cascadeRevertedIds,
    waveToBatchPropagatedIds: cascadeResult.waveToBatchPropagatedIds,
  });
}

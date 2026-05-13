/**
 * POST /api/batch-action — update a single batch_action's status.
 *
 * Body: {
 *   batchActionId: number,
 *   newStatus?:       "waiting"|"done"|"blocked"|"skipped",
 *   newExpectedDate?: string|null,   // yyyy-mm-dd, plan date
 *   newCompletedAt?:  string|null,   // ISO datetime, only honoured when newStatus="done"
 * }
 *
 * Behaviour:
 *   - status = done   → completed_at = newCompletedAt ?? now
 *   - status ≠ done   → completed_at = null
 *   - When flipping to `done`, runs an auto-unblock cascade: every
 *     dependent action (in this batch) whose parents are all `done`
 *     transitions from `blocked` → `waiting`.
 *   - When leaving `done` (revert to anything not-done), runs a
 *     cascade-revert: every transitive dependent on this batch that
 *     isn't already `skipped` becomes `blocked` with a null completedAt.
 *     The next time a parent is marked done, the unblock cascade picks
 *     them back up.
 *
 * Auth: relies on middleware. The Action Center is gated for ops/admin only at the
 * route level; this API is reachable by any authed user. (Phase: tighten
 * by checking req.auth.role here once roles propagate to NextRequest.)
 */
import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { batchActions, actionDependencies, actionTypes, batches } from "@/lib/db/schema";
import { requireAuth } from "@/lib/api-auth";
import { computeExpectedDate, addDays, daysBetween } from "@/lib/expected-date";

export const runtime = "nodejs";

const VALID = new Set(["waiting", "done", "blocked", "skipped"] as const);
type Status = "waiting" | "done" | "blocked" | "skipped";

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;

  /**
   * Body supports three flavours of mutation (each combinable with the others):
   *   - Status flip (cascades, auto-close, auto-shift): { batchActionId, newStatus }
   *   - Plan date patch:                                { batchActionId, newExpectedDate }
   *   - Manual completion timestamp:                    { batchActionId, newStatus:"done", newCompletedAt }
   */
  let body: {
    batchActionId?: number;
    newStatus?: Status;
    newExpectedDate?: string | null;
    newCompletedAt?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const id = Number(body.batchActionId);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "batchActionId required" }, { status: 400 });
  }

  const hasStatus = body.newStatus != null;
  const hasExpected = body.newExpectedDate !== undefined;
  const hasCompletedAt = body.newCompletedAt !== undefined;
  if (!hasStatus && !hasExpected) {
    return NextResponse.json(
      { error: "Provide newStatus and/or newExpectedDate" },
      { status: 400 },
    );
  }
  if (hasStatus && !VALID.has(body.newStatus!)) {
    return NextResponse.json(
      { error: "newStatus must be one of: waiting, done, blocked, skipped" },
      { status: 400 },
    );
  }
  if (hasExpected && body.newExpectedDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body.newExpectedDate ?? "")) {
    return NextResponse.json(
      { error: "newExpectedDate must be yyyy-mm-dd or null" },
      { status: 400 },
    );
  }
  // newCompletedAt: must parse as a valid Date and the request must also
  // be marking the action done (otherwise the field is ignored — there's
  // no meaningful completedAt for a non-done status).
  let manualCompletedAt: string | null = null;
  if (hasCompletedAt) {
    if (body.newCompletedAt === null) {
      manualCompletedAt = null;
    } else {
      const t = Date.parse(body.newCompletedAt ?? "");
      if (!Number.isFinite(t)) {
        return NextResponse.json(
          { error: "newCompletedAt must be an ISO datetime or null" },
          { status: 400 },
        );
      }
      manualCompletedAt = new Date(t).toISOString();
    }
    if (body.newStatus !== "done") {
      return NextResponse.json(
        { error: "newCompletedAt only applies when newStatus is 'done'" },
        { status: 400 },
      );
    }
  }

  const nowIso = new Date().toISOString();
  /** The timestamp written to `batch_actions.completed_at` when status = done. */
  const completedAtIso = manualCompletedAt ?? nowIso;

  // Fast path — only expected-date edit, no status change → simple update.
  // Saves a transaction round-trip when Ops is just adjusting plan dates.
  if (!hasStatus && hasExpected) {
    await db.update(batchActions).set({
      expectedDate: body.newExpectedDate,
      updatedAt:    nowIso,
    }).where(eq(batchActions.id, id));
    return NextResponse.json({
      ok: true,
      batchActionId: id,
      expectedDate: body.newExpectedDate,
    });
  }

  const newStatus = body.newStatus!;

  // Status flip + cascade run in a single transaction so two concurrent
  // "Mark done" clicks can never observe a half-promoted dependent.
  // libSQL transaction body is async — every query is `await`-ed.
  const result = await db.transaction(async (tx) => {
    const currentRows = await tx.select()
      .from(batchActions)
      .where(eq(batchActions.id, id))
      .limit(1);
    const current = currentRows[0];
    if (!current) return { notFound: true as const };

    await tx.update(batchActions)
      .set({
        status:      newStatus,
        completedAt: newStatus === "done" ? completedAtIso : null,
        // If the request also includes a new expected date, fold it into
        // the same UPDATE — keeps the operator's two intents atomic.
        ...(hasExpected ? { expectedDate: body.newExpectedDate } : {}),
        updatedAt:   nowIso,
      })
      .where(eq(batchActions.id, id));

    const autoUnblockedIds: number[] = [];
    const cascadeRevertedIds: number[] = [];
    let autoClosed = false;
    const becameDone   = newStatus === "done";
    const leftDoneState = current.status === "done" && newStatus !== "done";

    if (leftDoneState) {
      // Cascade-revert: dependents that were already done (or waiting)
      // no longer have a satisfied precondition, so push them back to
      // blocked. Skipped descendants are left alone — the team has
      // explicitly opted out of those.
      cascadeRevertedIds.push(
        ...await cascadeRevertDependents(tx, current.batchId, current.actionTypeId, nowIso),
      );
    }

    if (becameDone) {
      autoUnblockedIds.push(...await unblockDependents(tx, current.batchId, current.actionTypeId, nowIso));

      // Look up the action type once — used by both auto-close and
      // auto-shift logic below.
      const [type] = await tx.select({
          id: actionTypes.id,
          name: actionTypes.name,
        })
        .from(actionTypes)
        .where(eq(actionTypes.id, current.actionTypeId))
        .limit(1);

      // Auto-close: if the action just marked done is the canonical
      // "Delivery" action, the batch is now Delivered. Stamp closedAt +
      // closureReason inside the same transaction so the timeline picks
      // up the change atomically. closedAt uses the date portion of the
      // (possibly manual) completedAt timestamp so backdated delivery
      // updates land on the correct day.
      if (type?.name === "Delivery") {
        const closedDate = completedAtIso.slice(0, 10);
        await tx.update(batches)
          .set({
            closedAt:      closedDate,
            closureReason: "delivered",
            updatedAt:     nowIso,
          })
          .where(eq(batches.id, current.batchId));
        autoClosed = true;
      }

      // Auto-shift: when the VIN action completes, every post-VIN action's
      // expected date should re-anchor on the actual VIN date. The dealer's
      // downstream lead time is treated as fixed — if VIN is N days late,
      // every "from_vin" action's expectedDate slides forward by N days,
      // and the batch's currentProjectedDeliveryDate slips by the same N.
      if (type?.name === "VIN") {
        await autoShiftFromVin(tx, current.batchId, completedAtIso.slice(0, 10));
      }
    }
    return { notFound: false as const, autoUnblockedIds, cascadeRevertedIds, autoClosed };
  });

  if (result.notFound) {
    return NextResponse.json({ error: `No batch_action with id ${id}` }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    batchActionId: id,
    newStatus,
    completedAt: newStatus === "done" ? completedAtIso : null,
    autoUnblockedIds:    result.autoUnblockedIds,
    cascadeRevertedIds:  result.cascadeRevertedIds,
    autoClosed:          result.autoClosed,
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Cascade-revert: a parent action just left the `done` state, so every
 * transitive descendant on this batch whose precondition is no longer
 * satisfied needs to drop back to `blocked` (with completedAt cleared).
 *
 * `skipped` descendants are intentionally left alone — the team has
 * explicitly opted those actions out, so a parent revert shouldn't
 * un-skip them.
 *
 * Returns the ids of every batch_action this cascade touched.
 */
async function cascadeRevertDependents(
  tx: Tx,
  batchId: number,
  parentActionTypeId: number,
  nowIso: string,
): Promise<number[]> {
  // BFS through the dependency DAG: collect every action_type that
  // transitively depends on the reverted parent.
  const descendants = new Set<number>();
  const queue: number[] = [parentActionTypeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const childDeps = await tx.select()
      .from(actionDependencies)
      .where(eq(actionDependencies.dependsOnActionTypeId, current));
    for (const d of childDeps) {
      if (!descendants.has(d.actionTypeId)) {
        descendants.add(d.actionTypeId);
        queue.push(d.actionTypeId);
      }
    }
  }
  if (descendants.size === 0) return [];

  // Pull matching batch_action rows for this batch.
  const rows = await tx.select()
    .from(batchActions)
    .where(and(
      eq(batchActions.batchId, batchId),
      inArray(batchActions.actionTypeId, Array.from(descendants)),
    ));

  // Revert anything that isn't already skipped (skipped = team opted out).
  const toRevert = rows.filter((r) => r.status !== "skipped");
  if (toRevert.length === 0) return [];

  await tx.update(batchActions)
    .set({ status: "blocked", completedAt: null, updatedAt: nowIso })
    .where(inArray(batchActions.id, toRevert.map((r) => r.id)));

  return toRevert.map((r) => r.id);
}

/**
 * For every action_type that depends on `parentActionTypeId`, check whether
 * ALL its parents (within this batch) are now `done`. If so, promote any
 * matching `blocked` batch_action on this batch to `waiting`.
 *
 * Three queries total (read deps, read involved batch_actions, bulk update),
 * regardless of how many dependents fan out from the parent.
 *
 * Async — runs inside a libSQL transaction.
 */
async function unblockDependents(
  tx: Tx,
  batchId: number,
  parentActionTypeId: number,
  nowIso: string,
): Promise<number[]> {
  // 1. Find children (action_types that depend on this one).
  const childDeps = await tx.select()
    .from(actionDependencies)
    .where(eq(actionDependencies.dependsOnActionTypeId, parentActionTypeId));
  if (childDeps.length === 0) return [];

  const childActionTypeIds = childDeps.map((d) => d.actionTypeId);

  // 2. Pull every parent dependency for each child (single query).
  const allParentDeps = await tx.select()
    .from(actionDependencies)
    .where(inArray(actionDependencies.actionTypeId, childActionTypeIds));

  const parentsByChild = new Map<number, number[]>();
  for (const d of allParentDeps) {
    const arr = parentsByChild.get(d.actionTypeId) ?? [];
    arr.push(d.dependsOnActionTypeId);
    parentsByChild.set(d.actionTypeId, arr);
  }

  // 3. Pull every involved batch_action on this batch (single query).
  const involvedActionTypeIds = Array.from(new Set([
    ...childActionTypeIds,
    ...allParentDeps.map((d) => d.dependsOnActionTypeId),
  ]));
  const batchRows = await tx.select()
    .from(batchActions)
    .where(and(
      eq(batchActions.batchId, batchId),
      inArray(batchActions.actionTypeId, involvedActionTypeIds),
    ));
  const rowByActionType = new Map<number, typeof batchRows[number]>();
  for (const r of batchRows) rowByActionType.set(r.actionTypeId, r);

  // 4. Compute eligible promotions in memory.
  const promoteIds: number[] = [];
  for (const childActionTypeId of childActionTypeIds) {
    const childRow = rowByActionType.get(childActionTypeId);
    if (!childRow || childRow.status !== "blocked") continue;
    const parentIds = parentsByChild.get(childActionTypeId) ?? [];
    if (parentIds.every((pid) => rowByActionType.get(pid)?.status === "done")) {
      promoteIds.push(childRow.id);
    }
  }
  if (promoteIds.length === 0) return [];

  // 5. Single bulk UPDATE — replaces N sequential updates.
  await tx.update(batchActions)
    .set({ status: "waiting", updatedAt: nowIso })
    .where(inArray(batchActions.id, promoteIds));

  return promoteIds;
}

/**
 * VIN just landed — recompute downstream expected dates and the batch's
 * projected availability.
 *
 * Logic:
 *   1. Pull the batch row to learn the planned VIN date and the promised
 *      availability date.
 *   2. Compute `vinDelayDays = actualVinDate − plannedVinDate` (signed).
 *   3. For every batch_action on this batch whose action_type's
 *      offsetAnchor === "vin", recompute expectedDate using the actual
 *      VIN date as the new anchor. Only update actions that aren't
 *      already done.
 *   4. Update batches.currentProjectedDeliveryDate = promisedDate + vinDelayDays.
 *      (If VIN was on time → no change. If VIN slipped 3 days → projected
 *      slips 3 days too. If VIN came 2 days early → projected pulls in
 *      2 days. Treats the dealer's lead time as fixed.)
 */
async function autoShiftFromVin(tx: Tx, batchId: number, actualVinDate: string): Promise<void> {
  const [batchRow] = await tx.select({
    vinReceivingDate: batches.vinReceivingDate,
    promised: batches.dealerPromisedDeliveryDate,
  })
    .from(batches)
    .where(eq(batches.id, batchId))
    .limit(1);
  if (!batchRow) return;

  const plannedVin = batchRow.vinReceivingDate;
  if (!plannedVin) return;   // no plan → no shift to compute

  const vinDelayDays = daysBetween(actualVinDate, plannedVin);

  // 1) Re-anchor every "from_vin" action that's still pending.
  const fromVinRows = await tx.select({
      ba: batchActions,
      offsetDays: actionTypes.offsetDays,
    })
    .from(batchActions)
    .innerJoin(actionTypes, eq(batchActions.actionTypeId, actionTypes.id))
    .where(and(
      eq(batchActions.batchId, batchId),
      eq(actionTypes.offsetAnchor, "vin"),
    ));

  for (const r of fromVinRows) {
    if (r.ba.status === "done") continue;  // don't rewrite history
    const newExpected = computeExpectedDate({
      anchor:     "vin",
      offsetDays: r.offsetDays,
      submission: "",        // unused for vin anchor
      vin:        actualVinDate,
      promised:   batchRow.promised,
    });
    await tx.update(batchActions)
      .set({ expectedDate: newExpected ?? undefined, updatedAt: new Date().toISOString() })
      .where(eq(batchActions.id, r.ba.id));
  }

  // 2) Slide currentProjectedDeliveryDate by the VIN delay.
  if (vinDelayDays !== 0) {
    const newProjected = addDays(batchRow.promised, vinDelayDays);
    await tx.update(batches)
      .set({ currentProjectedDeliveryDate: newProjected, updatedAt: new Date().toISOString() })
      .where(eq(batches.id, batchId));
  }
}

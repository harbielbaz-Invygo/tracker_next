/**
 * Dependency cascade for scope-aware actions.
 *
 * Mirrors the cascade in /api/batch-action (legacy) but operates on
 * the new `actions` table keyed by (scope, scope_id, action_type_id).
 *
 * What it does
 * ============
 * - **unblockDependents** (called when a parent flips to done/skipped):
 *     For every action_type that depends on the just-settled parent,
 *     find candidate child rows on the same (scope, scope_id), and
 *     promote `blocked` → `waiting` when every parent dep is satisfied.
 *     A parent dep is satisfied when its action row is `done`/`skipped`
 *     OR absent on this scope (dormant dep — child not actually
 *     waiting on a sibling that was never picked).
 *
 * - **cascadeRevertDependents** (called when a parent leaves done):
 *     BFS through the dep DAG, flip every transitive descendant on the
 *     same scope back to `blocked` (skipped descendants are left alone).
 *
 * Scope policy (current cut)
 * ==========================
 * Cascade only fires **within the same (scope, scope_id)**. In practice
 * internal-phase deps are PO↔PO and VIN-chase deps are wave↔wave on the
 * same wave, so same-scope covers the realistic configurations. If a
 * cross-scope dep ever becomes a real need (e.g. a wave-scope action
 * depending on a PO-scope action), revisit here — the action_dependencies
 * table itself is already scope-agnostic.
 *
 * All helpers run inside a libSQL transaction passed by the caller; the
 * caller is responsible for wrapping the original status flip + cascade
 * in one tx so a concurrent "Mark done" can't observe a half-promoted
 * dependent.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  actions as actionsTable,
  actionDependencies,
} from "@/lib/db/schema";

type Scope = "po" | "wave" | "batch";

// Drizzle's tx type isn't directly exported — pull it from the transaction
// callback signature so this stays in sync if Drizzle changes shape.
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run after a parent action flipped to `done` or `skipped`.
 *
 * Returns the ids of every action this cascade promoted (for the API
 * response, useful when debugging "why did three rows suddenly open?").
 */
export async function unblockDependents(
  tx: Tx,
  scope: Scope,
  scopeId: number,
  parentActionTypeId: number,
  nowIso: string,
): Promise<number[]> {
  // 1. Find children (action_types that depend on this parent).
  const childDeps = await tx.select()
    .from(actionDependencies)
    .where(eq(actionDependencies.dependsOnActionTypeId, parentActionTypeId));
  if (childDeps.length === 0) return [];

  const childActionTypeIds = childDeps.map((d) => d.actionTypeId);

  // 2. Pull every parent dependency for every candidate child in one query.
  const allParentDeps = await tx.select()
    .from(actionDependencies)
    .where(inArray(actionDependencies.actionTypeId, childActionTypeIds));

  const parentsByChild = new Map<number, number[]>();
  for (const d of allParentDeps) {
    const arr = parentsByChild.get(d.actionTypeId) ?? [];
    arr.push(d.dependsOnActionTypeId);
    parentsByChild.set(d.actionTypeId, arr);
  }

  // 3. Pull every involved action row on this scope (single query).
  const involvedActionTypeIds = Array.from(new Set([
    ...childActionTypeIds,
    ...allParentDeps.map((d) => d.dependsOnActionTypeId),
  ]));
  const scopeRows = await tx.select()
    .from(actionsTable)
    .where(and(
      eq(actionsTable.scope, scope),
      eq(actionsTable.scopeId, scopeId),
      inArray(actionsTable.actionTypeId, involvedActionTypeIds),
    ));
  const rowByActionType = new Map<number, typeof scopeRows[number]>();
  for (const r of scopeRows) rowByActionType.set(r.actionTypeId, r);

  // 4. Compute eligible promotions in memory.
  // A child is eligible when every parent dep is satisfied. Two cases
  // count as satisfied:
  //   • Parent row exists and is `done` or `skipped` — work is settled.
  //   • Parent action_type was never picked on this scope (no row in
  //     actions table) — the dep is dormant. Without this case a child
  //     blocked by an absent parent stays blocked forever.
  const promoteIds: number[] = [];
  for (const childActionTypeId of childActionTypeIds) {
    const childRow = rowByActionType.get(childActionTypeId);
    if (!childRow || childRow.status !== "blocked") continue;
    const parentIds = parentsByChild.get(childActionTypeId) ?? [];
    const allParentsSatisfied = parentIds.every((pid) => {
      const parentRow = rowByActionType.get(pid);
      if (!parentRow) return true; // dormant on this scope
      return parentRow.status === "done" || parentRow.status === "skipped";
    });
    if (allParentsSatisfied) promoteIds.push(childRow.id);
  }
  if (promoteIds.length === 0) return [];

  // 5. Single bulk UPDATE — replaces N sequential updates.
  await tx.update(actionsTable)
    .set({ status: "waiting", updatedAt: nowIso })
    .where(inArray(actionsTable.id, promoteIds));

  return promoteIds;
}

/**
 * Run when a parent leaves the `done` state (re-opened from done →
 * waiting/blocked, or done → skipped).
 *
 * BFS the dependency DAG: every transitive descendant on the same scope
 * whose precondition is no longer met drops back to `blocked` with its
 * completedAt cleared. `skipped` descendants are intentionally NOT
 * reverted — the team has explicitly opted those actions out, so a
 * parent revert shouldn't un-skip them.
 *
 * Returns ids of every action row this cascade touched.
 */
export async function cascadeRevertDependents(
  tx: Tx,
  scope: Scope,
  scopeId: number,
  parentActionTypeId: number,
  nowIso: string,
): Promise<number[]> {
  // BFS over action_dependencies to collect every transitive descendant
  // action_type id.
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

  // Pull matching action rows on this scope.
  const rows = await tx.select()
    .from(actionsTable)
    .where(and(
      eq(actionsTable.scope, scope),
      eq(actionsTable.scopeId, scopeId),
      inArray(actionsTable.actionTypeId, Array.from(descendants)),
    ));

  // Revert anything that isn't already skipped.
  const toRevert = rows.filter((r) => r.status !== "skipped");
  if (toRevert.length === 0) return [];

  await tx.update(actionsTable)
    .set({ status: "blocked", completedAt: null, updatedAt: nowIso })
    .where(inArray(actionsTable.id, toRevert.map((r) => r.id)));

  return toRevert.map((r) => r.id);
}

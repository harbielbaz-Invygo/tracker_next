/**
 * One-time admin endpoint: re-evaluate every `blocked` batch_action
 * against the new "missing parent = dormant dep" rule.
 *
 * Background: the cascade-unblock used to require every parent of a
 * child to have a `batch_action` row with status="done". If a parent
 * action_type wasn't picked at intake, the child stayed blocked
 * forever. This PR fixed the rule (missing parent = satisfied), but
 * existing blocked rows on production won't move until something
 * re-triggers their parent. This endpoint runs the new rule once
 * across every batch so stuck rows get unstuck.
 *
 * GET /api/admin/recheck-blocked
 *   - admin-gated
 *   - returns JSON { ok, log, promoted: { batchId, actionTypeName }[] }
 *   - idempotent (re-running is a no-op once everything's settled)
 *
 * Delete this file in a follow-up PR after running.
 */
import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { batchActions, actionDependencies, actionTypes } from "@/lib/db/schema";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;

  const log: string[] = [];
  const promoted: { batchId: number; actionTypeName: string }[] = [];
  const push = (s: string) => { log.push(s); };

  try {
    push("→ Pulling every blocked batch_action…");
    const blockedRows = await db
      .select({
        id:           batchActions.id,
        batchId:      batchActions.batchId,
        actionTypeId: batchActions.actionTypeId,
      })
      .from(batchActions)
      .where(eq(batchActions.status, "blocked"));
    push(`  ✓ ${blockedRows.length} blocked rows found.`);
    if (blockedRows.length === 0) {
      push("✓ Nothing to do.");
      return NextResponse.json({ ok: true, log, promoted });
    }

    push("→ Pulling parent dependencies for every blocked action_type…");
    const blockedActionTypeIds = Array.from(new Set(blockedRows.map((r) => r.actionTypeId)));
    const allParentDeps = await db
      .select()
      .from(actionDependencies)
      .where(inArray(actionDependencies.actionTypeId, blockedActionTypeIds));
    const parentsByChild = new Map<number, number[]>();
    for (const d of allParentDeps) {
      const arr = parentsByChild.get(d.actionTypeId) ?? [];
      arr.push(d.dependsOnActionTypeId);
      parentsByChild.set(d.actionTypeId, arr);
    }

    push("→ Pulling action_type names for the log…");
    const allParentIds = Array.from(new Set(allParentDeps.map((d) => d.dependsOnActionTypeId)));
    const nameLookupIds = Array.from(new Set([...blockedActionTypeIds, ...allParentIds]));
    const typeRows = nameLookupIds.length
      ? await db.select({ id: actionTypes.id, name: actionTypes.name })
          .from(actionTypes)
          .where(inArray(actionTypes.id, nameLookupIds))
      : [];
    const nameByActionType = new Map(typeRows.map((t) => [t.id, t.name]));

    push("→ Walking blocked rows per batch and re-evaluating…");
    // Group by batchId so we can fetch each batch's actions in one query.
    const byBatch = new Map<number, typeof blockedRows>();
    for (const r of blockedRows) {
      const arr = byBatch.get(r.batchId) ?? [];
      arr.push(r);
      byBatch.set(r.batchId, arr);
    }

    for (const [batchId, blockedOnBatch] of byBatch) {
      // Pull every action on this batch we might need to inspect: the
      // blocked children + the parents we need to check.
      const involvedActionTypeIds = new Set<number>();
      for (const r of blockedOnBatch) {
        involvedActionTypeIds.add(r.actionTypeId);
        for (const pid of parentsByChild.get(r.actionTypeId) ?? []) {
          involvedActionTypeIds.add(pid);
        }
      }
      const batchRowsForBatch = await db
        .select({
          id:           batchActions.id,
          actionTypeId: batchActions.actionTypeId,
          status:       batchActions.status,
        })
        .from(batchActions)
        .where(and(
          eq(batchActions.batchId, batchId),
          inArray(batchActions.actionTypeId, Array.from(involvedActionTypeIds)),
        ));
      const rowByActionType = new Map(batchRowsForBatch.map((r) => [r.actionTypeId, r]));

      const promoteIds: number[] = [];
      for (const child of blockedOnBatch) {
        const parents = parentsByChild.get(child.actionTypeId) ?? [];
        const allSatisfied = parents.every((pid) => {
          const parentRow = rowByActionType.get(pid);
          if (!parentRow) return true; // dormant
          return parentRow.status === "done" || parentRow.status === "skipped";
        });
        if (allSatisfied) {
          promoteIds.push(child.id);
          promoted.push({
            batchId,
            actionTypeName: nameByActionType.get(child.actionTypeId) ?? `#${child.actionTypeId}`,
          });
        }
      }

      if (promoteIds.length > 0) {
        await db
          .update(batchActions)
          .set({ status: "waiting", updatedAt: new Date().toISOString() })
          .where(inArray(batchActions.id, promoteIds));
        push(`  • batch #${batchId}: promoted ${promoteIds.length} row(s)`);
      }
    }

    push(`✓ Done. Promoted ${promoted.length} total blocked→waiting.`);
    return NextResponse.json({ ok: true, log, promoted });
  } catch (err) {
    push(`✗ Failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ ok: false, log, promoted }, { status: 500 });
  }
}

/**
 * PATCH /api/scope-action/date — manually adjust an action's
 * expected date (and/or backdate its completedAt). Sibling to
 * /api/scope-action which handles status flips, and
 * /api/scope-action/assign which handles stakeholder reassignment.
 *
 * Why: ops sometimes needs to override the auto-computed expected
 * date (e.g. dealer slipped one stage's commitment but the rest of
 * the chain still tracks the original anchor) or backdate a done
 * action whose actual completion happened earlier than when ops
 * clicked the chip.
 *
 * Body:
 *   {
 *     actionId:     number,
 *     expectedDate: string | null,   // ISO yyyy-mm-dd; null clears
 *     completedAt?: string | null,   // ISO yyyy-mm-dd; only valid when
 *                                    //   action.status === "done";
 *                                    //   stamped at 12:00Z for stability
 *   }
 *
 * Auth: ops + admin.
 */
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { actions as actionsTable } from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

interface Body {
  actionId:     number;
  expectedDate: string | null;
  completedAt?: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function PATCH(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return apiError("Invalid JSON", 400);
  }

  const actionId = Number(body.actionId);
  if (!Number.isInteger(actionId) || actionId <= 0) {
    return apiError("actionId required", 400);
  }
  if (body.expectedDate !== null && (typeof body.expectedDate !== "string" || !ISO_DATE.test(body.expectedDate))) {
    return apiError("expectedDate must be yyyy-mm-dd or null", 400);
  }
  if (body.completedAt !== undefined
      && body.completedAt !== null
      && (typeof body.completedAt !== "string" || !ISO_DATE.test(body.completedAt))) {
    return apiError("completedAt must be yyyy-mm-dd or null", 400);
  }

  const [current] = await db
    .select({
      id:          actionsTable.id,
      status:      actionsTable.status,
      completedAt: actionsTable.completedAt,
    })
    .from(actionsTable)
    .where(eq(actionsTable.id, actionId))
    .limit(1);
  if (!current) return apiError("Action not found", 404);

  // Backdating completedAt only makes sense for done rows. Reject on
  // non-done so a stale UI can't silently corrupt the timeline.
  if (body.completedAt !== undefined && current.status !== "done") {
    return apiError("completedAt only editable when status='done'", 400);
  }

  const nowIso = new Date().toISOString();
  const updateSet: Record<string, unknown> = {
    expectedDate: body.expectedDate,
    updatedAt:    nowIso,
  };
  if (body.completedAt !== undefined) {
    // Stamp at noon UTC so day-comparisons are stable across TZs.
    updateSet.completedAt = body.completedAt
      ? `${body.completedAt}T12:00:00Z`
      : null;
  }

  await db.update(actionsTable).set(updateSet).where(eq(actionsTable.id, actionId));

  return NextResponse.json({
    ok: true,
    actionId,
    expectedDate: body.expectedDate,
    ...(body.completedAt !== undefined
      ? { completedAt: updateSet.completedAt as string | null }
      : {}),
  });
}

/**
 * PATCH /api/scope-action/assign — reassign an action's stakeholder
 * (and/or its department) without changing status. Sibling to
 * /api/scope-action which handles the status flips.
 *
 * Body:
 *   {
 *     actionId: number,
 *     assignedStakeholderId: number | null,   // null clears
 *     departmentId?: number | null,           // optional; cleared if null
 *   }
 *
 * Returns the updated row's identity for the caller to refresh against.
 *
 * Auth: ops + admin (same gate as the rest of the action APIs).
 */
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { actions as actionsTable } from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

interface AssignBody {
  actionId: number;
  assignedStakeholderId: number | null;
  departmentId?: number | null;
}

export async function PATCH(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;

  let body: AssignBody;
  try {
    body = (await req.json()) as AssignBody;
  } catch {
    return apiError("Invalid JSON", 400);
  }

  const actionId = Number(body.actionId);
  if (!Number.isInteger(actionId) || actionId <= 0) {
    return apiError("actionId required", 400);
  }
  // null = unassign; numeric id = assign. Anything else rejected.
  const stakeholderId = body.assignedStakeholderId;
  if (stakeholderId !== null && (!Number.isInteger(stakeholderId) || (stakeholderId as number) <= 0)) {
    return apiError("assignedStakeholderId must be a positive integer or null", 400);
  }

  // Pre-check the row exists so we can return 404 rather than a
  // silent no-op when ops references a stale action_id.
  const [current] = await db.select({ id: actionsTable.id })
    .from(actionsTable).where(eq(actionsTable.id, actionId)).limit(1);
  if (!current) return apiError("Action not found", 404);

  const nowIso = new Date().toISOString();
  // Only set departmentId if the caller passed it (undefined means "leave alone").
  const updateSet: Record<string, unknown> = {
    assignedStakeholderId: stakeholderId,
    updatedAt:             nowIso,
  };
  if (body.departmentId !== undefined) updateSet.departmentId = body.departmentId;

  await db.update(actionsTable).set(updateSet).where(eq(actionsTable.id, actionId));

  return NextResponse.json({
    ok: true,
    actionId,
    assignedStakeholderId: stakeholderId,
    departmentId: body.departmentId ?? null,
  });
}

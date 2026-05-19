/**
 * POST /api/batch-vins-received — record VINs actually received from
 * the dealer for a specific batch (full or partial), and flip the
 * batch-scope VIN External-Phase action accordingly.
 *
 * Body:
 *   {
 *     batchId:              number,
 *     vinsReceivedQuantity: number,  // 0..requestedQuantity
 *     actionId?:            number,  // optional batch-scope VIN action id
 *   }
 *
 * Behaviour:
 *   - Clamps qty to [0, batch.requestedQuantity].
 *   - Persists batches.vinsReceivedQuantity.
 *   - If actionId provided AND points to a batch-scope action on this
 *     batch whose type name matches /vin/i, flips that action:
 *        qty === 0          → status="waiting", completedAt=null
 *        qty >  0           → status="done",    completedAt=now
 *     (partial is treated as "done with a count"; the chip badge tells
 *     ops it's partial — saves inventing a new "partial" status enum.)
 *   - Caps deliveredQuantity at the new VIN count so a previously-set
 *     deliveredQuantity from an earlier mark-as-delivered doesn't
 *     exceed VINs after a downward correction.
 *
 * Auth: ops + admin.
 */
import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  actions as actionsTable,
  actionTypes,
  batches,
} from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

interface Body {
  batchId:              number;
  vinsReceivedQuantity: number;
  actionId?:            number;
}

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return apiError("Invalid JSON", 400);
  }

  if (!Number.isInteger(body.batchId) || body.batchId <= 0) {
    return apiError("batchId required", 400);
  }
  if (!Number.isFinite(body.vinsReceivedQuantity) || body.vinsReceivedQuantity < 0) {
    return apiError("vinsReceivedQuantity must be a non-negative integer", 400);
  }

  const [batch] = await db
    .select({ id: batches.id, requestedQuantity: batches.requestedQuantity })
    .from(batches)
    .where(eq(batches.id, body.batchId))
    .limit(1);
  if (!batch) return apiError("Batch not found", 404);

  const clamped = Math.min(
    Math.max(0, Math.floor(body.vinsReceivedQuantity)),
    batch.requestedQuantity,
  );

  const nowIso = new Date().toISOString();

  // Resolve the optional VIN action — must be a batch-scope row on
  // THIS batch, and the action_type name must mention vin (case-
  // insensitive). Anything else gets ignored, not rejected: ops can
  // still record qty without flipping an action.
  let vinAction: { id: number; status: string } | null = null;
  if (Number.isInteger(body.actionId) && body.actionId! > 0) {
    const [row] = await db
      .select({
        id:             actionsTable.id,
        status:         actionsTable.status,
        actionTypeName: actionTypes.name,
        scope:          actionsTable.scope,
        scopeId:        actionsTable.scopeId,
      })
      .from(actionsTable)
      .innerJoin(actionTypes, eq(actionsTable.actionTypeId, actionTypes.id))
      .where(eq(actionsTable.id, body.actionId!))
      .limit(1);
    if (row
        && row.scope === "batch"
        && row.scopeId === body.batchId
        && /vin/i.test(row.actionTypeName)) {
      vinAction = { id: row.id, status: row.status };
    }
  }

  await db.transaction(async (tx) => {
    // 1. Persist VINs received qty + cap delivered.
    // We don't bump deliveredQuantity downward beyond the new VINs
    // unless it was already higher — that case shouldn't happen in
    // practice (you can't have delivered more cars than VINs received),
    // but defending against it keeps the invariant clean.
    const [b] = await tx
      .select({ deliveredQuantity: batches.deliveredQuantity })
      .from(batches)
      .where(eq(batches.id, body.batchId))
      .limit(1);
    const currentDelivered = b?.deliveredQuantity ?? 0;
    const cappedDelivered = currentDelivered > clamped ? clamped : currentDelivered;

    await tx.update(batches).set({
      vinsReceivedQuantity: clamped,
      deliveredQuantity:    cappedDelivered,
      updatedAt:            nowIso,
    }).where(eq(batches.id, body.batchId));

    // 2. Flip the VIN action if one was identified.
    if (vinAction) {
      await tx.update(actionsTable).set({
        status:      clamped > 0 ? "done" : "waiting",
        completedAt: clamped > 0 ? nowIso : null,
        updatedAt:   nowIso,
      }).where(and(
        eq(actionsTable.id, vinAction.id),
        eq(actionsTable.scope, "batch"),
      ));
    }
  });

  return NextResponse.json({
    ok: true,
    batchId:              body.batchId,
    vinsReceivedQuantity: clamped,
    requestedQuantity:    batch.requestedQuantity,
    partial:              clamped > 0 && clamped < batch.requestedQuantity,
    actionFlipped:        vinAction != null,
  });
}

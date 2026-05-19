/**
 * POST /api/batch-vins-received — record VINs actually received from
 * the dealer per delivery leg (per-city) and roll up to the batch
 * total. Also flips the batch-scope VIN External-Phase action
 * accordingly.
 *
 * Body shapes:
 *   { batchId, vinsReceivedQuantity: N, actionId? }     // single-leg / legacy
 *   { batchId, legs: [{ id, vinsReceivedQuantity }], actionId? }  // per-city
 *
 * When `legs` is provided, the batch total is `sum(legs[].vins)`.
 * When `vinsReceivedQuantity` is provided alone, it's applied to the
 * batch row only (no per-leg writes). Either shape is valid.
 *
 * Behaviour:
 *   - Clamps each per-leg qty to [0, leg.requestedQuantity].
 *   - Persists batch_delivery_legs.vins_received_quantity per leg.
 *   - Persists batches.vins_received_quantity = sum across legs (or
 *     the supplied scalar when legs aren't passed).
 *   - If actionId provided AND points to a batch-scope action on this
 *     batch whose type name matches /vin/i, flips that action:
 *        sum === 0  → status="waiting", completedAt=null
 *        sum >  0   → status="done",    completedAt=now
 *   - Caps deliveredQuantity at the new VINs sum so a previously-set
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
  batchDeliveryLegs,
} from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

interface BodyLegsShape {
  batchId:  number;
  legs:     { id: number; vinsReceivedQuantity: number }[];
  actionId?: number;
}
interface BodyScalarShape {
  batchId:              number;
  vinsReceivedQuantity: number;
  actionId?:            number;
}
type Body = BodyLegsShape | BodyScalarShape;

function isLegsShape(b: Body): b is BodyLegsShape {
  return Array.isArray((b as BodyLegsShape).legs);
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

  const [batch] = await db
    .select({ id: batches.id, requestedQuantity: batches.requestedQuantity })
    .from(batches)
    .where(eq(batches.id, body.batchId))
    .limit(1);
  if (!batch) return apiError("Batch not found", 404);

  // Resolve the per-leg writes and the rolled-up batch total.
  // Per-leg path: pull current legs, validate each id belongs to this
  // batch, clamp each qty to its leg's requested qty.
  let perLegUpdates: { id: number; qty: number }[] = [];
  let batchTotal = 0;

  if (isLegsShape(body)) {
    if (!body.legs.every((l) => Number.isInteger(l.id) && Number.isFinite(l.vinsReceivedQuantity))) {
      return apiError("Each leg requires id (int) + vinsReceivedQuantity (number)", 400);
    }
    let legsForBatch: { id: number; requestedQuantity: number }[];
    try {
      legsForBatch = await db.select({
        id:                batchDeliveryLegs.id,
        requestedQuantity: batchDeliveryLegs.requestedQuantity,
      })
        .from(batchDeliveryLegs)
        .where(eq(batchDeliveryLegs.batchId, body.batchId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such table/i.test(msg)) {
        return apiError("batch_delivery_legs table missing — run /api/admin/ensure-vins-received-column", 500);
      }
      throw err;
    }
    const reqByLeg = new Map(legsForBatch.map((l) => [l.id, l.requestedQuantity]));
    for (const l of body.legs) {
      const reqQty = reqByLeg.get(l.id);
      if (reqQty == null) {
        return apiError(`Leg ${l.id} does not belong to batch ${body.batchId}`, 400);
      }
      const clamped = Math.min(Math.max(0, Math.floor(l.vinsReceivedQuantity)), reqQty);
      perLegUpdates.push({ id: l.id, qty: clamped });
      batchTotal += clamped;
    }
  } else {
    if (!Number.isFinite(body.vinsReceivedQuantity) || body.vinsReceivedQuantity < 0) {
      return apiError("vinsReceivedQuantity must be a non-negative integer", 400);
    }
    batchTotal = Math.min(
      Math.max(0, Math.floor(body.vinsReceivedQuantity)),
      batch.requestedQuantity,
    );
  }

  const nowIso = new Date().toISOString();

  // Resolve the optional VIN action — same rules as before.
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
    // 1. Per-leg writes (when supplied).
    for (const u of perLegUpdates) {
      await tx.update(batchDeliveryLegs).set({
        vinsReceivedQuantity: u.qty,
      }).where(and(
        eq(batchDeliveryLegs.id, u.id),
        eq(batchDeliveryLegs.batchId, body.batchId),
      ));
    }

    // 2. Batch-level rollup + cap delivered.
    const [b] = await tx
      .select({ deliveredQuantity: batches.deliveredQuantity })
      .from(batches)
      .where(eq(batches.id, body.batchId))
      .limit(1);
    const currentDelivered = b?.deliveredQuantity ?? 0;
    const cappedDelivered = currentDelivered > batchTotal ? batchTotal : currentDelivered;

    await tx.update(batches).set({
      vinsReceivedQuantity: batchTotal,
      deliveredQuantity:    cappedDelivered,
      updatedAt:            nowIso,
    }).where(eq(batches.id, body.batchId));

    // 3. Flip the VIN action if one was identified.
    if (vinAction) {
      await tx.update(actionsTable).set({
        status:      batchTotal > 0 ? "done" : "waiting",
        completedAt: batchTotal > 0 ? nowIso : null,
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
    vinsReceivedQuantity: batchTotal,
    requestedQuantity:    batch.requestedQuantity,
    partial:              batchTotal > 0 && batchTotal < batch.requestedQuantity,
    actionFlipped:        vinAction != null,
    perLegUpdates:        perLegUpdates.length,
  });
}

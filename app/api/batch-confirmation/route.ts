/**
 * POST /api/batch-confirmation — record how many cars the dealer has
 * *confirmed* against the batch's requested quantity, and flip the
 * batch-scope "Send Dealer Confirmation Email" External-Phase action
 * accordingly.
 *
 * Body:
 *   { batchId, confirmedQuantity: N, actionId? }
 *
 * Why scalar (not per-leg) like /api/batch-vins-received: dealer
 * confirmation lands as one number ("we have 7 out of 10 ready") —
 * the per-city split only matters once VINs arrive. We could model it
 * per-leg later if the data shows we need to.
 *
 * Behaviour:
 *   - Clamps to [0, requestedQuantity].
 *   - Persists batches.confirmed_quantity.
 *   - If actionId provided AND points to a batch-scope action on this
 *     batch whose type name matches /confirmation/i, flips that action:
 *        n === 0 → status="waiting", completedAt=null
 *        n >  0  → status="done",    completedAt=now
 *
 * Auth: ops + admin.
 */
import { and, eq, sql } from "drizzle-orm";
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
  batchId:           number;
  confirmedQuantity: number;
  actionId?:         number;
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
  if (!Number.isFinite(body.confirmedQuantity) || body.confirmedQuantity < 0) {
    return apiError("confirmedQuantity must be a non-negative integer", 400);
  }

  const [batch] = await db
    .select({ id: batches.id, requestedQuantity: batches.requestedQuantity })
    .from(batches)
    .where(eq(batches.id, body.batchId))
    .limit(1);
  if (!batch) return apiError("Batch not found", 404);

  const clamped = Math.min(
    Math.max(0, Math.floor(body.confirmedQuantity)),
    batch.requestedQuantity,
  );

  const nowIso = new Date().toISOString();

  // Resolve the optional Confirmation action — must be batch-scoped on
  // this batch AND have a type name matching /confirmation/i.
  let confirmationAction: { id: number; status: string } | null = null;
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
        && /confirmation/i.test(row.actionTypeName)) {
      confirmationAction = { id: row.id, status: row.status };
    }
  }

  try {
    await db.transaction(async (tx) => {
      // Raw SQL: `confirmed_quantity` isn't on the Drizzle schema
      // (intentionally — see comment in lib/db/schema.ts). Using
      // tx.update(batches).set({ confirmedQuantity }) would 500
      // every Drizzle-typed query elsewhere in the app.
      await tx.run(sql`
        UPDATE batches
        SET confirmed_quantity = ${clamped},
            updated_at         = ${nowIso}
        WHERE id = ${body.batchId}
      `);

      if (confirmationAction) {
        await tx.update(actionsTable).set({
          status:      clamped > 0 ? "done" : "waiting",
          completedAt: clamped > 0 ? nowIso : null,
          updatedAt:   nowIso,
        }).where(and(
          eq(actionsTable.id, confirmationAction.id),
          eq(actionsTable.scope, "batch"),
        ));
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such column.*confirmed_quantity/i.test(msg)) {
      return apiError(
        "confirmed_quantity column missing — run /api/admin/ensure-confirmed-quantity-column",
        503,
      );
    }
    throw err;
  }

  return NextResponse.json({
    ok: true,
    batchId:           body.batchId,
    confirmedQuantity: clamped,
    requestedQuantity: batch.requestedQuantity,
    partial:           clamped > 0 && clamped < batch.requestedQuantity,
    actionFlipped:     confirmationAction != null,
  });
}

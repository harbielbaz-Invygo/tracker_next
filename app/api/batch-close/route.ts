/**
 * POST /api/batch-close — close a batch as cancelled or delivered.
 *
 * Body shapes:
 *   { batchId, reason: "cancelled", note? }
 *   { batchId, reason: "delivered", closedAt?, deliveredQuantity?,
 *     colorConfirmations?: { color, deliveredQuantity }[] }
 *
 * Behaviour:
 *   - Sets `closedAt` (default today), `closureReason`, optional
 *     `cancellationNote` / `deliveredQuantity`.
 *   - Idempotent — re-closing a batch updates the same fields.
 *   - For `reason="delivered"`, also updates per-colour deliveredQuantity
 *     in batch_color_matrix when colorConfirmations is provided.
 *   - Marks the Delivery batch_action as done at closedAt (when it exists)
 *     so the Plan-vs-Reality timeline picks up the closure event.
 *   - Does NOT cascade other batch_actions. Statuses remain in place for
 *     audit / re-opening.
 */
import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { batches, batchActions, batchColorMatrix, actionTypes, batchDeliveryLegs } from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

interface CloseBody {
  batchId: number;
  reason: "cancelled" | "delivered";
  /** Cancellation note (only used when reason="cancelled"). */
  note?: string | null;
  /** Closure date (ISO yyyy-mm-dd). Defaults to today. Allows backdating. */
  closedAt?: string;
  /** Actually-delivered quantity (only used when reason="delivered"). */
  deliveredQuantity?: number;
  /** Per-colour confirmations (only used when reason="delivered"). */
  colorConfirmations?: { color: string; deliveredQuantity: number }[];
  /**
   * Per-leg delivered quantity (only used when reason="delivered").
   * Updates batch_delivery_legs.delivered_quantity for each leg.
   * Phase γ — multi-city batches need per-city accounting at close.
   */
  legConfirmations?: { id: number; deliveredQuantity: number }[];
}

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;

  let body: CloseBody;
  try {
    body = (await req.json()) as CloseBody;
  } catch {
    return apiError("Invalid JSON", 400);
  }

  if (!Number.isFinite(body.batchId)) return apiError("batchId required", 400);
  if (body.reason !== "cancelled" && body.reason !== "delivered") {
    return apiError("reason must be 'cancelled' or 'delivered'", 400);
  }
  // Closure date — use provided ISO, else today.
  const closedAt =
    body.closedAt && /^\d{4}-\d{2}-\d{2}$/.test(body.closedAt)
      ? body.closedAt
      : new Date().toISOString().slice(0, 10);

  await db.transaction(async (tx) => {
    // 1. Close the batch.
    await tx.update(batches).set({
      closedAt,
      closureReason:    body.reason,
      cancellationNote: body.reason === "cancelled" ? (body.note?.trim() || null) : null,
      deliveredQuantity:
        body.reason === "delivered" && Number.isFinite(body.deliveredQuantity)
          ? Math.max(0, Math.floor(body.deliveredQuantity!))
          : undefined,
      updatedAt: new Date().toISOString(),
    }).where(eq(batches.id, body.batchId));

    // 2. Delivered: persist per-colour deliveredQuantity into the matrix.
    if (body.reason === "delivered" && body.colorConfirmations?.length) {
      for (const c of body.colorConfirmations) {
        if (!c.color || !Number.isFinite(c.deliveredQuantity)) continue;
        await tx.update(batchColorMatrix)
          .set({ deliveredQuantity: Math.max(0, Math.floor(c.deliveredQuantity)) })
          .where(and(
            eq(batchColorMatrix.batchId, body.batchId),
            eq(batchColorMatrix.color, c.color),
          ));
      }
    }

    // 2b. Delivered: persist per-leg deliveredQuantity (Phase γ).
    //     Defensive — table may be missing on older DBs that pre-date α.
    if (body.reason === "delivered" && body.legConfirmations?.length) {
      try {
        for (const l of body.legConfirmations) {
          if (!Number.isFinite(l.id) || !Number.isFinite(l.deliveredQuantity)) continue;
          await tx.update(batchDeliveryLegs)
            .set({ deliveredQuantity: Math.max(0, Math.floor(l.deliveredQuantity)) })
            .where(and(
              eq(batchDeliveryLegs.id, l.id),
              eq(batchDeliveryLegs.batchId, body.batchId),
            ));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/no such table/i.test(msg)) throw err;
        // eslint-disable-next-line no-console
        console.warn("[batch-close] batch_delivery_legs missing — leg deliveries skipped. Run the Phase α migration.");
      }
    }

    // 3. Delivered: mark the Delivery batch_action done at closedAt so
    //    the Plan-vs-Reality timeline shows the closure event.
    if (body.reason === "delivered") {
      const deliveryType = await tx
        .select({ id: actionTypes.id })
        .from(actionTypes)
        .where(eq(actionTypes.name, "Delivery"))
        .limit(1);
      if (deliveryType.length > 0) {
        await tx.update(batchActions)
          .set({
            status: "done",
            completedAt: `${closedAt}T12:00:00Z`,
          })
          .where(and(
            eq(batchActions.batchId, body.batchId),
            eq(batchActions.actionTypeId, deliveryType[0].id),
          ));
      }
    }
  });

  return NextResponse.json({
    ok: true,
    batchId: body.batchId,
    closedAt,
    closureReason: body.reason,
  });
}


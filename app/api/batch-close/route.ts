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
import { and, eq, like } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  batches, batchActions, batchColorMatrix, actionTypes, batchDeliveryLegs,
  actions as actionsTable,
} from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";
import { cascadeBatchClosureUp } from "@/lib/closure-cascade";
import { checkBatchDeliveryGate } from "@/lib/closure-gates";

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
  /**
   * When true AND reason='delivered' AND deliveredQuantity < requestedQuantity,
   * spawn a sibling batch under the same wave for the leftover cars.
   * The new batch carries fresh batch-scope copies of the wave's
   * External-Phase action types + a fresh Delivery action so ops can
   * track the dealer completing the shortfall later. Multi-leg
   * remainders compute leftover per city.
   */
  createRemainderBatch?: boolean;
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

  // Server-side gate (G3): when closing as 'delivered', enforce the
  // same 5 checks the client tooltip shows. Cancellation skips this
  // — cancellation is a corrective action and must remain ungated.
  if (body.reason === "delivered") {
    const gate = await checkBatchDeliveryGate(db, body.batchId);
    if (!gate.ok) {
      return apiError(`Cannot mark as delivered: ${gate.reason}`, 409);
    }
  }

  let remainderBatchId: number | null = null;
  // Cascade result — set inside the transaction, read after.
  let waveClosedFromCascade = false;
  let poClosedFromCascade   = false;
  // Wave-scope External-Phase rows the closure cascade settled when
  // this delivery completed the window (see lib/closure-cascade.ts).
  let reconciledWaveActionIds: number[] = [];

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

    // 4. Remainder batch — when ops marked the original delivered with
    //    a partial qty AND requested it. The new batch is a sibling
    //    under the same wave, carrying the leftover cars + fresh
    //    External-Phase action chips so the dealer can complete the
    //    shortfall later. Skipped silently for non-delivered closures,
    //    full deliveries, or missing data.
    if (
      body.reason === "delivered"
      && body.createRemainderBatch === true
      && Number.isFinite(body.deliveredQuantity)
    ) {
      const [parent] = await tx
        .select()
        .from(batches)
        .where(eq(batches.id, body.batchId))
        .limit(1);
      if (parent) {
        const delivered = Math.max(0, Math.floor(body.deliveredQuantity!));
        const remainderQty = Math.max(0, parent.requestedQuantity - delivered);
        if (remainderQty > 0 && parent.waveId != null) {
          // Generate the next available code: `${parent}-R${n}`. Count
          // existing siblings under the same wave whose batch_code
          // starts with the parent's code + "-R" to pick the next n.
          const siblings = await tx.select({ batchCode: batches.batchCode })
            .from(batches)
            .where(and(
              eq(batches.waveId, parent.waveId),
              like(batches.batchCode, `${parent.batchCode}-R%`),
            ));
          const usedIndices = siblings
            .map((s) => {
              const m = /-R(\d+)$/.exec(s.batchCode);
              return m ? parseInt(m[1], 10) : 0;
            })
            .filter((n) => Number.isFinite(n) && n > 0);
          const nextIndex = usedIndices.length === 0 ? 1 : Math.max(...usedIndices) + 1;
          const remainderCode = `${parent.batchCode}-R${nextIndex}`;

          const insertedRemainder = await tx.insert(batches).values({
            batchCode:                     remainderCode,
            dealerId:                      parent.dealerId,
            model:                         parent.model,
            year:                          parent.year,
            category:                      parent.category,
            buyBackRate:                   parent.buyBackRate,
            contractLengthMonths:          parent.contractLengthMonths,
            colorSummary:                  parent.colorSummary,
            unitPriceSar:                  parent.unitPriceSar,
            lineAmountSar:                 parent.lineAmountSar,
            taxPct:                        parent.taxPct,
            discountPct:                   parent.discountPct,
            poNumber:                      parent.poNumber,
            poReference:                   parent.poReference,
            poTotalSar:                    parent.poTotalSar,
            poSubtotalSar:                 parent.poSubtotalSar,
            poTaxTotalSar:                 parent.poTaxTotalSar,
            poTermsNotes:                  parent.poTermsNotes,
            poEarlyTermination:            parent.poEarlyTermination,
            poDeliveryAddress:             parent.poDeliveryAddress,
            poDeliveryPhone:               parent.poDeliveryPhone,
            poDeliveryAttention:           parent.poDeliveryAttention,
            poDeliveryInstructions:        parent.poDeliveryInstructions,
            requestedQuantity:             remainderQty,
            allocatedQuantity:             0,
            deliveredQuantity:             0,
            vinsReceivedQuantity:          0,
            requestedAt:                   parent.requestedAt,
            dealerPromisedDeliveryDate:    parent.dealerPromisedDeliveryDate,
            vinReceivingDate:              parent.vinReceivingDate,
            currentProjectedDeliveryDate:  parent.currentProjectedDeliveryDate,
            appDisplayCities:              parent.appDisplayCities,
            dealerReceivingCity:           parent.dealerReceivingCity,
            requiresInterCityTransit:      parent.requiresInterCityTransit ?? undefined,
            dealerPolicySource:            parent.dealerPolicySource,
            feasibilityStatus:             parent.feasibilityStatus,
            lifecycleState:                "post_po",
            // Inherit the listed timestamp — the parent's listing applies
            // to the same model/PO, so we don't make ops re-list.
            appListedAt:                   parent.appListedAt,
            currentStage:                  parent.currentStage,
            waveId:                        parent.waveId,
            notes:                         `Remainder of ${parent.batchCode} (${remainderQty} undelivered of ${parent.requestedQuantity}).`,
          }).returning({ id: batches.id });

          const newId = insertedRemainder[0].id;
          remainderBatchId = newId;

          // Per-leg remainders. Two cases:
          //  - Multi-leg batches: ops sent legConfirmations[] in the
          //    DeliverForm; use those for per-city accounting.
          //  - Single-leg batches: legConfirmations is empty (the form
          //    only collects a scalar qty); treat the scalar
          //    deliveredQuantity as the single leg's delivered count.
          // Without the single-leg fallback the remainder leg inherited
          // the parent's full quantity — Jeddah 15 instead of Jeddah 5.
          try {
            const parentLegs = await tx.select()
              .from(batchDeliveryLegs)
              .where(eq(batchDeliveryLegs.batchId, parent.id));
            const deliveredByLeg = new Map<number, number>();
            for (const lc of body.legConfirmations ?? []) {
              deliveredByLeg.set(lc.id, Math.max(0, Math.floor(lc.deliveredQuantity)));
            }
            // Single-leg + no legConfirmations: scalar delivery → leg.
            if (
              parentLegs.length === 1
              && deliveredByLeg.size === 0
              && Number.isFinite(body.deliveredQuantity)
            ) {
              deliveredByLeg.set(parentLegs[0].id, delivered);
            }
            for (const leg of parentLegs) {
              const deliv = deliveredByLeg.get(leg.id) ?? (leg.deliveredQuantity ?? 0);
              const legRemainder = Math.max(0, leg.requestedQuantity - deliv);
              if (legRemainder === 0) continue;
              await tx.insert(batchDeliveryLegs).values({
                batchId:              newId,
                city:                 leg.city,
                requestedQuantity:    legRemainder,
                deliveredQuantity:    0,
                vinsReceivedQuantity: 0,
                notes:                null,
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/no such table/i.test(msg)) throw err;
            // Pre-Phase-α DB: legs table absent. The new batch's
            // dealerReceivingCity already inherits from parent, so the
            // single-city display still works.
          }

          // Copy wave-scope External-Phase action_types as batch-scope
          // rows on the remainder (status=waiting). Mirrors the Intake
          // pattern — one row per wave action_type per batch.
          const waveActionTypeIds = (
            await tx.select({ actionTypeId: actionsTable.actionTypeId })
              .from(actionsTable)
              .where(and(
                eq(actionsTable.scope, "wave"),
                eq(actionsTable.scopeId, parent.waveId),
              ))
          ).map((r) => r.actionTypeId);
          for (const atId of waveActionTypeIds) {
            const [at] = await tx.select({
              defaultDepartmentId: actionTypes.defaultDepartmentId,
            }).from(actionTypes).where(eq(actionTypes.id, atId)).limit(1);
            try {
              await tx.insert(actionsTable).values({
                scope:        "batch",
                scopeId:      newId,
                actionTypeId: atId,
                departmentId: at?.defaultDepartmentId ?? undefined,
                status:       "waiting",
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (!/UNIQUE constraint failed|already exists/i.test(msg)) throw err;
            }
          }

          // Fresh Delivery action so the remainder can be closed later.
          const [deliveryType] = await tx.select({
            id: actionTypes.id,
            defaultDepartmentId: actionTypes.defaultDepartmentId,
          }).from(actionTypes).where(eq(actionTypes.name, "Delivery")).limit(1);
          if (deliveryType) {
            try {
              await tx.insert(actionsTable).values({
                scope:        "batch",
                scopeId:      newId,
                actionTypeId: deliveryType.id,
                departmentId: deliveryType.defaultDepartmentId ?? undefined,
                status:       "waiting",
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (!/UNIQUE constraint failed|already exists/i.test(msg)) throw err;
            }
          }
        }
      }
    }

    // 5. Closure cascade — propagate this batch's closure up to its
    //    wave and PO when every sibling is closed. Mirrors the
    //    re-open path (handled by /api/scope-action on Delivery
    //    action flips). Same transaction so a half-cascaded state
    //    is impossible.
    waveClosedFromCascade = false;
    poClosedFromCascade = false;
    try {
      const cascade = await cascadeBatchClosureUp(tx, body.batchId, new Date().toISOString());
      waveClosedFromCascade = cascade.waveClosed;
      poClosedFromCascade = cascade.poClosed;
      reconciledWaveActionIds = cascade.reconciledWaveActionIds;
    } catch (err) {
      // The cascade is best-effort: a missing waves/pos row (legacy
      // batch with no wave linkage, or a corrupt FK) shouldn't fail
      // the closure that already succeeded. Log and continue.
      // eslint-disable-next-line no-console
      console.warn(
        "[batch-close] closure cascade failed for batch",
        body.batchId,
        err instanceof Error ? err.message : err,
      );
    }
  });

  return NextResponse.json({
    ok: true,
    batchId: body.batchId,
    closedAt,
    closureReason: body.reason,
    waveClosed: waveClosedFromCascade,
    poClosed:   poClosedFromCascade,
    reconciledWaveActionIds,
    ...(remainderBatchId != null ? { remainderBatchId } : {}),
  });
}


/**
 * GET/POST /api/admin/consolidate-window
 *
 * One-off data fix: collapse a delivery window's remainder batch(es) back
 * into the primary batch and mark the whole window FULLY DELIVERED on a
 * single date — for cases where a partial delivery (which spawned a
 * remainder) was actually a full, same-day delivery.
 *
 * Defaults target the PO-0107 / 2026-05-25 window (50-car primary +
 * 9-car remainder → one 59-car batch, 59 VINs, 59 delivered on
 * 2026-05-25). Override via ?po=, ?window=, ?date=.
 *
 * The "primary" is the batch whose code does NOT end in -R<n>; remainders
 * are the -R<n> siblings. Requires exactly one primary (else it refuses).
 *
 * GET  → dry-run: what it would do (no writes).
 * POST → apply in a single transaction.
 *
 * Admin-only. Destructive (deletes the remainder batch + its rows).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  pos, waves, batches, batchDeliveryLegs,
  actions as actionsTable, batchActions, actionTypes,
} from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const REMAINDER_RE = /-R\d+$/;

function params(req: NextRequest) {
  const u = new URL(req.url);
  return {
    poNumber:   u.searchParams.get("po") ?? "PO-0107",
    windowDate: u.searchParams.get("window") ?? "2026-05-25",
    date:       u.searchParams.get("date") ?? "2026-05-25",
  };
}

async function plan(poNumber: string, windowDate: string) {
  const [po] = await db.select({ id: pos.id }).from(pos)
    .where(eq(pos.poNumber, poNumber)).limit(1);
  if (!po) throw new Error(`PO ${poNumber} not found`);

  const [wave] = await db.select().from(waves)
    .where(and(eq(waves.poId, po.id), eq(waves.availabilityDate, windowDate))).limit(1);
  if (!wave) throw new Error(`Window ${windowDate} not found on ${poNumber}`);

  const waveBatches = await db.select().from(batches).where(eq(batches.waveId, wave.id));
  if (waveBatches.length === 0) throw new Error("No batches in this window");

  const primaries = waveBatches.filter((b) => !REMAINDER_RE.test(b.batchCode));
  const remainders = waveBatches.filter((b) => REMAINDER_RE.test(b.batchCode));
  if (primaries.length !== 1) {
    throw new Error(`Expected exactly one primary batch (non -R), found ${primaries.length}: ${primaries.map((b) => b.batchCode).join(", ")}`);
  }
  const primary = primaries[0];
  const total = waveBatches.reduce((s, b) => s + b.requestedQuantity, 0);
  return { po, wave, primary, remainders, total };
}

export async function GET(req: NextRequest) {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  const { poNumber, windowDate, date } = params(req);
  try {
    const p = await plan(poNumber, windowDate);
    return NextResponse.json({
      ok: true,
      dryRun: true,
      poNumber, windowDate, deliveredDate: date,
      primaryBatch: p.primary.batchCode,
      remainderBatches: p.remainders.map((b) => b.batchCode),
      finalCars: p.total,
      plan:
        `Merge ${p.remainders.length} remainder(s) into "${p.primary.batchCode}" → `
        + `${p.total} cars · ${p.total} VINs · ${p.total} delivered on ${date}; delete the remainder(s).`,
    });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : String(e), 400);
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  const { poNumber, windowDate, date } = params(req);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return apiError("date must be yyyy-mm-dd", 400);

  try {
    const p = await plan(poNumber, windowDate);
    const total = p.total;
    const completedAt = `${date}T12:00:00Z`;
    const nowIso = new Date().toISOString();
    const [deliveryType] = await db
      .select({ id: actionTypes.id }).from(actionTypes)
      .where(eq(actionTypes.name, "Delivery")).limit(1);

    await db.transaction(async (tx) => {
      // 1. Delete remainder batches. Their legs / colour matrix / legacy
      //    actions cascade via FK; the scope-aware `actions` rows don't, so
      //    clear those first.
      const remIds = p.remainders.map((b) => b.id);
      if (remIds.length > 0) {
        await tx.delete(actionsTable).where(and(
          eq(actionsTable.scope, "batch"),
          inArray(actionsTable.scopeId, remIds),
        ));
        await tx.delete(batches).where(inArray(batches.id, remIds));
      }

      // 2. Primary batch → fully delivered total on `date`.
      await tx.update(batches).set({
        requestedQuantity:    total,
        vinsReceivedQuantity: total,
        deliveredQuantity:    total,
        closedAt:             date,
        closureReason:        "delivered",
        updatedAt:            nowIso,
      }).where(eq(batches.id, p.primary.id));
      // confirmed_quantity lives off the Drizzle schema → raw SQL.
      try { await tx.run(sql`UPDATE batches SET confirmed_quantity = ${total} WHERE id = ${p.primary.id}`); } catch { /* column absent */ }

      // 3. Primary legs → fully delivered. One leg: set to total. Many:
      //    fully deliver each at its requested + add the leftover to the
      //    largest, so the legs still sum to `total`.
      const legs = await tx.select().from(batchDeliveryLegs).where(eq(batchDeliveryLegs.batchId, p.primary.id));
      if (legs.length === 1) {
        await tx.update(batchDeliveryLegs)
          .set({ requestedQuantity: total, vinsReceivedQuantity: total, deliveredQuantity: total })
          .where(eq(batchDeliveryLegs.id, legs[0].id));
      } else if (legs.length > 1) {
        const legSum = legs.reduce((s, l) => s + l.requestedQuantity, 0);
        const leftover = Math.max(0, total - legSum);
        const largestId = legs.slice().sort((a, b) => b.requestedQuantity - a.requestedQuantity)[0].id;
        for (const l of legs) {
          const q = l.requestedQuantity + (l.id === largestId ? leftover : 0);
          await tx.update(batchDeliveryLegs)
            .set({ requestedQuantity: q, vinsReceivedQuantity: q, deliveredQuantity: q })
            .where(eq(batchDeliveryLegs.id, l.id));
        }
      }

      // 4. Colour matrix → fully delivered (delivered = requested).
      try { await tx.run(sql`UPDATE batch_color_matrix SET delivered_quantity = requested_quantity WHERE batch_id = ${p.primary.id}`); } catch { /* table/column absent */ }

      // 5. Delivery action completedAt = `date` (scope-aware + legacy).
      if (deliveryType) {
        await tx.update(actionsTable)
          .set({ status: "done", completedAt, updatedAt: nowIso })
          .where(and(
            eq(actionsTable.scope, "batch"),
            eq(actionsTable.scopeId, p.primary.id),
            eq(actionsTable.actionTypeId, deliveryType.id),
          ));
        await tx.update(batchActions)
          .set({ status: "done", completedAt })
          .where(and(
            eq(batchActions.batchId, p.primary.id),
            eq(batchActions.actionTypeId, deliveryType.id),
          ));
      }
    });

    return NextResponse.json({
      ok: true,
      poNumber, windowDate, deliveredDate: date,
      primaryBatch: p.primary.batchCode,
      mergedRemainders: p.remainders.map((b) => b.batchCode),
      finalCars: total,
    });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : String(e), 500);
  }
}

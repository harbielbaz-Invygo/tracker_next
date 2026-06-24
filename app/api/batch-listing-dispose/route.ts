/**
 * POST /api/batch-listing-dispose — resolve a batch's unlisted remainder
 * at listing time. Splits the unlisted (and un-committed) cars off the
 * source batch and either CANCELS them or MOVES them to another delivery
 * window, so the source can become fully listed and close cleanly.
 *
 * Body:
 *   { batchId, action: "cancel", quantity }
 *   { batchId, action: "move",   quantity, windowDate }   // yyyy-mm-dd
 *
 * Rules:
 *   - Only cars that are NOT yet listed/committed can be disposed:
 *     disposable = requested − max(listed, vinsReceived, delivered).
 *   - The source's requested shrinks by `quantity` (it keeps its listed
 *     count → becomes fully listed once the leftover is gone).
 *   - cancel → a sibling batch with the cars, closure_reason='cancelled'
 *     (drops out of the listing denominator + counts as a baseline miss).
 *   - move   → a fresh unlisted batch in the target window (new wave +
 *     its external-phase actions if the window is new), to be listed later.
 *
 * Admin-only — it's a structural/commitment change, like redistribution.
 */
import { and, eq, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { waves, batches, actions as actionsTable, actionTypes } from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;
async function insertAction(tx: Tx, scope: "wave" | "batch", scopeId: number, actionTypeId: number, deptId: number | null) {
  try {
    await tx.insert(actionsTable).values({ scope, scopeId, actionTypeId, departmentId: deptId ?? undefined, status: "waiting" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/UNIQUE constraint failed|already exists/i.test(msg)) throw err;
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => null)) as
    | { batchId?: unknown; action?: unknown; quantity?: unknown; windowDate?: unknown }
    | null;
  const batchId = Number(body?.batchId);
  const action = body?.action;
  const quantity = Number(body?.quantity);
  const windowDate = typeof body?.windowDate === "string" ? body.windowDate : "";

  if (!Number.isInteger(batchId) || batchId <= 0) return apiError("batchId required", 400);
  if (action !== "cancel" && action !== "move") return apiError('action must be "cancel" or "move"', 400);
  if (!Number.isInteger(quantity) || quantity <= 0) return apiError("quantity must be a positive whole number", 400);
  if (action === "move" && !ISO.test(windowDate)) return apiError("windowDate (yyyy-mm-dd) required to move", 400);

  const [src] = await db.select().from(batches).where(eq(batches.id, batchId)).limit(1);
  if (!src) return apiError("Batch not found", 404);
  if (src.waveId == null) return apiError("Batch has no delivery window — can't dispose.", 409);
  if (src.closureReason) return apiError("Batch already closed — can't dispose.", 409);

  // listed_quantity is off-schema → raw read, tolerant.
  let listedQty = 0;
  try {
    const r = await db.all<{ lq: number }>(sql`SELECT listed_quantity AS lq FROM batches WHERE id = ${batchId}`);
    listedQty = Number(r[0]?.lq ?? 0);
  } catch { /* column not migrated — treat as 0 listed */ }

  const committed = Math.max(listedQty, src.vinsReceivedQuantity ?? 0, src.deliveredQuantity ?? 0);
  const disposable = src.requestedQuantity - committed;
  if (disposable <= 0) {
    return apiError("Nothing to dispose — every car here is already listed/committed.", 409);
  }
  if (quantity > disposable) {
    return apiError(`Only ${disposable} unlisted car(s) can be disposed here (${quantity} requested).`, 409);
  }

  const [srcWave] = await db.select({ id: waves.id, poId: waves.poId }).from(waves).where(eq(waves.id, src.waveId)).limit(1);
  if (!srcWave) return apiError("Source window not found.", 409);

  const waveActionTypes = await db.select().from(actionTypes).where(eq(actionTypes.scope, "wave"));
  const [deliveryType] = await db.select().from(actionTypes).where(eq(actionTypes.name, "Delivery")).limit(1);
  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  // Strip generated/identity columns so the clone gets fresh ones. (Note:
  // off-schema columns like listed_quantity aren't in `src` at all → the
  // clone starts at their column default of 0 = unlisted, which is correct.)
  const { id: _omitId, createdAt: _omitC, updatedAt: _omitU, ...clone } = src;

  await db.transaction(async (tx) => {
    await tx.update(batches)
      .set({ requestedQuantity: src.requestedQuantity - quantity, updatedAt: nowIso })
      .where(eq(batches.id, batchId));

    if (action === "cancel") {
      await tx.insert(batches).values({
        ...clone,
        batchCode:            `${src.batchCode}-X${today.replace(/-/g, "")}`,
        requestedQuantity:    quantity,
        allocatedQuantity:    0,
        deliveredQuantity:    0,
        vinsReceivedQuantity: 0,
        appListedAt:          null,
        closedAt:             today,
        closureReason:        "cancelled",
        cancellationNote:     `Unlisted remainder cancelled at listing — ${quantity} car(s)`,
        notes:                `Unlisted remainder cancelled at listing — ${quantity} car(s)`,
      });
      // No actions for a cancelled split — it's closed.
    } else {
      let [destWave] = await tx.select().from(waves)
        .where(and(eq(waves.poId, srcWave.poId), eq(waves.availabilityDate, windowDate))).limit(1);
      if (!destWave) {
        const [nw] = await tx.insert(waves).values({ poId: srcWave.poId, availabilityDate: windowDate }).returning();
        destWave = nw;
        for (const at of waveActionTypes) await insertAction(tx, "wave", nw.id, at.id, at.defaultDepartmentId ?? null);
      }
      const [nb] = await tx.insert(batches).values({
        ...clone,
        batchCode:                    `${src.batchCode}-L${windowDate.replace(/-/g, "")}`,
        waveId:                       destWave.id,
        requestedQuantity:            quantity,
        allocatedQuantity:            0,
        deliveredQuantity:            0,
        vinsReceivedQuantity:         0,
        appListedAt:                  null,
        dealerPromisedDeliveryDate:   windowDate,
        currentProjectedDeliveryDate: windowDate,
        closedAt:                     null,
        closureReason:                null,
        notes:                        `Unlisted remainder moved to ${windowDate} at listing — ${quantity} car(s)`,
      }).returning({ id: batches.id });
      for (const at of waveActionTypes) await insertAction(tx, "batch", nb.id, at.id, at.defaultDepartmentId ?? null);
      if (deliveryType) await insertAction(tx, "batch", nb.id, deliveryType.id, deliveryType.defaultDepartmentId ?? null);
    }
  });

  return NextResponse.json({ ok: true, batchId, action, quantity, ...(action === "move" ? { windowDate } : {}) });
}

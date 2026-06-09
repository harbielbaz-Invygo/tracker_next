/**
 * POST /api/po-redistribute — move cars between a PO's delivery windows
 * (the "working allocation"). The frozen baseline (po_delivery_baseline)
 * is NEVER touched — reliability is always scored against it.
 *
 * Admin-only. Body:
 *   { poId, allocation: [{ windowDate, quantity }], reason }
 *
 * Rules:
 *   - Cars are conserved: Σ allocation.quantity must equal the PO's frozen
 *     baseline total (you move cars, never invent/lose them).
 *   - A window can't be reduced below what's already committed (VINs
 *     received / delivered).
 *   - A window date not currently present creates a NEW window (wave +
 *     cloned batch + fresh external-phase action rows).
 *   - Every redistribution is logged (who/when/why + before/after).
 */
import { eq, inArray, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { waves, batches, actions as actionsTable, actionTypes } from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

interface Body {
  poId: number;
  allocation: { windowDate: string; quantity: number }[];
  reason: string;
}

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["admin"]); // admin-only
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  const poId = Number(body?.poId);
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  const rawAllocation = Array.isArray(body?.allocation) ? body!.allocation : [];

  if (!Number.isInteger(poId) || poId <= 0) return apiError("poId required", 400);
  if (!reason) return apiError("A reason is required", 400);
  if (rawAllocation.length === 0) return apiError("allocation required", 400);

  // Normalise + validate the requested allocation.
  const alloc: { windowDate: string; quantity: number }[] = [];
  const seen = new Set<string>();
  for (const a of rawAllocation) {
    const d = String(a?.windowDate ?? "");
    const q = Number(a?.quantity);
    if (!ISO.test(d)) return apiError(`window date "${d}" must be yyyy-mm-dd`, 400);
    if (!Number.isInteger(q) || q < 1) return apiError(`quantity for ${d} must be a whole number ≥ 1`, 400);
    if (seen.has(d)) return apiError(`duplicate window ${d}`, 400);
    seen.add(d);
    alloc.push({ windowDate: d, quantity: q });
  }

  // Frozen baseline total — cars must be conserved against the promise.
  let baselineTotal = 0;
  try {
    const rows = await db.all<{ total: number }>(
      sql`SELECT COALESCE(SUM(quantity), 0) AS total FROM po_delivery_baseline WHERE po_id = ${poId}`,
    );
    baselineTotal = Number(rows[0]?.total ?? 0);
  } catch {
    return apiError("Baseline table missing — run the PO delivery baseline migration first.", 409);
  }
  if (baselineTotal <= 0) {
    return apiError("This PO has no frozen baseline yet — run the PO delivery baseline migration.", 409);
  }
  const allocTotal = alloc.reduce((s, a) => s + a.quantity, 0);
  if (allocTotal !== baselineTotal) {
    return apiError(
      `Cars must stay balanced: this allocation totals ${allocTotal}, but the baseline is ${baselineTotal}.`,
      400,
    );
  }

  // Current working state.
  const waveRows = await db.select().from(waves).where(eq(waves.poId, poId));
  if (waveRows.length === 0) return apiError("PO has no delivery windows.", 409);
  const waveIds = waveRows.map((w) => w.id);
  const waveByDate = new Map(waveRows.map((w) => [w.availabilityDate, w]));

  const batchRows = await db.select().from(batches).where(inArray(batches.waveId, waveIds));
  if (batchRows.length === 0) return apiError("PO has no batches to redistribute.", 409);
  const batchesByWave = new Map<number, typeof batchRows>();
  for (const b of batchRows) {
    if (b.waveId == null) continue;
    const arr = batchesByWave.get(b.waveId) ?? [];
    arr.push(b);
    batchesByWave.set(b.waveId, arr);
  }

  // Multi-model guard (v1). Re-bucketing adjusts only a window's largest
  // batch, which silently picks which model moves AND breaks car
  // conservation when the move exceeds that batch. So any window holding
  // more than one batch (mixed models / splits) is unsafe — block the
  // whole PO until per-model redistribution lands.
  const multiBatchWave = waveRows.find((w) => (batchesByWave.get(w.id) ?? []).length > 1);
  if (multiBatchWave) {
    return apiError(
      `Window ${multiBatchWave.availabilityDate} holds multiple batches (mixed models or splits). `
      + "Per-model redistribution isn't supported yet — redistribution is disabled for this PO to keep car counts correct.",
      409,
    );
  }

  // "before" snapshot for the audit log.
  const before = waveRows.map((w) => ({
    windowDate: w.availabilityDate,
    quantity: (batchesByWave.get(w.id) ?? []).reduce((s, b) => s + b.requestedQuantity, 0),
  }));

  // Committed guard — a window can't drop below its VIN/delivered cars.
  for (const a of alloc) {
    const w = waveByDate.get(a.windowDate);
    if (!w) continue;
    const committed = (batchesByWave.get(w.id) ?? []).reduce(
      (s, b) => s + Math.max(b.deliveredQuantity ?? 0, b.vinsReceivedQuantity ?? 0), 0);
    if (a.quantity < committed) {
      return apiError(
        `Window ${a.windowDate} already has ${committed} car(s) committed (VINs/delivered) — can't reduce below that.`,
        409,
      );
    }
  }

  const template = batchRows[0];
  const waveActionTypes = await db.select().from(actionTypes).where(eq(actionTypes.scope, "wave"));
  const [deliveryType] = await db
    .select().from(actionTypes).where(eq(actionTypes.name, "Delivery")).limit(1);
  const nowIso = new Date().toISOString();

  await db.transaction(async (tx) => {
    for (const a of alloc) {
      const existing = waveByDate.get(a.windowDate);

      if (existing) {
        // Hit the target by adjusting this window's largest batch.
        const wbatches = (batchesByWave.get(existing.id) ?? [])
          .slice().sort((x, y) => y.requestedQuantity - x.requestedQuantity);
        const current = wbatches.reduce((s, b) => s + b.requestedQuantity, 0);
        const delta = a.quantity - current;
        if (delta !== 0 && wbatches.length > 0) {
          const primary = wbatches[0];
          const newQty = Math.max(0, primary.requestedQuantity + delta);
          await tx.update(batches)
            .set({ requestedQuantity: newQty, updatedAt: nowIso })
            .where(eq(batches.id, primary.id));
        }
        continue;
      }

      // New window — create a wave + cloned batch + fresh external actions.
      const [newWave] = await tx.insert(waves)
        .values({ poId, availabilityDate: a.windowDate })
        .returning({ id: waves.id });
      const newWaveId = newWave.id;

      const { id: _omitId, createdAt: _omitC, updatedAt: _omitU, ...clone } = template;
      const newCode = `${template.batchCode}-RW${a.windowDate.replace(/-/g, "")}`;
      const [newBatch] = await tx.insert(batches).values({
        ...clone,
        batchCode:                    newCode,
        waveId:                       newWaveId,
        requestedQuantity:            a.quantity,
        allocatedQuantity:            0,
        deliveredQuantity:            0,
        vinsReceivedQuantity:         0,
        dealerPromisedDeliveryDate:   a.windowDate,
        currentProjectedDeliveryDate: a.windowDate,
        closedAt:                     null,
        closureReason:                null,
        notes:                        `Redistributed window — ${reason}`,
      }).returning({ id: batches.id });
      const newBatchId = newBatch.id;

      const insertAction = async (scope: "wave" | "batch", scopeId: number, actionTypeId: number, deptId: number | null) => {
        try {
          await tx.insert(actionsTable).values({
            scope, scopeId, actionTypeId,
            departmentId: deptId ?? undefined,
            status: "waiting",
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/UNIQUE constraint failed|already exists/i.test(msg)) throw err;
        }
      };
      for (const at of waveActionTypes) {
        await insertAction("wave", newWaveId, at.id, at.defaultDepartmentId ?? null);
        await insertAction("batch", newBatchId, at.id, at.defaultDepartmentId ?? null);
      }
      if (deliveryType) {
        await insertAction("batch", newBatchId, deliveryType.id, deliveryType.defaultDepartmentId ?? null);
      }
    }
  });

  // Audit log — best-effort, tolerant of the un-migrated table.
  try {
    await db.run(sql`
      INSERT INTO po_redistribution_log (po_id, reason, before_json, after_json, redistributed_by)
      VALUES (${poId}, ${reason}, ${JSON.stringify(before)}, ${JSON.stringify(alloc)}, ${gate.user.username})
    `);
  } catch {
    /* log table not migrated — the redistribution still succeeded. */
  }

  return NextResponse.json({ ok: true, poId, allocation: alloc });
}

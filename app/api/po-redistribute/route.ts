/**
 * POST /api/po-redistribute — move cars of ONE model between a PO's
 * delivery windows (the "working allocation"). Per-model: each model is
 * redistributed and conserved independently, so windows holding multiple
 * models are handled correctly. The frozen baseline is never touched —
 * reliability is always scored against it.
 *
 * Admin-only. Body:
 *   { poId, model, year, allocation: [{ windowDate, quantity }], reason }
 *
 * Rules:
 *   - Cars of this model are conserved: Σ allocation.quantity must equal
 *     the model's frozen baseline total.
 *   - A (window × this model) can't be reduced below what's already
 *     committed (VINs received / delivered) for this model in that window.
 *   - A window date not present creates a NEW window (wave + cloned batch
 *     of this model + fresh external-phase action rows). An existing
 *     window without this model gets a new batch of this model.
 *   - Logged (who/when/why + before/after, scoped to the model).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { waves, batches, actions as actionsTable, actionTypes } from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

interface Body {
  poId: number;
  model: string;
  year: number;
  allocation: { windowDate: string; quantity: number }[];
  reason: string;
}

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["admin"]); // admin-only
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  const poId = Number(body?.poId);
  const model = typeof body?.model === "string" ? body.model : "";
  const year = Number(body?.year);
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  const rawAllocation = Array.isArray(body?.allocation) ? body!.allocation : [];

  if (!Number.isInteger(poId) || poId <= 0) return apiError("poId required", 400);
  if (!model || !Number.isInteger(year)) return apiError("model + year required", 400);
  if (!reason) return apiError("A reason is required", 400);
  if (rawAllocation.length === 0) return apiError("allocation required", 400);

  // Normalise + validate the requested allocation.
  const alloc: { windowDate: string; quantity: number }[] = [];
  const seen = new Set<string>();
  for (const a of rawAllocation) {
    const d = String(a?.windowDate ?? "");
    const q = Number(a?.quantity);
    if (!ISO.test(d)) return apiError(`window date "${d}" must be yyyy-mm-dd`, 400);
    // 0 is allowed — it empties this model's cars from the window (the
    // window is deleted if no model has cars left there).
    if (!Number.isInteger(q) || q < 0) return apiError(`quantity for ${d} must be a whole number ≥ 0`, 400);
    if (seen.has(d)) return apiError(`duplicate window ${d}`, 400);
    seen.add(d);
    alloc.push({ windowDate: d, quantity: q });
  }

  // This model's frozen baseline total — cars of this model are conserved.
  let baselineTotal = 0;
  try {
    const rows = await db.all<{ total: number }>(sql`
      SELECT COALESCE(SUM(quantity), 0) AS total
        FROM po_delivery_baseline_model
       WHERE po_id = ${poId} AND model = ${model} AND year = ${year}
    `);
    baselineTotal = Number(rows[0]?.total ?? 0);
  } catch {
    return apiError("Per-model baseline table missing — run the PO baseline (per-model) migration first.", 409);
  }
  if (baselineTotal <= 0) {
    return apiError(`No frozen baseline for ${model} ${year} on this PO — run the per-model baseline migration.`, 409);
  }
  const allocTotal = alloc.reduce((s, a) => s + a.quantity, 0);
  if (allocTotal !== baselineTotal) {
    return apiError(
      `${model} ${year} must stay balanced: this allocation totals ${allocTotal}, baseline is ${baselineTotal}.`,
      400,
    );
  }

  // Current working state for this PO.
  const waveRows = await db.select().from(waves).where(eq(waves.poId, poId));
  if (waveRows.length === 0) return apiError("PO has no delivery windows.", 409);
  const waveIds = waveRows.map((w) => w.id);
  const waveByDate = new Map(waveRows.map((w) => [w.availabilityDate, w]));

  const allBatchRows = await db.select().from(batches).where(inArray(batches.waveId, waveIds));
  // listed_quantity is off-schema → raw read, tolerant. Listed cars are
  // live in-app and can't be moved out from under customers, so they count
  // as committed alongside VINs/delivered in the shrink guards below.
  const listedByBatch = new Map<number, number>();
  if (allBatchRows.length > 0) {
    try {
      const lrows = await db.all<{ id: number; lq: number }>(sql`SELECT id, listed_quantity AS lq FROM batches WHERE id IN (${sql.join(allBatchRows.map((b) => sql`${b.id}`), sql`, `)})`);
      for (const r of lrows) listedByBatch.set(Number(r.id), Number(r.lq ?? 0));
    } catch { /* listed_quantity un-migrated — treat as 0 listed */ }
  }
  // Only this model's batches, grouped by wave.
  const modelBatchesByWave = new Map<number, typeof allBatchRows>();
  for (const b of allBatchRows) {
    if (b.waveId == null || b.model !== model || b.year !== year) continue;
    const arr = modelBatchesByWave.get(b.waveId) ?? [];
    arr.push(b);
    modelBatchesByWave.set(b.waveId, arr);
  }
  const template = allBatchRows.find((b) => b.model === model && b.year === year) ?? allBatchRows[0];
  if (!template) return apiError("PO has no batches to redistribute.", 409);

  // batch_code is UNIQUE. A cloned batch derives its code from the
  // template + window date, but that derivation is NOT collision-proof:
  // an earlier redistribution to the same window/model can already hold
  // that exact code, and re-running would violate the constraint (500).
  // Track every code in play (existing PO batches + ones we mint this
  // transaction) and disambiguate with a numeric suffix when needed.
  const usedBatchCodes = new Set<string>(allBatchRows.map((b) => b.batchCode));
  const uniqueBatchCode = (base: string): string => {
    if (!usedBatchCodes.has(base)) { usedBatchCodes.add(base); return base; }
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`;
      if (!usedBatchCodes.has(candidate)) { usedBatchCodes.add(candidate); return candidate; }
    }
  };

  // "before" snapshot (this model only) for the audit log.
  const before = waveRows
    .map((w) => ({
      windowDate: w.availabilityDate,
      quantity: (modelBatchesByWave.get(w.id) ?? []).reduce((s, b) => s + b.requestedQuantity, 0),
    }))
    .filter((r) => r.quantity > 0);

  // Delivered guard — a window can't drop below its DELIVERED cars: those
  // are done and can't move. VIN'd / listed cars MAY be moved (a delivery
  // window can change after VINs are assigned); the cars that move out
  // reset their VIN / listing status in the destination window.
  for (const a of alloc) {
    const w = waveByDate.get(a.windowDate);
    if (!w) continue;
    const delivered = (modelBatchesByWave.get(w.id) ?? []).reduce(
      (s, b) => s + (b.deliveredQuantity ?? 0), 0);
    if (a.quantity < delivered) {
      return apiError(
        `${model} in window ${a.windowDate} already has ${delivered} delivered car(s) — can't reduce below that.`,
        409,
      );
    }
  }

  const waveActionTypes = await db.select().from(actionTypes).where(eq(actionTypes.scope, "wave"));
  const [deliveryType] = await db
    .select().from(actionTypes).where(eq(actionTypes.name, "Delivery")).limit(1);
  const nowIso = new Date().toISOString();

  await db.transaction(async (tx) => {
    const insertAction = async (scope: "wave" | "batch", scopeId: number, actionTypeId: number, deptId: number | null) => {
      try {
        await tx.insert(actionsTable).values({ scope, scopeId, actionTypeId, departmentId: deptId ?? undefined, status: "waiting" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/UNIQUE constraint failed|already exists/i.test(msg)) throw err;
      }
    };
    const cloneBatchInto = async (waveId: number, qty: number) => {
      const { id: _omitId, createdAt: _omitC, updatedAt: _omitU, ...clone } = template;
      const date = waveRows.find((w) => w.id === waveId)?.availabilityDate ?? nowIso.slice(0, 10);
      const [nb] = await tx.insert(batches).values({
        ...clone,
        batchCode:                    uniqueBatchCode(`${template.batchCode}-RW${date.replace(/-/g, "")}`),
        waveId,
        requestedQuantity:            qty,
        allocatedQuantity:            0,
        deliveredQuantity:            0,
        vinsReceivedQuantity:         0,
        dealerPromisedDeliveryDate:   date,
        currentProjectedDeliveryDate: date,
        closedAt:                     null,
        closureReason:                null,
        // Cars moved to a new window start UN-listed — don't let the
        // spread inherit the template's app_listed_at (a listed batch is
        // listed for ITS window, not the destination). listed_quantity is
        // off-schema so it already defaults to 0; reset the binary flag to
        // match, then the destination window is re-listed on its own.
        appListedAt:                  null,
        notes:                        `Redistributed (${model} ${year}) — ${reason}`,
      }).returning({ id: batches.id });
      // Belt-and-braces: force listed_quantity to 0 on the clone (off-schema
      // → raw, tolerant) so a fresh window never appears partially listed.
      try { await tx.run(sql`UPDATE batches SET listed_quantity = 0 WHERE id = ${nb.id}`); } catch { /* un-migrated */ }
      for (const at of waveActionTypes) await insertAction("batch", nb.id, at.id, at.defaultDepartmentId ?? null);
      if (deliveryType) await insertAction("batch", nb.id, deliveryType.id, deliveryType.defaultDepartmentId ?? null);
    };

    const touchedWaveIds = new Set<number>();

    for (const a of alloc) {
      let wave = waveByDate.get(a.windowDate);

      // 0 = empty this model from the window — delete its batches (+ their
      // batch-scope actions). The delivered guard ensured no DELIVERED cars
      // are here; any VIN'd / listed cars reset (they move to another
      // window). The window itself is pruned below if no model has cars
      // left in it.
      if (a.quantity === 0) {
        if (!wave) continue;
        const mb = modelBatchesByWave.get(wave.id) ?? [];
        if (mb.length > 0) {
          const ids = mb.map((b) => b.id);
          await tx.delete(actionsTable).where(and(
            eq(actionsTable.scope, "batch"),
            inArray(actionsTable.scopeId, ids),
          ));
          await tx.delete(batches).where(inArray(batches.id, ids));
        }
        touchedWaveIds.add(wave.id);
        continue;
      }

      // Create a brand-new window (wave + its wave-scope actions) if needed.
      if (!wave) {
        const [nw] = await tx.insert(waves).values({ poId, availabilityDate: a.windowDate }).returning();
        wave = nw;
        waveByDate.set(a.windowDate, nw);
        for (const at of waveActionTypes) await insertAction("wave", nw.id, at.id, at.defaultDepartmentId ?? null);
      }
      touchedWaveIds.add(wave.id);

      const modelBatches = (modelBatchesByWave.get(wave.id) ?? [])
        .slice().sort((x, y) => y.requestedQuantity - x.requestedQuantity);
      const current = modelBatches.reduce((s, b) => s + b.requestedQuantity, 0);
      const delta = a.quantity - current;
      if (delta === 0) continue;

      if (delta > 0) {
        // Grow: add to the largest existing batch of this model, or make one.
        if (modelBatches.length > 0) {
          const primary = modelBatches[0];
          await tx.update(batches)
            .set({ requestedQuantity: primary.requestedQuantity + delta, updatedAt: nowIso })
            .where(eq(batches.id, primary.id));
        } else {
          await cloneBatchInto(wave.id, a.quantity);
        }
      } else {
        // Shrink: reduce largest-first, never below each batch's DELIVERED
        // count. When a batch drops below its VINs / listed cars, cap those
        // to the new size — the cars that moved out reset their VIN /
        // listing in the destination window (vins/listed ≤ requested).
        let need = -delta;
        for (const b of modelBatches) {
          if (need <= 0) break;
          const floor = b.deliveredQuantity ?? 0;
          const room = b.requestedQuantity - floor;
          const take = Math.min(Math.max(0, room), need);
          if (take > 0) {
            const newReq = b.requestedQuantity - take;
            const upd: { requestedQuantity: number; updatedAt: string; vinsReceivedQuantity?: number } =
              { requestedQuantity: newReq, updatedAt: nowIso };
            if ((b.vinsReceivedQuantity ?? 0) > newReq) upd.vinsReceivedQuantity = newReq;
            await tx.update(batches).set(upd).where(eq(batches.id, b.id));
            // listed_quantity is off-schema → cap via raw SQL, tolerant.
            if ((listedByBatch.get(b.id) ?? 0) > newReq) {
              try { await tx.run(sql`UPDATE batches SET listed_quantity = ${newReq} WHERE id = ${b.id}`); } catch { /* un-migrated */ }
            }
            need -= take;
          }
        }
      }
    }

    // Prune windows left with no batches at all (every model moved out).
    if (touchedWaveIds.size > 0) {
      const ids = Array.from(touchedWaveIds);
      const stillHaveBatches = await tx
        .select({ waveId: batches.waveId })
        .from(batches)
        .where(inArray(batches.waveId, ids));
      const live = new Set<number>();
      for (const r of stillHaveBatches) if (r.waveId != null) live.add(r.waveId);
      const emptyWaveIds = ids.filter((id) => !live.has(id));
      if (emptyWaveIds.length > 0) {
        await tx.delete(actionsTable).where(and(
          eq(actionsTable.scope, "wave"),
          inArray(actionsTable.scopeId, emptyWaveIds),
        ));
        await tx.delete(waves).where(inArray(waves.id, emptyWaveIds));
      }
    }
  });

  // Audit log — best-effort, tolerant of the un-migrated table.
  try {
    await db.run(sql`
      INSERT INTO po_redistribution_log (po_id, reason, before_json, after_json, redistributed_by)
      VALUES (${poId}, ${`[${model} ${year}] ${reason}`}, ${JSON.stringify(before)}, ${JSON.stringify(alloc)}, ${gate.user.username})
    `);
  } catch {
    /* log table not migrated — the redistribution still succeeded. */
  }

  return NextResponse.json({ ok: true, poId, model, year, allocation: alloc });
}

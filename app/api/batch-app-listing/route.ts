/**
 * POST /api/batch-app-listing — set the App Listing state on a single
 * batch. Supports PARTIAL listing: how many of the batch's cars are live.
 *
 * App Listing is a fixed system concept (not an action_type), stored as
 * `batches.app_listed_at` (when listing started) + `batches.listed_quantity`
 * (how many cars are live, 0..requested). Admin can't rename/misconfigure
 * it through Settings — same pattern as `batches.closedAt`.
 *
 * Body (one of):
 *   { batchId, listedQuantity }            // partial: 0..requested
 *   { batchId, appListedAt: string|null }  // legacy binary (all / none)
 *
 * Semantics:
 *   - listedQuantity > 0 → batch listed; app_listed_at kept (or stamped
 *     now / to the supplied value) so the "since listed" clock anchors.
 *   - listedQuantity = 0 → un-listed; app_listed_at cleared.
 *   - legacy appListedAt path mirrors listed_quantity to requested / 0 so
 *     the two never drift.
 *
 * Auth: ops + admin (same gate as /api/batch-action).
 */
import { eq, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { batches } from "@/lib/db/schema";
import { requireAuth } from "@/lib/api-auth";
import { checkBatchListingGate } from "@/lib/closure-gates";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;

  let body: { batchId?: number; appListedAt?: string | null; listedQuantity?: number | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const batchId = Number(body.batchId);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: "batchId required" }, { status: 400 });
  }

  const hasQty = body.listedQuantity !== undefined && body.listedQuantity !== null;
  let qty = 0;
  if (hasQty) {
    qty = Number(body.listedQuantity);
    if (!Number.isInteger(qty) || qty < 0) {
      return NextResponse.json({ error: "listedQuantity must be a whole number ≥ 0" }, { status: 400 });
    }
  }
  if (body.appListedAt !== null && body.appListedAt !== undefined) {
    if (Number.isNaN(new Date(body.appListedAt).getTime())) {
      return NextResponse.json({ error: "appListedAt must be an ISO datetime string or null" }, { status: 400 });
    }
  }

  const [batch] = await db
    .select({ id: batches.id, requestedQuantity: batches.requestedQuantity, appListedAt: batches.appListedAt })
    .from(batches).where(eq(batches.id, batchId)).limit(1);
  if (!batch) {
    return NextResponse.json({ error: `No batch with id ${batchId}` }, { status: 404 });
  }
  if (hasQty && qty > batch.requestedQuantity) {
    return NextResponse.json(
      { error: `listedQuantity (${qty}) can't exceed requested (${batch.requestedQuantity})` },
      { status: 400 },
    );
  }

  // Resolve the final (listed_quantity, app_listed_at) pair.
  let finalQty: number;
  let finalAppListedAt: string | null;
  if (hasQty) {
    finalQty = qty;
    finalAppListedAt = qty > 0
      ? (typeof body.appListedAt === "string" && body.appListedAt ? body.appListedAt : batch.appListedAt ?? new Date().toISOString())
      : null;
  } else {
    // Legacy binary path: app_listed_at drives, mirror the count.
    finalAppListedAt = body.appListedAt ?? null;
    finalQty = finalAppListedAt ? batch.requestedQuantity : 0;
  }
  const willBeListed = finalQty > 0;

  // Gate (G2): listing requires every Internal-Phase action on the parent
  // PO done/skipped. Un-listing (→ 0) bypasses — a corrective action.
  if (willBeListed) {
    const g = await checkBatchListingGate(db, batchId);
    if (!g.ok) {
      return NextResponse.json({ error: `Cannot mark as listed: ${g.reason}` }, { status: 409 });
    }
  }

  try {
    await db.update(batches)
      .set({ appListedAt: finalAppListedAt, updatedAt: new Date().toISOString() })
      .where(eq(batches.id, batchId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such column|has no column/i.test(msg)) {
      return NextResponse.json(
        { error: "batches.app_listed_at column doesn't exist yet. Run /api/admin/migrate-app-listing (admin)." },
        { status: 503 },
      );
    }
    throw err;
  }
  // listed_quantity is off-schema → raw SQL, tolerant of the un-migrated
  // column (the binary app_listed_at above still records the listing).
  try {
    await db.run(sql`UPDATE batches SET listed_quantity = ${finalQty} WHERE id = ${batchId}`);
  } catch { /* run ensure-listed-quantity-column to enable partial counts */ }

  return NextResponse.json({ ok: true, listedQuantity: finalQty, appListedAt: finalAppListedAt });
}

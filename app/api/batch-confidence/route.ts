/**
 * POST /api/batch-confidence — set Operations confidence on a batch.
 *
 * Body: { batchId: number, value: number }     // value 0–100
 *
 * Behaviour:
 *   - Live `operations_confidence` is updated every time.
 *   - `operations_confidence_at_lock` is set ONCE — on the first save —
 *     and never overwritten thereafter. That snapshot feeds the long-term
 *     "did Ops know it was going to slip?" analytic.
 *
 * (Partnership confidence is locked at Forecast submit, not here.)
 */
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { batches } from "@/lib/db/schema";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;

  let body: { batchId?: number; value?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const id = Number(body.batchId);
  const value = Number(body.value);
  if (!Number.isFinite(id) || !Number.isFinite(value) || value < 0 || value > 100) {
    return NextResponse.json(
      { error: "Body must be { batchId: number, value: number 0..100 }" },
      { status: 400 },
    );
  }

  const [batch] = await db.select().from(batches).where(eq(batches.id, id)).limit(1);
  if (!batch) {
    return NextResponse.json({ error: `No batch with id ${id}` }, { status: 404 });
  }

  const isFirstLock = batch.operationsConfidenceAtLock == null;
  const updates: Partial<typeof batches.$inferInsert> = {
    operationsConfidence: value,
    updatedAt: new Date().toISOString(),
  };
  if (isFirstLock) updates.operationsConfidenceAtLock = value;

  await db.update(batches).set(updates).where(eq(batches.id, id));

  return NextResponse.json({
    ok: true,
    batchId: id,
    operationsConfidence: value,
    operationsConfidenceAtLock: isFirstLock ? value : batch.operationsConfidenceAtLock,
    locked: !isFirstLock || true, // is now locked after this call
  });
}

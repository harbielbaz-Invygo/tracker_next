/**
 * POST /api/batch-close — close a batch as cancelled or delivered.
 *
 * Body:
 *   { batchId: number, reason: "cancelled", note?: string }
 *   { batchId: number, reason: "delivered" }   // typically auto-fired by /api/batch-action
 *
 * Behaviour:
 *   - Sets `closedAt = today`, `closureReason = …`, optional `cancellationNote`.
 *   - Idempotent — re-closing a batch that's already closed updates the
 *     reason and note (no-op if same).
 *   - Does NOT cascade to batch_actions. After closure, the Cockpit drawer
 *     simply hides the action editor; existing statuses remain in place
 *     for audit / reopening.
 */
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { batches } from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

interface CloseBody {
  batchId: number;
  reason: "cancelled" | "delivered";
  note?: string | null;
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

  const today = new Date().toISOString().slice(0, 10);
  await db.update(batches).set({
    closedAt:         today,
    closureReason:    body.reason,
    cancellationNote: body.reason === "cancelled" ? (body.note?.trim() || null) : null,
    updatedAt:        new Date().toISOString(),
  }).where(eq(batches.id, body.batchId));

  return NextResponse.json({
    ok: true,
    batchId: body.batchId,
    closedAt: today,
    closureReason: body.reason,
  });
}

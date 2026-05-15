/**
 * POST /api/forecast/cancel — cancel an open Forecast.
 *
 * Body: { batchId, reason? }
 *
 * Sets the underlying pre_po batch's closure fields:
 *   closedAt        = today
 *   closureReason   = "cancelled"
 *   cancellationNote = reason (optional)
 *
 * A cancelled Forecast counts as a *miss* in the per-submitter
 * reliability metrics (introduced in PR 4) — so this is a one-way door.
 */
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { batches, batchForecasts } from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["admin", "ops"]);
  if (!gate.ok) return gate.response;

  const body = await req.json().catch(() => null);
  const batchId = Number((body as Record<string, unknown> | null)?.batchId);
  const reason = (body as Record<string, unknown> | null)?.reason;
  if (!Number.isInteger(batchId) || batchId <= 0) return apiError("batchId required", 400);

  // Must be a Forecast batch (has a batch_forecasts row) and not already closed.
  const existing = await db
    .select({ id: batches.id, closedAt: batches.closedAt, lifecycle: batches.lifecycleState })
    .from(batches)
    .innerJoin(batchForecasts, eq(batchForecasts.batchId, batches.id))
    .where(eq(batches.id, batchId))
    .limit(1);
  if (existing.length === 0) return apiError("Not a Forecast batch", 404);
  if (existing[0].closedAt) return apiError("Already closed", 409);
  if (existing[0].lifecycle !== "pre_po") return apiError("Cannot cancel after PO has arrived", 409);

  const today = new Date().toISOString().slice(0, 10);
  await db.update(batches).set({
    closedAt: today,
    closureReason: "cancelled",
    cancellationNote: typeof reason === "string" && reason.trim() ? reason.trim() : null,
  }).where(eq(batches.id, batchId));

  return NextResponse.json({ ok: true });
}

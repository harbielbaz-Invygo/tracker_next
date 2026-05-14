/**
 * POST /api/vin-stage — update a single batch_vin_stages row.
 *
 * Body: {
 *   batchVinStageId: number,
 *   newStatus:       "waiting" | "done" | "skipped",
 *   newCompletedAt?: string|null,   // ISO datetime, only honoured when newStatus="done"
 * }
 *
 * Behaviour:
 *   - status = done   → completed_at = newCompletedAt ?? now
 *   - status ≠ done   → completed_at = null
 *
 * Unlike /api/batch-action, the VIN chase chain has no dependency DAG —
 * stages are strictly linear, and "blocked" doesn't exist as a status.
 * Reverting an earlier step doesn't auto-revert later ones; ops can do
 * that one stage at a time if they need to.
 *
 * Auth: ops + admin (same gate as /api/batch-action).
 */
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { batchVinStages } from "@/lib/db/schema";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";

const VALID = new Set(["waiting", "done", "skipped"] as const);
type Status = "waiting" | "done" | "skipped";

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;

  let body: {
    batchVinStageId?: number;
    newStatus?: Status;
    newCompletedAt?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const id = Number(body.batchVinStageId);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "batchVinStageId required" }, { status: 400 });
  }
  if (body.newStatus == null || !VALID.has(body.newStatus)) {
    return NextResponse.json(
      { error: "newStatus must be one of: waiting, done, skipped" },
      { status: 400 },
    );
  }

  const completedAt = body.newStatus === "done"
    ? (body.newCompletedAt ?? new Date().toISOString())
    : null;

  try {
    await db
      .update(batchVinStages)
      .set({
        status:      body.newStatus,
        completedAt,
        updatedAt:   new Date().toISOString(),
      })
      .where(eq(batchVinStages.id, id));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(msg)) {
      return NextResponse.json(
        {
          error:
            "batch_vin_stages table doesn't exist on this DB. Run the migration: " +
            "`npx tsx scripts/migrate-vin-stages.ts`.",
        },
        { status: 503 },
      );
    }
    throw err;
  }

  return NextResponse.json({ ok: true });
}

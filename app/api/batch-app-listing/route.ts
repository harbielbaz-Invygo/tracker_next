/**
 * POST /api/batch-app-listing — set or clear the App Listing
 * milestone on a single batch.
 *
 * App Listing is a fixed system concept (not an action_type), stored
 * as `batches.app_listed_at`. Admin can't rename, delete, or
 * misconfigure it through Settings — same pattern as `batches.closedAt`.
 *
 * Body: {
 *   batchId: number,
 *   appListedAt: string | null,   // ISO datetime; null to clear/un-list
 * }
 *
 * Behaviour:
 *   - non-null timestamp → batch listed (or relisted/edited timestamp)
 *   - null              → cleared (un-list)
 *
 * Auth: ops + admin (same gate as /api/batch-action).
 */
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { batches } from "@/lib/db/schema";
import { requireAuth } from "@/lib/api-auth";
import { checkBatchListingGate } from "@/lib/closure-gates";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;

  let body: { batchId?: number; appListedAt?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const batchId = Number(body.batchId);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: "batchId required" }, { status: 400 });
  }
  if (body.appListedAt !== null && body.appListedAt !== undefined) {
    // Sanity check the timestamp parses — otherwise we'd store garbage.
    const parsed = new Date(body.appListedAt);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        { error: "appListedAt must be an ISO datetime string or null" },
        { status: 400 },
      );
    }
  }

  // Server-side gate (G2): when SETTING appListedAt, require every
  // Internal-Phase action on the parent PO to be done or skipped.
  // Un-listing (null) bypasses — that's a corrective action ops
  // needs to be able to fire regardless of state.
  if (body.appListedAt) {
    const gate = await checkBatchListingGate(db, batchId);
    if (!gate.ok) {
      return NextResponse.json(
        { error: `Cannot mark as listed: ${gate.reason}` },
        { status: 409 },
      );
    }
  }

  try {
    const result = await db
      .update(batches)
      .set({
        appListedAt: body.appListedAt ?? null,
        updatedAt:   new Date().toISOString(),
      })
      .where(eq(batches.id, batchId))
      .returning({ id: batches.id });
    if (result.length === 0) {
      return NextResponse.json({ error: `No batch with id ${batchId}` }, { status: 404 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Defensive: production DB might not have the column yet (the
    // migration runs separately via /api/admin/migrate-app-listing).
    if (/no such column/i.test(msg) || /has no column/i.test(msg)) {
      return NextResponse.json(
        {
          error:
            "batches.app_listed_at column doesn't exist yet. Run the migration: " +
            "GET /api/admin/migrate-app-listing (admin only).",
        },
        { status: 503 },
      );
    }
    throw err;
  }

  return NextResponse.json({ ok: true });
}

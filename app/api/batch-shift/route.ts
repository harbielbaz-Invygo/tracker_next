/**
 * POST /api/batch-shift — apply a projected-availability-date shift.
 *
 * Body:
 *   {
 *     batchId: number,
 *     newProjectedDate: string,    // ISO yyyy-mm-dd
 *     bookingsAtShift?: number,    // default 0; ops's count at shift moment
 *     reason?: string | null,      // optional free-text "why"
 *   }
 *
 * Behaviour:
 *   - Reads the batch's CURRENT `currentProjectedDeliveryDate` as the
 *     "previous" value.
 *   - Computes signed delayDays = newProjectedDate − previousProjectedDate.
 *   - Inserts a row into `batch_date_revisions` (the per-event history).
 *   - Updates `batches.currentProjectedDeliveryDate` to the new value.
 *   - Increments `batches.deliveryDateRevisionCount` (kept in sync with
 *     row count for back-compat; reports will switch to deriving it).
 *   - Wraps everything in a transaction so partial state is impossible.
 *
 * Defensive: if `batch_date_revisions` table is missing (Phase A
 * migration not yet applied to this DB), still applies the projection
 * update and returns ok with a `warning` field so the UI can surface it.
 */
import { eq, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { batches, batchDateRevisions } from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

interface ShiftBody {
  batchId: number;
  newProjectedDate: string;
  bookingsAtShift?: number;
  reason?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime());
}
function daysBetween(later: string, earlier: string): number {
  return Math.round((new Date(later).getTime() - new Date(earlier).getTime()) / DAY_MS);
}
function isMissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table/i.test(msg);
}

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;

  let body: ShiftBody;
  try {
    body = (await req.json()) as ShiftBody;
  } catch {
    return apiError("Invalid JSON", 400);
  }

  if (!Number.isFinite(body.batchId)) return apiError("batchId required", 400);
  if (!body.newProjectedDate || !isIsoDate(body.newProjectedDate)) {
    return apiError("newProjectedDate must be yyyy-mm-dd", 400);
  }
  const bookings = Number.isFinite(body.bookingsAtShift)
    ? Math.max(0, Math.floor(body.bookingsAtShift!))
    : 0;
  const reason = body.reason?.trim() || null;

  // Fetch current state to compute the delta.
  const [current] = await db
    .select({
      previous:        batches.currentProjectedDeliveryDate,
      promised:        batches.dealerPromisedDeliveryDate,
      revisionCount:   batches.deliveryDateRevisionCount,
      closedAt:        batches.closedAt,
    })
    .from(batches)
    .where(eq(batches.id, body.batchId))
    .limit(1);

  if (!current) return apiError(`batch ${body.batchId} not found`, 404);
  if (current.closedAt) {
    return apiError("Cannot shift a closed batch", 409);
  }

  // Previous projection — fall back to dealer-promised when ops hasn't
  // set one yet (first shift after intake).
  const previous = current.previous ?? current.promised;
  const delayDays = daysBetween(body.newProjectedDate, previous);

  // No-op shifts (newDate === previous) are still recorded so the
  // bookings + reason fields capture intent, but with delayDays=0.

  let revisionsTableMissing = false;
  await db.transaction(async (tx) => {
    // 1. Write the revision row.
    try {
      await tx.insert(batchDateRevisions).values({
        batchId:               body.batchId,
        revisedBy:             gate.user.username,
        previousProjectedDate: previous,
        newProjectedDate:      body.newProjectedDate,
        delayDays,
        bookingsAtShift:       bookings,
        reason,
      });
    } catch (err) {
      if (isMissingTableError(err)) {
        // Migration not yet run — keep going, but flag back.
        // eslint-disable-next-line no-console
        console.warn("[batch-shift] batch_date_revisions table missing — skipping row write. Run `npm run db:push`.");
        revisionsTableMissing = true;
      } else {
        throw err;
      }
    }

    // 2. Apply the projection update + bump the counter.
    await tx.update(batches).set({
      currentProjectedDeliveryDate: body.newProjectedDate,
      deliveryDateRevisionCount: sql`${batches.deliveryDateRevisionCount} + 1`,
      updatedAt: new Date().toISOString(),
    }).where(eq(batches.id, body.batchId));
  });

  return NextResponse.json({
    ok: true,
    batchId:           body.batchId,
    previousProjectedDate: previous,
    newProjectedDate:  body.newProjectedDate,
    delayDays,
    bookingsAtShift:   bookings,
    reason,
    revisionCount:     (current.revisionCount ?? 0) + 1,
    ...(revisionsTableMissing
      ? { warning: "batch_date_revisions table missing — projection applied, revision row skipped. Run db migration." }
      : {}),
  });
}

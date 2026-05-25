/**
 * POST /api/forecast/update-bookings — adjust the running booking count
 * on a single Forecast row (one batch_delivery_legs entry).
 *
 * Body:
 *   {
 *     legId:    number,        // batch_delivery_legs.id
 *     // EITHER delta (relative bump, can be negative) OR value
 *     // (absolute set). delta is preferred — matches the ops
 *     // "+1 / -1" interaction in the pre-PO drawer.
 *     delta?:   number,
 *     value?:   number,
 *   }
 *
 * Enforces:
 *   • bookings_count never goes below 0 (clamps to 0 on negative deltas
 *     that would underflow).
 *   • Only callable while the parent batch is still in pre_po state.
 *     After the PO is signed and the batch flips to post_po, bookings
 *     should be tracked through the standard post-PO booking flow.
 *   • Caps at requestedQuantity — you can't book more cars than the
 *     row originally listed. UI shows a warning before allowing
 *     bookings = qty.
 *
 * The Action Center pre-PO drawer wires +/- buttons + a direct-set
 * input field at this endpoint.
 */
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { batchDeliveryLegs, batches } from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

interface Body {
  legId: number;
  delta?: number;
  value?: number;
}

function validate(body: unknown): { ok: true; data: Body } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, reason: "Missing body" };
  const b = body as Record<string, unknown>;
  if (typeof b.legId !== "number" || b.legId <= 0)
    return { ok: false, reason: "legId is required" };
  const hasDelta = typeof b.delta === "number" && Number.isFinite(b.delta);
  const hasValue = typeof b.value === "number" && Number.isFinite(b.value) && b.value >= 0;
  if (!hasDelta && !hasValue)
    return { ok: false, reason: "either delta or value is required" };
  return {
    ok: true,
    data: {
      legId: b.legId as number,
      delta: hasDelta ? (b.delta as number) : undefined,
      value: hasValue ? (b.value as number) : undefined,
    },
  };
}

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["admin", "ops"]);
  if (!gate.ok) return gate.response;

  const parsed = validate(await req.json().catch(() => null));
  if (!parsed.ok) return apiError(parsed.reason, 400);
  const { legId, delta, value } = parsed.data;

  // Load the leg + its parent batch. We need the batch's lifecycle
  // state to gate the mutation, and the leg's requestedQuantity to cap.
  let leg: { id: number; batchId: number; requestedQuantity: number; bookingsCount: number } | undefined;
  try {
    const rows = await db
      .select({
        id:                leg2col(batchDeliveryLegs.id),
        batchId:           batchDeliveryLegs.batchId,
        requestedQuantity: batchDeliveryLegs.requestedQuantity,
        bookingsCount:     batchDeliveryLegs.bookingsCount,
      })
      .from(batchDeliveryLegs)
      .where(eq(batchDeliveryLegs.id, legId))
      .limit(1);
    leg = rows[0];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such column/i.test(msg)) {
      return apiError(
        "bookings_count column missing — run `npm run db:push` to apply the Forecast pre-PO listing migration.",
        500,
      );
    }
    throw err;
  }
  if (!leg) return apiError("Unknown legId", 404);

  const [batch] = await db
    .select({ lifecycleState: batches.lifecycleState })
    .from(batches)
    .where(eq(batches.id, leg.batchId))
    .limit(1);
  if (!batch) return apiError("Parent batch missing", 404);
  if (batch.lifecycleState !== "pre_po") {
    return apiError(
      "Bookings can only be tracked on pre-PO Forecasts. After the PO arrives, use the post-PO booking flow.",
      409,
    );
  }

  // Compute the new bookings count. Clamp 0..requestedQuantity so the
  // UI's +/- bumps and any direct-set entries stay in a sensible range.
  const current = leg.bookingsCount ?? 0;
  const raw = value !== undefined ? value : current + (delta ?? 0);
  const next = Math.max(0, Math.min(leg.requestedQuantity, Math.round(raw)));

  await db
    .update(batchDeliveryLegs)
    .set({ bookingsCount: next })
    .where(eq(batchDeliveryLegs.id, legId));

  return NextResponse.json({
    legId,
    bookingsCount: next,
    requestedQuantity: leg.requestedQuantity,
  });
}

// Tiny alias so we can swap the id column reference without losing
// type narrowing in the select tuple above.
function leg2col<T>(col: T): T { return col; }

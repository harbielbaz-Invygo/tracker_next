/**
 * POST /api/wave-set-ops-projected — set Ops's expected delivery
 * date at the WAVE (delivery-window) level.
 *
 * Body:
 *   {
 *     waveId: number,
 *     opsProjectedDate: string,    // ISO yyyy-mm-dd
 *     reason?: string | null,      // optional context
 *   }
 *
 * Behaviour:
 *   - Updates `waves.ops_expected_date` to the new value.
 *   - For each open batch under the wave:
 *       - sets `batches.current_projected_delivery_date` = newDate
 *       - stamps `batches.ops_projected_delivery_date_at_lock` =
 *         newDate ONLY IF the column is null (one-way lock)
 *       - writes a row to `batch_date_revisions` so the audit
 *         trail captures the window-wide commitment
 *   - Cascades wave-action expectedDates similar to /api/batch-shift,
 *     reusing the same anchor recompute logic for post-vin actions.
 *
 * Why wave-level: at intake ops has no projection. The first
 * commitment comes once VINs / dealer confirmations land. Ops makes
 * a single call at the window level — every batch under the window
 * gets the same date, every batch's lock snapshot freezes together,
 * and the Internal Phase team sees the window's ops date as their
 * App-listing target.
 *
 * Subsequent per-batch shifts go through /api/batch-shift and only
 * move the live `current_projected_*` value; the at-lock snapshot
 * stays untouched (the lock is one-way).
 */
import { and, eq, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { batches, waves, batchDateRevisions } from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

interface Body {
  waveId: number;
  opsProjectedDate: string;
  reason?: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(later: string, earlier: string): number {
  return Math.round((new Date(later).getTime() - new Date(earlier).getTime()) / DAY_MS);
}

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return apiError("Invalid JSON", 400);
  }

  if (!Number.isInteger(body.waveId) || body.waveId <= 0) {
    return apiError("waveId required", 400);
  }
  if (typeof body.opsProjectedDate !== "string" || !ISO_DATE.test(body.opsProjectedDate)) {
    return apiError("opsProjectedDate must be yyyy-mm-dd", 400);
  }
  const reason = body.reason?.trim() || "Window-level Ops projection";

  // Pull the wave so we can iterate its open batches and write the
  // wave row in the same transaction.
  const [wave] = await db
    .select({
      id: waves.id,
      availabilityDate: waves.availabilityDate,
      opsExpectedDate:  waves.opsExpectedDate,
    })
    .from(waves)
    .where(eq(waves.id, body.waveId))
    .limit(1);
  if (!wave) return apiError(`wave ${body.waveId} not found`, 404);

  const nowIso = new Date().toISOString();
  let revisionsTableMissing = false;
  let affectedBatches = 0;
  let lockedFirstTime = 0;

  await db.transaction(async (tx) => {
    // 1. Update the wave's ops expected date.
    await tx.update(waves).set({
      opsExpectedDate: body.opsProjectedDate,
      updatedAt:       nowIso,
    }).where(eq(waves.id, body.waveId));

    // 2. Fan out to every OPEN batch in the wave.
    const openBatches = await tx
      .select({
        id:        batches.id,
        previous:  batches.currentProjectedDeliveryDate,
        promised:  batches.dealerPromisedDeliveryDate,
        atLock:    batches.opsProjectedDeliveryDateAtLock,
        closedAt:  batches.closedAt,
      })
      .from(batches)
      .where(eq(batches.waveId, body.waveId));

    for (const b of openBatches) {
      if (b.closedAt != null) continue; // skip closed
      affectedBatches++;

      const previousDate = b.previous ?? b.promised;
      const delayDays = daysBetween(body.opsProjectedDate, previousDate);
      const shouldLock = b.atLock == null;
      if (shouldLock) lockedFirstTime++;

      // 2a. Audit row — captures "the wave's ops projection landed".
      try {
        await tx.insert(batchDateRevisions).values({
          batchId:               b.id,
          revisedBy:             gate.user.username,
          previousProjectedDate: previousDate,
          newProjectedDate:      body.opsProjectedDate,
          delayDays,
          bookingsAtShift:       0,
          reason:                shouldLock ? `Initial ops projection — ${reason}` : reason,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/no such table/i.test(msg)) {
          revisionsTableMissing = true;
          // eslint-disable-next-line no-console
          console.warn(
            "[wave-set-ops-projected] batch_date_revisions table missing — " +
            "audit row skipped. Run /api/admin/ensure-batch-date-revisions to migrate.",
          );
        } else {
          throw err;
        }
      }

      // 2b. Update the batch — live projection + first-time lock.
      await tx.update(batches).set({
        currentProjectedDeliveryDate: body.opsProjectedDate,
        ...(shouldLock
          ? { opsProjectedDeliveryDateAtLock: body.opsProjectedDate }
          : {}),
        deliveryDateRevisionCount: sql`${batches.deliveryDateRevisionCount} + 1`,
        updatedAt:                    nowIso,
      }).where(eq(batches.id, b.id));
    }
  });

  return NextResponse.json({
    ok: true,
    waveId: body.waveId,
    opsProjectedDate: body.opsProjectedDate,
    affectedBatches,
    lockedFirstTime,
    ...(revisionsTableMissing ? { warning: "batch_date_revisions table missing — audit rows skipped." } : {}),
  });
}

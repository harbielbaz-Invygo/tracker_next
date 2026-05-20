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
import { and, eq, inArray, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { batches, batchDateRevisions, waves, actions as actionsTable, actionTypes } from "@/lib/db/schema";
import { computeExpectedDate } from "@/lib/expected-date";
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

  // Fetch current state to compute the delta + drive wave moves.
  // The previous wave's id + its availabilityDate together decide
  // whether this shift just changes the projection (same window) or
  // moves the batch to a different delivery window (new date).
  const [current] = await db
    .select({
      previous:        batches.currentProjectedDeliveryDate,
      promised:        batches.dealerPromisedDeliveryDate,
      revisionCount:   batches.deliveryDateRevisionCount,
      closedAt:        batches.closedAt,
      waveId:          batches.waveId,
      poNumber:        batches.poNumber,
      opsAtLock:       batches.opsProjectedDeliveryDateAtLock,
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
  // First-time ops projection lock — capture the FIRST date ops
  // commits to so accuracy (initial vs final) can be measured. Lock
  // is one-way: once set, future shifts only move `current_projected_*`
  // and the at-lock snapshot stays untouched. Read independently from
  // the action-level "backdate completion" feature — that edits a
  // batch_action's completedAt and never touches this field.
  const lockOpsProjection = current.opsAtLock == null;

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

    // 2. Apply the projection + promise updates + bump the counter.
    // We move the canonical "what date is this batch tracking" by
    // updating BOTH projection and promise — the wave's date IS the
    // batch's commitment date in the new model.
    //
    // On the first shift for this batch we also stamp
    // `ops_projected_delivery_date_at_lock` — the locked snapshot
    // captures the FIRST ops commitment so accuracy is measurable
    // against the operator's initial bet, not their final revision.
    await tx.update(batches).set({
      currentProjectedDeliveryDate: body.newProjectedDate,
      dealerPromisedDeliveryDate:   body.newProjectedDate,
      deliveryDateRevisionCount: sql`${batches.deliveryDateRevisionCount} + 1`,
      ...(lockOpsProjection
        ? { opsProjectedDeliveryDateAtLock: body.newProjectedDate }
        : {}),
      updatedAt: new Date().toISOString(),
    }).where(eq(batches.id, body.batchId));

    // 3. Wave move semantics.
    //
    // Each delivery window (= wave row) is keyed by (po, date). When
    // the batch's shifted date no longer matches its current wave's
    // date, the batch moves OUT of that wave into a wave with the
    // new date — creating a new wave under the same PO when one
    // doesn't already exist.
    //
    // The OLD wave's wave-scope actions stay where they are (history
    // is preserved). The batch carries its batch-scope copies with
    // it via the foreign-key on actions.scope_id.
    if (current.waveId != null) {
      const oldWaveId = current.waveId;
      const [oldWaveRow] = await tx
        .select({ id: waves.id, poId: waves.poId, availabilityDate: waves.availabilityDate })
        .from(waves).where(eq(waves.id, oldWaveId)).limit(1);

      if (oldWaveRow && oldWaveRow.availabilityDate !== body.newProjectedDate) {
        // Window-move path: find or create the target window.
        const [existingTarget] = await tx
          .select({ id: waves.id })
          .from(waves)
          .where(and(
            eq(waves.poId, oldWaveRow.poId),
            eq(waves.availabilityDate, body.newProjectedDate),
          ))
          .limit(1);

        let targetWaveId: number;
        if (existingTarget) {
          targetWaveId = existingTarget.id;
        } else {
          const [created] = await tx.insert(waves).values({
            poId:             oldWaveRow.poId,
            availabilityDate: body.newProjectedDate,
            opsExpectedDate:  body.newProjectedDate,
            vinReceivedAtIntake: false,
          }).returning({ id: waves.id });
          targetWaveId = created.id;

          // Auto-attach a wave-scope row for every wave-scope
          // action_type so the new window has its full External-Phase
          // action set from creation. Mirrors the intake flow.
          const waveActionTypes = await tx
            .select({
              id:                  actionTypes.id,
              offsetDays:          actionTypes.offsetDays,
              offsetAnchor:        actionTypes.offsetAnchor,
              defaultDepartmentId: actionTypes.defaultDepartmentId,
            })
            .from(actionTypes)
            .where(eq(actionTypes.scope, "wave"));
          for (const at of waveActionTypes) {
            const expected = computeExpectedDate({
              anchor:     at.offsetAnchor,
              offsetDays: at.offsetDays,
              submission: new Date().toISOString().slice(0, 10),
              vin:        null,
              promised:   body.newProjectedDate,
            });
            try {
              await tx.insert(actionsTable).values({
                scope:        "wave",
                scopeId:      targetWaveId,
                actionTypeId: at.id,
                departmentId: at.defaultDepartmentId ?? undefined,
                status:       "waiting",
                expectedDate: expected ?? undefined,
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (!/UNIQUE constraint failed|already exists/i.test(msg)) throw err;
            }
          }
        }

        // Move the batch.
        await tx.update(batches).set({
          waveId:    targetWaveId,
          updatedAt: new Date().toISOString(),
        }).where(eq(batches.id, body.batchId));

        // Recompute the OLD wave's opsExpectedDate based on whatever
        // batches still remain under it — OR delete the wave entirely
        // when nothing's left. Wave-scope actions on the empty wave
        // have to go with it (actions.scope_id is an integer FK with
        // no cascade), so we drop them in the same transaction.
        const remaining = await tx
          .select({
            projection: batches.currentProjectedDeliveryDate,
            promised:   batches.dealerPromisedDeliveryDate,
          })
          .from(batches)
          .where(eq(batches.waveId, oldWaveId));
        if (remaining.length === 0) {
          // Empty → prune. The batch's audit trail in
          // batch_date_revisions survives (batchId, not waveId), so
          // the Shift History on the destination window still shows
          // the move out of this date.
          await tx.delete(actionsTable).where(and(
            eq(actionsTable.scope, "wave"),
            eq(actionsTable.scopeId, oldWaveId),
          ));
          await tx.delete(waves).where(eq(waves.id, oldWaveId));
        } else {
          const remainingDates = remaining
            .map((r) => r.projection ?? r.promised)
            .filter(Boolean) as string[];
          const oldOps = remainingDates.length > 0
            ? remainingDates.sort().at(-1)!
            : oldWaveRow.availabilityDate;
          await tx.update(waves).set({
            opsExpectedDate: oldOps,
            updatedAt:       new Date().toISOString(),
          }).where(eq(waves.id, oldWaveId));
        }
      } else if (oldWaveRow) {
        // Same-window path: only the batch's own projection moved.
        // Bring the wave's opsExpectedDate in line with the slowest
        // batch under it (existing recompute), AND slide every non-
        // settled wave-scope action's expectedDate by the delta —
        // preserves the historic propagation behaviour for the
        // common "same date, just bumping projection" case.
        const allBatchesProjections = await tx
          .select({
            projection: batches.currentProjectedDeliveryDate,
            promised:   batches.dealerPromisedDeliveryDate,
          })
          .from(batches)
          .where(eq(batches.waveId, oldWaveId));
        const effectiveDates = allBatchesProjections
          .map((b) => b.projection ?? b.promised)
          .filter(Boolean) as string[];
        const newWaveOps = effectiveDates.length > 0
          ? effectiveDates.sort().at(-1)!
          : oldWaveRow.availabilityDate;
        const [{ opsExpectedDate: prevOpsRaw }] = await tx
          .select({ opsExpectedDate: waves.opsExpectedDate })
          .from(waves).where(eq(waves.id, oldWaveId)).limit(1);
        const prevWaveOps = prevOpsRaw ?? oldWaveRow.availabilityDate;
        if (newWaveOps !== prevWaveOps) {
          const waveDelta = daysBetween(newWaveOps, prevWaveOps);
          await tx.update(waves).set({
            opsExpectedDate: newWaveOps,
            updatedAt:       new Date().toISOString(),
          }).where(eq(waves.id, oldWaveId));

          if (waveDelta !== 0) {
            const waveActions = await tx
              .select({ id: actionsTable.id, expectedDate: actionsTable.expectedDate })
              .from(actionsTable)
              .where(and(
                eq(actionsTable.scope, "wave"),
                eq(actionsTable.scopeId, oldWaveId),
                inArray(actionsTable.status, ["waiting", "blocked"]),
              ));
            for (const a of waveActions) {
              if (!a.expectedDate) continue;
              const shifted = new Date(new Date(a.expectedDate).getTime() + waveDelta * DAY_MS)
                .toISOString().slice(0, 10);
              await tx.update(actionsTable).set({
                expectedDate: shifted,
                updatedAt:    new Date().toISOString(),
              }).where(eq(actionsTable.id, a.id));
            }
          }
        }
      }
    }
  });
  // Silence unused-import lint until the next time we wire this.
  void current.poNumber;

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

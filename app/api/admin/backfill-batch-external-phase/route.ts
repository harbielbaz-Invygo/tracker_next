/**
 * POST /api/admin/backfill-batch-external-phase
 *
 * Per-batch External-Phase rollout backfill. Now that every batch
 * carries its own copy of each wave-scope action_type (so ops can
 * tick "VIN" per-batch instead of only at the window level), batches
 * that were created BEFORE the rollout don't have those batch-scope
 * rows yet. This admin endpoint walks every batch and ensures the
 * full set of batch-scope External-Phase actions exists.
 *
 * Idempotent — the (scope, scope_id, action_type_id) UNIQUE index on
 * `actions` catches duplicate inserts. Safe to re-run.
 *
 * GET  → dry-run report (counts + sample batch codes)
 * POST → perform the backfill
 *
 * Admin-only. Will be removed once the rollout is confirmed in prod.
 */
import { eq, and, inArray, isNotNull } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  batches, actions as actionsTable, actionTypes,
} from "@/lib/db/schema";
import { computeExpectedDate } from "@/lib/expected-date";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

interface BackfillReport {
  batchesScanned: number;
  externalActionTypeCount: number;
  /** How many (batch, action_type) pairs DIDN'T already exist as
   *  batch-scope rows when we started — the work the backfill does. */
  missingRowCount: number;
  /** Sample batchCodes that needed at least one row attached (≤ 50). */
  sampleBatchCodes: string[];
  inserted: number;
  dryRun: boolean;
}

async function buildReport(write: boolean): Promise<BackfillReport> {
  const allBatches = await db
    .select({
      id:                          batches.id,
      batchCode:                   batches.batchCode,
      dealerPromisedDeliveryDate:  batches.dealerPromisedDeliveryDate,
      requestedAt:                 batches.requestedAt,
    })
    .from(batches)
    .where(isNotNull(batches.waveId)); // only scope-aware batches

  const externalActionTypes = await db
    .select({
      id:                  actionTypes.id,
      offsetDays:          actionTypes.offsetDays,
      offsetAnchor:        actionTypes.offsetAnchor,
      defaultDepartmentId: actionTypes.defaultDepartmentId,
    })
    .from(actionTypes)
    .where(eq(actionTypes.scope, "wave"));

  // Existing batch-scope rows for the external action_types — used
  // to detect what's already in place per batch.
  const existing = externalActionTypes.length === 0 || allBatches.length === 0
    ? []
    : await db
        .select({
          scopeId:      actionsTable.scopeId,
          actionTypeId: actionsTable.actionTypeId,
        })
        .from(actionsTable)
        .where(and(
          eq(actionsTable.scope, "batch"),
          inArray(actionsTable.actionTypeId, externalActionTypes.map((t) => t.id)),
        ));
  const existingKey = new Set(existing.map((r) => `${r.scopeId}:${r.actionTypeId}`));

  const missingPairs: { batchId: number; batchCode: string; promised: string; submission: string; type: typeof externalActionTypes[number] }[] = [];
  for (const b of allBatches) {
    for (const t of externalActionTypes) {
      const key = `${b.id}:${t.id}`;
      if (existingKey.has(key)) continue;
      missingPairs.push({
        batchId:    b.id,
        batchCode:  b.batchCode,
        promised:   b.dealerPromisedDeliveryDate,
        submission: b.requestedAt,
        type:       t,
      });
    }
  }

  const sampleBatchCodes = Array.from(
    new Set(missingPairs.slice(0, 50).map((p) => p.batchCode)),
  );

  let inserted = 0;
  if (write && missingPairs.length > 0) {
    for (const p of missingPairs) {
      const expected = computeExpectedDate({
        anchor:     p.type.offsetAnchor,
        offsetDays: p.type.offsetDays,
        submission: p.submission,
        vin:        null,
        promised:   p.promised,
      });
      try {
        await db.insert(actionsTable).values({
          scope:        "batch",
          scopeId:      p.batchId,
          actionTypeId: p.type.id,
          departmentId: p.type.defaultDepartmentId ?? undefined,
          status:       "waiting",
          expectedDate: expected ?? undefined,
        });
        inserted++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // UNIQUE violation = already exists (race or re-run). Anything
        // else is a real problem — bubble up so admin sees it.
        if (!/UNIQUE constraint failed|already exists/i.test(msg)) {
          throw err;
        }
      }
    }
  }

  return {
    batchesScanned:           allBatches.length,
    externalActionTypeCount:  externalActionTypes.length,
    missingRowCount:          missingPairs.length,
    sampleBatchCodes,
    inserted,
    dryRun:                   !write,
  };
}

export async function GET() {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  const report = await buildReport(false);
  return NextResponse.json({ ok: true, ...report });
}

export async function POST(_req: NextRequest) {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  try {
    const report = await buildReport(true);
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return apiError(`Backfill failed: ${msg}`, 500);
  }
}

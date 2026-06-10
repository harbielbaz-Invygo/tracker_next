/**
 * GET/POST /api/admin/backfill-vin-anchored-dates
 *
 * One-off backfill: populate the `expectedDate` of scope-aware
 * vin-anchored actions (Plate, Customs/Insurance, Tracking, Inspection,
 * Showroom Ready …) for batches/waves whose "VIN" action is already done.
 *
 * Why it's needed: intake creates vin-anchored actions with
 * expectedDate=null (the VIN date isn't known yet) and, until now, the
 * scope-aware path never re-anchored them once the VIN landed. So every
 * pre-existing closed PO has vin-anchored steps with no planned date —
 * they show up on the performance panels as "N done" with no on-time %,
 * because actions without a planned date are excluded from the rate.
 *
 * This walks every done "VIN" action and re-anchors that batch's (or
 * wave's) vin-anchored steps to the VIN's actual completion date — making
 * those historical steps measurable. Idempotent: re-running just rewrites
 * the same dates.
 *
 * GET  → dry-run report (how many batches/waves qualify, how many
 *        vin-anchored actions still have a null planned date).
 * POST → perform the backfill.
 *
 * Admin-only.
 */
import { and, eq, inArray, isNull, isNotNull } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { actions as actionsTable, actionTypes } from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";
import { reanchorVinAnchoredActions } from "@/lib/vin-reanchor";

export const runtime = "nodejs";

interface BackfillReport {
  vinActionTypeFound: boolean;
  vinAnchoredActionTypes: number;
  batchesWithDoneVin: number;
  wavesWithDoneVin: number;
  /** vin-anchored actions that currently have NO planned date (the gap). */
  actionsMissingPlannedDate: number;
  /** Action rows actually re-anchored (0 on a dry run). */
  actionsReanchored: number;
  dryRun: boolean;
}

async function buildReport(write: boolean): Promise<BackfillReport> {
  // The "VIN" action type(s) by name — the trigger that reveals the date.
  const vinNamed = await db
    .select({ id: actionTypes.id })
    .from(actionTypes)
    .where(eq(actionTypes.name, "VIN"));
  const vinNamedIds = vinNamed.map((t) => t.id);

  // vin-ANCHORED action types — the downstream steps we re-date.
  const vinAnchored = await db
    .select({ id: actionTypes.id })
    .from(actionTypes)
    .where(eq(actionTypes.offsetAnchor, "vin"));
  const vinAnchoredIds = vinAnchored.map((t) => t.id);

  if (vinNamedIds.length === 0 || vinAnchoredIds.length === 0) {
    return {
      vinActionTypeFound: vinNamedIds.length > 0,
      vinAnchoredActionTypes: vinAnchoredIds.length,
      batchesWithDoneVin: 0,
      wavesWithDoneVin: 0,
      actionsMissingPlannedDate: 0,
      actionsReanchored: 0,
      dryRun: !write,
    };
  }

  // Done VIN actions (any scope) with a completion timestamp.
  const doneVin = await db
    .select({
      scope: actionsTable.scope,
      scopeId: actionsTable.scopeId,
      completedAt: actionsTable.completedAt,
    })
    .from(actionsTable)
    .where(and(
      inArray(actionsTable.actionTypeId, vinNamedIds),
      eq(actionsTable.status, "done"),
      isNotNull(actionsTable.completedAt),
    ));

  const batchVin = doneVin.filter((r) => r.scope === "batch" && r.completedAt);
  const waveVin = doneVin.filter((r) => r.scope === "wave" && r.completedAt);

  // How many vin-anchored actions still have no planned date at all.
  const missing = await db
    .select({ id: actionsTable.id })
    .from(actionsTable)
    .where(and(
      inArray(actionsTable.actionTypeId, vinAnchoredIds),
      isNull(actionsTable.expectedDate),
    ));

  let actionsReanchored = 0;
  if (write && (batchVin.length > 0 || waveVin.length > 0)) {
    await db.transaction(async (tx) => {
      for (const r of batchVin) {
        actionsReanchored += await reanchorVinAnchoredActions(tx, {
          batchIds: [r.scopeId],
          actualVinDate: r.completedAt!.slice(0, 10),
          includeDone: true,
        });
      }
      for (const r of waveVin) {
        actionsReanchored += await reanchorVinAnchoredActions(tx, {
          waveIds: [r.scopeId],
          actualVinDate: r.completedAt!.slice(0, 10),
          includeDone: true,
        });
      }
    });
  }

  return {
    vinActionTypeFound: true,
    vinAnchoredActionTypes: vinAnchoredIds.length,
    batchesWithDoneVin: batchVin.length,
    wavesWithDoneVin: waveVin.length,
    actionsMissingPlannedDate: missing.length,
    actionsReanchored,
    dryRun: !write,
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

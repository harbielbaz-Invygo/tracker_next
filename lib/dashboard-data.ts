/**
 * Dashboard data layer.
 *
 * Server-side queries + display-row computation for the Dashboard view.
 * Mirrors `tracker_v1/dashboard.py:_batch_table_row` and `_classify_status`,
 * but pre-flattened so the table component can render without re-querying.
 */
import { db } from "@/lib/db";
import {
  batches, dealers, batchActions, actionTypes, departments, stakeholders,
  vinChaseStages, batchVinStages,
  // Phase 4a — read scope-aware actions for new batches (wave_id set).
  // The legacy reads stay in place for old batches; the two sets are
  // unioned, not replaced, until Phase 5 drops the legacy tables.
  waves, actions as actionsTable,
} from "@/lib/db/schema";
import { eq, desc, and, asc, gte, or, isNull, sql, inArray } from "drizzle-orm";
import type { ReportPeriod } from "./reports-period";

/**
 * Compute the inclusive lower-bound ISO date for a given period.
 * Returns null for "all" — caller should treat that as "no filter".
 * Duplicated from reports-data.ts so dashboard-data can stay
 * self-contained without circular imports.
 */
function fromIsoForPeriod(period: ReportPeriod): string | null {
  if (period === "all") return null;
  const days = { "30d": 30, "90d": 90, "6m": 183 }[period];
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ──────────────────────────────────────────────────────────────────
// Display types
// ──────────────────────────────────────────────────────────────────

/** Status bucket used both for the table chip and the status filter. */
export type StatusBucket = "on_track" | "ahead" | "delayed" | "delivered";

/** One row in the requests table. All values are pre-formatted for display. */
export interface DashboardRow {
  /* Identity */
  batchCode: string;
  poNumber: string | null;

  /* Vehicle */
  dealerName: string;
  modelYear: string;          // e.g. "Sonata 2026" or "—"
  quantity: number;
  colors: string;             // raw text or ""

  /* Dates */
  requestedAt: string;        // ISO
  promisedDate: string;       // ISO

  /* Stage / lifecycle */
  stage: string;              // raw stage code
  stageDisplay: string;       // titleized

  /* Status presentation */
  poStatusLabel: string;      // "✅ 2025-04-12" / "⚠️ Overdue 3d" / "🟢 due in 5d" / "—"
  deliveryStatusLabel: string;
  status: StatusBucket;
  statusLabel: string;        // "🟢 On track" etc.
  delayDays: number;          // signed; positive = late

  /* Risk + confidence */
  risk: number;
  confidenceLabel: string;    // "60% / 45%"

  /**
   * VIN phase — the pivot between uncertain and execution zones.
   *  - `pre_vin`  = VIN not yet confirmed by dealer → HIGH RISK zone.
   *  - `post_vin` = VIN received → EXECUTION zone (predictable lead time).
   */
  vinPhase: "pre_vin" | "post_vin";

  /**
   * Days from today to the effective availability date.
   * Positive = future, negative = overdue, null = delivered batch.
   * Uses `currentProjectedDeliveryDate` when set, else `dealerPromisedDeliveryDate`.
   */
  daysToAvailability: number | null;
}

/** Plan-vs-Reality timeline data — used by the SVG renderer. */
export interface TimelineData {
  batchCode: string;
  modelYear: string;
  dealerName: string;
  quantity: number;
  stageDisplay: string;

  /* Plan track */
  planRequested: string;
  planExpectedPo: string | null;
  planPromised: string;

  /**
   * Date the dealer issued the PO (parsed from the PDF). Drawn as a
   * tick on the Reality track BEFORE Submitted when there's a
   * pre-tracking gap. `null` when no PO date is known (e.g. Pre-PO bets).
   */
  poIssuedDate: string | null;
  /**
   * Days lost between PO issuance and our upload. 0 when poDate >= requestedAt
   * (we uploaded same-day or anticipated). Positive when there was lag.
   */
  preTrackingGapDays: number;

  /* Reality track */
  realityRequested: string;
  realityActualPo: string | null;
  /**
   * The end-of-Reality marker.
   *   - When the batch is closed → `closedAt` (the Actual Availability Date).
   *     Label is "Actual Availability Date" (delivered) or "Cancelled".
   *   - When the batch is open → today's projection. Label "Projected".
   *   - When neither is available → null.
   */
  realityDelivery: string | null;
  realityDeliveryLabel: "Actual Availability Date" | "Cancelled" | "Projected" | null;
  /**
   * Every completed batch_action becomes a tick on the Reality track,
   * sourced from `batch_actions.completedAt` (date-only). Sorted ascending.
   * The `Delivery` action is excluded — it's the canonical "Delivered"
   * marker, rendered separately as `realityDelivery`.
   *
   * `delayDays` = completed − expected (signed). 0 when on time or when
   * the action had no `expectedDate` set.
   */
  realityActions: { date: string; label: string; delayDays: number }[];

  /* Delay measurements (signed; positive = late) */
  poDelayDays: number | null;
  deliveryDelayDays: number | null;

  /* Header chips */
  poStatusLabel: string;
  deliveryStatusLabel: string;
  overallStatusLabel: string;

  /**
   * Full activity list — every batch_action on this batch with its
   * owner, planned date (`expectedDate`), actual completion, and signed
   * delay. Drives the activity table shown under the Plan vs Reality
   * SVG. Sorted chronologically by expected date (null expected last,
   * with skipped at the very end).
   */
  activity: TimelineActivity[];
}

/** One row in the activity table under the Plan vs Reality SVG. */
export interface TimelineActivity {
  /** Stable action_types.name — the canonical key (e.g. "VIN"). */
  actionTypeName: string;
  /** Display label, swapped to done_label when status === "done". */
  actionLabel: string;
  status: "waiting" | "blocked" | "done" | "skipped";
  /** Department that owns the action, or null when unassigned. */
  departmentName: string | null;
  /** Specific stakeholder picked for the action, or null. */
  stakeholderName: string | null;
  /** ISO yyyy-mm-dd planned date. Null when no expected date is set. */
  expectedDate: string | null;
  /**
   * Full ISO datetime of actual completion (e.g. `2026-05-11T14:32:00.000Z`).
   * Null when still open. UI renders in local time. The day-based delay
   * math uses only the date portion.
   */
  completedAt: string | null;
  /**
   * Signed delay in days vs the expected date.
   *   - `done` action with both dates → completedAt − expectedDate.
   *   - `waiting`/`blocked` action with expectedDate in the past → today − expectedDate (positive).
   *   - Otherwise → null (no delay calculable).
   */
  delayDays: number | null;
  notes: string | null;
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / DAY_MS);
}

function daysFromToday(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(iso).getTime() - today.getTime()) / DAY_MS);
}

function stageDisplay(code: string | null | undefined): string {
  if (!code) return "—";
  return code
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ──────────────────────────────────────────────────────────────────
// Public queries
// ──────────────────────────────────────────────────────────────────

/**
 * Return one DashboardRow per batch, ordered most-recently-requested first.
 *
 * Sources the "Delivered" date from the canonical `Delivery` action's
 * `completed_at`. Falls back to scanning every completed batch_action
 * with the canonical name "Delivery" — the seed/Settings always uses
 * that name as the action_type identity for the final hand-off.
 */
export async function getDashboardRows(period: ReportPeriod = "all"): Promise<DashboardRow[]> {
  const fromIso = fromIsoForPeriod(period);
  // Same period semantics as Reports: open batches always show
  // (current state), closed batches must have closedAt within the
  // window. Filters at the DB layer so the dashboard row count
  // matches the metric tiles exactly.
  const rowsQuery = db
    .select({
      b: batches,
      dealerName: dealers.name,
    })
    .from(batches)
    .leftJoin(dealers, eq(batches.dealerId, dealers.id))
    .orderBy(desc(batches.requestedAt))
    .$dynamic();
  const rows = fromIso
    ? await rowsQuery.where(or(isNull(batches.closedAt), gte(batches.closedAt, fromIso)))
    : await rowsQuery;

  // Pull every completed Delivery action and every completed VIN-Receiving
  // stage in parallel. Delivery = batch is fully delivered; VIN done =
  // execution zone (the pivot from "uncertain" to "predictable lead time").
  //
  // VIN moved from action_types into vin_chase_stages in PR #53, and AGAIN
  // into the scope-aware `actions` table (wave-scope) in the phase-2
  // restructure. Both sources are queried here and unioned — the source
  // of truth depends on whether ops has used the legacy /action-center
  // or /action-center-v2 to mark VIN done.
  const vinStageDone = await (async () => {
    try {
      return await db
        .select({ batchId: batchVinStages.batchId })
        .from(batchVinStages)
        .innerJoin(vinChaseStages, eq(batchVinStages.stageId, vinChaseStages.id))
        .where(and(
          eq(batchVinStages.status, "done"),
          // Match any stage with "vin" in its name (canonical name is
          // "VIN Receiving"; admin can edit but most rename variants
          // still contain "vin"). Permissive on purpose — false
          // positives are harmless (we'd over-flag a batch as post-VIN),
          // false negatives strand the signal.
          sql`LOWER(${vinChaseStages.name}) LIKE '%vin%'`,
        ));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such table/i.test(msg)) return [];
      throw err;
    }
  })();
  // Phase 4a — new shape: wave-scope action rows.
  // batch_id → wave_id → wave-scope action of type matching /vin/i in
  // status='done'. Used to flip the batch's vinPhase to post_vin once
  // ops marks the wave's VIN action done in /action-center-v2.
  // Returns batch ids (denormalised from wave) so the downstream
  // `vinDoneBatches` set logic stays unchanged.
  const vinWaveActionDone = await (async () => {
    try {
      return await db
        .select({ batchId: batches.id })
        .from(actionsTable)
        .innerJoin(actionTypes, eq(actionsTable.actionTypeId, actionTypes.id))
        .innerJoin(waves,       eq(actionsTable.scopeId, waves.id))
        .innerJoin(batches,     eq(batches.waveId, waves.id))
        .where(and(
          eq(actionsTable.scope, "wave"),
          eq(actionsTable.status, "done"),
          sql`LOWER(${actionTypes.name}) LIKE '%vin%'`,
        ));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such table|no such column/i.test(msg)) return [];
      throw err;
    }
  })();
  const delivered = await db
    .select({
      batchId:     batchActions.batchId,
      completedAt: batchActions.completedAt,
    })
    .from(batchActions)
    .innerJoin(actionTypes, eq(batchActions.actionTypeId, actionTypes.id))
    .where(and(
      eq(batchActions.status, "done"),
      eq(actionTypes.name, "Delivery"),
    ));

  const deliveredByBatch = new Map<number, string>();
  for (const m of delivered) {
    if (m.completedAt) deliveredByBatch.set(m.batchId, m.completedAt.slice(0, 10));
  }
  // A batch is "vin done" if it has at least one done VIN-related stage
  // OR its wave has a done VIN-named wave-scope action (new shape). The
  // two sources are unioned because the source of truth shifts when ops
  // moves from legacy /action-center to /action-center-v2 — both must
  // stay live until Phase 5 drops the legacy tables.
  const vinDoneBatches = new Set<number>([
    ...vinStageDone.map((a) => a.batchId),
    ...vinWaveActionDone.map((a) => a.batchId),
  ]);

  return rows.map(({ b, dealerName }) =>
    buildRow(b, dealerName, deliveredByBatch.get(b.id), vinDoneBatches.has(b.id)),
  );
}

/**
 * Hydrate a single batch's timeline data for the drawer.
 * Returns null when the code doesn't match.
 *
 * Reality track is built from `batch_actions`:
 *   - Every completed action becomes a tick on the Reality track at its
 *     `completed_at` date, labelled with the action_type's `done_label`.
 *   - The canonical `Delivery` action drives the dedicated `realityDelivery`
 *     field (and the delivery delay bracket), and is omitted from the
 *     generic `realityActions` list to avoid a duplicate tick.
 */
export async function getTimelineData(batchCode: string): Promise<TimelineData | null> {
  const row = await db
    .select({ b: batches, dealerName: dealers.name })
    .from(batches)
    .leftJoin(dealers, eq(batches.dealerId, dealers.id))
    .where(eq(batches.batchCode, batchCode))
    .limit(1);

  if (row.length === 0) return null;
  const { b, dealerName } = row[0];

  // Every batch_action on this batch — used for both the Reality SVG
  // ticks (filter to done) and the activity table (full set).
  const allActions = await db
    .select({
      id:             batchActions.id,
      status:         batchActions.status,
      completedAt:    batchActions.completedAt,
      expectedDate:   batchActions.expectedDate,
      notes:          batchActions.notes,
      actionTypeName: actionTypes.name,
      waitingLabel:   actionTypes.waitingLabel,
      doneLabel:      actionTypes.doneLabel,
      sortOrder:      actionTypes.sortOrder,
      departmentName: departments.name,
      stakeholderName: stakeholders.name,
    })
    .from(batchActions)
    .innerJoin(actionTypes,    eq(batchActions.actionTypeId, actionTypes.id))
    .leftJoin(departments,     eq(batchActions.departmentId, departments.id))
    .leftJoin(stakeholders,    eq(batchActions.assignedStakeholderId, stakeholders.id))
    .where(eq(batchActions.batchId, b.id))
    .orderBy(asc(actionTypes.sortOrder));

  // VIN chase stages on this batch — moved out of action_types in
  // PR #53, and AGAIN into wave-scope rows on the `actions` table in
  // the phase-2 restructure. For new batches (wave_id set) we skip
  // batch_vin_stages entirely and use the wave-scope reads further
  // down. For legacy batches (wave_id null) we keep reading
  // batch_vin_stages so the drawer still shows their chain.
  const isNewBatch = b.waveId != null;
  const vinStageRows = isNewBatch ? [] : await (async () => {
    try {
      return await db
        .select({
          status:      batchVinStages.status,
          completedAt: batchVinStages.completedAt,
          notes:       batchVinStages.notes,
          stageName:   vinChaseStages.name,
          waitingLabel:vinChaseStages.waitingLabel,
          doneLabel:   vinChaseStages.doneLabel,
          sortOrder:   vinChaseStages.sortOrder,
        })
        .from(batchVinStages)
        .innerJoin(vinChaseStages, eq(batchVinStages.stageId, vinChaseStages.id))
        .where(eq(batchVinStages.batchId, b.id))
        .orderBy(asc(vinChaseStages.sortOrder));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such table/i.test(msg)) return [];
      throw err;
    }
  })();

  // Phase 4a — pull scope-aware actions for new batches: the batch's
  // wave-scope rows (VIN chase) and its PO's po-scope rows (internal
  // phase). These didn't exist for legacy batches, so we skip the
  // query entirely when wave_id is null. Batch-scope rows are
  // intentionally omitted — they duplicate batch_actions for new batches
  // (Phase 2 double-writes them) and we'd double-count if both ran.
  const scopedActionRows = !isNewBatch ? [] : await (async () => {
    try {
      const waveRow = await db
        .select({ id: waves.id, poId: waves.poId })
        .from(waves).where(eq(waves.id, b.waveId!)).limit(1);
      if (waveRow.length === 0) return [];
      const { id: waveId, poId } = waveRow[0];
      return await db
        .select({
          scope:           actionsTable.scope,
          status:          actionsTable.status,
          completedAt:     actionsTable.completedAt,
          expectedDate:    actionsTable.expectedDate,
          notes:           actionsTable.notes,
          actionTypeName:  actionTypes.name,
          waitingLabel:    actionTypes.waitingLabel,
          doneLabel:       actionTypes.doneLabel,
          sortOrder:       actionTypes.sortOrder,
          departmentName:  departments.name,
          stakeholderName: stakeholders.name,
        })
        .from(actionsTable)
        .innerJoin(actionTypes,  eq(actionsTable.actionTypeId, actionTypes.id))
        .leftJoin(departments,   eq(actionsTable.departmentId, departments.id))
        .leftJoin(stakeholders,  eq(actionsTable.assignedStakeholderId, stakeholders.id))
        .where(or(
          and(eq(actionsTable.scope, "wave"), eq(actionsTable.scopeId, waveId)),
          and(eq(actionsTable.scope, "po"),   eq(actionsTable.scopeId, poId)),
        ))
        .orderBy(asc(actionTypes.sortOrder));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such table|no such column/i.test(msg)) return [];
      throw err;
    }
  })();

  const completedActions = allActions.filter((a) => a.status === "done");

  const deliveryAction = completedActions.find((a) => a.actionTypeName === "Delivery");
  const deliveredAt = deliveryAction?.completedAt
    ? deliveryAction.completedAt.slice(0, 10)
    : null;

  // ── Activity table rows ─────────────────────────────────────────
  // Three sources, all flattened into the same TimelineActivity shape:
  //   1. batch_actions (internal phase work)
  //   2. batch_vin_stages (VIN chase chain — its own table since PR #53)
  //   3. batches.app_listed_at (App Listing milestone — its own column
  //      since PR #71, single-event)
  //
  // We pass through the full ISO `completedAt` rather than truncating
  // to date-only so the UI can render the time too. Day-based delay
  // math uses just the date portion.
  const todayIso = new Date().toISOString().slice(0, 10);
  const activity: TimelineActivity[] = allActions.map((a) => {
    const completedDateOnly = a.completedAt ? a.completedAt.slice(0, 10) : null;
    let delayDays: number | null = null;
    if (a.status === "done" && completedDateOnly && a.expectedDate) {
      delayDays = daysBetween(completedDateOnly, a.expectedDate);
    } else if ((a.status === "waiting" || a.status === "blocked") && a.expectedDate && todayIso > a.expectedDate) {
      // Past-due open action — surface how late it already is.
      delayDays = daysBetween(todayIso, a.expectedDate);
    }
    return {
      actionTypeName: a.actionTypeName,
      actionLabel: a.status === "done" ? a.doneLabel : a.waitingLabel,
      status: a.status,
      departmentName: a.departmentName ?? null,
      stakeholderName: a.stakeholderName ?? null,
      expectedDate: a.expectedDate ?? null,
      completedAt: a.completedAt ?? null,
      delayDays,
      notes: a.notes ?? null,
    };
  });

  // VIN chase stages → activity rows. No planned date (the chain has no
  // expectedDate; ops marks done when the real-world event happens) so
  // delayDays is always null. No department/stakeholder ownership
  // either — VIN chase is dealer-side work, not internal.
  for (const s of vinStageRows) {
    activity.push({
      actionTypeName: s.stageName,
      actionLabel:    s.status === "done" ? s.doneLabel : s.waitingLabel,
      status:         s.status as TimelineActivity["status"],
      departmentName: null,
      stakeholderName:null,
      expectedDate:   null,
      completedAt:    s.completedAt ?? null,
      delayDays:      null,
      notes:          s.notes ?? null,
    });
  }

  // Phase 4a — wave-scope + po-scope actions → activity rows. Same
  // delay math as batch_actions (done with expected → completed minus
  // expected; open past-due → today minus expected; else null).
  for (const s of scopedActionRows) {
    const completedDateOnly = s.completedAt ? s.completedAt.slice(0, 10) : null;
    let delayDays: number | null = null;
    if (s.status === "done" && completedDateOnly && s.expectedDate) {
      delayDays = daysBetween(completedDateOnly, s.expectedDate);
    } else if ((s.status === "waiting" || s.status === "blocked") && s.expectedDate && todayIso > s.expectedDate) {
      delayDays = daysBetween(todayIso, s.expectedDate);
    }
    activity.push({
      actionTypeName: s.actionTypeName,
      actionLabel:    s.status === "done" ? s.doneLabel : s.waitingLabel,
      status:         s.status as TimelineActivity["status"],
      departmentName: s.departmentName ?? null,
      stakeholderName:s.stakeholderName ?? null,
      expectedDate:   s.expectedDate ?? null,
      completedAt:    s.completedAt ?? null,
      delayDays,
      notes:          s.notes ?? null,
    });
  }

  // App Listing → activity row (when set). One synthetic row matching
  // the TimelineActivity shape so the UI doesn't need a special case.
  if (b.appListedAt) {
    activity.push({
      actionTypeName: "App Listing",
      actionLabel:    "Listed in app",
      status:         "done",
      departmentName: null,
      stakeholderName:null,
      expectedDate:   null,
      completedAt:    b.appListedAt,
      delayDays:      null,
      notes:          null,
    });
  }

  // Sort the activity narrative chronologically: skipped go to the
  // bottom; done/waiting/blocked sort by expectedDate (or the date
  // portion of completedAt when no plan), with rows missing both
  // dates pushed last.
  activity.sort((a, b) => {
    const aSkip = a.status === "skipped" ? 1 : 0;
    const bSkip = b.status === "skipped" ? 1 : 0;
    if (aSkip !== bSkip) return aSkip - bSkip;
    const aKey = a.expectedDate ?? (a.completedAt ? a.completedAt.slice(0, 10) : "9999-12-31");
    const bKey = b.expectedDate ?? (b.completedAt ? b.completedAt.slice(0, 10) : "9999-12-31");
    return aKey.localeCompare(bKey);
  });

  // Reality ticks — three sources, all flattened into one ordered list:
  //   1. Completed batch_actions (excluding Delivery — that's the
  //      end-of-Reality marker rendered separately).
  //   2. Completed VIN chase stages (each is a milestone tick).
  //   3. App Listing milestone if set on this batch.
  // delayDays = completed − expected (signed). 0 when no expectedDate
  // or when the source has no concept of planned date (VIN chain, App
  // Listing).
  const realityFromActions = completedActions
    .filter((a) => a.actionTypeName !== "Delivery" && a.completedAt)
    .map((a) => {
      const completedIso = a.completedAt!.slice(0, 10);
      const delayDays = a.expectedDate ? daysBetween(completedIso, a.expectedDate) : 0;
      return {
        date:  completedIso,
        label: a.doneLabel,
        delayDays,
      };
    });
  const realityFromVinStages = vinStageRows
    .filter((s) => s.status === "done" && s.completedAt)
    .map((s) => ({
      date:      s.completedAt!.slice(0, 10),
      label:     s.doneLabel,
      delayDays: 0,
    }));
  const realityFromAppListing = b.appListedAt
    ? [{ date: b.appListedAt.slice(0, 10), label: "Listed in app", delayDays: 0 }]
    : [];
  // Phase 4a — wave/po-scope completed actions become Reality ticks too.
  // Same exclusion as batch_actions: skip Delivery (it's the end-of-track
  // marker rendered separately) — though it's not wave/po scope anyway,
  // the filter is cheap and future-proofs against admin reconfiguring.
  const realityFromScoped = scopedActionRows
    .filter((s) => s.status === "done" && s.completedAt && s.actionTypeName !== "Delivery")
    .map((s) => {
      const completedIso = s.completedAt!.slice(0, 10);
      const delayDays = s.expectedDate ? daysBetween(completedIso, s.expectedDate) : 0;
      return { date: completedIso, label: s.doneLabel, delayDays };
    });
  const realityActions = [
    ...realityFromActions,
    ...realityFromVinStages,
    ...realityFromScoped,
    ...realityFromAppListing,
  ].sort((a, b) => a.date.localeCompare(b.date));

  const built = buildRow(b, dealerName, deliveredAt ?? undefined);

  /**
   * Reality end-of-track. Three sources, in priority order:
   *   1. Closed batch → `closedAt` (the Actual Availability Date). Label
   *      varies by `closureReason`: "Actual Availability Date" or "Cancelled".
   *   2. Delivered action complete (legacy/edge case for batches that
   *      somehow didn't get auto-closed) → its completedAt.
   *   3. Open batch with a projection → currentProjectedDeliveryDate.
   */
  let realityDelivery: string | null = null;
  let realityDeliveryLabel: "Actual Availability Date" | "Cancelled" | "Projected" | null = null;
  if (b.closedAt) {
    realityDelivery = b.closedAt;
    realityDeliveryLabel = b.closureReason === "cancelled"
      ? "Cancelled"
      : "Actual Availability Date";
  } else if (deliveredAt) {
    realityDelivery = deliveredAt;
    realityDeliveryLabel = "Actual Availability Date";
  } else if (b.currentProjectedDeliveryDate) {
    realityDelivery = b.currentProjectedDeliveryDate;
    realityDeliveryLabel = "Projected";
  }

  const poDelayDays =
    b.actualPoDate && b.expectedPoDate
      ? daysBetween(b.actualPoDate, b.expectedPoDate)
      : null;

  const deliveryDelayDays = realityDelivery
    ? daysBetween(realityDelivery, b.dealerPromisedDeliveryDate)
    : null;

  return {
    batchCode: b.batchCode,
    modelYear: built.modelYear,
    dealerName: built.dealerName,
    quantity: b.requestedQuantity,
    stageDisplay: stageDisplay(b.currentStage),

    planRequested: b.requestedAt,
    // Suppress the Expected-PO milestone when it equals the Actual-PO
    // date — that's the Post-PO case (PO uploaded at intake, both fields
    // derived from the same PDF), where putting it on the Plan track
    // just duplicates the Reality-track Actual-PO tick at the same date.
    // For Pre-PO batches (no actualPoDate yet, or a real override gap),
    // the planned target survives and the comparison stays meaningful.
    planExpectedPo: b.expectedPoDate && b.expectedPoDate !== b.actualPoDate
      ? b.expectedPoDate
      : null,
    planPromised: b.dealerPromisedDeliveryDate,

    poIssuedDate: b.actualPoDate ?? null,
    preTrackingGapDays: b.actualPoDate
      ? Math.max(0, daysBetween(b.requestedAt, b.actualPoDate))
      : 0,

    realityRequested: b.requestedAt,
    realityActualPo: b.actualPoDate ?? null,
    realityDelivery,
    realityDeliveryLabel,
    realityActions,

    poDelayDays,
    deliveryDelayDays,

    poStatusLabel: built.poStatusLabel,
    deliveryStatusLabel: built.deliveryStatusLabel,
    overallStatusLabel: built.statusLabel,

    activity,
  };
}

// ──────────────────────────────────────────────────────────────────
// Row builder (pure — easy to unit-test later)
// ──────────────────────────────────────────────────────────────────

function buildRow(
  b: typeof batches.$inferSelect,
  dealerName: string | null,
  deliveredAt?: string,
  vinDone = false,
): DashboardRow {
  // PO status
  let poStatusLabel = "—";
  if (b.actualPoDate) {
    poStatusLabel = `✅ ${b.actualPoDate}`;
  } else if (b.targetPoDate) {
    const daysLeft = daysFromToday(b.targetPoDate) ?? 0;
    poStatusLabel = daysLeft < 0 ? `⚠️ Overdue ${-daysLeft}d` : `🟢 due in ${daysLeft}d`;
  }

  // Delivery status
  let deliveryStatusLabel = "—";
  if (deliveredAt) {
    deliveryStatusLabel = `🎉 ${deliveredAt}`;
  } else if (b.currentProjectedDeliveryDate) {
    deliveryStatusLabel = `🔮 ${b.currentProjectedDeliveryDate}`;
  }

  // Delay vs promise
  const delayDays =
    b.currentProjectedDeliveryDate && b.dealerPromisedDeliveryDate
      ? daysBetween(b.currentProjectedDeliveryDate, b.dealerPromisedDeliveryDate)
      : 0;

  // Status bucket + label
  let status: StatusBucket;
  let statusLabel: string;
  if (b.currentStage === "delivered") {
    status = "delivered";
    statusLabel = "🎉 Delivered";
  } else if (delayDays > 0) {
    status = "delayed";
    statusLabel = `🔴 Delayed +${delayDays}d`;
  } else if (delayDays < 0) {
    status = "ahead";
    statusLabel = `🔵 Ahead ${-delayDays}d`;
  } else {
    status = "on_track";
    statusLabel = "🟢 On track";
  }

  const modelYear = [b.model, b.year].filter(Boolean).join(" ") || "—";

  // VIN phase: once the VIN action is marked done the batch enters the
  // execution zone. Delivered batches are also implicitly post-VIN but
  // we track them separately via `status`.
  const vinPhase: DashboardRow["vinPhase"] = vinDone ? "post_vin" : "pre_vin";

  // Days to the effective availability date. null for delivered batches.
  let daysToAvailability: number | null = null;
  if (status !== "delivered") {
    const effectiveDate = b.currentProjectedDeliveryDate ?? b.dealerPromisedDeliveryDate;
    daysToAvailability = daysFromToday(effectiveDate);
  }

  return {
    batchCode: b.batchCode,
    poNumber: b.poNumber ?? null,
    dealerName: dealerName ?? "—",
    modelYear,
    quantity: b.requestedQuantity,
    colors: b.colorSummary ?? "",
    requestedAt: b.requestedAt,
    promisedDate: b.dealerPromisedDeliveryDate,
    stage: b.currentStage ?? "request_submitted",
    stageDisplay: stageDisplay(b.currentStage),
    poStatusLabel,
    deliveryStatusLabel,
    status,
    statusLabel,
    delayDays,
    risk: Math.round(b.riskScore ?? 0),
    confidenceLabel: `${Math.round(b.partnershipConfidence ?? 0)}% / ${Math.round(b.operationsConfidence ?? 0)}%`,
    vinPhase,
    daysToAvailability,
  };
}

/** Aggregate metrics for the top of the dashboard. */
export function summarize(rows: DashboardRow[]) {
  const total = rows.length;
  const delivered = rows.filter((r) => r.status === "delivered").length;
  const active = total - delivered;
  const delayed = rows.filter((r) => r.status === "delayed").length;
  const onTrack = rows.filter((r) => r.status === "on_track").length;
  /**
   * High-risk count: active batches that are still pre-VIN AND have ≤ 14
   * days until their effective availability date. These need immediate ops
   * attention — the VIN is the last chance to course-correct.
   */
  const highRisk = rows.filter(
    (r) =>
      r.status !== "delivered" &&
      r.vinPhase === "pre_vin" &&
      r.daysToAvailability !== null &&
      r.daysToAvailability <= 14,
  ).length;
  return { total, active, delivered, delayed, onTrack, highRisk };
}

/**
 * Weekly count of LATE deliveries over the last 12 weeks (oldest first).
 * "Late" = closureReason="delivered" AND closedAt > dealerPromisedDeliveryDate.
 *
 * Powers the sparkline on the Dashboard's Delayed hero tile —
 * communicates the trend of "are we delivering late more often, less
 * often, or about the same?" Same Monday-anchored bucket alignment as
 * the Reports on-time rate weekly buckets, so a side-by-side view
 * stays comparable.
 */
export async function getLateDeliveriesWeekly(): Promise<number[]> {
  const rows = await db
    .select({
      closedAt:        batches.closedAt,
      closureReason:   batches.closureReason,
      promisedDate:    batches.dealerPromisedDeliveryDate,
    })
    .from(batches);

  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysSinceMonday = (today.getDay() + 6) % 7;
  const thisWeekStartMs = today.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000;
  const buckets = Array.from({ length: 12 }, () => 0);
  for (const r of rows) {
    if (!r.closedAt || r.closureReason !== "delivered") continue;
    if (!(r.closedAt > r.promisedDate)) continue; // on-time → skip
    const ts = new Date(r.closedAt + "T12:00:00Z").getTime();
    const offset = thisWeekStartMs - ts;
    if (offset < 0 || offset >= 12 * WEEK_MS) continue;
    const weekIdx = 11 - Math.floor(offset / WEEK_MS);
    buckets[weekIdx]++;
  }
  return buckets;
}

/**
 * Action Center data layer — server-side queries.
 *
 * Two public surfaces:
 *   - getActionCenterRows(): one row per batch with action counts + next pending
 *   - getDrawerData(code):   full action list for a single batch (drawer detail)
 *
 * Aggregation happens in JS since the dataset is small (dozens of batches × 9
 * actions). For larger volumes, switch to GROUP BY in SQL.
 */
import { eq, asc, inArray, and } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batches, dealers, batchActions, actionTypes, actionDependencies, departments, stakeholders, alerts, batchColorMatrix, batchDeliveryLegs,
  vinChaseStages, batchVinStages,
} from "@/lib/db/schema";
import type { ActiveAlert } from "@/lib/alert-engine";
import { highestSeverity } from "@/lib/alert-engine";
import { getLeadTimeDays } from "@/lib/rules";

// ──────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────

export interface ActionCenterRow {
  /* Identity */
  batchId: number;
  batchCode: string;
  modelYear: string;
  dealerName: string;
  quantity: number;
  lifecycleState: "pre_po" | "post_po";

  /* Closure */
  closedAt: string | null;                                     // ISO yyyy-mm-dd
  closureReason: "delivered" | "cancelled" | null;

  /* Action aggregates */
  actionsWaiting: number;
  actionsBlocked: number;
  actionsDone: number;
  actionsSkipped: number;
  totalActions: number;

  /* Next pending — for the "what's needed" column. */
  nextActionLabel: string | null;       // e.g. "Waiting VIN"
  nextDepartmentName: string | null;    // e.g. "Operations"

  /* Distinct departments with at least one waiting action. */
  pendingDepartments: string[];

  /* Status */
  delayDays: number;                    // signed; positive = late
  statusLabel: string;                  // "🟢 On track" / "🔴 Delayed +5d" / etc.

  /* Confidence */
  operationsConfidence: number | null;
  operationsLocked: boolean;

  /* Alerts */
  alertCount: number;
  highestAlertSeverity: ActiveAlert["severity"] | null;

  /**
   * Compact descriptors of every OPEN (waiting OR blocked) action on
   * this batch. Used by the aggregate filter strip above the table to
   * count "N batches waiting on Car Specs / on Specs dept / on Ahmed",
   * and to filter the table when a chip is clicked.
   *
   * One entry per open action — a batch with 3 waiting actions
   * contributes 3 entries. Aggregations DE-DUPE by batchId, so we count
   * distinct *batches* per group, not actions.
   */
  openActions: OpenActionRef[];
}

/** One open-action reference — enough to power the aggregate strip. */
export interface OpenActionRef {
  actionTypeId: number;
  actionTypeName: string;
  waitingLabel: string;
  status: "waiting" | "blocked";
  departmentId: number | null;
  departmentName: string | null;
  stakeholderId: number | null;
  stakeholderName: string | null;
  /**
   * Days late: today − expectedDate when expectedDate is in the past,
   * else 0. Drives the "Delayed work" filter strip — actions with
   * delayDays === 0 don't appear there.
   */
  delayDays: number;
}

/**
 * Per-city delivery leg for a batch (Phase α of grouping rework).
 *
 * Multi-leg batches arise when the intake-grouper merges splits
 * sharing (model, year, date, commercial terms) but with different
 * cities. The legs table is the source of truth for per-city quantity
 * and per-city delivery confirmation. Single-leg batches still have
 * one row here for consistency.
 */
export interface BatchDeliveryLegRow {
  id: number;
  city: string;
  requestedQuantity: number;
  deliveredQuantity: number;
  notes: string | null;
}

/**
 * One step of the VIN chase chain on a specific batch. Combines the
 * canonical stage definition (from `vin_chase_stages`) with the batch's
 * per-stage state (from `batch_vin_stages`). The drawer renders every
 * stage every time — they're created at Intake and backfilled for
 * pre-migration batches, so `state` is always non-null.
 */
export interface VinChaseStageDetail {
  /** batch_vin_stages row id — PK for mutations via /api/vin-stage. */
  id: number;
  /** vin_chase_stages row id — stable handle for admin renames. */
  stageId: number;
  /** Canonical key, e.g. "VIN Receiving", "Plate". */
  name: string;
  waitingLabel: string;
  doneLabel: string;
  sortOrder: number;
  status: "waiting" | "done" | "skipped";
  /** ISO datetime when status flipped to done. */
  completedAt: string | null;
  notes: string | null;
}

/** Per-colour breakdown for a batch — drives the Car Delivery confirmation modal. */
export interface BatchColorRow {
  color: string;
  requestedQuantity: number;
  confirmedQuantity: number;
  deliveredQuantity: number;
}

export interface ActionDetail {
  /** batchActions row id (PK for mutations) */
  id: number;
  /** Stable handle on the action type */
  actionTypeId: number;
  actionTypeName: string;
  waitingLabel: string;
  doneLabel: string;
  status: "waiting" | "blocked" | "done" | "skipped";
  departmentId: number | null;
  departmentName: string | null;
  /** Stakeholder responsible for this action (within the department). */
  assignedStakeholderId: number | null;
  assignedStakeholderName: string | null;
  /** Planned date this action should complete (ISO yyyy-mm-dd). Computed at Intake; auto-shifts when VIN slips. */
  expectedDate: string | null;
  completedAt: string | null;
  notes: string | null;
  /** Action-type names this action is currently waiting on (only populated when status='blocked'). */
  blockedBy: string[];
  sortOrder: number;
}

export interface DrawerData {
  batchId: number;
  batchCode: string;
  modelYear: string;
  dealerName: string;
  quantity: number;
  lifecycleState: "pre_po" | "post_po";

  /** Promised delivery date (ISO yyyy-mm-dd). */
  promisedDate: string;
  /**
   * Ops's current projected availability date (ISO yyyy-mm-dd). Null
   * means no projection set yet — use `promisedDate` as the working
   * value. Mutated by the Date-shift modal; each shift logged into
   * `batch_date_revisions`.
   */
  currentProjectedDeliveryDate: string | null;
  /**
   * The configurable Pre PO Ops Lead Time (Settings → Rules). Surfaced
   * here so the Phase G recommend-shift banner can compute the safe
   * runway: recommendedDate = today + prePoOpsLeadTimeDays.
   */
  prePoOpsLeadTimeDays: number;
  /** Pre-formatted status label ("🟢 On track", "🔴 Delayed +5d", etc.). */
  statusLabel: string;

  /* Closure (null = batch is open). */
  closedAt: string | null;
  closureReason: "delivered" | "cancelled" | null;
  cancellationNote: string | null;

  partnershipConfidence:       number | null;
  partnershipConfidenceAtLock: number | null;
  operationsConfidence:        number | null;
  operationsConfidenceAtLock:  number | null;

  actions: ActionDetail[];
  /** Departments available for re-assignment in the drawer. */
  departments: { id: number; name: string }[];
  /** Active (unresolved) alerts for this batch. */
  alerts: ActiveAlert[];
  /**
   * Per-colour breakdown rows for this batch. Drives the Car Delivery
   * confirmation modal — ops fills in delivered quantity per colour at
   * the closure moment. Empty array when no color matrix is configured.
   */
  colorMatrix: BatchColorRow[];
  /** Currently-recorded delivered quantity on the batch (cumulative). */
  deliveredQuantity: number;
  /**
   * Per-city delivery legs for this batch. Empty array when the batch
   * was created before Phase α (legacy single-city batches). When
   * non-empty, the Car Delivery modal collects per-leg confirmations.
   */
  legs: BatchDeliveryLegRow[];
  /**
   * VIN chase chain for this specific batch — one item per canonical
   * stage in `vin_chase_stages`, joined with the batch's row in
   * `batch_vin_stages`. Ordered by stage.sortOrder. Drives the
   * stepper UI directly; no further classifier work needed.
   */
  vinChaseStages: VinChaseStageDetail[];
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / DAY_MS);
}

function statusFor(b: typeof batches.$inferSelect): { delayDays: number; statusLabel: string } {
  const delayDays =
    b.currentProjectedDeliveryDate && b.dealerPromisedDeliveryDate
      ? daysBetween(b.currentProjectedDeliveryDate, b.dealerPromisedDeliveryDate)
      : 0;
  if (b.currentStage === "delivered") return { delayDays, statusLabel: "🎉 Delivered" };
  if (delayDays > 0) return { delayDays, statusLabel: `🔴 Delayed +${delayDays}d` };
  if (delayDays < 0) return { delayDays, statusLabel: `🔵 Ahead ${-delayDays}d` };
  return { delayDays, statusLabel: "🟢 On track" };
}

// ──────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────

export async function getActionCenterRows(
  alertsByBatch: Map<number, ActiveAlert[]> = new Map(),
): Promise<ActionCenterRow[]> {
  // Pull every batch, plus its dealer name.
  const batchRows = await db
    .select({ b: batches, dealerName: dealers.name })
    .from(batches)
    .leftJoin(dealers, eq(batches.dealerId, dealers.id));

  // Pull every batch_action joined with its action_type, department, and
  // (optionally) the assigned stakeholder. One round-trip — small dataset.
  // expectedDate flows through so we can compute delayDays per open action
  // for the "Delayed work" filter strip.
  const actions = await db
    .select({
      batchId:        batchActions.batchId,
      status:         batchActions.status,
      expectedDate:   batchActions.expectedDate,
      sortOrder:      actionTypes.sortOrder,
      actionTypeId:   actionTypes.id,
      actionTypeName: actionTypes.name,
      waitingLabel:   actionTypes.waitingLabel,
      departmentId:   departments.id,
      departmentName: departments.name,
      stakeholderId:    stakeholders.id,
      stakeholderName:  stakeholders.name,
    })
    .from(batchActions)
    .innerJoin(actionTypes,    eq(batchActions.actionTypeId, actionTypes.id))
    .leftJoin(departments,     eq(batchActions.departmentId, departments.id))
    .leftJoin(stakeholders,    eq(batchActions.assignedStakeholderId, stakeholders.id));

  // Today as midnight epoch ms — reused inside the per-row loop below so
  // we don't reconstruct the date for every action.
  const todayMs = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  function computeDelayDays(expectedDate: string | null | undefined): number {
    if (!expectedDate) return 0;
    const exp = new Date(expectedDate).setHours(0, 0, 0, 0);
    if (exp >= todayMs) return 0;
    return Math.round((todayMs - exp) / DAY_MS);
  }

  // Bucket actions by batchId for O(1) per-row lookup.
  const byBatch = new Map<number, typeof actions>();
  for (const a of actions) {
    const arr = byBatch.get(a.batchId) ?? [];
    arr.push(a);
    byBatch.set(a.batchId, arr);
  }

  return batchRows.map(({ b, dealerName }) => {
    const bAct = (byBatch.get(b.id) ?? []).slice().sort((x, y) => x.sortOrder - y.sortOrder);

    let actionsWaiting = 0, actionsBlocked = 0, actionsDone = 0, actionsSkipped = 0;
    for (const a of bAct) {
      if (a.status === "waiting") actionsWaiting++;
      else if (a.status === "blocked") actionsBlocked++;
      else if (a.status === "done") actionsDone++;
      else if (a.status === "skipped") actionsSkipped++;
    }

    // Next pending: first waiting in sort order; else first blocked; else null.
    const nextWaiting = bAct.find((a) => a.status === "waiting");
    const nextBlocked = bAct.find((a) => a.status === "blocked");
    const next = nextWaiting ?? nextBlocked ?? null;

    const pendingDeptSet = new Set<string>();
    const openActions: OpenActionRef[] = [];
    for (const a of bAct) {
      if (a.status !== "waiting" && a.status !== "blocked") continue;
      if (a.departmentName) pendingDeptSet.add(a.departmentName);
      openActions.push({
        actionTypeId:    a.actionTypeId,
        actionTypeName:  a.actionTypeName,
        waitingLabel:    a.waitingLabel,
        status:          a.status as "waiting" | "blocked",
        departmentId:    a.departmentId ?? null,
        departmentName:  a.departmentName ?? null,
        stakeholderId:   a.stakeholderId ?? null,
        stakeholderName: a.stakeholderName ?? null,
        // Blocked actions don't own their delay — the parent action they
        // depend on does. Force delayDays = 0 so the Delayed-Work strip
        // skips them, and the upstream waiting parent shows the lateness.
        delayDays:       a.status === "waiting" ? computeDelayDays(a.expectedDate) : 0,
      });
    }

    const { delayDays, statusLabel } = statusFor(b);

    return {
      batchId:    b.id,
      batchCode:  b.batchCode,
      modelYear:  [b.model, b.year].filter(Boolean).join(" ") || "—",
      dealerName: dealerName ?? "—",
      quantity:   b.requestedQuantity,
      lifecycleState: (b.lifecycleState ?? "post_po") as "pre_po" | "post_po",

      closedAt:      b.closedAt ?? null,
      closureReason: (b.closureReason ?? null) as ActionCenterRow["closureReason"],

      actionsWaiting,
      actionsBlocked,
      actionsDone,
      actionsSkipped,
      totalActions: bAct.length,

      nextActionLabel:    next?.waitingLabel ?? null,
      nextDepartmentName: next?.departmentName ?? null,
      pendingDepartments: Array.from(pendingDeptSet).sort(),

      delayDays,
      statusLabel,

      operationsConfidence: b.operationsConfidence ?? null,
      operationsLocked: b.operationsConfidenceAtLock != null,

      alertCount:           (alertsByBatch.get(b.id) ?? []).length,
      highestAlertSeverity: highestSeverity(alertsByBatch.get(b.id) ?? []),

      openActions,
    };
  });
}

export async function getDrawerData(batchCode: string): Promise<DrawerData | null> {
  const [row] = await db
    .select({ b: batches, dealerName: dealers.name })
    .from(batches)
    .leftJoin(dealers, eq(batches.dealerId, dealers.id))
    .where(eq(batches.batchCode, batchCode))
    .limit(1);

  if (!row) return null;
  const b = row.b;

  // All batch_actions for this batch, plus action_type + department + stakeholder.
  const actionRows = await db
    .select({
      ba:               batchActions,
      at:               actionTypes,
      departmentId:     departments.id,
      departmentName:   departments.name,
      stakeholderId:    stakeholders.id,
      stakeholderName:  stakeholders.name,
    })
    .from(batchActions)
    .innerJoin(actionTypes,   eq(batchActions.actionTypeId, actionTypes.id))
    .leftJoin(departments,    eq(batchActions.departmentId, departments.id))
    .leftJoin(stakeholders,   eq(batchActions.assignedStakeholderId, stakeholders.id))
    .where(eq(batchActions.batchId, b.id))
    .orderBy(asc(actionTypes.sortOrder));

  // Compute blockedBy: for each action whose status is "blocked", look up
  // its parent action_types via action_dependencies; cross-reference the
  // current statuses on this batch so we only show parents that are still
  // not done.
  const actionTypeIds = actionRows.map((r) => r.at.id);
  const deps = actionTypeIds.length
    ? await db.select().from(actionDependencies)
        .where(inArray(actionDependencies.actionTypeId, actionTypeIds))
    : [];

  // Map: actionTypeId → status on this batch
  const statusByActionType = new Map<number, string>();
  for (const r of actionRows) {
    statusByActionType.set(r.at.id, r.ba.status);
  }
  // Map: actionTypeId → name (for display)
  const nameByActionType = new Map<number, string>();
  for (const r of actionRows) {
    nameByActionType.set(r.at.id, r.at.name);
  }

  // depsByActionType: childId → [parentName, ...] where parent is not yet done
  const blockedByMap = new Map<number, string[]>();
  for (const dep of deps) {
    const parentStatus = statusByActionType.get(dep.dependsOnActionTypeId);
    if (parentStatus !== "done") {
      const list = blockedByMap.get(dep.actionTypeId) ?? [];
      const parentName = nameByActionType.get(dep.dependsOnActionTypeId);
      if (parentName) list.push(parentName);
      blockedByMap.set(dep.actionTypeId, list);
    }
  }

  const actions: ActionDetail[] = actionRows.map((r) => ({
    id:                       r.ba.id,
    actionTypeId:             r.at.id,
    actionTypeName:           r.at.name,
    waitingLabel:             r.at.waitingLabel,
    doneLabel:                r.at.doneLabel,
    status:                   r.ba.status as ActionDetail["status"],
    departmentId:             r.departmentId,
    departmentName:           r.departmentName,
    assignedStakeholderId:    r.stakeholderId ?? null,
    assignedStakeholderName:  r.stakeholderName ?? null,
    expectedDate:             r.ba.expectedDate ?? null,
    completedAt:              r.ba.completedAt,
    notes:                    r.ba.notes,
    blockedBy:                blockedByMap.get(r.at.id) ?? [],
    sortOrder:                r.at.sortOrder,
  }));

  const [allDepartments, batchAlerts, colorMatrixRows, leadTimeDays, deliveryLegs, vinStageRows] = await Promise.all([
    db
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .orderBy(asc(departments.sortOrder)),
    db
      .select()
      .from(alerts)
      .where(and(eq(alerts.batchId, b.id), eq(alerts.resolved, false))),
    db
      .select({
        color:              batchColorMatrix.color,
        requestedQuantity:  batchColorMatrix.requestedQuantity,
        confirmedQuantity:  batchColorMatrix.confirmedQuantity,
        deliveredQuantity:  batchColorMatrix.deliveredQuantity,
      })
      .from(batchColorMatrix)
      .where(eq(batchColorMatrix.batchId, b.id)),
    getLeadTimeDays(),
    // Defensive: legs table is Phase α. If the migration hasn't been
    // applied to this DB yet, return empty array — drawer falls back
    // to the legacy single-city display.
    (async () => {
      try {
        return await db
          .select({
            id:                 batchDeliveryLegs.id,
            city:               batchDeliveryLegs.city,
            requestedQuantity:  batchDeliveryLegs.requestedQuantity,
            deliveredQuantity:  batchDeliveryLegs.deliveredQuantity,
            notes:              batchDeliveryLegs.notes,
          })
          .from(batchDeliveryLegs)
          .where(eq(batchDeliveryLegs.batchId, b.id))
          .orderBy(asc(batchDeliveryLegs.id));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/no such table/i.test(msg)) return [];
        throw err;
      }
    })(),
    // VIN chase chain for this batch — joins the canonical stage
    // catalogue with the batch's per-stage state. Wrapped in
    // try/catch so a DB that hasn't been migrated yet falls back to
    // an empty chain rather than 500ing the whole drawer.
    (async () => {
      try {
        return await db
          .select({
            id:           batchVinStages.id,
            stageId:      vinChaseStages.id,
            name:         vinChaseStages.name,
            waitingLabel: vinChaseStages.waitingLabel,
            doneLabel:    vinChaseStages.doneLabel,
            sortOrder:    vinChaseStages.sortOrder,
            status:       batchVinStages.status,
            completedAt:  batchVinStages.completedAt,
            notes:        batchVinStages.notes,
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
    })(),
  ]);

  const vinChainForBatch: VinChaseStageDetail[] = vinStageRows.map((r) => ({
    id:           r.id,
    stageId:      r.stageId,
    name:         r.name,
    waitingLabel: r.waitingLabel,
    doneLabel:    r.doneLabel,
    sortOrder:    r.sortOrder,
    status:       r.status as VinChaseStageDetail["status"],
    completedAt:  r.completedAt,
    notes:        r.notes,
  }));

  const { statusLabel } = statusFor(b);

  return {
    batchId:    b.id,
    batchCode:  b.batchCode,
    modelYear:  [b.model, b.year].filter(Boolean).join(" ") || "—",
    dealerName: row.dealerName ?? "—",
    quantity:   b.requestedQuantity,
    lifecycleState: (b.lifecycleState ?? "post_po") as "pre_po" | "post_po",

    promisedDate: b.dealerPromisedDeliveryDate,
    currentProjectedDeliveryDate: b.currentProjectedDeliveryDate ?? null,
    prePoOpsLeadTimeDays: leadTimeDays,
    statusLabel,

    closedAt:         b.closedAt ?? null,
    closureReason:    (b.closureReason ?? null) as DrawerData["closureReason"],
    cancellationNote: b.cancellationNote ?? null,

    partnershipConfidence:       b.partnershipConfidence ?? null,
    partnershipConfidenceAtLock: b.partnershipConfidenceAtLock ?? null,
    operationsConfidence:        b.operationsConfidence ?? null,
    operationsConfidenceAtLock:  b.operationsConfidenceAtLock ?? null,

    actions,
    departments: allDepartments,
    colorMatrix: colorMatrixRows.map((c) => ({
      color: c.color,
      requestedQuantity: c.requestedQuantity,
      confirmedQuantity: c.confirmedQuantity ?? 0,
      deliveredQuantity: c.deliveredQuantity ?? 0,
    })),
    deliveredQuantity: b.deliveredQuantity ?? 0,
    legs: deliveryLegs.map((l) => ({
      id:                 l.id,
      city:               l.city,
      requestedQuantity:  l.requestedQuantity,
      deliveredQuantity:  l.deliveredQuantity ?? 0,
      notes:              l.notes ?? null,
    })),
    vinChaseStages: vinChainForBatch,
    alerts: batchAlerts.map((a) => ({
      id:             a.id,
      fingerprint:    a.fingerprint,
      // Same fingerprint-parse pattern used by the engine. Keeps the wire
      // shape consistent across both data sources without needing a DB column.
      actionId:       (() => {
        const m = a.fingerprint.match(/-action-(\d+)$/);
        return m ? Number(m[1]) : null;
      })(),
      severity:       a.severity as ActiveAlert["severity"],
      alertType:      a.alertType,
      message:        a.message,
      raisedAt:       a.raisedAt ?? new Date().toISOString(),
    })),
  };
}

/** Aggregate summary metrics for the top of the page. */
export function summarizeActionCenter(rows: ActionCenterRow[]) {
  const total = rows.length;
  const withWaiting = rows.filter((r) => r.actionsWaiting > 0).length;
  const fullyDone   = rows.filter((r) => r.totalActions > 0 && r.actionsDone === r.totalActions).length;
  const delayed     = rows.filter((r) => r.delayDays > 0).length;
  return { total, withWaiting, fullyDone, delayed };
}

// Slack formatter moved to `lib/action-center-slack.ts` so client components can
// import it without dragging the better-sqlite3 driver into the browser
// bundle. See lib/action-center-slack.ts:formatStatusCheckMessage.

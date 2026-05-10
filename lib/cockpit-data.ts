/**
 * Cockpit data layer — server-side queries.
 *
 * Two public surfaces:
 *   - getCockpitRows():     one row per batch with action counts + next pending
 *   - getDrawerData(code):  full action list for a single batch (drawer detail)
 *
 * Aggregation happens in JS since the dataset is small (dozens of batches × 9
 * actions). For larger volumes, switch to GROUP BY in SQL.
 */
import { eq, asc, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batches, dealers, batchActions, actionTypes, actionDependencies, departments, stakeholders,
} from "@/lib/db/schema";

// ──────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────

export interface CockpitRow {
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

export async function getCockpitRows(): Promise<CockpitRow[]> {
  // Pull every batch, plus its dealer name.
  const batchRows = await db
    .select({ b: batches, dealerName: dealers.name })
    .from(batches)
    .leftJoin(dealers, eq(batches.dealerId, dealers.id));

  // Pull every batch_action joined with its action_type and department for
  // a single round-trip aggregate.
  const actions = await db
    .select({
      batchId:       batchActions.batchId,
      status:        batchActions.status,
      sortOrder:     actionTypes.sortOrder,
      waitingLabel:  actionTypes.waitingLabel,
      departmentName: departments.name,
    })
    .from(batchActions)
    .innerJoin(actionTypes,  eq(batchActions.actionTypeId, actionTypes.id))
    .leftJoin(departments,   eq(batchActions.departmentId, departments.id));

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
    for (const a of bAct) {
      if ((a.status === "waiting" || a.status === "blocked") && a.departmentName) {
        pendingDeptSet.add(a.departmentName);
      }
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
      closureReason: (b.closureReason ?? null) as CockpitRow["closureReason"],

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

  const allDepartments = await db
    .select({ id: departments.id, name: departments.name })
    .from(departments)
    .orderBy(asc(departments.sortOrder));

  const { statusLabel } = statusFor(b);

  return {
    batchId:    b.id,
    batchCode:  b.batchCode,
    modelYear:  [b.model, b.year].filter(Boolean).join(" ") || "—",
    dealerName: row.dealerName ?? "—",
    quantity:   b.requestedQuantity,
    lifecycleState: (b.lifecycleState ?? "post_po") as "pre_po" | "post_po",

    promisedDate: b.dealerPromisedDeliveryDate,
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
  };
}

/** Aggregate summary metrics for the top of the page. */
export function summarizeCockpit(rows: CockpitRow[]) {
  const total = rows.length;
  const withWaiting = rows.filter((r) => r.actionsWaiting > 0).length;
  const fullyDone   = rows.filter((r) => r.totalActions > 0 && r.actionsDone === r.totalActions).length;
  const delayed     = rows.filter((r) => r.delayDays > 0).length;
  return { total, withWaiting, fullyDone, delayed };
}

// Slack formatter moved to `lib/cockpit-slack.ts` so client components can
// import it without dragging the better-sqlite3 driver into the browser
// bundle. See lib/cockpit-slack.ts:formatStatusCheckMessage.

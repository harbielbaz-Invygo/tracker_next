/**
 * Performance report data layer — server-only aggregations.
 *
 * Pulls every batch_action joined with department, stakeholder, action
 * type, and batch info, then aggregates in JS. With our small dataset
 * (dozens to low-hundreds of batches) this is fast enough; if volumes
 * grow past ~10k actions, fold the aggregates into SQL with GROUP BY.
 *
 * Two attribution models were on the table:
 *   (α) time-in-action — average delay per completed action
 *   (β) delayed-batch ownership — count batches the dept owns one+ late actions in
 *
 * This module computes BOTH so the UI can show them side-by-side. The
 * table headers explain what each column means.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batchActions, actionTypes, departments, stakeholders, batches,
} from "@/lib/db/schema";
import { daysBetween } from "@/lib/expected-date";

export interface DepartmentRow {
  id: number;
  name: string;
  /** Total batch_actions assigned to this department, all statuses. */
  totalActions: number;
  doneActions: number;
  /** waiting + blocked. */
  activeActions: number;
  skippedActions: number;
  /** % of done actions that landed on or before expectedDate. Null when no done actions or none had expectedDate. */
  onTimeRate: number | null;
  /** Average completedAt − expectedDate (days, signed) over done actions with both dates set. */
  avgDelayDays: number | null;
  /** Largest single completedAt − expectedDate (days, signed). */
  worstDelayDays: number | null;
  /** Distinct batches where this department owns at least one delayed action. */
  delayedBatchesOwned: number;
}

export interface StakeholderRow {
  id: number;
  name: string;
  departmentName: string;
  totalActions: number;
  doneActions: number;
  activeActions: number;
  skippedActions: number;
  onTimeRate: number | null;
  avgDelayDays: number | null;
  worstDelayDays: number | null;
  delayedBatchesOwned: number;
}

export interface PerformanceReport {
  generatedAt: string;
  totals: {
    /** Total open + closed batches in the system. */
    totalBatches: number;
    /** Closed with reason="delivered" AND closedAt ≤ dealerPromisedDeliveryDate. */
    deliveredOnTime: number;
    /** Closed with reason="delivered" AND closedAt > dealerPromisedDeliveryDate. */
    deliveredLate: number;
    cancelled: number;
    /** Not yet closed. */
    open: number;
  };
  departments: DepartmentRow[];
  stakeholders: StakeholderRow[];
}

interface AggregateAccumulator {
  totalActions: number;
  doneActions: number;
  activeActions: number;
  skippedActions: number;
  /** delayDays values for done actions where expectedDate exists. */
  delayDays: number[];
  /** count of done actions where delayDays ≤ 0 (on time or early). */
  onTimeDoneCount: number;
  /** count of done actions where expectedDate exists at all. */
  measurableDoneCount: number;
  /** distinct batchIds that contain at least one late action owned by this aggregator. */
  delayedBatchIds: Set<number>;
}

function emptyAcc(): AggregateAccumulator {
  return {
    totalActions: 0,
    doneActions: 0,
    activeActions: 0,
    skippedActions: 0,
    delayDays: [],
    onTimeDoneCount: 0,
    measurableDoneCount: 0,
    delayedBatchIds: new Set(),
  };
}

function summarizeAcc(acc: AggregateAccumulator): {
  onTimeRate: number | null;
  avgDelayDays: number | null;
  worstDelayDays: number | null;
} {
  const onTimeRate = acc.measurableDoneCount > 0
    ? Math.round((acc.onTimeDoneCount / acc.measurableDoneCount) * 100)
    : null;
  const avgDelayDays = acc.delayDays.length > 0
    ? Math.round((acc.delayDays.reduce((a, b) => a + b, 0) / acc.delayDays.length) * 10) / 10
    : null;
  const worstDelayDays = acc.delayDays.length > 0
    ? Math.max(...acc.delayDays)
    : null;
  return { onTimeRate, avgDelayDays, worstDelayDays };
}

export async function getPerformanceReport(): Promise<PerformanceReport> {
  // Pull every batch_action joined with the metadata we need.
  const rows = await db
    .select({
      ba:           batchActions,
      atName:       actionTypes.name,
      deptId:       departments.id,
      deptName:     departments.name,
      stakeholderId:    stakeholders.id,
      stakeholderName:  stakeholders.name,
      // Batch context for delayed-batch attribution.
      batchId:                   batches.id,
      batchClosedAt:             batches.closedAt,
      batchClosureReason:        batches.closureReason,
      batchPromisedDate:         batches.dealerPromisedDeliveryDate,
    })
    .from(batchActions)
    .innerJoin(actionTypes,  eq(batchActions.actionTypeId, actionTypes.id))
    .leftJoin(departments,   eq(batchActions.departmentId, departments.id))
    .leftJoin(stakeholders,  eq(batchActions.assignedStakeholderId, stakeholders.id))
    .innerJoin(batches,      eq(batchActions.batchId, batches.id));

  // Pull all departments + stakeholders so the report includes ones with
  // zero actions (e.g. a newly added department). Without this, anyone
  // who hasn't been assigned anything yet would silently be missing.
  const allDepts = await db.select().from(departments);
  const allStakeholders = await db
    .select({
      id: stakeholders.id,
      name: stakeholders.name,
      departmentId: stakeholders.departmentId,
      departmentName: departments.name,
    })
    .from(stakeholders)
    .leftJoin(departments, eq(stakeholders.departmentId, departments.id));

  const todayIso = new Date().toISOString().slice(0, 10);
  const departmentAcc = new Map<number, AggregateAccumulator>();
  const stakeholderAcc = new Map<number, AggregateAccumulator>();

  for (const r of rows) {
    const ba = r.ba;
    const isDone     = ba.status === "done";
    const isSkipped  = ba.status === "skipped";
    const isActive   = ba.status === "waiting" || ba.status === "blocked";

    // Compute this action's delay (if measurable).
    //   - Done action with expectedDate → completedAt − expectedDate
    //   - Active action past expected → today − expectedDate (counts as late even though not done)
    let delayDays: number | null = null;
    let isLate = false;
    if (isDone && ba.expectedDate && ba.completedAt) {
      delayDays = daysBetween(ba.completedAt.slice(0, 10), ba.expectedDate);
      isLate = delayDays > 0;
    } else if (isActive && ba.expectedDate && todayIso > ba.expectedDate) {
      // Past-due active action — late but no completedAt yet
      isLate = true;
    }

    function bump(acc: AggregateAccumulator) {
      acc.totalActions++;
      if (isDone)    acc.doneActions++;
      if (isSkipped) acc.skippedActions++;
      if (isActive)  acc.activeActions++;
      if (isDone && delayDays !== null) {
        acc.delayDays.push(delayDays);
        acc.measurableDoneCount++;
        if (delayDays <= 0) acc.onTimeDoneCount++;
      }
      if (isLate) acc.delayedBatchIds.add(r.batchId);
    }

    if (r.deptId != null) {
      const acc = departmentAcc.get(r.deptId) ?? emptyAcc();
      bump(acc);
      departmentAcc.set(r.deptId, acc);
    }
    if (r.stakeholderId != null) {
      const acc = stakeholderAcc.get(r.stakeholderId) ?? emptyAcc();
      bump(acc);
      stakeholderAcc.set(r.stakeholderId, acc);
    }
  }

  // Build department rows. Include zero-action departments at the bottom.
  const departmentsList: DepartmentRow[] = allDepts.map((d) => {
    const acc = departmentAcc.get(d.id) ?? emptyAcc();
    return {
      id:   d.id,
      name: d.name,
      totalActions: acc.totalActions,
      doneActions: acc.doneActions,
      activeActions: acc.activeActions,
      skippedActions: acc.skippedActions,
      delayedBatchesOwned: acc.delayedBatchIds.size,
      ...summarizeAcc(acc),
    };
  });

  // Build stakeholder rows.
  const stakeholdersList: StakeholderRow[] = allStakeholders.map((s) => {
    const acc = stakeholderAcc.get(s.id) ?? emptyAcc();
    return {
      id:   s.id,
      name: s.name,
      departmentName: s.departmentName ?? "—",
      totalActions: acc.totalActions,
      doneActions: acc.doneActions,
      activeActions: acc.activeActions,
      skippedActions: acc.skippedActions,
      delayedBatchesOwned: acc.delayedBatchIds.size,
      ...summarizeAcc(acc),
    };
  });

  // Sort to surface concerns: highest avgDelayDays first, then most active actions.
  // Departments/stakeholders with no measurable delay sink to the bottom.
  function rankBy<T extends { avgDelayDays: number | null; activeActions: number; totalActions: number }>(rows: T[]): T[] {
    return rows.sort((a, b) => {
      const ad = a.avgDelayDays ?? -Infinity;
      const bd = b.avgDelayDays ?? -Infinity;
      if (ad !== bd) return bd - ad;
      if (a.activeActions !== b.activeActions) return b.activeActions - a.activeActions;
      return b.totalActions - a.totalActions;
    });
  }

  // Batch totals for the summary strip.
  const allBatches = await db.select({
    id: batches.id,
    closedAt: batches.closedAt,
    closureReason: batches.closureReason,
    promisedDate: batches.dealerPromisedDeliveryDate,
  }).from(batches);

  let deliveredOnTime = 0, deliveredLate = 0, cancelled = 0, open = 0;
  for (const b of allBatches) {
    if (!b.closedAt) { open++; continue; }
    if (b.closureReason === "cancelled") { cancelled++; continue; }
    if (b.closureReason === "delivered") {
      if (b.closedAt > b.promisedDate) deliveredLate++;
      else deliveredOnTime++;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      totalBatches: allBatches.length,
      deliveredOnTime,
      deliveredLate,
      cancelled,
      open,
    },
    departments: rankBy(departmentsList),
    stakeholders: rankBy(stakeholdersList),
  };
}

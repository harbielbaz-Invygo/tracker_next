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
import { eq, asc, gte, or, isNull, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  actionTypes, departments, stakeholders, batches, dealers, batchColorMatrix, batchDateRevisions, batchDeliveryLegs,
  // Phase 5c — single-source from the scope-aware `actions` table.
  // batch_actions reads are gone (table itself is dropped in phase 5d).
  waves, actions as actionsTable,
  // Review #4 R1 — per-PO reliability needs the pos table for PO-level
  // identity (poNumber → pos.id lookup) and to attribute back to a PO row.
  pos,
} from "@/lib/db/schema";
import {
  computePoReliability,
  aggregateDealerReliability,
  type ReliabilityBatch,
} from "@/lib/po-reliability";
import { derivePoClosureOutcome } from "@/lib/po-closure";
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
  /**
   * On-time rate per week, last 12 weeks (oldest first). null in
   * weeks with no done batch_actions for this department. Drives a
   * tiny sparkline in the Performance table row.
   */
  onTimeRateWeekly: (number | null)[];
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
  /** On-time rate per week, last 12 weeks (oldest first). Same shape as DepartmentRow. */
  onTimeRateWeekly: (number | null)[];
}

/**
 * Per-dealer PO reliability — the four trust dimensions discussed in the
 * onboarding logic design:
 *   1. Date       — did cars arrive on or before the promised date?
 *   2. Quantity   — did the dealer deliver the full requested quantity?
 *   3. Color      — did the dealer honor the ordered color breakdown?
 *   4. Cancellation — rate of POs that were cancelled (implicit city / commitment breach)
 *
 * Separated from the operational performance metrics (dept / stakeholder)
 * so management can track supplier trust independently of internal execution.
 */
export interface DealerReliabilityRow {
  dealerId: number;
  dealerName: string;
  dealerType: "old" | "new" | null;

  totalBatches: number;
  openBatches: number;
  deliveredBatches: number;
  cancelledBatches: number;

  /**
   * 1. Date reliability
   * % of delivered batches where closedAt ≤ dealerPromisedDeliveryDate.
   * Null when no batches have been delivered yet.
   */
  dateReliabilityRate: number | null;
  /**
   * Mean of (closedAt − dealerPromisedDeliveryDate) in days across delivered
   * batches. Negative = ahead of schedule. Null when no deliveries.
   */
  avgDateVarianceDays: number | null;

  /**
   * 2. Quantity reliability
   * sum(deliveredQuantity) / sum(requestedQuantity) × 100 across ALL batches
   * (open + closed — partial deliveries count against the dealer).
   * Null when no batches have any requestedQuantity > 0.
   */
  qtyFulfillmentRate: number | null;

  /**
   * 3. Color reliability
   * sum(confirmedQuantity) / sum(requestedQuantity) × 100 across ALL
   * batchColorMatrix rows for this dealer's batches. Uses confirmedQty
   * because deliveredQty is filled in later; confirmed is the earlier
   * and more consistently populated signal.
   * Null when no color matrix rows exist for this dealer.
   */
  colorReliabilityRate: number | null;

  /**
   * 4. Cancellation rate
   * cancelledBatches / totalBatches × 100. High rate = dealer frequently
   * fails to honour the PO entirely.
   */
  cancellationRate: number | null;

  /**
   * 5. Listing speed (Audit 2 #4) — answers "which dealers slow our
   * listings?" Median (appListedAt − requestedAt) in days across this
   * dealer's post_po batches that have been listed. Null when none
   * have been listed yet.
   */
  medianDaysToListed: number | null;

  /**
   * 6. Listing on-time rate (Audit 2 #4 companion).
   * % of this dealer's listed post_po batches where days-to-listed
   * ≤ 14. Same threshold as the global `unlistedOverThreshold`.
   * Null when no batches have been listed.
   */
  listingOnTimeRate: number | null;

  /**
   * 7. PO Reliability rollup (Audit 4 #2). Composite PO score across
   * the dealer's closed POs, in two flavours:
   *   - `poReliabilityMean`        — simple unweighted average per PO
   *   - `poReliabilityCarWeighted` — weighted by requestedCars per PO,
   *     so one large failed PO can't be masked by a handful of tiny
   *     perfect ones (the number leadership should trust)
   * Both null when the dealer has zero scored POs in the period.
   */
  poReliabilityMean: number | null;
  poReliabilityCarWeighted: number | null;
  /** PO count that contributed to the means above. */
  poReliabilityPoCount: number;
}

/**
 * One batch's contribution to customer impact. We include batches that
 * are late OR projected-late — both hurt customer experience, just on
 * different timelines.
 */
export interface CustomerImpactBatch {
  batchId: number;
  batchCode: string;
  dealerName: string;
  modelYear: string;
  /** How many vehicles in this batch — multiplier for impact. */
  quantity: number;

  /** The PO-locked promise date (the customer expectation). */
  promisedDate: string;
  /**
   * The realised or expected availability date.
   *   - Delivered batches → closedAt.
   *   - Open batches      → currentProjectedDeliveryDate.
   */
  effectiveDate: string;

  /** Days late: effectiveDate − promisedDate (always > 0 for affected batches). */
  delayDays: number;

  /**
   * Sum across `batch_date_revisions` of `bookingsAtShift × delayDays`
   * per shift event — the precise customer-impact measure (Phase H).
   * 0 when the batch has no recorded shifts (legacy batches or
   * deliveries that landed late without an explicit ops shift).
   */
  customerDaysImpact: number;

  /**
   * Peak bookings held against the batch at any shift moment (max of
   * `bookingsAtShift` across this batch's revisions). Approximates the
   * count of distinct customers exposed to the lateness. 0 when no
   * revisions exist.
   */
  affectedBookings: number;

  /** Whether the impact is already realised or still projected. */
  state: "delivered_late" | "projected_late";

  /** How many times this batch's projection has shifted (trust erosion). */
  revisionCount: number;

  /** Bucket for the distribution chart. */
  severity: "mild" | "moderate" | "severe";
}

export interface CustomerImpactReport {
  /** Affected batches, sorted by customerDaysImpact descending. */
  batches: CustomerImpactBatch[];
  totals: {
    /** Distinct batches that are late or projected-late. */
    affectedBatches: number;
    /** Sum of `quantity` across affected batches (customers feeling the slip). */
    affectedCustomers: number;
    /** Sum of `customerDaysImpact` — total customer-days lost / will lose. */
    customerDaysLost: number;
    /** Mean delayDays across affected batches. Null when none. */
    avgDelayDays: number | null;
    /** Sum of revisionCount across affected batches — total re-promises issued. */
    totalRePromises: number;

    /** Distribution by severity tier (counts of batches). */
    mild: number;     // 1–7 days late
    moderate: number; // 8–21 days late
    severe: number;   // > 21 days late

    /** Split by realisation state. */
    deliveredLateCount: number;
    projectedLateCount: number;
  };
}

// Period type + options moved to `lib/reports-period.ts` so the
// client <PeriodSelect> can import them without pulling this whole
// (server-only) module into the client bundle. See PR #69 lesson.
export { type ReportPeriod, REPORT_PERIODS } from "./reports-period";
import type { ReportPeriod } from "./reports-period";

/** Compute the inclusive lower-bound ISO date (yyyy-mm-dd) for a given period. Returns null for "all". */
function fromIsoForPeriod(period: ReportPeriod): string | null {
  if (period === "all") return null;
  const days = { "30d": 30, "90d": 90, "6m": 183 }[period];
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export interface PerformanceReport {
  generatedAt: string;
  /** The period filter that was applied to produce this report. */
  period: ReportPeriod;
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
  /** Per-dealer trust metrics — the four PO reliability dimensions. */
  dealerReliability: DealerReliabilityRow[];
  /** Customer impact from availability date shifts (item 4). */
  customerImpact: CustomerImpactReport;
  /**
   * Per-city reliability (Phase δ). Drawn from batch_delivery_legs joined
   * to their parent batch. Empty array when no multi-leg batches exist yet
   * — the lens is most useful once Phase β has been running for a while.
   */
  cityReliability: CityReliabilityRow[];
  /**
   * On-time delivery rate trend, weekly buckets for the last 12 weeks
   * (oldest first). Each bucket: { weekStart, rate (0-100 or null),
   * deliveredCount }. Powers the sparkline next to the hero rate card
   * on the Reports page.
   *
   * `rate` is null when no batches were delivered in that week (don't
   * skip the bucket — keep the weekly cadence so the spark renders at
   * consistent width).
   */
  onTimeRateWeekly: { weekStart: string; rate: number | null; deliveredCount: number }[];
  /**
   * Per-PO composite reliability (Review #4 R1+R2+R3+R6). One row
   * per PO with the 5-component composite plus a sibling Ops
   * Reliability score using the locked Ops projection. Drives the
   * Insights → PO Reliability tab + Action Center tree badges.
   */
  poReliability: PoReliabilityRowFull[];
}

export interface PoReliabilityRowFull {
  poId:          number;
  poNumber:      string;
  dealerId:      number;
  dealerName:    string;
  poDate:        string | null;
  /** When the PO closed (max closedAt across its batches). */
  closedAt:      string | null;
  /** True when every batch under the PO has closedAt set. */
  fullyClosed:   boolean;
  totalBatches:  number;
  closedBatches: number;
  /** PO Reliability — anchor: poExpectedDateAtLock. */
  po: {
    composite:        number;
    components: {
      date:         number;
      qty:          number;
      color:        number;
      cancellation: number;
      stability:    number;
    };
    dateVarianceDays: number | null;
  };
  /** Ops Reliability — anchor: opsProjectedDeliveryDateAtLock. */
  ops: {
    composite:        number;
    components: {
      date:         number;
      qty:          number;
      color:        number;
      cancellation: number;
      stability:    number;
    };
    dateVarianceDays: number | null;
  };
  /** opsAddedValue = ops.composite − po.composite. Positive means
   *  ops's locked bet was closer to reality than the original PO. */
  opsAddedValue: number;
  raw: {
    requestedCars:    number;
    deliveredCars:    number;
    cancelledCars:    number;
    cancelledBatches: number;
    shiftCount:       number;
  };
  /**
   * Closure outcome (Audit 1 #4) — derived, not stored. Categorical
   * end-state for the PO once every batch under it closes:
   *   - open                 → still in flight
   *   - delivered_in_full    → every batch delivered, qty met
   *   - partly_delivered     → at least one delivered, qty short
   *   - cancelled_mid_flight → no batch delivered
   */
  closureOutcome: import("@/lib/po-closure").PoClosureOutcome;
}

/**
 * One row per delivery city across the whole dataset. Joined from
 * batch_delivery_legs → batches, so date metrics (variance, on-time
 * rate) inherit the parent batch's promised vs closedAt date.
 */
export interface CityReliabilityRow {
  city: string;
  /** Total batches this city is a leg of (delivered + open + cancelled). */
  totalBatches: number;
  /** Batches delivered to this city (closureReason="delivered"). */
  deliveredBatches: number;
  /** Cars requested to this city across all batches. */
  carsRequested: number;
  /** Cars actually delivered to this city. */
  carsDelivered: number;
  /**
   * sum(deliveredQuantity) / sum(requestedQuantity) × 100, across all
   * legs for this city. Null when no cars requested.
   */
  qtyFulfillmentRate: number | null;
  /**
   * % of delivered batches in this city where closedAt ≤ promisedDate.
   * Null when no deliveries to this city yet.
   */
  dateReliabilityRate: number | null;
  /**
   * Mean (closedAt − promisedDate) in days across this city's delivered
   * batches. Negative = early. Null when no deliveries.
   */
  avgDateVarianceDays: number | null;
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

export async function getPerformanceReport(period: ReportPeriod = "all"): Promise<PerformanceReport> {
  const fromIso = fromIsoForPeriod(period);
  // Filter predicate — applied only when a finite period was chosen.
  // We keep rows whose completedAt is in the window OR is null (active
  // actions still count — they're in flight today). For batches the
  // closedAt window applies to the city-reliability lens further down.
  const batchInPeriod = fromIso
    ? or(isNull(batches.closedAt), gte(batches.closedAt, fromIso))
    : undefined;

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

  // Weekly on-time/late counters per owner, for the 12-week sparkline.
  // Indexed by owner id → array of 12 weekly buckets (oldest first).
  // Pre-compute the bucket boundaries once.
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
  const daysSinceMonday = (todayMidnight.getDay() + 6) % 7;
  const thisWeekStartMs = todayMidnight.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000;
  const bucketEdges = Array.from({ length: 12 }, (_, i) => thisWeekStartMs - (11 - i) * WEEK_MS);
  // bucketEdges[i] = start of bucket i; bucket i covers [edge, edge + WEEK_MS).
  const newWeekly = (): { onTime: number; late: number }[] =>
    Array.from({ length: 12 }, () => ({ onTime: 0, late: 0 }));
  const departmentWeekly = new Map<number, { onTime: number; late: number }[]>();
  const stakeholderWeekly = new Map<number, { onTime: number; late: number }[]>();

  // Phase 5c — single source. Pull every action row across all three
  // scopes (po + wave + batch) from the scope-aware `actions` table.
  // Period filter: completed-in-window OR not-yet-completed (active
  // actions still count — they're in flight today).
  const scopedRows = await (async () => {
    const q = db
      .select({
        scope:           actionsTable.scope,
        scopeId:         actionsTable.scopeId,
        status:          actionsTable.status,
        completedAt:     actionsTable.completedAt,
        expectedDate:    actionsTable.expectedDate,
        deptId:          departments.id,
        stakeholderId:   stakeholders.id,
      })
      .from(actionsTable)
      .leftJoin(departments,  eq(actionsTable.departmentId, departments.id))
      .leftJoin(stakeholders, eq(actionsTable.assignedStakeholderId, stakeholders.id))
      .$dynamic();
    return fromIso
      ? q.where(or(isNull(actionsTable.completedAt), gte(actionsTable.completedAt, fromIso)))
      : q;
  })();

  // Build wave→batches and po→batches lookups once. Used to fan out a
  // late wave/PO action's "delayed batches owned" attribution to every
  // batch beneath that level — matches operator intuition that a slow
  // Specs decision impacts ALL batches in the PO, not "one". Batch-
  // scope rows attribute to a single batch (their scopeId IS the
  // batchId), no lookup needed.
  const waveToBatches = new Map<number, number[]>();
  const poToBatches   = new Map<number, number[]>();
  if (scopedRows.some((r) => r.scope === "po" || r.scope === "wave")) {
    const allWaves = await db.select({ id: waves.id, poId: waves.poId }).from(waves);
    const allBatchIds = await db
      .select({ id: batches.id, waveId: batches.waveId })
      .from(batches);
    for (const b of allBatchIds) {
      if (b.waveId == null) continue;
      const arr = waveToBatches.get(b.waveId) ?? [];
      arr.push(b.id);
      waveToBatches.set(b.waveId, arr);
    }
    for (const w of allWaves) {
      const arr = poToBatches.get(w.poId) ?? [];
      arr.push(...(waveToBatches.get(w.id) ?? []));
      poToBatches.set(w.poId, arr);
    }
  }

  for (const r of scopedRows) {
    const isDone     = r.status === "done";
    const isSkipped  = r.status === "skipped";
    const isActive   = r.status === "waiting" || r.status === "blocked";

    let delayDays: number | null = null;
    let isLate = false;
    if (isDone && r.expectedDate && r.completedAt) {
      delayDays = daysBetween(r.completedAt.slice(0, 10), r.expectedDate);
      isLate = delayDays > 0;
    } else if (isActive && r.expectedDate && todayIso > r.expectedDate) {
      isLate = true;
    }

    let bucketIdx: number | null = null;
    if (isDone && r.completedAt && delayDays !== null) {
      const ts = new Date(r.completedAt).getTime();
      if (ts >= bucketEdges[0] && ts < thisWeekStartMs + WEEK_MS) {
        bucketIdx = Math.min(11, Math.floor((ts - bucketEdges[0]) / WEEK_MS));
      }
    }

    // Fan out: which batches does this action "cover"?
    //   po-scope   → every batch under that PO
    //   wave-scope → every batch in that wave
    //   batch-scope → just that one batch (scopeId IS the batchId)
    const coveredBatchIds = r.scope === "po"
      ? (poToBatches.get(r.scopeId)   ?? [])
      : r.scope === "wave"
        ? (waveToBatches.get(r.scopeId) ?? [])
        : [r.scopeId];

    function bumpScoped(acc: AggregateAccumulator) {
      acc.totalActions++;
      if (isDone)    acc.doneActions++;
      if (isSkipped) acc.skippedActions++;
      if (isActive)  acc.activeActions++;
      if (isDone && delayDays !== null) {
        acc.delayDays.push(delayDays);
        acc.measurableDoneCount++;
        if (delayDays <= 0) acc.onTimeDoneCount++;
      }
      if (isLate) for (const bid of coveredBatchIds) acc.delayedBatchIds.add(bid);
    }

    if (r.deptId != null) {
      const acc = departmentAcc.get(r.deptId) ?? emptyAcc();
      bumpScoped(acc);
      departmentAcc.set(r.deptId, acc);
      if (bucketIdx !== null && delayDays !== null) {
        const wk = departmentWeekly.get(r.deptId) ?? newWeekly();
        if (delayDays <= 0) wk[bucketIdx].onTime++; else wk[bucketIdx].late++;
        departmentWeekly.set(r.deptId, wk);
      }
    }
    if (r.stakeholderId != null) {
      const acc = stakeholderAcc.get(r.stakeholderId) ?? emptyAcc();
      bumpScoped(acc);
      stakeholderAcc.set(r.stakeholderId, acc);
      if (bucketIdx !== null && delayDays !== null) {
        const wk = stakeholderWeekly.get(r.stakeholderId) ?? newWeekly();
        if (delayDays <= 0) wk[bucketIdx].onTime++; else wk[bucketIdx].late++;
        stakeholderWeekly.set(r.stakeholderId, wk);
      }
    }
  }

  // Helper: convert weekly counts to per-week on-time rates (0-100 or null).
  // Same rule as the hero's onTimeRateWeekly — null when nothing done in
  // that week, so the sparkline renders gaps instead of false zeros.
  function ratesFromWeekly(wk: { onTime: number; late: number }[] | undefined): (number | null)[] {
    if (!wk) return Array.from({ length: 12 }, () => null);
    return wk.map(({ onTime, late }) => {
      const total = onTime + late;
      return total > 0 ? Math.round((onTime / total) * 100) : null;
    });
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
      onTimeRateWeekly: ratesFromWeekly(departmentWeekly.get(d.id)),
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
      onTimeRateWeekly: ratesFromWeekly(stakeholderWeekly.get(s.id)),
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

  // ── Batch totals + dealer reliability data (one extra round-trip) ─────
  // Customer-impact analysis (item 4) needs a wider projection: batchCode,
  // model/year for display, projectedDate to score open batches, and the
  // revisionCount to measure trust erosion from repeated re-promises.
  // Same period filter we applied to the actions query — applied to
  // batches (and joined queries on batches) so the totals and the
  // dealer reliability are scoped consistently. Open batches always
  // pass (closedAt IS NULL); closed batches must have closedAt
  // within the window.
  // Defensive: the at-lock columns + batch_color_matrix.delivered_
  // quantity are newer additions. On a DB that hasn't run the
  // matching ensure-* migration yet, the explicit projection 500s
  // the entire Insights page. Two-step degradation: try the
  // enriched projection first; on "no such column" fall back to
  // the legacy shape and synthesize the missing fields as null/0.
  const allBatchesQuery = (async () => {
    const enrichedQuery = (() => {
      const q = db.select({
        id:            batches.id,
        batchCode:     batches.batchCode,
        dealerId:      batches.dealerId,
        dealerName:    dealers.name,
        model:         batches.model,
        year:          batches.year,
        closedAt:      batches.closedAt,
        closureReason: batches.closureReason,
        promisedDate:  batches.dealerPromisedDeliveryDate,
        projectedDate: batches.currentProjectedDeliveryDate,
        requestedQty:  batches.requestedQuantity,
        deliveredQty:  batches.deliveredQuantity,
        revisionCount: batches.deliveryDateRevisionCount,
        // Review #4 R1+R6 — PO identity + the two at-lock anchors.
        poNumber:                       batches.poNumber,
        poExpectedDateAtLock:           batches.poExpectedDateAtLock,
        opsProjectedDeliveryDateAtLock: batches.opsProjectedDeliveryDateAtLock,
        // Audit 2 #4 — supplier listing-delay needs these.
        requestedAt:                    batches.requestedAt,
        appListedAt:                    batches.appListedAt,
      })
      .from(batches)
      .leftJoin(dealers, eq(batches.dealerId, dealers.id))
      .$dynamic();
      return batchInPeriod ? q.where(batchInPeriod) : q;
    })();
    try {
      return await enrichedQuery;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/no such column/i.test(msg)) throw err;
      // eslint-disable-next-line no-console
      console.warn(
        "[reports-data] batches at-lock columns missing — falling back to legacy projection. " +
        "Run /api/admin/ensure-{po,ops}-*-at-lock-column to migrate.",
      );
      const legacyQuery = (() => {
        const q = db.select({
          id:            batches.id,
          batchCode:     batches.batchCode,
          dealerId:      batches.dealerId,
          dealerName:    dealers.name,
          model:         batches.model,
          year:          batches.year,
          closedAt:      batches.closedAt,
          closureReason: batches.closureReason,
          promisedDate:  batches.dealerPromisedDeliveryDate,
          projectedDate: batches.currentProjectedDeliveryDate,
          requestedQty:  batches.requestedQuantity,
          deliveredQty:  batches.deliveredQuantity,
          revisionCount: batches.deliveryDateRevisionCount,
          poNumber:      batches.poNumber,
          requestedAt:   batches.requestedAt,
          appListedAt:   batches.appListedAt,
        })
        .from(batches)
        .leftJoin(dealers, eq(batches.dealerId, dealers.id))
        .$dynamic();
        return batchInPeriod ? q.where(batchInPeriod) : q;
      })();
      const rows = await legacyQuery;
      return rows.map((r) => ({
        ...r,
        poExpectedDateAtLock:           null as string | null,
        opsProjectedDeliveryDateAtLock: null as string | null,
      }));
    }
  })();
  const colorMatrixQuery = (async () => {
    const enrichedQuery = (() => {
      const q = db.select({
        batchId:           batchColorMatrix.batchId,
        dealerId:          batches.dealerId,
        color:             batchColorMatrix.color,
        requestedQuantity: batchColorMatrix.requestedQuantity,
        confirmedQuantity: batchColorMatrix.confirmedQuantity,
        // Review #4 R7 — delivered preferred over confirmed when
        // realised. Defensive against pre-migration DBs below.
        deliveredQuantity: batchColorMatrix.deliveredQuantity,
      })
      .from(batchColorMatrix)
      .innerJoin(batches, eq(batchColorMatrix.batchId, batches.id))
      .$dynamic();
      return batchInPeriod ? q.where(batchInPeriod) : q;
    })();
    try {
      return await enrichedQuery;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/no such column/i.test(msg)) throw err;
      // eslint-disable-next-line no-console
      console.warn(
        "[reports-data] batch_color_matrix.delivered_quantity missing — " +
        "falling back to confirmed-only mode.",
      );
      const legacyQuery = (() => {
        const q = db.select({
          batchId:           batchColorMatrix.batchId,
          dealerId:          batches.dealerId,
          color:             batchColorMatrix.color,
          requestedQuantity: batchColorMatrix.requestedQuantity,
          confirmedQuantity: batchColorMatrix.confirmedQuantity,
        })
        .from(batchColorMatrix)
        .innerJoin(batches, eq(batchColorMatrix.batchId, batches.id))
        .$dynamic();
        return batchInPeriod ? q.where(batchInPeriod) : q;
      })();
      const rows = await legacyQuery;
      return rows.map((r) => ({ ...r, deliveredQuantity: 0 }));
    }
  })();
  // pos rows — needed for the per-PO reliability row's poId identity.
  // Wrapped defensively so legacy DBs without the table don't 500
  // the whole report.
  const posQuery = (async () => {
    try {
      return await db.select({
        id:       pos.id,
        poNumber: pos.poNumber,
        poDate:   pos.poDate,
        dealerId: pos.dealerId,
        closedAt: pos.closedAt,
      }).from(pos);
    } catch {
      return [] as {
        id: number; poNumber: string; poDate: string | null;
        dealerId: number; closedAt: string | null;
      }[];
    }
  })();
  const [allBatches, allDealers, colorMatrixRows, posRows] = await Promise.all([
    allBatchesQuery,
    db.select().from(dealers).orderBy(asc(dealers.name)),
    colorMatrixQuery,
    posQuery,
  ]);

  // Phase H: fetch every shift event (batch_date_revisions) so the
  // customer-impact metric becomes precise per-shift instead of the
  // earlier `quantity × total_delay` approximation. Defensive: if the
  // table doesn't exist yet (Phase A migration not run on this DB),
  // treat as empty so the rest of the report still loads.
  const revisionsByBatch = new Map<number, { bookingsAtShift: number; delayDays: number }[]>();
  try {
    const revisions = await db
      .select({
        batchId:          batchDateRevisions.batchId,
        bookingsAtShift:  batchDateRevisions.bookingsAtShift,
        delayDays:        batchDateRevisions.delayDays,
      })
      .from(batchDateRevisions);
    for (const r of revisions) {
      const arr = revisionsByBatch.get(r.batchId) ?? [];
      arr.push({
        bookingsAtShift: r.bookingsAtShift ?? 0,
        delayDays:       r.delayDays ?? 0,
      });
      revisionsByBatch.set(r.batchId, arr);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(msg)) {
      // eslint-disable-next-line no-console
      console.warn("[reports] batch_date_revisions missing — customer-impact metric falls back to zero. Run `npm run db:push`.");
    } else {
      throw err;
    }
  }

  // ── Summary strip totals ────────────────────────────────────────────
  let deliveredOnTime = 0, deliveredLate = 0, cancelled = 0, open = 0;
  for (const b of allBatches) {
    if (!b.closedAt) { open++; continue; }
    if (b.closureReason === "cancelled") { cancelled++; continue; }
    if (b.closureReason === "delivered") {
      if (b.closedAt > b.promisedDate) deliveredLate++;
      else deliveredOnTime++;
    }
  }

  // ── On-time rate trend — weekly buckets, last 12 weeks ────────────
  // For every batch that was DELIVERED (closureReason="delivered"),
  // bucket by the week of its closedAt date and compute the on-time
  // rate within that week. Cancelled batches don't count toward the
  // trend (they weren't delivered at all). Open batches don't count
  // either (the trend measures realised outcomes).
  //
  // 12 weeks is enough to see a quarter-scale trend without flattening
  // out per-week variation into a single average. Empty weeks render
  // as gaps in the sparkline.
  const onTimeRateWeekly = (() => {
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    // Week start = the most recent Monday on or before today, then
    // step backwards in 7-day chunks. Using local-midnight to keep
    // bucket boundaries readable in the UI.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, ...
    const daysSinceMonday = (dayOfWeek + 6) % 7; // 0 if Monday, 6 if Sunday
    const thisWeekStart = new Date(today.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
    const buckets: { weekStart: string; rate: number | null; deliveredCount: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const weekStartMs = thisWeekStart.getTime() - i * WEEK_MS;
      const weekEndMs   = weekStartMs + WEEK_MS;
      let onTime = 0;
      let late = 0;
      for (const b of allBatches) {
        if (!b.closedAt || b.closureReason !== "delivered") continue;
        const ts = new Date(b.closedAt + "T12:00:00Z").getTime();
        if (ts < weekStartMs || ts >= weekEndMs) continue;
        if (b.closedAt > b.promisedDate) late++;
        else onTime++;
      }
      const delivered = onTime + late;
      buckets.push({
        weekStart: new Date(weekStartMs).toISOString().slice(0, 10),
        rate: delivered > 0 ? Math.round((onTime / delivered) * 100) : null,
        deliveredCount: delivered,
      });
    }
    return buckets;
  })();

  // ── Dealer reliability aggregation ─────────────────────────────────

  interface DealerAcc {
    total: number;
    open: number;
    delivered: number;
    cancelled: number;
    /** Signed date variance in days for each delivered batch. */
    dateVariances: number[];
    /** requestedQty sum across all batches. */
    totalRequestedQty: number;
    /** deliveredQty sum across all batches. */
    totalDeliveredQty: number;
    /** Audit 2 #4 — days-to-listed samples for the dealer's listed batches. */
    listingDays: number[];
    /** Count of listed batches with days-to-listed ≤ 14 (the SLA). */
    listingOnTimeCount: number;
  }

  const dealerAcc = new Map<number, DealerAcc>();

  function ensureDealer(id: number): DealerAcc {
    if (!dealerAcc.has(id)) {
      dealerAcc.set(id, {
        total: 0, open: 0, delivered: 0, cancelled: 0,
        dateVariances: [],
        totalRequestedQty: 0, totalDeliveredQty: 0,
        listingDays: [],
        listingOnTimeCount: 0,
      });
    }
    return dealerAcc.get(id)!;
  }

  for (const b of allBatches) {
    const acc = ensureDealer(b.dealerId);
    acc.total++;
    acc.totalRequestedQty += b.requestedQty ?? 0;
    acc.totalDeliveredQty += b.deliveredQty ?? 0;

    if (!b.closedAt) {
      acc.open++;
    } else if (b.closureReason === "cancelled") {
      acc.cancelled++;
    } else if (b.closureReason === "delivered") {
      acc.delivered++;
      // Signed variance: positive = late, negative = early.
      const variance = daysBetween(b.closedAt, b.promisedDate);
      acc.dateVariances.push(variance);
    }

    // Audit 2 #4 — listing speed. Only counts batches actually listed
    // (we need both anchors). Same metric the hero uses globally,
    // bucketed per dealer here.
    if (b.appListedAt && b.requestedAt) {
      const days = Math.round(
        (new Date(b.appListedAt.slice(0, 10)).getTime() - new Date(b.requestedAt).getTime())
          / (24 * 60 * 60 * 1000),
      );
      if (days >= 0) {
        acc.listingDays.push(days);
        if (days <= 14) acc.listingOnTimeCount++;
      }
    }
  }

  // Color matrix: sum confirmed vs requested per dealer.
  const colorByDealer = new Map<number, { confirmed: number; requested: number }>();
  for (const row of colorMatrixRows) {
    const c = colorByDealer.get(row.dealerId) ?? { confirmed: 0, requested: 0 };
    c.confirmed += row.confirmedQuantity ?? 0;
    c.requested += row.requestedQuantity ?? 0;
    colorByDealer.set(row.dealerId, c);
  }

  // Build dealer reliability rows. Dealers with zero batches in the
  // current period are filtered out below — they're noise that makes
  // the table feel stale (showing dealer rows that never had any
  // activity in the window the user is looking at).
  const dealerReliability: DealerReliabilityRow[] = allDealers.map((d) => {
    const acc = dealerAcc.get(d.id) ?? {
      total: 0, open: 0, delivered: 0, cancelled: 0,
      dateVariances: [], totalRequestedQty: 0, totalDeliveredQty: 0,
      listingDays: [], listingOnTimeCount: 0,
    };
    const color = colorByDealer.get(d.id);

    // Date reliability
    const dateReliabilityRate = acc.delivered > 0
      ? Math.round((acc.dateVariances.filter((v) => v <= 0).length / acc.delivered) * 100)
      : null;
    const avgDateVarianceDays = acc.dateVariances.length > 0
      ? Math.round(
          (acc.dateVariances.reduce((a, b) => a + b, 0) / acc.dateVariances.length) * 10,
        ) / 10
      : null;

    // Quantity reliability
    const qtyFulfillmentRate = acc.totalRequestedQty > 0
      ? Math.round((acc.totalDeliveredQty / acc.totalRequestedQty) * 1000) / 10
      : null;

    // Color reliability
    const colorReliabilityRate =
      color && color.requested > 0
        ? Math.round((color.confirmed / color.requested) * 1000) / 10
        : null;

    // Cancellation rate
    const cancellationRate = acc.total > 0
      ? Math.round((acc.cancelled / acc.total) * 1000) / 10
      : null;

    // Audit 2 #4 — listing speed per dealer.
    let medianDaysToListed: number | null = null;
    if (acc.listingDays.length > 0) {
      const sorted = acc.listingDays.slice().sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      medianDaysToListed = sorted.length % 2 === 0
        ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
        : sorted[mid];
    }
    const listingOnTimeRate = acc.listingDays.length > 0
      ? Math.round((acc.listingOnTimeCount / acc.listingDays.length) * 100)
      : null;

    return {
      dealerId:   d.id,
      dealerName: d.name,
      dealerType: d.dealerType as "old" | "new" | null,
      totalBatches:     acc.total,
      openBatches:      acc.open,
      deliveredBatches: acc.delivered,
      cancelledBatches: acc.cancelled,
      dateReliabilityRate,
      avgDateVarianceDays,
      qtyFulfillmentRate,
      colorReliabilityRate,
      cancellationRate,
      medianDaysToListed,
      listingOnTimeRate,
      // Audit 4 #2 rollup — patched in after the poReliability loop runs.
      poReliabilityMean:        null,
      poReliabilityCarWeighted: null,
      poReliabilityPoCount:     0,
    };
  });

  // Filter out dealers with no batches in scope — they're noise.
  // Then sort so the most-active dealers land at the top.
  const dealerReliabilityFiltered = dealerReliability
    .filter((r) => r.totalBatches > 0)
    .sort((a, b) => b.totalBatches - a.totalBatches);

  // ── City reliability (Phase δ) ─────────────────────────────────────
  // Aggregates batch_delivery_legs joined with their parent batch so the
  // per-city lens picks up the parent's promised vs closedAt date.
  // Defensive: legs table may be missing on older DBs that pre-date α.
  type CityAcc = {
    totalBatches: Set<number>;
    deliveredBatches: Set<number>;
    carsRequested: number;
    carsDelivered: number;
    /** Signed variances for delivered batches (closedAt − promised). */
    dateVariances: number[];
  };
  const cityAcc = new Map<string, CityAcc>();
  function ensureCity(city: string): CityAcc {
    if (!cityAcc.has(city)) {
      cityAcc.set(city, {
        totalBatches: new Set(),
        deliveredBatches: new Set(),
        carsRequested: 0,
        carsDelivered: 0,
        dateVariances: [],
      });
    }
    return cityAcc.get(city)!;
  }
  let legRows: {
    city: string;
    requestedQuantity: number;
    deliveredQuantity: number | null;
    batchId: number;
    closedAt: string | null;
    closureReason: string | null;
    promisedDate: string;
  }[] = [];
  try {
    legRows = await db
      .select({
        city:               batchDeliveryLegs.city,
        requestedQuantity:  batchDeliveryLegs.requestedQuantity,
        deliveredQuantity:  batchDeliveryLegs.deliveredQuantity,
        batchId:            batches.id,
        closedAt:           batches.closedAt,
        closureReason:      batches.closureReason,
        promisedDate:       batches.dealerPromisedDeliveryDate,
      })
      .from(batchDeliveryLegs)
      .innerJoin(batches, eq(batches.id, batchDeliveryLegs.batchId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no such table/i.test(msg)) throw err;
    // eslint-disable-next-line no-console
    console.warn("[reports] batch_delivery_legs missing — city reliability lens shows empty. Run the Phase α migration.");
  }

  for (const r of legRows) {
    const acc = ensureCity(r.city);
    acc.totalBatches.add(r.batchId);
    acc.carsRequested += r.requestedQuantity;
    acc.carsDelivered += r.deliveredQuantity ?? 0;
    if (r.closedAt && r.closureReason === "delivered") {
      acc.deliveredBatches.add(r.batchId);
      acc.dateVariances.push(daysBetween(r.closedAt, r.promisedDate));
    }
  }

  const cityReliability: CityReliabilityRow[] = Array.from(cityAcc.entries()).map(([city, acc]) => {
    const dateReliabilityRate = acc.deliveredBatches.size > 0
      ? Math.round((acc.dateVariances.filter((v) => v <= 0).length / acc.deliveredBatches.size) * 100)
      : null;
    const avgDateVarianceDays = acc.dateVariances.length > 0
      ? Math.round((acc.dateVariances.reduce((a, b) => a + b, 0) / acc.dateVariances.length) * 10) / 10
      : null;
    const qtyFulfillmentRate = acc.carsRequested > 0
      ? Math.round((acc.carsDelivered / acc.carsRequested) * 1000) / 10
      : null;
    return {
      city,
      totalBatches:      acc.totalBatches.size,
      deliveredBatches:  acc.deliveredBatches.size,
      carsRequested:     acc.carsRequested,
      carsDelivered:     acc.carsDelivered,
      qtyFulfillmentRate,
      dateReliabilityRate,
      avgDateVarianceDays,
    };
  });
  // Most-active cities at top.
  cityReliability.sort((a, b) => b.totalBatches - a.totalBatches);

  // ── Customer impact (item 4) ───────────────────────────────────────
  // A batch is "affected" when its effective availability date lands
  // after the dealer-promised date. We evaluate both delivered batches
  // (truth — closedAt) and open batches (forecast — projectedDate).
  // Cancelled batches are excluded; cancellation is its own trust signal
  // already covered by `dealerReliability.cancellationRate`.
  const impactBatches: CustomerImpactBatch[] = [];
  for (const b of allBatches) {
    if (b.closureReason === "cancelled") continue;

    let effectiveDate: string | null = null;
    let state: CustomerImpactBatch["state"] | null = null;

    if (b.closedAt && b.closureReason === "delivered") {
      effectiveDate = b.closedAt;
      state = "delivered_late";
    } else if (!b.closedAt && b.projectedDate) {
      effectiveDate = b.projectedDate;
      state = "projected_late";
    } else {
      // Open batch with no projection — nothing to measure.
      continue;
    }

    const delayDays = daysBetween(effectiveDate, b.promisedDate);
    if (delayDays <= 0) continue; // on time or early — no customer impact

    const qty = b.requestedQty ?? 0;

    // Phase H: customer-days impact comes from the revisions log
    // (bookings at shift × delay added by shift), summed per batch.
    // Zero when no revisions exist for this batch — legacy / silently-
    // late deliveries land here. Dealer reliability still records the
    // raw date variance separately, so the signal isn't lost.
    const revs = revisionsByBatch.get(b.id) ?? [];
    let customerDaysImpact = 0;
    let affectedBookings = 0;
    for (const r of revs) {
      if (r.bookingsAtShift > 0 && r.delayDays > 0) {
        customerDaysImpact += r.bookingsAtShift * r.delayDays;
      }
      if (r.bookingsAtShift > affectedBookings) {
        affectedBookings = r.bookingsAtShift;
      }
    }

    const severity: CustomerImpactBatch["severity"] =
      delayDays > 21 ? "severe"
      : delayDays > 7 ? "moderate"
      : "mild";

    const modelYear = [b.model, b.year].filter(Boolean).join(" ") || "—";

    impactBatches.push({
      batchId:       b.id,
      batchCode:     b.batchCode,
      dealerName:    b.dealerName ?? "—",
      modelYear,
      quantity:      qty,
      promisedDate:  b.promisedDate,
      effectiveDate,
      delayDays,
      customerDaysImpact,
      affectedBookings,
      state,
      revisionCount: b.revisionCount ?? 0,
      severity,
    });
  }

  // Highest customer-days impact first — that's where ops attention pays
  // off most. Ties broken by raw delay days (longer slip wins).
  impactBatches.sort((a, b) => {
    if (b.customerDaysImpact !== a.customerDaysImpact)
      return b.customerDaysImpact - a.customerDaysImpact;
    return b.delayDays - a.delayDays;
  });

  let mild = 0, moderate = 0, severe = 0;
  let deliveredLateCount = 0, projectedLateCount = 0;
  let affectedCustomers = 0, customerDaysLost = 0, totalRePromises = 0;
  let delaySum = 0;
  for (const b of impactBatches) {
    if (b.severity === "mild")     mild++;
    if (b.severity === "moderate") moderate++;
    if (b.severity === "severe")   severe++;
    if (b.state === "delivered_late") deliveredLateCount++;
    if (b.state === "projected_late") projectedLateCount++;
    // Phase H: affected customers = peak bookings held during shifts
    // (closer to "distinct customers exposed") instead of raw qty.
    // Fall back to qty when no revisions exist so the metric isn't
    // zero on legacy data.
    affectedCustomers += b.affectedBookings > 0 ? b.affectedBookings : b.quantity;
    customerDaysLost += b.customerDaysImpact;
    totalRePromises  += b.revisionCount;
    delaySum         += b.delayDays;
  }
  const avgDelayDays = impactBatches.length > 0
    ? Math.round((delaySum / impactBatches.length) * 10) / 10
    : null;

  const customerImpact: CustomerImpactReport = {
    batches: impactBatches,
    totals: {
      affectedBatches: impactBatches.length,
      affectedCustomers,
      customerDaysLost,
      avgDelayDays,
      totalRePromises,
      mild,
      moderate,
      severe,
      deliveredLateCount,
      projectedLateCount,
    },
  };

  // ── Review #4 R1+R2+R3+R6 — Per-PO Reliability Score ────────────
  // Group batches by poNumber (the natural PO identity — pos.id
  // exists too but isn't FK'd from batches), then shape each PO's
  // batches into the ReliabilityBatch contract `lib/po-reliability`
  // expects. Excludes Pre-PO and PO-less rows.
  const colorByBatch = new Map<number, {
    color: string; requested: number; confirmed: number; delivered: number;
  }[]>();
  for (const c of colorMatrixRows) {
    const arr = colorByBatch.get(c.batchId) ?? [];
    arr.push({
      color:     c.color,
      requested: c.requestedQuantity ?? 0,
      confirmed: c.confirmedQuantity ?? 0,
      delivered: c.deliveredQuantity ?? 0,
    });
    colorByBatch.set(c.batchId, arr);
  }

  const batchesByPo = new Map<string, typeof allBatches>();
  for (const b of allBatches) {
    if (!b.poNumber) continue;
    const arr = batchesByPo.get(b.poNumber) ?? [];
    arr.push(b);
    batchesByPo.set(b.poNumber, arr);
  }

  const poRowByNumber = new Map<string, (typeof posRows)[number]>();
  for (const p of posRows) poRowByNumber.set(p.poNumber, p);

  const dealerById = new Map<number, typeof allDealers[number]>();
  for (const d of allDealers) dealerById.set(d.id, d);

  const poReliability: PoReliabilityRowFull[] = [];
  for (const [poNumber, batchesForPo] of batchesByPo.entries()) {
    // Skip POs with zero closed batches — reliability is meaningful
    // only against realised closures.
    const closedCount = batchesForPo.filter((b) => b.closedAt != null).length;
    if (closedCount === 0) continue;

    const poRow = poRowByNumber.get(poNumber) ?? null;
    const firstBatch = batchesForPo[0];
    const dealerId = firstBatch.dealerId;
    const dealerName = dealerById.get(dealerId)?.name ?? firstBatch.dealerName ?? "—";

    // Shape into the pure scorer's input.
    const shaped: ReliabilityBatch[] = batchesForPo.map((b) => ({
      batchCode:                       b.batchCode,
      requestedQuantity:               b.requestedQty,
      deliveredQuantity:               b.deliveredQty ?? 0,
      closedAt:                        b.closedAt,
      closureReason:                   (b.closureReason ?? null) as
                                         "delivered" | "cancelled" | null,
      poExpectedDateAtLock:            b.poExpectedDateAtLock,
      opsProjectedDeliveryDateAtLock:  b.opsProjectedDeliveryDateAtLock,
      dealerPromisedDeliveryDate:      b.promisedDate,
      currentProjectedDeliveryDate:    b.projectedDate,
      shiftCount:                      b.revisionCount ?? 0,
      colors:                          colorByBatch.get(b.id) ?? [],
    }));
    const scored = computePoReliability(shaped);

    const latestClose = batchesForPo
      .map((b) => b.closedAt)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1) ?? null;

    poReliability.push({
      poId:          poRow?.id ?? 0,
      poNumber,
      dealerId,
      dealerName,
      poDate:        poRow?.poDate ?? null,
      closedAt:      latestClose,
      fullyClosed:   closedCount === batchesForPo.length,
      totalBatches:  batchesForPo.length,
      closedBatches: closedCount,
      po:  {
        composite:        scored.po.composite,
        components:       scored.po.components,
        dateVarianceDays: scored.po.dateVarianceDays,
      },
      ops: {
        composite:        scored.ops.composite,
        components:       scored.ops.components,
        dateVarianceDays: scored.ops.dateVarianceDays,
      },
      opsAddedValue: scored.opsAddedValue,
      raw: {
        requestedCars:    scored.po.raw.requestedCars,
        deliveredCars:    scored.po.raw.deliveredCars,
        cancelledCars:    scored.po.raw.cancelledCars,
        cancelledBatches: scored.po.raw.cancelledBatches,
        shiftCount:       scored.po.raw.shiftCount,
      },
      closureOutcome: derivePoClosureOutcome(batchesForPo.map((b) => ({
        closedAt:          b.closedAt,
        closureReason:     (b.closureReason ?? null) as "delivered" | "cancelled" | null,
        requestedQuantity: b.requestedQty,
        deliveredQuantity: b.deliveredQty ?? 0,
      }))),
    });
  }
  // Audit 4 #2 — dealer PO Reliability rollup. Bucket the per-PO
  // scores by dealer, then run the pure aggregator. Patches the
  // (mean, carWeightedMean, count) onto the dealer rows that were
  // built earlier. Doing this after the per-PO loop avoids a second
  // pass over batches.
  const scoresByDealer = new Map<number, { composite: number; requestedCars: number }[]>();
  for (const p of poReliability) {
    const arr = scoresByDealer.get(p.dealerId) ?? [];
    arr.push({ composite: p.po.composite, requestedCars: p.raw.requestedCars });
    scoresByDealer.set(p.dealerId, arr);
  }
  for (const row of dealerReliability) {
    const scores = scoresByDealer.get(row.dealerId);
    if (!scores || scores.length === 0) continue;
    const rollup = aggregateDealerReliability(scores);
    row.poReliabilityMean        = rollup.mean;
    row.poReliabilityCarWeighted = rollup.carWeightedMean;
    row.poReliabilityPoCount     = rollup.n;
  }

  // Sort: lowest composite first (problematic POs surface to the
  // top — same pattern as the customer impact table).
  poReliability.sort((a, b) => a.po.composite - b.po.composite);

  return {
    generatedAt: new Date().toISOString(),
    period,
    totals: {
      totalBatches: allBatches.length,
      deliveredOnTime,
      deliveredLate,
      cancelled,
      open,
    },
    departments: rankBy(departmentsList),
    stakeholders: rankBy(stakeholdersList),
    dealerReliability: dealerReliabilityFiltered,
    customerImpact,
    cityReliability,
    onTimeRateWeekly,
    poReliability,
  };
}

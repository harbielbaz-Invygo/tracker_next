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
import { eq, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batchActions, actionTypes, departments, stakeholders, batches, dealers, batchColorMatrix, batchDateRevisions, batchDeliveryLegs,
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

  // ── Batch totals + dealer reliability data (one extra round-trip) ─────
  // Customer-impact analysis (item 4) needs a wider projection: batchCode,
  // model/year for display, projectedDate to score open batches, and the
  // revisionCount to measure trust erosion from repeated re-promises.
  const [allBatches, allDealers, colorMatrixRows] = await Promise.all([
    db.select({
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
    })
    .from(batches)
    .leftJoin(dealers, eq(batches.dealerId, dealers.id)),
    db.select().from(dealers).orderBy(asc(dealers.name)),
    // Color matrix for color reliability per dealer.
    db.select({
      batchId:           batchColorMatrix.batchId,
      dealerId:          batches.dealerId,
      requestedQuantity: batchColorMatrix.requestedQuantity,
      confirmedQuantity: batchColorMatrix.confirmedQuantity,
    })
    .from(batchColorMatrix)
    .innerJoin(batches, eq(batchColorMatrix.batchId, batches.id)),
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
  }

  const dealerAcc = new Map<number, DealerAcc>();

  function ensureDealer(id: number): DealerAcc {
    if (!dealerAcc.has(id)) {
      dealerAcc.set(id, {
        total: 0, open: 0, delivered: 0, cancelled: 0,
        dateVariances: [],
        totalRequestedQty: 0, totalDeliveredQty: 0,
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
  }

  // Color matrix: sum confirmed vs requested per dealer.
  const colorByDealer = new Map<number, { confirmed: number; requested: number }>();
  for (const row of colorMatrixRows) {
    const c = colorByDealer.get(row.dealerId) ?? { confirmed: 0, requested: 0 };
    c.confirmed += row.confirmedQuantity ?? 0;
    c.requested += row.requestedQuantity ?? 0;
    colorByDealer.set(row.dealerId, c);
  }

  // Build dealer reliability rows — include every dealer even if no batches.
  const dealerReliability: DealerReliabilityRow[] = allDealers.map((d) => {
    const acc = dealerAcc.get(d.id) ?? {
      total: 0, open: 0, delivered: 0, cancelled: 0,
      dateVariances: [], totalRequestedQty: 0, totalDeliveredQty: 0,
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
    };
  });

  // Sort: dealers with most batches first (most relevant at top).
  dealerReliability.sort((a, b) => b.totalBatches - a.totalBatches);

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
    dealerReliability,
    customerImpact,
    cityReliability,
  };
}

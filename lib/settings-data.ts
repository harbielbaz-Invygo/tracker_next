/**
 * Settings page data layer — server-only.
 *
 * One round-trip pulls everything every editor renders:
 *   - departments
 *   - action types (with their dependency parents resolved)
 *   - dealers (for the batch editor's dealer dropdown)
 *   - batches (full editable detail + per-batch action summary)
 *   - rules (key/value tunables)
 */
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  departments, stakeholders, actionTypes, actionDependencies,
  dealers, batches, actions as actionsTable, users,
  vinChaseStages,
} from "@/lib/db/schema";
import { getAllRules } from "@/lib/rules";

export interface SettingsData {
  departments: {
    id: number;
    name: string;
    sortOrder: number;
    /** Stakeholders within this department, sorted by sortOrder. */
    stakeholders: { id: number; name: string; sortOrder: number }[];
  }[];
  actionTypes: {
    id: number;
    name: string;
    waitingLabel: string;
    doneLabel: string;
    defaultDepartmentId: number | null;
    sortOrder: number;
    dependsOnIds: number[];
    /**
     * SLA budget for this action type, in whole hours. NULL = no SLA →
     * the action is exempt from the countdown / overdue engine. Read via
     * raw SQL (not on the Drizzle schema) — see safeReadSlaHours.
     */
    slaHours: number | null;
  }[];
  actionTypeNames: Record<number, string>;
  dealers: { id: number; name: string; homeCity: string }[];
  batches: BatchEditRow[];
  rules: {
    prePoOpsLeadTimeDays: number;
  };
  /**
   * Application users. Password hashes are deliberately omitted — only
   * the metadata Settings → Users needs is exposed. To set or rotate a
   * password, the editor sends a `user` mutation with `password` set;
   * the server bcrypt-hashes it and updates `passwordHash`.
   */
  users: SettingsUser[];
  /**
   * Canonical VIN chase stages (the linear chain shown in the Action
   * Center drawer). Edited inline in Settings → VIN Chase Stages.
   */
  vinChaseStages: {
    id: number;
    name: string;
    waitingLabel: string;
    doneLabel: string;
    sortOrder: number;
  }[];
}

export interface SettingsUser {
  id: number;
  username: string;
  name: string | null;
  email: string | null;
  role: "admin" | "ops";
  createdAt: string | null;
}

/** Full editable shape of a batch + a compact action summary. */
export interface BatchEditRow {
  id: number;
  batchCode: string;

  /* PO-level fields (editable; warning shown when poBatchCount > 1). */
  poNumber: string | null;
  poReference: string | null;
  actualPoDate: string | null;
  expectedPoDate: string | null;
  poTotalSar: number | null;
  poSubtotalSar: number | null;
  poTaxTotalSar: number | null;
  /** How many other batches share `poNumber`. 1 if unique. */
  poBatchCount: number;

  /* Batch identity. */
  dealerId: number;
  dealerName: string;
  model: string | null;
  year: number | null;
  category: string | null;

  /* Quantities. */
  requestedQuantity: number;
  allocatedQuantity: number;
  deliveredQuantity: number;
  /** Dealer-confirmed cars (set by the Confirmation action). Off-schema. */
  confirmedQuantity: number | null;

  /* Cities. */
  appDisplayCities: string | null;
  dealerReceivingCity: string | null;

  /* Dates. */
  requestedAt: string;
  dealerPromisedDeliveryDate: string;
  currentProjectedDeliveryDate: string | null;
  targetPoDate: string | null;          // computed; read-only
  /** ISO date the cars went live in the customer app. Drives PO→Listed. */
  appListedAt: string | null;
  /** ISO date the dealer committed to share VINs. */
  vinReceivingDate: string | null;
  /** Baseline @ lock — first PO expected date. Drives variance metrics. */
  poExpectedDateAtLock: string | null;
  /** Baseline @ lock — first ops-projected delivery date. */
  opsProjectedDeliveryDateAtLock: string | null;

  /* VINs. */
  vinsReceivedQuantity: number;
  vinReceivedAtIntake: boolean;

  /* Closure (realised outcome — drives on-time + customer-days). */
  closedAt: string | null;
  closureReason: "delivered" | "cancelled" | null;
  cancellationNote: string | null;

  /* Status & lifecycle. */
  currentStage: string;
  lifecycleState: "pre_po" | "post_po";
  feasibilityStatus: string;

  /* Commercial. */
  buyBackRate: number | null;
  contractLengthMonths: number | null;
  colorSummary: string | null;
  unitPriceSar: number | null;
  taxPct: number | null;
  lineAmountSar: number | null;

  /* Confidence. */
  partnershipConfidence: number | null;
  partnershipConfidenceAtLock: number | null;
  operationsConfidence: number | null;
  operationsConfidenceAtLock: number | null;
  riskScore: number | null;

  notes: string | null;

  /* Action summary (per-batch, sorted by action type sort_order). */
  actions: {
    id: number;
    actionTypeId: number;
    actionTypeName: string;
    waitingLabel: string;
    doneLabel: string;
    status: "waiting" | "blocked" | "done" | "skipped";
    departmentId: number | null;
    departmentName: string | null;
    completedAt: string | null;
  }[];
}

/**
 * Defensive helper: returns [] if the `vin_chase_stages` table is missing
 * in this database (e.g. production hasn't had the migration run yet).
 * Without this, the entire Settings page would 500.
 */
async function safeListVinChaseStages(): Promise<(typeof vinChaseStages.$inferSelect)[]> {
  try {
    return await db.select().from(vinChaseStages).orderBy(asc(vinChaseStages.sortOrder));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(msg)) {
      // eslint-disable-next-line no-console
      console.warn("[settings] vin_chase_stages table missing — returning []. Run `npm run db:push` to enable.");
      return [];
    }
    throw err;
  }
}

/**
 * Read action_types.sla_hours via raw SQL. The column is deliberately
 * NOT declared on the Drizzle schema (settings-data does
 * `select().from(actionTypes)` — an un-migrated declared column would 500
 * the whole Settings page). Returns a Map keyed by action_type id;
 * absent / NULL values are simply not present. Tolerant of the column
 * not existing yet (pre-migration) — returns an empty Map.
 */
async function safeReadSlaHours(): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  try {
    const rows = await db.all<{ id: number; sla_hours: number | null }>(
      sql`SELECT id, sla_hours FROM action_types`,
    );
    for (const r of rows) {
      if (r.sla_hours != null && Number.isFinite(Number(r.sla_hours))) {
        out.set(Number(r.id), Number(r.sla_hours));
      }
    }
  } catch {
    /* column not migrated yet — every type is exempt (no SLA). */
  }
  return out;
}

/**
 * Read batches.confirmed_quantity via raw SQL. Like sla_hours, this column
 * is deliberately OFF the Drizzle schema (the batch query does
 * `select({ b: batches })` — an un-migrated declared column would 500 the
 * whole Settings page). Returns a Map keyed by batch id; tolerant of the
 * column not existing yet (pre-migration) → empty Map.
 */
async function safeReadConfirmedQuantities(): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  try {
    const rows = await db.all<{ id: number; confirmed_quantity: number | null }>(
      sql`SELECT id, confirmed_quantity FROM batches`,
    );
    for (const r of rows) {
      if (r.confirmed_quantity != null && Number.isFinite(Number(r.confirmed_quantity))) {
        out.set(Number(r.id), Number(r.confirmed_quantity));
      }
    }
  } catch {
    /* column not migrated yet — confirmed qty simply unavailable. */
  }
  return out;
}


export async function getSettingsData(): Promise<SettingsData> {
  const [
    deptsRaw, stakeholdersRaw, typesRaw, depsRaw, dealersRaw, batchesRaw, actionsRaw, rules, usersRaw, vinStagesRaw, slaHoursById, confirmedQtyById,
  ] = await Promise.all([
    db.select().from(departments).orderBy(asc(departments.sortOrder)),
    db.select().from(stakeholders).orderBy(asc(stakeholders.sortOrder)),
    db.select().from(actionTypes).orderBy(asc(actionTypes.sortOrder)),
    db.select().from(actionDependencies),
    db.select().from(dealers).orderBy(asc(dealers.name)),
    db.select({ b: batches, dealerName: dealers.name })
      .from(batches)
      .leftJoin(dealers, eq(batches.dealerId, dealers.id))
      .orderBy(asc(batches.batchCode)),
    // Per-batch action summary — read from the LIVE scope-aware `actions`
    // table (scope='batch'), NOT the legacy `batch_actions`. This is the
    // canonical action state the Action Center edits, so the batch row's
    // "X/Y done" chip stays aligned with what users actually see there.
    // Explicit column list (no off-schema columns like sla_started_at) so
    // the query never 500s on an un-migrated column.
    db.select({
        id: actionsTable.id,
        batchId: actionsTable.scopeId,
        status: actionsTable.status,
        completedAt: actionsTable.completedAt,
        atId: actionTypes.id,
        atName: actionTypes.name,
        waitingLabel: actionTypes.waitingLabel,
        doneLabel: actionTypes.doneLabel,
        deptId: departments.id,
        deptName: departments.name,
      })
      .from(actionsTable)
      .innerJoin(actionTypes, eq(actionsTable.actionTypeId, actionTypes.id))
      .leftJoin(departments,  eq(actionsTable.departmentId,  departments.id))
      .where(eq(actionsTable.scope, "batch"))
      .orderBy(asc(actionTypes.sortOrder)),
    getAllRules(),
    // Users — explicit column selection so the password hash never
    // leaves the server. Sorted by role (admins first), then username.
    db.select({
      id:        users.id,
      username:  users.username,
      name:      users.name,
      email:     users.email,
      role:      users.role,
      createdAt: users.createdAt,
    }).from(users).orderBy(asc(users.role), asc(users.username)),
    safeListVinChaseStages(),
    safeReadSlaHours(),
    safeReadConfirmedQuantities(),
  ]);

  // Group stakeholders by department for inline rendering.
  const stakeholdersByDept = new Map<number, { id: number; name: string; sortOrder: number }[]>();
  for (const s of stakeholdersRaw) {
    const arr = stakeholdersByDept.get(s.departmentId) ?? [];
    arr.push({ id: s.id, name: s.name, sortOrder: s.sortOrder });
    stakeholdersByDept.set(s.departmentId, arr);
  }

  // Dependencies: child → parent ids
  const dependsOnByChild = new Map<number, number[]>();
  for (const d of depsRaw) {
    const arr = dependsOnByChild.get(d.actionTypeId) ?? [];
    arr.push(d.dependsOnActionTypeId);
    dependsOnByChild.set(d.actionTypeId, arr);
  }

  // Action lookup names
  const actionTypeNames: Record<number, string> = {};
  for (const t of typesRaw) actionTypeNames[t.id] = t.name;

  // Group actions by batchId (scope_id of the scope='batch' rows).
  const actionsByBatch = new Map<number, BatchEditRow["actions"]>();
  for (const a of actionsRaw) {
    if (a.batchId == null) continue;
    const arr = actionsByBatch.get(a.batchId) ?? [];
    arr.push({
      id:               a.id,
      actionTypeId:     a.atId,
      actionTypeName:   a.atName,
      waitingLabel:     a.waitingLabel,
      doneLabel:        a.doneLabel,
      status:           a.status as BatchEditRow["actions"][number]["status"],
      departmentId:     a.deptId ?? null,
      departmentName:   a.deptName ?? null,
      completedAt:      a.completedAt,
    });
    actionsByBatch.set(a.batchId, arr);
  }

  // Count batches per PO number for the warning chip
  const poBatchCounts = new Map<string, number>();
  for (const r of batchesRaw) {
    if (r.b.poNumber) {
      poBatchCounts.set(r.b.poNumber, (poBatchCounts.get(r.b.poNumber) ?? 0) + 1);
    }
  }

  const batchesList: BatchEditRow[] = batchesRaw.map(({ b, dealerName }) => ({
    id: b.id,
    batchCode: b.batchCode,

    poNumber:    b.poNumber ?? null,
    poReference: b.poReference ?? null,
    actualPoDate:   b.actualPoDate ?? null,
    expectedPoDate: b.expectedPoDate ?? null,
    poTotalSar:    b.poTotalSar ?? null,
    poSubtotalSar: b.poSubtotalSar ?? null,
    poTaxTotalSar: b.poTaxTotalSar ?? null,
    poBatchCount:  b.poNumber ? (poBatchCounts.get(b.poNumber) ?? 1) : 1,

    dealerId:   b.dealerId,
    dealerName: dealerName ?? "—",
    model:      b.model ?? null,
    year:       b.year ?? null,
    category:   b.category ?? null,

    requestedQuantity: b.requestedQuantity,
    allocatedQuantity: b.allocatedQuantity ?? 0,
    deliveredQuantity: b.deliveredQuantity ?? 0,
    confirmedQuantity: confirmedQtyById.get(b.id) ?? null,

    appDisplayCities:    b.appDisplayCities ?? null,
    dealerReceivingCity: b.dealerReceivingCity ?? null,

    requestedAt: b.requestedAt,
    dealerPromisedDeliveryDate: b.dealerPromisedDeliveryDate,
    currentProjectedDeliveryDate: b.currentProjectedDeliveryDate ?? null,
    targetPoDate: b.targetPoDate ?? null,
    appListedAt: b.appListedAt ?? null,
    vinReceivingDate: b.vinReceivingDate ?? null,
    poExpectedDateAtLock: b.poExpectedDateAtLock ?? null,
    opsProjectedDeliveryDateAtLock: b.opsProjectedDeliveryDateAtLock ?? null,

    vinsReceivedQuantity: b.vinsReceivedQuantity ?? 0,
    vinReceivedAtIntake: b.vinReceivedAtIntake ?? false,

    closedAt: b.closedAt ?? null,
    closureReason: (b.closureReason ?? null) as "delivered" | "cancelled" | null,
    cancellationNote: b.cancellationNote ?? null,

    currentStage:   b.currentStage ?? "request_submitted",
    lifecycleState: (b.lifecycleState ?? "post_po") as "pre_po" | "post_po",
    feasibilityStatus: b.feasibilityStatus ?? "feasible",

    buyBackRate: b.buyBackRate ?? null,
    contractLengthMonths: b.contractLengthMonths ?? null,
    colorSummary: b.colorSummary ?? null,
    unitPriceSar: b.unitPriceSar ?? null,
    taxPct:       b.taxPct ?? null,
    lineAmountSar: b.lineAmountSar ?? null,

    partnershipConfidence: b.partnershipConfidence ?? null,
    partnershipConfidenceAtLock: b.partnershipConfidenceAtLock ?? null,
    operationsConfidence: b.operationsConfidence ?? null,
    operationsConfidenceAtLock: b.operationsConfidenceAtLock ?? null,
    riskScore: b.riskScore ?? null,

    notes: b.notes ?? null,

    actions: actionsByBatch.get(b.id) ?? [],
  }));

  return {
    departments: deptsRaw.map((d) => ({
      id: d.id, name: d.name, sortOrder: d.sortOrder,
      stakeholders: stakeholdersByDept.get(d.id) ?? [],
    })),
    actionTypes: typesRaw.map((t) => ({
      id: t.id,
      name: t.name,
      waitingLabel: t.waitingLabel,
      doneLabel: t.doneLabel,
      defaultDepartmentId: t.defaultDepartmentId,
      sortOrder: t.sortOrder,
      dependsOnIds: dependsOnByChild.get(t.id) ?? [],
      slaHours: slaHoursById.get(t.id) ?? null,
    })),
    actionTypeNames,
    dealers: dealersRaw.map((d) => ({
      id: d.id, name: d.name, homeCity: d.homeCity,
    })),
    batches: batchesList,
    rules,
    users: usersRaw.map((u) => ({
      id:        u.id,
      username:  u.username,
      name:      u.name,
      email:     u.email,
      role:      u.role as "admin" | "ops",
      createdAt: u.createdAt,
    })),
    vinChaseStages: vinStagesRaw.map((s) => ({
      id:           s.id,
      name:         s.name,
      waitingLabel: s.waitingLabel,
      doneLabel:    s.doneLabel,
      sortOrder:    s.sortOrder,
    })),
  };
}

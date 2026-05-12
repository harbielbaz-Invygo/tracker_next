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
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  departments, stakeholders, actionTypes, actionDependencies,
  dealers, batches, batchActions, users, alertRules,
} from "@/lib/db/schema";
import { getAllRules } from "@/lib/rules";

export interface AlertRuleSetting {
  id: number;
  name: string;
  triggerType: "no_vin_before_avail" | "action_overdue" | "action_pending_before_avail";
  thresholdDays: number;
  actionTypeId: number | null;
  /** Name of the actionType, resolved for display. */
  actionTypeName: string | null;
  severity: "critical" | "high" | "medium" | "info";
  isActive: boolean;
}

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
  }[];
  actionTypeNames: Record<number, string>;
  dealers: { id: number; name: string; homeCity: string }[];
  batches: BatchEditRow[];
  rules: {
    prePoOpsLeadTimeDays: number;
  };
  alertRules: AlertRuleSetting[];
  /**
   * Application users. Password hashes are deliberately omitted — only
   * the metadata Settings → Users needs is exposed. To set or rotate a
   * password, the editor sends a `user` mutation with `password` set;
   * the server bcrypt-hashes it and updates `passwordHash`.
   */
  users: SettingsUser[];
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

  /* Cities. */
  appDisplayCities: string | null;
  dealerReceivingCity: string | null;

  /* Dates. */
  requestedAt: string;
  dealerPromisedDeliveryDate: string;
  currentProjectedDeliveryDate: string | null;
  targetPoDate: string | null;          // computed; read-only

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

export async function getSettingsData(): Promise<SettingsData> {
  const [
    deptsRaw, stakeholdersRaw, typesRaw, depsRaw, dealersRaw, batchesRaw, actionsRaw, rules, usersRaw, alertRulesRaw,
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
    db.select({
        ba: batchActions,
        atId: actionTypes.id,
        atName: actionTypes.name,
        waitingLabel: actionTypes.waitingLabel,
        doneLabel: actionTypes.doneLabel,
        sortOrder: actionTypes.sortOrder,
        deptId: departments.id,
        deptName: departments.name,
      })
      .from(batchActions)
      .innerJoin(actionTypes, eq(batchActions.actionTypeId, actionTypes.id))
      .leftJoin(departments,  eq(batchActions.departmentId,  departments.id))
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
    db.select().from(alertRules).orderBy(asc(alertRules.id)),
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

  // Group actions by batchId
  const actionsByBatch = new Map<number, BatchEditRow["actions"]>();
  for (const a of actionsRaw) {
    const arr = actionsByBatch.get(a.ba.batchId) ?? [];
    arr.push({
      id:               a.ba.id,
      actionTypeId:     a.atId,
      actionTypeName:   a.atName,
      waitingLabel:     a.waitingLabel,
      doneLabel:        a.doneLabel,
      status:           a.ba.status as BatchEditRow["actions"][number]["status"],
      departmentId:     a.deptId ?? null,
      departmentName:   a.deptName ?? null,
      completedAt:      a.ba.completedAt,
    });
    actionsByBatch.set(a.ba.batchId, arr);
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

    appDisplayCities:    b.appDisplayCities ?? null,
    dealerReceivingCity: b.dealerReceivingCity ?? null,

    requestedAt: b.requestedAt,
    dealerPromisedDeliveryDate: b.dealerPromisedDeliveryDate,
    currentProjectedDeliveryDate: b.currentProjectedDeliveryDate ?? null,
    targetPoDate: b.targetPoDate ?? null,

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
    })),
    actionTypeNames,
    dealers: dealersRaw.map((d) => ({
      id: d.id, name: d.name, homeCity: d.homeCity,
    })),
    batches: batchesList,
    rules,
    alertRules: alertRulesRaw.map((r) => ({
      id:             r.id,
      name:           r.name,
      triggerType:    r.triggerType as AlertRuleSetting["triggerType"],
      thresholdDays:  r.thresholdDays,
      actionTypeId:   r.actionTypeId ?? null,
      actionTypeName: r.actionTypeId ? (actionTypeNames[r.actionTypeId] ?? null) : null,
      severity:       r.severity as AlertRuleSetting["severity"],
      isActive:       r.isActive ?? true,
    })),
    users: usersRaw.map((u) => ({
      id:        u.id,
      username:  u.username,
      name:      u.name,
      email:     u.email,
      role:      u.role as "admin" | "ops",
      createdAt: u.createdAt,
    })),
  };
}

/**
 * Phase 3 — data layer for the scope-aware Action Center.
 *
 * Returns the full hierarchy the new UI renders against:
 *   Dealer ▸ PO ▸ (PO-scope actions) ▸ Waves ▸ (wave-scope actions) ▸ Batches ▸ (batch-scope actions)
 *
 * The shape is intentionally denormalised — every level carries the
 * data the UI needs without further round-trips, so the left tree
 * panel + the right drawer can render from a single fetched object.
 *
 * Pure server-side; types are imported below by client components via
 * `import type` so the DB client never leaks into the bundle.
 */
import { eq, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  pos, waves, batches, dealers,
  actions as actionsTable, actionTypes, actionDependencies, departments, stakeholders,
} from "@/lib/db/schema";

export type ScopedActionStatus = "waiting" | "blocked" | "done" | "skipped";

export interface ScopedActionDetail {
  id:             number;
  actionTypeId:   number;
  actionTypeName: string;
  waitingLabel:   string;
  doneLabel:      string;
  status:         ScopedActionStatus;
  departmentName: string | null;
  stakeholderName: string | null;
  expectedDate:   string | null;
  completedAt:    string | null;
  notes:          string | null;
  sortOrder:      number;
  /**
   * Names of parent action_types that are STILL pending on the same
   * scope as this action. Sourced from action_dependencies, filtered
   * to actually-blocking parents (already-done parents drop off the
   * list). Empty when not blocked.
   */
  blockedByNames: string[];
  /**
   * Names of child action_types currently in a non-settled state on
   * the same scope. Populated for ALL action rows (not just blocked
   * parents) so the Skip-with-dependents confirm in the UI can list
   * what would be auto-unblocked downstream.
   */
  pendingDependentNames: string[];
}

export interface BatchNode {
  id:                 number;
  batchCode:          string;
  modelYear:          string;          // "Geely Emgrand 2026"
  city:               string;
  requestedQuantity:  number;
  deliveredQuantity:  number;
  closedAt:           string | null;
  closureReason:      "delivered" | "cancelled" | null;
  appListedAt:        string | null;
  actions:            ScopedActionDetail[]; // scope='batch' for this batch
}

export interface WaveNode {
  id:                 number;
  availabilityDate:   string;
  vinReceivingDate:   string | null;
  opsExpectedDate:    string | null;
  closedAt:           string | null;
  actions:            ScopedActionDetail[]; // scope='wave' for this wave
  /** Batches landing in this wave. */
  batches:            BatchNode[];
}

export interface PoNode {
  id:                 number;
  poNumber:           string;
  poDate:             string | null;
  poReference:        string | null;
  contractLengthMonths: number | null;
  buyBackRate:        number | null;
  /** Unit price (SAR) — surfaced in the header for at-a-glance value. */
  unitPriceSar:       number | null;
  closedAt:           string | null;
  totalCars:          number;          // sum of requestedQuantity across batches in this PO
  /** Sum across batches: requestedQuantity × unitPriceSar (when available). */
  totalValueSar:      number | null;
  /** Earliest availability date across waves under this PO. Drives the
   *  "in N days" indicator in the header. */
  nextAvailability:   string | null;
  actions:            ScopedActionDetail[]; // scope='po' for this PO
  /** Waves under this PO, sorted by availability date. */
  waves:              WaveNode[];
  /**
   * App-listing roll-up across the PO's batches. Drives the synthetic
   * "App listed" row at the end of Internal Phase: done when every
   * batch has `appListedAt` set, pending otherwise.
   */
  appListingSummary: {
    listed:        number;
    total:         number;
    /** Latest appListedAt across the PO's batches, when ALL are listed. */
    completedAt:   string | null;
  };
  /**
   * True when every PO-scope action is in a settled state (done or
   * skipped). Drives the gating logic for the per-batch
   * "Mark as listed" and "Mark as delivered" buttons — neither
   * should fire while internal-phase work is still in flight.
   */
  internalPhaseDone: boolean;
}

export interface DealerNode {
  id:                 number;
  name:               string;
  homeCity:           string;
  pos:                PoNode[];        // sorted by po_date desc
}

export interface ActionCenterTree {
  dealers: DealerNode[];
  /** Generation timestamp — useful for the UI's stale-data indicator. */
  generatedAt: string;
}

/**
 * Fetch the full Dealer → PO → Wave → Batch → Actions tree.
 *
 * Only includes batches that have wave_id set (i.e. those created
 * since the phase-2 Intake landed). Legacy batches without a wave
 * are invisible here — they're still queryable via the legacy
 * Action Center at /action-center until phase 3b swaps the routes.
 */
export async function getActionCenterTree(): Promise<ActionCenterTree> {
  // Pull everything in parallel — small dataset, cheap on Turso.
  const [posRows, wavesRows, batchesRows, actionRows, depRows, allTypesForDeps, dealersRows] = await Promise.all([
    db.select().from(pos),
    db.select().from(waves),
    db.select().from(batches),
    db
      .select({
        id:              actionsTable.id,
        scope:           actionsTable.scope,
        scopeId:         actionsTable.scopeId,
        actionTypeId:    actionsTable.actionTypeId,
        actionTypeName:  actionTypes.name,
        waitingLabel:    actionTypes.waitingLabel,
        doneLabel:       actionTypes.doneLabel,
        sortOrder:       actionTypes.sortOrder,
        status:          actionsTable.status,
        departmentName:  departments.name,
        stakeholderName: stakeholders.name,
        expectedDate:    actionsTable.expectedDate,
        completedAt:     actionsTable.completedAt,
        notes:           actionsTable.notes,
      })
      .from(actionsTable)
      .innerJoin(actionTypes, eq(actionsTable.actionTypeId, actionTypes.id))
      .leftJoin(departments,  eq(actionsTable.departmentId, departments.id))
      .leftJoin(stakeholders, eq(actionsTable.assignedStakeholderId, stakeholders.id))
      .orderBy(asc(actionTypes.sortOrder)),
    // action_dependencies + a small types lookup so we can resolve
    // parent names for the "waiting on …" hint on blocked rows.
    db.select().from(actionDependencies),
    db.select({ id: actionTypes.id, name: actionTypes.name, sortOrder: actionTypes.sortOrder })
      .from(actionTypes),
    db.select({ id: dealers.id, name: dealers.name, homeCity: dealers.homeCity }).from(dealers),
  ]);

  // Resolve "this action_type depends on these parent action_types".
  // We keep both id and name so we can filter to UNSATISFIED parents
  // per action row below (vs. showing every dep regardless of state,
  // which the operator misread as "still waiting on Cars specs" when
  // Cars specs was actually done).
  const typeInfoById = new Map(allTypesForDeps.map((t) => [t.id, t]));
  const parentIdsByChild = new Map<number, number[]>();
  for (const d of depRows) {
    if (!typeInfoById.has(d.dependsOnActionTypeId)) continue;
    const arr = parentIdsByChild.get(d.actionTypeId) ?? [];
    arr.push(d.dependsOnActionTypeId);
    parentIdsByChild.set(d.actionTypeId, arr);
  }

  // Per-scope lookup: scope-key → (action_type_id → status). Used to
  // resolve blockedByNames to only the parents that are NOT yet
  // done/skipped on the SAME scope as the blocked action.
  const statusByScopeAndType = new Map<string, Map<number, ScopedActionStatus>>();
  for (const a of actionRows) {
    const key = `${a.scope}:${a.scopeId}`;
    let m = statusByScopeAndType.get(key);
    if (!m) { m = new Map(); statusByScopeAndType.set(key, m); }
    m.set(a.actionTypeId, a.status as ScopedActionStatus);
  }

  // Index actions by (scope, scope_id).
  const actionsByKey = new Map<string, ScopedActionDetail[]>();
  for (const a of actionRows) {
    const key = `${a.scope}:${a.scopeId}`;
    const arr = actionsByKey.get(key) ?? [];

    // Resolve blockedByNames to the parents that are STILL pending on
    // this scope. A parent counts as satisfied when its action row on
    // the same scope is done or skipped — OR when it's absent
    // entirely (dep is dormant; matches the cascade satisfaction rule
    // in lib/scope-cascade.ts).
    const parentIds = parentIdsByChild.get(a.actionTypeId) ?? [];
    const blockedByNames: string[] = [];
    if (a.status === "blocked") {
      const peers = statusByScopeAndType.get(key) ?? new Map();
      for (const pid of parentIds) {
        const parentStatus = peers.get(pid);
        if (parentStatus === undefined) continue; // dormant
        if (parentStatus === "done" || parentStatus === "skipped") continue;
        const parent = typeInfoById.get(pid);
        if (parent) blockedByNames.push(parent.name);
      }
      blockedByNames.sort((x, y) => {
        const sx = allTypesForDeps.find((t) => t.name === x)?.sortOrder ?? 0;
        const sy = allTypesForDeps.find((t) => t.name === y)?.sortOrder ?? 0;
        return sx - sy;
      });
    }

    arr.push({
      id:               a.id,
      actionTypeId:     a.actionTypeId,
      actionTypeName:   a.actionTypeName,
      waitingLabel:     a.waitingLabel,
      doneLabel:        a.doneLabel,
      status:           a.status as ScopedActionStatus,
      departmentName:   a.departmentName ?? null,
      stakeholderName:  a.stakeholderName ?? null,
      expectedDate:     a.expectedDate ?? null,
      completedAt:      a.completedAt ?? null,
      notes:            a.notes ?? null,
      sortOrder:        a.sortOrder,
      blockedByNames,
      pendingDependentNames: [], // filled in by the second pass below
    });
    actionsByKey.set(key, arr);
  }

  // Forward dep map: parent action_type_id → child action_type_ids.
  // Used to populate `pendingDependentNames` per action row so the
  // Skip-with-dependents confirm can list the children that would
  // be auto-unblocked.
  const childrenByParent = new Map<number, number[]>();
  for (const d of depRows) {
    const arr = childrenByParent.get(d.dependsOnActionTypeId) ?? [];
    arr.push(d.actionTypeId);
    childrenByParent.set(d.dependsOnActionTypeId, arr);
  }

  // Second pass: now that we have the per-scope status map, fill
  // pendingDependentNames on every action row.
  for (const arr of actionsByKey.values()) {
    // The scope/scopeId is shared across the array — grab it from any row.
    if (arr.length === 0) continue;
    // peers map for this scope:
    // (we don't have direct access to scope/scopeId on ScopedActionDetail
    // any more — re-derive via the actionRows source instead.)
  }
  // Re-walk actionRows to keep peer lookup cheap: each action row's
  // children are filtered against the same scope's peer status map.
  const detailById = new Map<number, ScopedActionDetail>();
  for (const arr of actionsByKey.values()) for (const r of arr) detailById.set(r.id, r);
  for (const a of actionRows) {
    const key = `${a.scope}:${a.scopeId}`;
    const peers = statusByScopeAndType.get(key) ?? new Map();
    const detail = detailById.get(a.id);
    if (!detail) continue;
    const childTypeIds = childrenByParent.get(a.actionTypeId) ?? [];
    const names: string[] = [];
    for (const cid of childTypeIds) {
      const cStatus = peers.get(cid);
      // "Pending" means present and not done/skipped. Absent → no
      // action row → nothing to flag for this scope.
      if (cStatus === "waiting" || cStatus === "blocked") {
        const child = typeInfoById.get(cid);
        if (child) names.push(child.name);
      }
    }
    detail.pendingDependentNames = names.sort();
  }

  // Index batches by wave.
  const batchesByWave = new Map<number, typeof batchesRows>();
  for (const b of batchesRows) {
    if (b.waveId == null) continue;
    const arr = batchesByWave.get(b.waveId) ?? [];
    arr.push(b);
    batchesByWave.set(b.waveId, arr);
  }

  // Index waves by PO, sorted by availability date.
  const wavesByPo = new Map<number, typeof wavesRows>();
  for (const w of wavesRows) {
    const arr = wavesByPo.get(w.poId) ?? [];
    arr.push(w);
    wavesByPo.set(w.poId, arr);
  }
  for (const arr of wavesByPo.values()) {
    arr.sort((a, b) => a.availabilityDate.localeCompare(b.availabilityDate));
  }

  // Build PO nodes.
  // Skip POs with no batches under any of their waves — these are
  // orphans left behind when ops deleted batches via Settings (the
  // pos/waves rows aren't children of batches and don't cascade).
  // The intake self-heals these on re-upload and `/api/admin/cleanup-
  // orphan-pos` purges them server-side, but filtering here means
  // the UI stops showing them immediately without needing either step.
  const posByDealer = new Map<number, PoNode[]>();
  for (const p of posRows) {
    const hasAnyBatch = (wavesByPo.get(p.id) ?? []).some(
      (w) => (batchesByWave.get(w.id)?.length ?? 0) > 0,
    );
    if (!hasAnyBatch) continue;

    const wavesForPo: WaveNode[] = (wavesByPo.get(p.id) ?? []).map((w) => {
      const wBatches = (batchesByWave.get(w.id) ?? []).map<BatchNode>((b) => ({
        id:                 b.id,
        batchCode:          b.batchCode,
        modelYear:          [b.model, b.year].filter(Boolean).join(" ") || "—",
        city:               b.dealerReceivingCity ?? "—",
        requestedQuantity:  b.requestedQuantity,
        deliveredQuantity:  b.deliveredQuantity ?? 0,
        closedAt:           b.closedAt ?? null,
        closureReason:      (b.closureReason ?? null) as BatchNode["closureReason"],
        appListedAt:        b.appListedAt ?? null,
        actions:            actionsByKey.get(`batch:${b.id}`) ?? [],
      }));
      return {
        id:               w.id,
        availabilityDate: w.availabilityDate,
        vinReceivingDate: w.vinReceivingDate ?? null,
        opsExpectedDate:  w.opsExpectedDate ?? null,
        closedAt:         w.closedAt ?? null,
        actions:          actionsByKey.get(`wave:${w.id}`) ?? [],
        batches:          wBatches,
      };
    });

    const totalCars = wavesForPo.reduce(
      (sum, w) => sum + w.batches.reduce((s, b) => s + b.requestedQuantity, 0),
      0,
    );

    // App-listing roll-up: count batches with `appListedAt` set vs.
    // total. When every batch is listed, expose the latest timestamp
    // so the synthetic row can render its completion date.
    const allBatchesUnderPo = wavesForPo.flatMap((w) => w.batches);
    const listedBatches = allBatchesUnderPo.filter((b) => b.appListedAt != null);
    const allListed = listedBatches.length > 0
      && listedBatches.length === allBatchesUnderPo.length;
    const latestListedAt = listedBatches
      .map((b) => b.appListedAt!)
      .sort()
      .at(-1) ?? null;

    const poActions = actionsByKey.get(`po:${p.id}`) ?? [];
    const internalPhaseDone = poActions.length > 0
      && poActions.every((a) => a.status === "done" || a.status === "skipped");
    const totalValueSar = p.unitPriceSar != null && totalCars > 0
      ? Math.round(p.unitPriceSar * totalCars)
      : null;
    const nextAvailability = wavesForPo.length === 0
      ? null
      : wavesForPo
          .map((w) => w.availabilityDate)
          .sort()
          .at(0) ?? null;

    const node: PoNode = {
      id:                   p.id,
      poNumber:             p.poNumber,
      poDate:               p.poDate ?? null,
      poReference:          p.poReference ?? null,
      contractLengthMonths: p.contractLengthMonths ?? null,
      buyBackRate:          p.buyBackRate ?? null,
      unitPriceSar:         p.unitPriceSar ?? null,
      closedAt:             p.closedAt ?? null,
      totalCars,
      totalValueSar,
      nextAvailability,
      actions:              poActions,
      waves:                wavesForPo,
      appListingSummary: {
        listed:      listedBatches.length,
        total:       allBatchesUnderPo.length,
        completedAt: allListed ? latestListedAt : null,
      },
      internalPhaseDone,
    };

    const arr = posByDealer.get(p.dealerId) ?? [];
    arr.push(node);
    posByDealer.set(p.dealerId, arr);
  }

  // Build dealer nodes. Only include dealers that have at least one PO
  // in the new model — keeps the tree focused on actionable rows.
  const dealerNodes: DealerNode[] = dealersRows
    .filter((d) => (posByDealer.get(d.id)?.length ?? 0) > 0)
    .map((d) => ({
      id:       d.id,
      name:     d.name,
      homeCity: d.homeCity,
      pos:      (posByDealer.get(d.id) ?? []).sort(
        (a, b) => (b.poDate ?? "").localeCompare(a.poDate ?? ""),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { dealers: dealerNodes, generatedAt: new Date().toISOString() };
}

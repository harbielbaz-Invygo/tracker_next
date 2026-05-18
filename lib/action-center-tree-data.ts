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
import { eq, asc, inArray, and } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  pos, waves, batches, dealers,
  actions as actionsTable, actionTypes, departments, stakeholders,
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
  closedAt:           string | null;
  totalCars:          number;          // sum of requestedQuantity across batches in this PO
  actions:            ScopedActionDetail[]; // scope='po' for this PO
  /** Waves under this PO, sorted by availability date. */
  waves:              WaveNode[];
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
  const [posRows, wavesRows, batchesRows, actionRows, dealersRows] = await Promise.all([
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
    db.select({ id: dealers.id, name: dealers.name, homeCity: dealers.homeCity }).from(dealers),
  ]);

  // Index actions by (scope, scope_id).
  const actionsByKey = new Map<string, ScopedActionDetail[]>();
  for (const a of actionRows) {
    const key = `${a.scope}:${a.scopeId}`;
    const arr = actionsByKey.get(key) ?? [];
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
    });
    actionsByKey.set(key, arr);
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
  const posByDealer = new Map<number, PoNode[]>();
  for (const p of posRows) {
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

    const node: PoNode = {
      id:                   p.id,
      poNumber:             p.poNumber,
      poDate:               p.poDate ?? null,
      poReference:          p.poReference ?? null,
      contractLengthMonths: p.contractLengthMonths ?? null,
      buyBackRate:          p.buyBackRate ?? null,
      closedAt:             p.closedAt ?? null,
      totalCars,
      actions:              actionsByKey.get(`po:${p.id}`) ?? [],
      waves:                wavesForPo,
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

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
import { eq, asc, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  pos, waves, batches, dealers,
  actions as actionsTable, actionTypes, actionDependencies, departments, stakeholders,
  batchDateRevisions, batchDeliveryLegs,
  batchForecasts, users,
} from "@/lib/db/schema";
import { computePoReliability, type ReliabilityBatch } from "@/lib/po-reliability";

type BatchRow = typeof batches.$inferSelect;

/**
 * Fetch the batches table — tolerant of pre-migration DBs that may
 * still be missing newer columns. The standard
 * `db.select().from(batches)` generates a SELECT that requests every
 * column declared in the Drizzle schema; if a column hasn't been
 * applied to prod yet, the whole query 500s and the Action Center
 * page goes dark.
 *
 * Pattern: try the Drizzle-typed select first; on "no such column"
 * error, fall back to a raw `SELECT *` (libsql returns whatever
 * columns exist) and patch the missing field on each row with a 0
 * default. The page stays up; ops just doesn't see the new column's
 * data until the admin migration endpoint runs.
 */
/**
 * Read every row in `action_touchpoints` via raw SQL — used by the
 * Action Center to power the External-Phase chip metrics + the
 * Log-contact/Escalate inline controls. Tolerant of the table being
 * missing (pre-migration DBs return an empty Map).
 *
 * Sorted DESC by contactedAt, then by id, so consumers can treat
 * `arr[0]` as "latest" and `arr[arr.length-1]` as "earliest".
 */
async function fetchTouchpointsByAction(): Promise<Record<string, ActionTouchpoint[]>> {
  try {
    const rows = await db.all<{
      id: number; action_id: number; channel: string; direction: string;
      outcome: string; note: string | null; contacted_at: string;
      next_followup_at: string | null; logged_by: string | null;
      escalated: number;
    }>(sql`
      SELECT id, action_id, channel, direction, outcome, note,
             contacted_at, next_followup_at, logged_by, escalated
      FROM action_touchpoints
      ORDER BY contacted_at DESC, id DESC
    `);
    const grouped: Record<string, ActionTouchpoint[]> = {};
    for (const r of rows) {
      const key = String(r.action_id);
      (grouped[key] ??= []).push({
        id:             Number(r.id),
        actionId:       Number(r.action_id),
        channel:        r.channel,
        direction:      r.direction,
        outcome:        r.outcome,
        note:           r.note,
        contactedAt:    r.contacted_at,
        nextFollowupAt: r.next_followup_at,
        loggedBy:       r.logged_by,
        escalated:      Boolean(r.escalated),
      });
    }
    return grouped;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such (column|table)/i.test(msg)) return {};
    throw err;
  }
}

/**
 * Read `batches.confirmed_quantity` via raw SQL so callers don't have
 * to declare the column on the Drizzle schema (which would force
 * EVERY db.select().from(batches) anywhere to include it, breaking
 * every page on a pre-migration DB). Returns a Map keyed by batch.id.
 *
 * Tolerant: missing column / table → empty Map.
 */
async function fetchConfirmedQtyByBatch(): Promise<Map<number, number>> {
  try {
    const rows = await db.all<{ id: number; confirmed_quantity: number }>(
      sql`SELECT id, confirmed_quantity FROM batches`,
    );
    return new Map(rows.map((r) => [Number(r.id), Number(r.confirmed_quantity ?? 0)]));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such (column|table)/i.test(msg)) return new Map();
    throw err;
  }
}

async function fetchBatchesTolerant(): Promise<BatchRow[]> {
  try {
    return await db.select().from(batches);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no such column/i.test(msg)) throw err;
    // eslint-disable-next-line no-console
    console.warn(
      `[action-center-tree-data] batches has a missing column — falling back to a projection that omits known-newer columns. ` +
      `Run the matching /api/admin/ensure-* endpoint to migrate. (${msg})`,
    );
    // Project only the columns the data layer actually consumes,
    // skipping the newest additions (`vinsReceivedQuantity`,
    // `confirmedQuantity`). Drizzle's .select({...}) still maps
    // snake_case → camelCase per the schema, so consumers get the
    // BatchRow shape they expect with the missing fields filled in as
    // 0 at the call site.
    const rows = await db.select({
      id:                            batches.id,
      batchCode:                     batches.batchCode,
      model:                         batches.model,
      year:                          batches.year,
      requestedQuantity:             batches.requestedQuantity,
      deliveredQuantity:             batches.deliveredQuantity,
      closedAt:                      batches.closedAt,
      closureReason:                 batches.closureReason,
      appListedAt:                   batches.appListedAt,
      dealerPromisedDeliveryDate:    batches.dealerPromisedDeliveryDate,
      currentProjectedDeliveryDate:  batches.currentProjectedDeliveryDate,
      colorSummary:                  batches.colorSummary,
      unitPriceSar:                  batches.unitPriceSar,
      dealerReceivingCity:           batches.dealerReceivingCity,
      waveId:                        batches.waveId,
    }).from(batches);
    return rows.map((r) => ({
      ...r,
      vinsReceivedQuantity: 0,
      confirmedQuantity:    0,
    })) as unknown as BatchRow[];
  }
}

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
  /**
   * VINs the dealer has actually shared for this batch (0..requested).
   * Captured when ops marks the batch-scope VIN External-Phase chip
   * done. Caps Mark-as-delivered quantity at close. Defaults to 0 on
   * legacy batches that pre-date the column.
   */
  vinsReceivedQuantity: number;
  /**
   * Cars the dealer has *confirmed* they can supply (0..requested).
   * Captured when ops marks the Confirmation chip done — often
   * partial ("dealer can only give us 7 of 10"). Defaults to 0 on
   * legacy batches that pre-date the column.
   */
  confirmedQuantity:   number;
  closedAt:           string | null;
  closureReason:      "delivered" | "cancelled" | null;
  appListedAt:        string | null;
  /**
   * Current PO Expected Date — the live partnership-dealer
   * commitment. Mutates if the dealer renegotiates (via Shift).
   * Used for "today's commitment" displays.
   */
  promisedDate:       string;
  /**
   * Locked snapshot of the FIRST PO Expected Date — the original
   * agreement captured at intake. Foundation for PO Reliability
   * scoring. Null on legacy batches until the admin migration runs.
   */
  poExpectedDateAtLock: string | null;
  /**
   * Ops's current projected delivery date for THIS batch — may have
   * shifted from the original promise via /api/batch-shift. Defaults
   * to the dealer-promised date at intake (ops doesn't project yet).
   */
  currentProjectedDeliveryDate: string | null;
  /**
   * Snapshot of the FIRST ops projection ops committed to via the
   * "Set Ops expected date" CTA (or any first shift). Null until the
   * first shift, then frozen. Drives the initial-commitment vs.
   * realised accuracy metric.
   *
   * Note: independent from action-level backdating — the
   * mark-done-with-custom-date affordance edits an action's
   * completedAt, never this field.
   */
  opsProjectedDeliveryDateAtLock: string | null;
  /** Free-text colour summary captured at Intake. */
  colorSummary:       string | null;
  /** SAR unit price from the batch's commercial terms. Null when
   *  Intake didn't capture one. */
  unitPriceSar:       number | null;
  /** Pre-computed requestedQuantity × unitPriceSar. Retained on the
   *  type for any downstream metric callers; the External-Phase view
   *  no longer renders monetary fields. */
  totalValueSar:      number | null;
  /**
   * Per-city delivery breakdown sourced from batch_delivery_legs.
   * Empty when the batch is single-city (legacy) or the legs table
   * isn't migrated. UI renders the comma-joined city + total fallback
   * when this is empty.
   *   - id: legs row id, used as the key when ops records per-city
   *         VINs received or per-city delivered quantity.
   *   - quantity: requested cars to this city.
   *   - vinsReceivedQuantity: VINs the dealer has assigned to this
   *         leg so far (0 by default). Sum across legs = batch total.
   */
  legs:               { id: number; city: string; quantity: number; vinsReceivedQuantity: number }[];
  /**
   * Chronological shift history sourced from batch_date_revisions.
   * Earliest first. Each entry's `previousDate` is the date the batch
   * was tracking BEFORE that shift; the first entry's previousDate is
   * the original promised date (the one captured at Intake / Forecast).
   */
  shiftHistory:       {
    /** ISO datetime when ops applied the shift. */
    revisedAt:    string;
    previousDate: string;
    newDate:      string;
    reason:       string | null;
  }[];
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
  /**
   * Listing-speed signals for the primary "PO → App Listed" KPI.
   *   - daysSinceSubmission: today − earliest batch.requestedAt under the PO.
   *     Surfaces "this PO has been open for N days" on the tree row.
   *   - daysToListed: latest appListedAt − earliest requestedAt across the
   *     PO's batches. Null until every batch is listed. Drives the per-PO
   *     "Listed in Nd" badge + portfolio aggregates.
   * Both are computed from existing columns; no schema change required.
   */
  daysSinceSubmission: number | null;
  daysToListed:        number | null;
  /**
   * Composite PO Reliability Score (0-100) — null until every batch
   * under the PO is closed. Drives the per-PO tree badge. Computed
   * via lib/po-reliability from the same anchors the Insights → PO
   * Reliability tab uses.
   */
  reliabilityScore:    number | null;
  /**
   * True when this node is a virtual stand-in for a Pre-PO (Forecast)
   * batch — no real PO exists yet, so the drawer hides the Internal /
   * External Phase tabs and shows only the Pre-PO follow-up view.
   * When false this is a real PO row backed by a `pos` table entry.
   */
  isPrePo: boolean;
  /**
   * For Pre-PO virtual nodes, the underlying `batches.id` of the
   * pre_po batch. Lets the Pre-PO follow-up view deep-link to Intake
   * with `?linkForecast={prePoBatchId}` so the partnership commitment
   * carries forward when the real PO arrives. Null on real PO nodes.
   */
  prePoBatchId: number | null;
  /**
   * Pre-PO batch identity surfaced in the drawer header (city,
   * promised date, submitter). Null on real PO nodes. Synth'd by the
   * data layer from the underlying batch + batch_forecasts rows.
   */
  prePoSummary: {
    city: string;
    expectedDeliveryDate: string;
    expectedPoSigningDate: string | null;
    submittedAt: string;
    submittedByName: string | null;
  } | null;
}

export interface DealerNode {
  id:                 number;
  name:               string;
  homeCity:           string;
  pos:                PoNode[];        // sorted by po_date desc
}

export interface DepartmentCatalog {
  id:           number;
  name:         string;
  stakeholders: { id: number; name: string }[];
}

export interface ActionCenterTree {
  dealers: DealerNode[];
  /**
   * Department + stakeholder catalog, used by the per-action stakeholder
   * reassign picker. All active departments with their stakeholders;
   * the picker filters by the action's current department.
   */
  departments: DepartmentCatalog[];
  /**
   * Per-action touchpoint history, keyed by action id (stringified).
   * Sourced from `action_touchpoints` — used by the Action Center's
   * External-Phase chips to surface 📞/↗/⏱ metrics + the
   * Log-contact/Escalate inline controls. Empty when the touchpoints
   * table hasn't been migrated yet.
   */
  touchpointsByAction: Record<string, ActionTouchpoint[]>;
  /** Generation timestamp — useful for the UI's stale-data indicator. */
  generatedAt: string;
}

/**
 * Touchpoint row as the Action Center consumes it — JSON-serialisable
 * subset of `action_touchpoints`. Keeping the type here (rather than
 * pulling from action-flow-shared) keeps the dependency graph
 * unidirectional: action-flow-shared imports FROM action-center-tree-
 * data, never the other way.
 */
export interface ActionTouchpoint {
  id:             number;
  actionId:       number;
  channel:        string;
  direction:      string;
  outcome:        string;
  note:           string | null;
  contactedAt:    string;
  nextFollowupAt: string | null;
  loggedBy:       string | null;
  escalated:      boolean;
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
  const [posRows, wavesRows, batchesRows, confirmedQtyByBatch, touchpointsByAction, actionRows, depRows, allTypesForDeps, dealersRows, deptCatalogRows, stakeholderRows, legsRows, revisionRows] = await Promise.all([
    db.select().from(pos),
    db.select().from(waves),
    fetchBatchesTolerant(),
    fetchConfirmedQtyByBatch(),
    fetchTouchpointsByAction(),
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
    db.select({ id: departments.id, name: departments.name, sortOrder: departments.sortOrder })
      .from(departments)
      .orderBy(asc(departments.sortOrder)),
    db.select({ id: stakeholders.id, name: stakeholders.name, departmentId: stakeholders.departmentId, sortOrder: stakeholders.sortOrder })
      .from(stakeholders)
      .orderBy(asc(stakeholders.sortOrder)),
    (async () => {
      // batch_delivery_legs feeds the per-city qty breakdown in the
      // batch meta line. Same defensive try/catch as the other
      // optional tables — if not migrated yet, return [] and the UI
      // falls back to the comma-joined city + total.
      // Two-step degradation: legs table missing → []. Legs table
      // present but vins_received_quantity column missing → re-query
      // without it (defaulted to 0 in-memory).
      try {
        return await db.select({
          id:                   batchDeliveryLegs.id,
          batchId:              batchDeliveryLegs.batchId,
          city:                 batchDeliveryLegs.city,
          requestedQuantity:    batchDeliveryLegs.requestedQuantity,
          vinsReceivedQuantity: batchDeliveryLegs.vinsReceivedQuantity,
        }).from(batchDeliveryLegs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/no such table/i.test(msg)) return [] as {
          id: number; batchId: number; city: string;
          requestedQuantity: number; vinsReceivedQuantity: number;
        }[];
        if (/no such column/i.test(msg)) {
          // eslint-disable-next-line no-console
          console.warn(
            "[action-center-tree-data] batch_delivery_legs.vins_received_quantity missing — " +
            "Run /api/admin/ensure-vins-received-column to migrate. Treating per-leg VINs as 0.",
          );
          const legacy = await db.select({
            id:                batchDeliveryLegs.id,
            batchId:           batchDeliveryLegs.batchId,
            city:              batchDeliveryLegs.city,
            requestedQuantity: batchDeliveryLegs.requestedQuantity,
          }).from(batchDeliveryLegs);
          return legacy.map((l) => ({ ...l, vinsReceivedQuantity: 0 }));
        }
        throw err;
      }
    })(),
    (async () => {
      // Defensive: pre-Phase-A DBs don't have batch_date_revisions yet.
      // Wrapped so the missing-table case falls back to [] rather
      // than 500-ing the whole Action Center page. We log a warning
      // so an operator's "I shifted but the history is empty" can be
      // traced from the server logs to the missing-table cause.
      try {
        return await db.select({
          batchId:               batchDateRevisions.batchId,
          revisedAt:             batchDateRevisions.revisedAt,
          previousProjectedDate: batchDateRevisions.previousProjectedDate,
          newProjectedDate:      batchDateRevisions.newProjectedDate,
          reason:                batchDateRevisions.reason,
        })
          .from(batchDateRevisions)
          .orderBy(asc(batchDateRevisions.revisedAt));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/no such table/i.test(msg)) {
          // eslint-disable-next-line no-console
          console.warn(
            "[action-center-tree-data] batch_date_revisions table missing — " +
            "Shift History will render empty. Run POST /api/admin/ensure-batch-date-revisions to migrate.",
          );
          return [] as {
            batchId: number; revisedAt: string | null;
            previousProjectedDate: string; newProjectedDate: string;
            reason: string | null;
          }[];
        }
        throw err;
      }
    })(),
  ]);

  // Index per-city legs by batch — order preserved (intake order).
  const legsByBatch = new Map<number, BatchNode["legs"]>();
  for (const l of legsRows) {
    const arr = legsByBatch.get(l.batchId) ?? [];
    arr.push({
      id:                   l.id,
      city:                 l.city,
      quantity:             l.requestedQuantity,
      vinsReceivedQuantity: l.vinsReceivedQuantity ?? 0,
    });
    legsByBatch.set(l.batchId, arr);
  }

  // Index shift history by batch — earliest first.
  const shiftHistoryByBatch = new Map<number, BatchNode["shiftHistory"]>();
  for (const r of revisionRows) {
    const arr = shiftHistoryByBatch.get(r.batchId) ?? [];
    arr.push({
      revisedAt:    r.revisedAt ?? "",
      previousDate: r.previousProjectedDate,
      newDate:      r.newProjectedDate,
      reason:       r.reason ?? null,
    });
    shiftHistoryByBatch.set(r.batchId, arr);
  }

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

    // Filter out empty waves (no batches). After the batch-shift
    // auto-prune lands these should be rare, but defending here
    // hides any pre-existing empty placeholders from the UI even
    // before the admin cleanup runs.
    const wavesForPo: WaveNode[] = (wavesByPo.get(p.id) ?? [])
      .filter((w) => (batchesByWave.get(w.id)?.length ?? 0) > 0)
      .map((w) => {
      const wBatches = (batchesByWave.get(w.id) ?? []).map<BatchNode>((b) => {
        const totalValueSar = b.unitPriceSar != null && b.requestedQuantity > 0
          ? Math.round(b.unitPriceSar * b.requestedQuantity)
          : null;
        return {
          id:                 b.id,
          batchCode:          b.batchCode,
          modelYear:          [b.model, b.year].filter(Boolean).join(" ") || "—",
          city:               b.dealerReceivingCity ?? "—",
          requestedQuantity:  b.requestedQuantity,
          deliveredQuantity:  b.deliveredQuantity ?? 0,
          // Defensive — `vinsReceivedQuantity` is a newer column; some
          // pre-migration DB snapshots may still be missing it and
          // Drizzle's select returns undefined in that case. Treat as 0
          // until /api/admin/ensure-vins-received-column has run.
          vinsReceivedQuantity: (b as { vinsReceivedQuantity?: number | null }).vinsReceivedQuantity ?? 0,
          // `confirmedQuantity` is intentionally not on the Drizzle
          // schema (see lib/db/schema.ts comment) — read via raw SQL
          // through fetchConfirmedQtyByBatch above. Defaults to 0
          // when the column hasn't been migrated yet.
          confirmedQuantity:    confirmedQtyByBatch.get(b.id) ?? 0,
          closedAt:           b.closedAt ?? null,
          closureReason:      (b.closureReason ?? null) as BatchNode["closureReason"],
          appListedAt:        b.appListedAt ?? null,
          promisedDate:                  b.dealerPromisedDeliveryDate,
          currentProjectedDeliveryDate:  b.currentProjectedDeliveryDate ?? null,
          // Defensive reads — both *AtLock columns were added later
          // and may be missing on pre-migration DB snapshots.
          opsProjectedDeliveryDateAtLock:
            (b as { opsProjectedDeliveryDateAtLock?: string | null })
              .opsProjectedDeliveryDateAtLock ?? null,
          poExpectedDateAtLock:
            (b as { poExpectedDateAtLock?: string | null })
              .poExpectedDateAtLock ?? null,
          colorSummary:                  b.colorSummary ?? null,
          unitPriceSar:                  b.unitPriceSar ?? null,
          totalValueSar,
          shiftHistory:                  shiftHistoryByBatch.get(b.id) ?? [],
          legs:                          legsByBatch.get(b.id) ?? [],
          actions:            actionsByKey.get(`batch:${b.id}`) ?? [],
        };
      });
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

    // Listing-speed metrics (Review #2 R1/R9). Read `requestedAt` from
    // the raw batches (it's not on BatchNode) — the earliest submission
    // date across the PO's batches anchors the "since PO submitted"
    // clock. `appListedAt` lives per-batch; we take the latest, which
    // only exists when every batch is listed (the PO counts as "fully
    // listed" only then). Both null-safe for legacy POs.
    const todayIsoStr = new Date().toISOString().slice(0, 10);
    const rawBatchesUnderPo = wavesForPo
      .flatMap((w) => batchesByWave.get(w.id) ?? []);
    const firstSubmittedAt = rawBatchesUnderPo
      .map((b) => b.requestedAt)
      .filter((d): d is string => !!d)
      .sort()
      .at(0) ?? null;
    const daysSinceSubmission = firstSubmittedAt
      ? Math.max(0, Math.round(
          (new Date(todayIsoStr).getTime() - new Date(firstSubmittedAt).getTime())
            / (24 * 60 * 60 * 1000),
        ))
      : null;
    const daysToListed = (allListed && firstSubmittedAt && latestListedAt)
      ? Math.max(0, Math.round(
          (new Date(latestListedAt.slice(0, 10)).getTime() - new Date(firstSubmittedAt).getTime())
            / (24 * 60 * 60 * 1000),
        ))
      : null;

    // Review #4 R1+R2 — tree-badge reliability score. Computed only
    // when every batch under the PO is closed (matches the Insights
    // tab's "fullyClosed" gate). Color component is left empty here
    // (treated as 100%) because the action-center data layer doesn't
    // load batch_color_matrix; the full per-component breakdown
    // remains canonical on the Insights → PO Reliability tab.
    const reliabilityScore = (() => {
      const allBatchesClosed = rawBatchesUnderPo.length > 0
        && rawBatchesUnderPo.every((b) => b.closedAt != null);
      if (!allBatchesClosed) return null;
      const shaped: ReliabilityBatch[] = rawBatchesUnderPo.map((b) => ({
        batchCode:                       b.batchCode,
        requestedQuantity:               b.requestedQuantity,
        deliveredQuantity:               b.deliveredQuantity ?? 0,
        closedAt:                        b.closedAt ?? null,
        closureReason:                   (b.closureReason ?? null) as
                                           "delivered" | "cancelled" | null,
        poExpectedDateAtLock:
          (b as { poExpectedDateAtLock?: string | null }).poExpectedDateAtLock ?? null,
        opsProjectedDeliveryDateAtLock:
          (b as { opsProjectedDeliveryDateAtLock?: string | null })
            .opsProjectedDeliveryDateAtLock ?? null,
        dealerPromisedDeliveryDate:      b.dealerPromisedDeliveryDate,
        currentProjectedDeliveryDate:    b.currentProjectedDeliveryDate ?? null,
        shiftCount:                      b.deliveryDateRevisionCount ?? 0,
        colors:                          [],
      }));
      return computePoReliability(shaped).po.composite;
    })();

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
      daysSinceSubmission,
      daysToListed,
      reliabilityScore,
      isPrePo:      false,
      prePoBatchId: null,
      prePoSummary: null,
    };

    const arr = posByDealer.get(p.dealerId) ?? [];
    arr.push(node);
    posByDealer.set(p.dealerId, arr);
  }

  // ── Pre-PO virtual PoNodes ────────────────────────────────────
  // Pre-PO batches (lifecycleState='pre_po') don't have a real PO
  // entry in the `pos` table or a wave linkage yet — they're
  // Partnership commitments captured by the Forecast page. We surface
  // them in the Action Center tree as virtual PoNodes under their
  // dealer so ops can chase the Pre-PO App Listing (and any other
  // pre_po actions) from the same drawer they use for live POs. When
  // the real PO arrives via Intake the virtual node disappears (the
  // batch flips to post_po and re-emerges under a real PO).
  const prePoBatches = batchesRows.filter(
    (b) => b.lifecycleState === "pre_po" && b.closedAt == null,
  );
  let prePoForecastIndex: Map<
    number,
    { submittedAt: string; submittedByName: string | null; expectedPoDate: string | null }
  >;
  try {
    const forecastRows = await db
      .select({
        batchId:       batchForecasts.batchId,
        submittedAt:   batchForecasts.submittedAt,
        userName:      users.name,
        userUsername:  users.username,
      })
      .from(batchForecasts)
      .leftJoin(users, eq(batchForecasts.submittedByUserId, users.id));
    prePoForecastIndex = new Map(
      forecastRows.map((r) => [
        r.batchId,
        {
          submittedAt: r.submittedAt,
          submittedByName: r.userName ?? r.userUsername ?? null,
          expectedPoDate: null,
        },
      ]),
    );
  } catch {
    // batch_forecasts missing — tree still works without summaries.
    prePoForecastIndex = new Map();
  }

  for (const b of prePoBatches) {
    const batchActions = actionsByKey.get(`batch:${b.id}`) ?? [];
    const summary = prePoForecastIndex.get(b.id) ?? null;
    const virtualPoNode: PoNode = {
      // Use a negative id derived from the batch id so it can never
      // collide with a real `pos.id` (autoincrement is always > 0).
      id:                   -b.id,
      poNumber:             `Pre-PO · ${b.batchCode}`,
      poDate:               null,
      poReference:          null,
      contractLengthMonths: null,
      buyBackRate:          null,
      unitPriceSar:         null,
      closedAt:             null,
      totalCars:            b.requestedQuantity,
      totalValueSar:        null,
      nextAvailability:     b.dealerPromisedDeliveryDate,
      actions:              [],  // No PO-scope actions on pre_po batches.
      waves:                [],  // No waves yet — that's the whole point.
      appListingSummary: {
        listed:      0,
        total:       0,
        completedAt: null,
      },
      internalPhaseDone:   false,
      // Listing-speed KPI + PO reliability don't apply to Pre-PO —
      // the PO doesn't exist yet, so "PO → Listed" has no clock and
      // reliability has no realised outcome to score.
      daysSinceSubmission: null,
      daysToListed:        null,
      reliabilityScore:    null,
      isPrePo:             true,
      prePoBatchId:        b.id,
      prePoSummary: {
        city:                  b.dealerReceivingCity ?? "—",
        expectedDeliveryDate:  b.dealerPromisedDeliveryDate,
        expectedPoSigningDate: (b as { expectedPoDate?: string | null }).expectedPoDate ?? null,
        submittedAt:           summary?.submittedAt ?? "—",
        submittedByName:       summary?.submittedByName ?? null,
      },
    };
    // Stash the pre_po batch's actions on the virtualPoNode for the
    // drawer to render in the Pre-PO follow-up tab. We hijack the
    // `actions` field but mark `isPrePo` so the existing Internal
    // Phase view doesn't render them as PO-scope actions.
    virtualPoNode.actions = batchActions;
    const arr = posByDealer.get(b.dealerId) ?? [];
    arr.push(virtualPoNode);
    posByDealer.set(b.dealerId, arr);
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

  // Build the dept + stakeholder catalog used by the reassign picker.
  const stakeholdersByDept = new Map<number, { id: number; name: string }[]>();
  for (const s of stakeholderRows) {
    const arr = stakeholdersByDept.get(s.departmentId) ?? [];
    arr.push({ id: s.id, name: s.name });
    stakeholdersByDept.set(s.departmentId, arr);
  }
  const deptCatalog: DepartmentCatalog[] = deptCatalogRows.map((d) => ({
    id:           d.id,
    name:         d.name,
    stakeholders: stakeholdersByDept.get(d.id) ?? [],
  }));

  return {
    dealers:     dealerNodes,
    departments: deptCatalog,
    touchpointsByAction,
    generatedAt: new Date().toISOString(),
  };
}

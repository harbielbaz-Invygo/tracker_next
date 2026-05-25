/**
 * Forecast data layer — server-only queries powering the Forecast page.
 *
 * A Forecast row is a `batches` row with `lifecycleState='pre_po'` and
 * a matching 1:1 `batch_forecasts` extension carrying the Partnership
 * submission metadata (submittedAt + submittedByUserId).
 *
 * Lifecycle states surfaced here:
 *   - "open"        — pre_po, not closed, not superseded. Waiting for PO.
 *   - "fulfilled"   — flipped to post_po by Intake (PR 3) — same record.
 *   - "superseded"  — split into multiple Intake batches; the parent
 *                     stays for accuracy tracking.
 *   - "cancelled"   — Ops cancelled the Forecast (counts as a miss).
 */
import { and, eq, asc, desc, gte, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batches, batchForecasts, batchDeliveryLegs, dealers, users, departments, stakeholders,
} from "@/lib/db/schema";

const PARTNERSHIP_DEPARTMENT_NAME = "Partnership";

export type ForecastStatus = "open" | "fulfilled" | "superseded" | "cancelled";

/**
 * Per-row Pre-PO listing data — one entry per `batch_delivery_legs`
 * row attached to a Forecast batch. Captures what was committed to
 * customers (city × model × qty × listing date) before the PO arrived.
 */
export interface ForecastLeg {
  legId: number;
  city: string;
  carModel: string | null;
  quantity: number;
  listedAt: string | null;
  promisedAvailabilityDate: string | null;
  bookingsCount: number;
}

export interface ForecastRow {
  batchId: number;
  batchCode: string;
  dealerId: number;
  dealerName: string;
  city: string;
  quantity: number;
  expectedDeliveryDate: string;   // ISO yyyy-mm-dd
  /** Dealer's commitment to sign by this date. Drives the PO-signing
   *  chase chip in the list. Null when the Partnership team didn't
   *  capture one at submission time. */
  promisedPoSigningDate: string | null;
  submittedAt: string;            // ISO yyyy-mm-dd
  submittedByUserId: number;
  submittedByName: string;        // user.name ?? username
  status: ForecastStatus;
  closedAt: string | null;
  /** Forecast's per-row commitments. Empty when the legs migration
   *  hasn't run yet on this environment. */
  legs: ForecastLeg[];
  /** Sum of bookingsCount across legs — surfaces "how many customers
   *  are already on the hook?" headline on each row. */
  totalBookings: number;
  /** When this Forecast was manually linked to a post-PO batch (via
   *  /api/forecast/link-po), that batch's identity. Null until linked. */
  linkedPo: { batchId: number; batchCode: string; poNumber: string | null } | null;
}

/**
 * Candidate post-PO batch the operator can pick when manually linking
 * a Forecast to its arrived PO. Recent post-PO batches that aren't
 * already linked to a different Forecast, scoped to the last 90 days
 * so the picker stays short.
 */
export interface ForecastLinkCandidate {
  batchId: number;
  batchCode: string;
  dealerId: number;
  dealerName: string;
  poNumber: string | null;
  city: string;
  model: string | null;
  year: number | null;
  quantity: number;
  /** ISO yyyy-mm-dd when the PO was actually signed (from batches.actualPoDate). */
  poDate: string | null;
  promisedDate: string;
  alreadyLinkedTo: number | null;
}

export interface ForecastFormOptions {
  dealers:  { id: number; name: string }[];
  /** Any user (admin or ops) may be picked as the submitting Partnership member. */
  users:    { id: number; label: string }[];
}

/**
 * Pull every Forecast in the system. Sorted by submission date desc
 * so the freshest commitments are on top.
 *
 * Defensive: if `batch_forecasts` (or the new columns on `batches`)
 * haven't been migrated yet on this DB, return [] instead of 500-ing
 * the page. Mirrors the pattern used for `batch_delivery_legs` and
 * `batch_vin_stages` elsewhere in the codebase.
 */
export async function getForecastRows(): Promise<ForecastRow[]> {
  let rows: Awaited<ReturnType<typeof selectForecastRows>>;
  try {
    rows = await selectForecastRows();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table|no such column/i.test(msg)) {
      // eslint-disable-next-line no-console
      console.warn(
        "[forecast-data] batch_forecasts / new batches columns missing — " +
        "did you run `npm run db:push` after PR 1? Returning empty list.",
      );
      return [];
    }
    throw err;
  }

  // Per-row leg data — loaded once with a single query covering every
  // forecast batch, then bucketed in-memory. Pre-PO listing extension
  // columns may not exist on legacy DBs; degrades to empty `legs` and
  // zero bookings rather than failing the page.
  const batchIds = rows.map((r) => r.batchId);
  const legsByBatch = await loadLegsForForecasts(batchIds);

  // Manual-link reverse pointers — post-PO batches whose
  // `parent_forecast_batch_id` points back at one of these forecasts.
  const linkedByForecastId = await loadLinkedPoBatches(batchIds);

  return rows.map((r) => {
    const legs = legsByBatch.get(r.batchId) ?? [];
    const totalBookings = legs.reduce((s, l) => s + l.bookingsCount, 0);
    return {
      batchId:    r.batchId,
      batchCode:  r.batchCode,
      dealerId:   r.dealerId,
      dealerName: r.dealerName ?? "—",
      city:       r.city ?? "—",
      quantity:   r.quantity,
      expectedDeliveryDate:  r.expectedDate,
      promisedPoSigningDate: r.expectedPoDate ?? null,
      submittedAt:       r.submittedAt,
      submittedByUserId: r.submittedById,
      submittedByName:   r.userName ?? r.userUsername ?? `User #${r.submittedById}`,
      status:            statusFromRow(r),
      closedAt:          r.closedAt ?? null,
      legs,
      totalBookings,
      linkedPo:          linkedByForecastId.get(r.batchId) ?? null,
    };
  });
}

function selectForecastRows() {
  return db
    .select({
      batchId:       batches.id,
      batchCode:     batches.batchCode,
      dealerId:      batches.dealerId,
      dealerName:    dealers.name,
      city:          batches.dealerReceivingCity,
      quantity:      batches.requestedQuantity,
      expectedDate:  batches.dealerPromisedDeliveryDate,
      expectedPoDate: batches.expectedPoDate,
      lifecycleState: batches.lifecycleState,
      closedAt:      batches.closedAt,
      closureReason: batches.closureReason,
      supersededAt:  batches.forecastSupersededAt,
      submittedAt:   batchForecasts.submittedAt,
      submittedById: batchForecasts.submittedByUserId,
      userName:      users.name,
      userUsername:  users.username,
    })
    .from(batchForecasts)
    .innerJoin(batches, eq(batchForecasts.batchId, batches.id))
    .leftJoin(dealers,  eq(batches.dealerId, dealers.id))
    .leftJoin(users,    eq(batchForecasts.submittedByUserId, users.id))
    .orderBy(desc(batchForecasts.submittedAt), desc(batchForecasts.id));
}

async function loadLegsForForecasts(batchIds: number[]): Promise<Map<number, ForecastLeg[]>> {
  const out = new Map<number, ForecastLeg[]>();
  if (batchIds.length === 0) return out;
  try {
    const rows = await db
      .select({
        legId:                    batchDeliveryLegs.id,
        batchId:                  batchDeliveryLegs.batchId,
        city:                     batchDeliveryLegs.city,
        carModel:                 batchDeliveryLegs.carModel,
        requestedQuantity:        batchDeliveryLegs.requestedQuantity,
        listedAt:                 batchDeliveryLegs.listedAt,
        promisedAvailabilityDate: batchDeliveryLegs.promisedAvailabilityDate,
        bookingsCount:            batchDeliveryLegs.bookingsCount,
      })
      .from(batchDeliveryLegs);
    for (const r of rows) {
      if (!batchIds.includes(r.batchId)) continue;
      const arr = out.get(r.batchId) ?? [];
      arr.push({
        legId:                    r.legId,
        city:                     r.city,
        carModel:                 r.carModel ?? null,
        quantity:                 r.requestedQuantity,
        listedAt:                 r.listedAt ?? null,
        promisedAvailabilityDate: r.promisedAvailabilityDate ?? null,
        bookingsCount:            r.bookingsCount ?? 0,
      });
      out.set(r.batchId, arr);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no such table|no such column/i.test(msg)) throw err;
    // eslint-disable-next-line no-console
    console.warn(
      "[forecast-data] pre-PO listing columns missing on batch_delivery_legs — " +
      "run `npm run db:push` to enable per-row model / listing / bookings.",
    );
  }
  return out;
}

async function loadLinkedPoBatches(forecastBatchIds: number[]) {
  const out = new Map<number, { batchId: number; batchCode: string; poNumber: string | null }>();
  if (forecastBatchIds.length === 0) return out;
  try {
    const rows = await db
      .select({
        id:        batches.id,
        batchCode: batches.batchCode,
        poNumber:  batches.poNumber,
        parentId:  batches.parentForecastBatchId,
      })
      .from(batches)
      .where(isNotNull(batches.parentForecastBatchId));
    for (const r of rows) {
      if (r.parentId == null) continue;
      if (!forecastBatchIds.includes(r.parentId)) continue;
      // Only surface the most recent link if multiple POs point at the
      // same Forecast — rare, but keeps the UI single-valued.
      if (!out.has(r.parentId)) {
        out.set(r.parentId, {
          batchId:   r.id,
          batchCode: r.batchCode,
          poNumber:  r.poNumber ?? null,
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no such column/i.test(msg)) throw err;
  }
  return out;
}

/**
 * Pull candidate post-PO batches for the manual Forecast→PO link picker.
 * Scoped to the last 90 days and excluded if already linked to a
 * different Forecast. Optional `dealerId` filter to surface same-dealer
 * candidates first in the UI; passing null returns all dealers.
 */
export async function getForecastLinkCandidates(
  dealerId: number | null = null,
): Promise<ForecastLinkCandidate[]> {
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const sinceIso = ninetyDaysAgo.toISOString().slice(0, 10);

  const whereClauses = [
    eq(batches.lifecycleState, "post_po"),
    gte(batches.requestedAt, sinceIso),
  ];

  try {
    const rows = await db
      .select({
        batchId:       batches.id,
        batchCode:     batches.batchCode,
        dealerId:      batches.dealerId,
        dealerName:    dealers.name,
        poNumber:      batches.poNumber,
        city:          batches.dealerReceivingCity,
        model:         batches.model,
        year:          batches.year,
        quantity:      batches.requestedQuantity,
        // `batches` doesn't have a `po_date` column directly — the
        // actual signing date lives in `actual_po_date`. The `pos`
        // table also carries one but joining there isn't required for
        // the picker (a label sorted by signing date is enough).
        poDate:        batches.actualPoDate,
        promisedDate:  batches.dealerPromisedDeliveryDate,
        parentForecastBatchId: batches.parentForecastBatchId,
      })
      .from(batches)
      .leftJoin(dealers, eq(batches.dealerId, dealers.id))
      .where(and(...whereClauses))
      .orderBy(desc(batches.actualPoDate), desc(batches.id))
      .limit(200);
    return rows
      .filter((r) => dealerId == null || r.dealerId === dealerId)
      .map((r) => ({
        batchId:         r.batchId,
        batchCode:       r.batchCode,
        dealerId:        r.dealerId,
        dealerName:      r.dealerName ?? "—",
        poNumber:        r.poNumber ?? null,
        city:            r.city ?? "—",
        model:           r.model ?? null,
        year:            r.year ?? null,
        quantity:        r.quantity,
        poDate:          r.poDate ?? null,
        promisedDate:    r.promisedDate,
        alreadyLinkedTo: r.parentForecastBatchId ?? null,
      }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such column/i.test(msg)) return [];
    throw err;
  }
}

function statusFromRow(r: {
  lifecycleState: "pre_po" | "post_po";
  closedAt: string | null;
  closureReason: "delivered" | "cancelled" | null;
  supersededAt: string | null;
}): ForecastStatus {
  if (r.closureReason === "cancelled") return "cancelled";
  if (r.supersededAt) return "superseded";
  if (r.lifecycleState === "post_po") return "fulfilled";
  return "open";
}

/** Dealers + Partnership-department stakeholders for the Forecast form.
 *
 *  Source moved from `users` → `stakeholders` (matches what Settings →
 *  Department → Stakeholders shows). The previous user-based lookup
 *  required admin to assign user accounts to the Partnership
 *  department; the new stakeholder source uses the names ops already
 *  configured in Settings.
 *
 *  Field name on the public type stays `users` for backwards
 *  compatibility with existing form code — the *contents* are now
 *  stakeholder rows, not user rows.
 */
export async function getForecastFormOptions(): Promise<ForecastFormOptions> {
  const dealerRows = await db
    .select({ id: dealers.id, name: dealers.name })
    .from(dealers)
    .orderBy(asc(dealers.name));

  // Resolve the Partnership department's id. If the dept doesn't
  // exist (fresh DB / typo), the dropdown stays empty and the form
  // surfaces its "No Partnership members configured" hint.
  let partnershipDeptId: number | null = null;
  try {
    const rows = await db
      .select({ id: departments.id })
      .from(departments)
      .where(eq(departments.name, PARTNERSHIP_DEPARTMENT_NAME))
      .limit(1);
    partnershipDeptId = rows[0]?.id ?? null;
  } catch {
    partnershipDeptId = null;
  }

  let stakeholderRows: { id: number; name: string }[] = [];
  if (partnershipDeptId != null) {
    try {
      stakeholderRows = await db
        .select({ id: stakeholders.id, name: stakeholders.name })
        .from(stakeholders)
        .where(eq(stakeholders.departmentId, partnershipDeptId))
        .orderBy(asc(stakeholders.name));
    } catch (err) {
      // Pre-migration / older deploy where the stakeholders table is
      // missing — fall back to empty list, form surfaces the hint.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/no such (column|table)/i.test(msg)) throw err;
      stakeholderRows = [];
    }
  }

  return {
    dealers: dealerRows,
    users: stakeholderRows.map((s) => ({
      id: s.id,
      label: s.name,
    })),
  };
}

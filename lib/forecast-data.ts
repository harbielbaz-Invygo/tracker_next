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
import { eq, asc, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { batches, batchForecasts, dealers, users, departments } from "@/lib/db/schema";

const PARTNERSHIP_DEPARTMENT_NAME = "Partnership";

export type ForecastStatus = "open" | "fulfilled" | "superseded" | "cancelled";

export interface ForecastRow {
  batchId: number;
  batchCode: string;
  dealerName: string;
  city: string;
  quantity: number;
  expectedDeliveryDate: string;   // ISO yyyy-mm-dd
  submittedAt: string;            // ISO yyyy-mm-dd
  submittedByUserId: number;
  submittedByName: string;        // user.name ?? username
  status: ForecastStatus;
  closedAt: string | null;
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

  return rows.map((r) => ({
    batchId:    r.batchId,
    batchCode:  r.batchCode,
    dealerName: r.dealerName ?? "—",
    city:       r.city ?? "—",
    quantity:   r.quantity,
    expectedDeliveryDate: r.expectedDate,
    submittedAt:       r.submittedAt,
    submittedByUserId: r.submittedById,
    submittedByName:   r.userName ?? r.userUsername ?? `User #${r.submittedById}`,
    status:            statusFromRow(r),
    closedAt:          r.closedAt ?? null,
  }));
}

function selectForecastRows() {
  return db
    .select({
      batchId:       batches.id,
      batchCode:     batches.batchCode,
      dealerName:    dealers.name,
      city:          batches.dealerReceivingCity,
      quantity:      batches.requestedQuantity,
      expectedDate:  batches.dealerPromisedDeliveryDate,
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

/** Dealers + Partnership-department users for the Forecast form. */
export async function getForecastFormOptions(): Promise<ForecastFormOptions> {
  const dealerRows = await db
    .select({ id: dealers.id, name: dealers.name })
    .from(dealers)
    .orderBy(asc(dealers.name));

  // Resolve the Partnership department's id so we can filter users.
  // Wrapped in try/catch so a missing `users.department_id` column
  // doesn't 500 the page; admin runs
  // /api/admin/ensure-user-department-column to enable the filter.
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

  let userRows: { id: number; name: string | null; username: string }[];
  try {
    if (partnershipDeptId != null) {
      userRows = await db
        .select({
          id: users.id,
          name: users.name,
          username: users.username,
        })
        .from(users)
        .where(eq(users.departmentId, partnershipDeptId))
        .orderBy(asc(users.username));
    } else {
      userRows = await db
        .select({ id: users.id, name: users.name, username: users.username })
        .from(users)
        .orderBy(asc(users.username));
    }
  } catch (err) {
    // Pre-migration DB: department_id column missing on users. Fall
    // back to the unfiltered list so the form keeps working.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no such column/i.test(msg)) throw err;
    userRows = await db
      .select({ id: users.id, name: users.name, username: users.username })
      .from(users)
      .orderBy(asc(users.username));
  }

  return {
    dealers: dealerRows,
    users: userRows.map((u) => ({
      id: u.id,
      label: u.name ? `${u.name} (@${u.username})` : `@${u.username}`,
    })),
  };
}

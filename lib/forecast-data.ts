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
import { eq, asc, desc, isNull, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { batches, batchForecasts, dealers, users } from "@/lib/db/schema";

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
 */
export async function getForecastRows(): Promise<ForecastRow[]> {
  const rows = await db
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

/** Dealers + users for the Forecast form dropdowns. */
export async function getForecastFormOptions(): Promise<ForecastFormOptions> {
  const [dealerRows, userRows] = await Promise.all([
    db.select({ id: dealers.id, name: dealers.name }).from(dealers).orderBy(asc(dealers.name)),
    db.select({
      id: users.id,
      name: users.name,
      username: users.username,
    }).from(users).orderBy(asc(users.username)),
  ]);
  return {
    dealers: dealerRows,
    users: userRows.map((u) => ({
      id: u.id,
      label: u.name ? `${u.name} (@${u.username})` : `@${u.username}`,
    })),
  };
}

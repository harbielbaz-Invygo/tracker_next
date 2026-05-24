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
import { batches, batchForecasts, dealers, users, departments, stakeholders } from "@/lib/db/schema";

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

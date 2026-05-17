/**
 * Intake form options loader — server-only.
 *
 * Pulls everything the Intake form needs to render in one round trip:
 *   - All active departments + their stakeholders
 *   - All action types (master action picker), with default dept
 *   - All action dependencies (for the "depends on X, Y" hints)
 *   - All dealers (for the dealer selector; create-new is also supported)
 */
import { asc, eq, and, isNull, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  departments, stakeholders, actionTypes, actionDependencies, dealers,
  batches, batchForecasts,
} from "@/lib/db/schema";
import { getLeadTimeDays } from "@/lib/rules";

export interface IntakeOptions {
  /** Pre PO Ops Lead Time in days — minimum buffer between today and the
   *  promised availability date. Used by the Intake risk-check. */
  leadTimeDays: number;
  departments: {
    id: number;
    name: string;
    sortOrder: number;
    /** Stakeholders that can be picked for this department's actions. */
    stakeholders: { id: number; name: string; sortOrder: number }[];
  }[];
  actionTypes: {
    id: number;
    name: string;
    waitingLabel: string;
    doneLabel: string;
    defaultDepartmentId: number | null;
    sortOrder: number;
    /** Names of action types this one depends on (for "Waiting on …" hints). */
    dependsOnNames: string[];
  }[];
  dealers: { id: number; name: string; homeCity: string }[];
  /**
   * Open Forecasts the Intake can fulfil. An Intake submission may
   * optionally link to one of these; the create route then flips the
   * Forecast batch to post_po (1:1) or marks it superseded and creates
   * children with `parentForecastBatchId` set (split).
   */
  openForecasts: {
    batchId: number;
    label: string;        // human-readable summary for the picker
    dealerName: string;
    city: string;
    quantity: number;
    expectedDate: string; // ISO yyyy-mm-dd
  }[];
}

export async function getIntakeOptions(): Promise<IntakeOptions> {
  // Open Forecasts query is wrapped — if batch_forecasts (or the new
  // columns on batches) aren't migrated yet, default to [] so Intake
  // still loads. Same fallback pattern used for batch_delivery_legs
  // and batch_vin_stages.
  const openForecastsPromise = (async () => {
    try {
      return await db.select({
        batchId:      batches.id,
        dealerName:   dealers.name,
        city:         batches.dealerReceivingCity,
        quantity:     batches.requestedQuantity,
        expectedDate: batches.dealerPromisedDeliveryDate,
      })
      .from(batchForecasts)
      .innerJoin(batches, eq(batchForecasts.batchId, batches.id))
      .leftJoin(dealers, eq(batches.dealerId, dealers.id))
      .where(and(
        eq(batches.lifecycleState, "pre_po"),
        isNull(batches.closedAt),
        isNull(batches.forecastSupersededAt),
      ))
      .orderBy(desc(batchForecasts.submittedAt));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such table|no such column/i.test(msg)) {
        // eslint-disable-next-line no-console
        console.warn(
          "[intake-data] batch_forecasts / new batches columns missing — " +
          "Forecast picker hidden. Run `npm run db:push`.",
        );
        return [];
      }
      throw err;
    }
  })();

  const [deptsRaw, stakeholdersRaw, typesRaw, depsRaw, dealersRaw, leadTimeDays, openForecastRows] = await Promise.all([
    db.select().from(departments).orderBy(asc(departments.sortOrder)),
    db.select().from(stakeholders).orderBy(asc(stakeholders.sortOrder)),
    db.select().from(actionTypes).orderBy(asc(actionTypes.sortOrder)),
    db.select().from(actionDependencies),
    db.select().from(dealers).orderBy(asc(dealers.name)),
    getLeadTimeDays(),
    openForecastsPromise,
  ]);

  const nameByActionTypeId = new Map(typesRaw.map((t) => [t.id, t.name]));
  const dependsOnByChild = new Map<number, string[]>();
  for (const d of depsRaw) {
    const arr = dependsOnByChild.get(d.actionTypeId) ?? [];
    const parentName = nameByActionTypeId.get(d.dependsOnActionTypeId);
    if (parentName) arr.push(parentName);
    dependsOnByChild.set(d.actionTypeId, arr);
  }

  // Group stakeholders by department.
  const stakeholdersByDept = new Map<number, { id: number; name: string; sortOrder: number }[]>();
  for (const s of stakeholdersRaw) {
    const arr = stakeholdersByDept.get(s.departmentId) ?? [];
    arr.push({ id: s.id, name: s.name, sortOrder: s.sortOrder });
    stakeholdersByDept.set(s.departmentId, arr);
  }

  // Action types that are auto-attached by the system rather than
  // user-picked at Intake time:
  //   - Delivery: every Intake batch needs one (closure trigger);
  //     attached by /api/intake/create on every new batch.
  //   - Pre-PO App Listing: only meaningful on Forecast batches;
  //     attached by /api/forecast/create or copied during a split.
  // Hidden from the Intake action picker so ops doesn't have to
  // remember to tick them.
  const AUTO_ATTACHED_ACTION_NAMES = new Set(["Delivery", "Pre-PO App Listing"]);

  return {
    leadTimeDays,
    departments: deptsRaw.map((d) => ({
      id: d.id, name: d.name, sortOrder: d.sortOrder,
      stakeholders: stakeholdersByDept.get(d.id) ?? [],
    })),
    actionTypes: typesRaw
      .filter((t) => !AUTO_ATTACHED_ACTION_NAMES.has(t.name))
      .map((t) => ({
        id: t.id,
        name: t.name,
        waitingLabel: t.waitingLabel,
        doneLabel: t.doneLabel,
        defaultDepartmentId: t.defaultDepartmentId,
        sortOrder: t.sortOrder,
        dependsOnNames: dependsOnByChild.get(t.id) ?? [],
      })),
    dealers: dealersRaw.map((d) => ({
      id: d.id, name: d.name, homeCity: d.homeCity,
    })),
    openForecasts: openForecastRows.map((r) => ({
      batchId:      r.batchId,
      dealerName:   r.dealerName ?? "—",
      city:         r.city ?? "—",
      quantity:     r.quantity,
      expectedDate: r.expectedDate,
      label: `${r.dealerName ?? "—"} · ${r.quantity}× in ${r.city ?? "—"} · expected ${r.expectedDate}`,
    })),
  };
}

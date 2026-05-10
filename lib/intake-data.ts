/**
 * Intake form options loader — server-only.
 *
 * Pulls everything the Intake form needs to render in one round trip:
 *   - All active departments + their stakeholders
 *   - All action types (master action picker), with default dept
 *   - All action dependencies (for the "depends on X, Y" hints)
 *   - All dealers (for the dealer selector; create-new is also supported)
 */
import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  departments, stakeholders, actionTypes, actionDependencies, dealers,
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
}

export async function getIntakeOptions(): Promise<IntakeOptions> {
  const [deptsRaw, stakeholdersRaw, typesRaw, depsRaw, dealersRaw, leadTimeDays] = await Promise.all([
    db.select().from(departments).orderBy(asc(departments.sortOrder)),
    db.select().from(stakeholders).orderBy(asc(stakeholders.sortOrder)),
    db.select().from(actionTypes).orderBy(asc(actionTypes.sortOrder)),
    db.select().from(actionDependencies),
    db.select().from(dealers).orderBy(asc(dealers.name)),
    getLeadTimeDays(),
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

  return {
    leadTimeDays,
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
      dependsOnNames: dependsOnByChild.get(t.id) ?? [],
    })),
    dealers: dealersRaw.map((d) => ({
      id: d.id, name: d.name, homeCity: d.homeCity,
    })),
  };
}

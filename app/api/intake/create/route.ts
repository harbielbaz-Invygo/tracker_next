/**
 * POST /api/intake/create — submit a Post-PO Intake.
 *
 * One PO becomes one batch per (item × split). Actions picked at Intake
 * apply to every batch created. Dependencies determine initial status:
 *   - action with no parent dependencies → waiting
 *   - action with any parent dependency  → blocked
 * Once Ops marks a parent done in Cockpit, dependents auto-promote.
 *
 * If the dealer doesn't exist yet, we create one with the dealer name as
 * given and the first split's city as home_city.
 */
import { eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  batches, dealers, batchActions, actionDependencies, actionTypes,
} from "@/lib/db/schema";
import { makeBatchCode } from "@/lib/utils";
import { getLeadTimeDays } from "@/lib/rules";
import { requireAuth } from "@/lib/api-auth";
import { computeExpectedDate } from "@/lib/expected-date";

export const runtime = "nodejs";

interface CreateBody {
  po: {
    number: string;
    date: string;                // ISO yyyy-mm-dd
    reference?: string | null;
  };
  /** Either dealerId (existing) or dealerName (create-new). One required. */
  dealerId?: number;
  dealerName?: string;
  items: {
    model: string;
    year: number;
    buyBackRate?: number | null;
    contractLength?: string | null;
    contractLengthMonths?: number | null;
    colorsRaw?: string | null;
    unitPriceSar?: number | null;
    taxPct?: number | null;
    splits: {
      quantity: number;
      city: string;
      /** ISO — dealer-promised availability date (the PO promise). */
      date: string;
      /**
       * ISO — Ops's own expected delivery date, the operational
       * commitment used to measure Ops Confidence. Stored on the batch
       * as `currentProjectedDeliveryDate`. Defaults to `date` in the UI,
       * but Ops can adjust before submitting.
       */
      opsExpectedDate: string;
    }[];
  }[];
  actions: {
    actionTypeId: number;
    /** Override of action_types.defaultDepartmentId; nullable. */
    departmentId: number | null;
    /** Stakeholder (within the department) responsible for this action; nullable. */
    assignedStakeholderId?: number | null;
  }[];
  notes?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoMinusDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // ── Validate ────────────────────────────────────────────────────
  const errors = validate(body);
  if (errors.length) {
    return NextResponse.json({ error: errors.join("; ") }, { status: 400 });
  }

  // ── Resolve dealer (find-or-create) ────────────────────────────
  let dealerId: number;
  if (body.dealerId) {
    const [d] = await db.select({ id: dealers.id })
      .from(dealers).where(eq(dealers.id, body.dealerId)).limit(1);
    if (!d) return NextResponse.json({ error: `dealerId ${body.dealerId} not found` }, { status: 400 });
    dealerId = d.id;
  } else {
    const name = body.dealerName!.trim();
    const [existing] = await db.select({ id: dealers.id })
      .from(dealers).where(eq(dealers.name, name)).limit(1);
    if (existing) {
      dealerId = existing.id;
    } else {
      const [created] = await db.insert(dealers).values({
        name,
        homeCity: body.items[0].splits[0].city,
        dealerType: "old",
        policyStatus: "existing",
        avgResponseDays: 3.0,
      }).returning({ id: dealers.id });
      dealerId = created.id;
    }
  }
  const [dealerRow] = await db.select({ name: dealers.name })
    .from(dealers).where(eq(dealers.id, dealerId)).limit(1);
  const dealerName = dealerRow.name;

  // ── Lookup dependency map + offsets for picked actions only ────
  const pickedActionIds = body.actions.map((a) => a.actionTypeId);
  const depsRows = pickedActionIds.length
    ? await db.select().from(actionDependencies)
        .where(inArray(actionDependencies.actionTypeId, pickedActionIds))
    : [];
  const hasParentDep = new Set<number>(); // actionTypeId → has any parent dep
  for (const d of depsRows) hasParentDep.add(d.actionTypeId);

  // Fetch full action_type metadata so we can both validate and use the
  // offset/anchor when computing each batch_action's expected date.
  const typeRows = pickedActionIds.length
    ? await db.select({
        id: actionTypes.id,
        offsetDays: actionTypes.offsetDays,
        offsetAnchor: actionTypes.offsetAnchor,
      }).from(actionTypes)
        .where(inArray(actionTypes.id, pickedActionIds))
    : [];
  const typeById = new Map(typeRows.map((t) => [t.id, t]));
  const invalidPicks = pickedActionIds.filter((id) => !typeById.has(id));
  if (invalidPicks.length) {
    return NextResponse.json(
      { error: `Unknown actionTypeId(s): ${invalidPicks.join(", ")}` },
      { status: 400 },
    );
  }

  // ── Create batches × splits — single transaction ──────────────
  // If any insert below throws (FK violation, disk full, …), the whole
  // submission rolls back so we never leave half-created batches.
  const today = todayIso();
  const leadTimeDays = await getLeadTimeDays();
  const splitTotal = body.items.reduce((sum, it) => sum + it.splits.length, 0);

  // ── Feasibility flag — Ops behind dealer promise? ──────────────
  // The form locks PO Availability (the dealer date) and auto-floors
  // Ops Expected to today + leadTimeDays. So the only risk signal at
  // submit time is: did Ops's commitment land later than the dealer's
  // promised date? If so, mark the batch at_risk so dashboards flag it.
  // No hard server block — the form has already mediated the floor.
  const feasibilityStatus: "feasible" | "at_risk" = body.items.some((it) =>
    it.splits.some((s) => (s.opsExpectedDate || s.date) > s.date),
  ) ? "at_risk" : "feasible";

  type CreatedBatch = { id: number; batchCode: string; modelYear: string; city: string; quantity: number };

  // libSQL transactions take an async callback. All inserts/updates
  // inside must be `await`-ed; if any throws, the whole submission rolls
  // back and we never leave half-created batches.
  const created: CreatedBatch[] = await db.transaction(async (tx) => {
    const out: CreatedBatch[] = [];
    let splitN = 0;
    for (const item of body.items) {
      for (const split of item.splits) {
        splitN++;
        const batchCode = makeBatchCode({
          poNumber:   body.po.number,
          dealerName,
          splitN,
          splitTotal,
          city:       split.city,
          model:      item.model,
          qty:        split.quantity,
        });
        // Per-batch target PO date — Ops needs `leadTimeDays` before the
        // split's own promised delivery date.
        const targetPoDate = isoMinusDays(split.date, leadTimeDays);
        const [batchRow] = await tx.insert(batches).values({
          batchCode,
          dealerId,
          model: item.model,
          year:  item.year,
          category: "Standard",

          buyBackRate:           item.buyBackRate ?? undefined,
          contractLengthMonths:  item.contractLengthMonths ?? undefined,
          colorSummary:          item.colorsRaw ?? undefined,
          unitPriceSar:          item.unitPriceSar ?? undefined,
          taxPct:                item.taxPct ?? undefined,

          poNumber:    body.po.number,
          poReference: body.po.reference ?? undefined,

          requestedQuantity: split.quantity,
          requestedAt: today,
          dealerPromisedDeliveryDate: split.date,
          targetPoDate,
          expectedPoDate: body.po.date,
          actualPoDate:   body.po.date,
          // Ops's own commitment, separate from the dealer promise. Used
          // to measure Ops Confidence over time. Falls back to the dealer
          // date if Ops didn't change it at Intake.
          currentProjectedDeliveryDate: split.opsExpectedDate || split.date,

          appDisplayCities:    split.city,
          dealerReceivingCity: split.city,
          requiresInterCityTransit: false,
          // VIN receiving date is no longer captured at Intake — Ops
          // sets it later in Cockpit when the dealer commits a VIN date.
          // Until then, post-VIN actions have a null expectedDate.
          vinReceivingDate:    null,

          currentStage: "po_issued",
          lifecycleState: "post_po",
          feasibilityStatus,

          notes: body.notes ?? undefined,
        }).returning({ id: batches.id });

        // Create batch_actions per picked action — same transaction.
        // Each action's expectedDate is derived from the action_type's
        // offsetDays + offsetAnchor and the batch's submission, VIN, and
        // promised dates.
        for (const a of body.actions) {
          const status = hasParentDep.has(a.actionTypeId) ? "blocked" : "waiting";
          const type = typeById.get(a.actionTypeId);
          // VIN receiving date is captured later in Cockpit, so it's
          // null at Intake. Vin-anchored actions get a null expected
          // date here; they fill in once the VIN date is known.
          const expectedDate = type
            ? computeExpectedDate({
                anchor:     type.offsetAnchor,
                offsetDays: type.offsetDays,
                submission: today,
                vin:        null,
                promised:   split.date,
              })
            : null;
          await tx.insert(batchActions).values({
            batchId:      batchRow.id,
            actionTypeId: a.actionTypeId,
            departmentId: a.departmentId ?? undefined,
            assignedStakeholderId: a.assignedStakeholderId ?? undefined,
            status,
            expectedDate: expectedDate ?? undefined,
          });
        }

        out.push({
          id: batchRow.id,
          batchCode,
          modelYear: `${item.model} ${item.year}`,
          city: split.city,
          quantity: split.quantity,
        });
      }
    }
    return out;
  });

  return NextResponse.json({ ok: true, created });
}

// ── Validation ─────────────────────────────────────────────────────

function validate(body: CreateBody): string[] {
  const errors: string[] = [];
  if (!body.po) errors.push("po block required");
  else {
    if (!body.po.number?.trim()) errors.push("po.number required");
    if (!isIso(body.po.date)) errors.push("po.date must be yyyy-mm-dd");
  }
  if (!body.dealerId && !body.dealerName?.trim()) {
    errors.push("dealerId or dealerName required");
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    errors.push("items required (at least one)");
  } else {
    for (const [i, it] of body.items.entries()) {
      if (!it.model?.trim())     errors.push(`items[${i}].model required`);
      if (!Number.isFinite(it.year)) errors.push(`items[${i}].year required`);
      if (!Array.isArray(it.splits) || it.splits.length === 0) {
        errors.push(`items[${i}].splits required (at least one)`);
        continue;
      }
      for (const [j, s] of it.splits.entries()) {
        if (!Number.isFinite(s.quantity) || s.quantity <= 0) errors.push(`items[${i}].splits[${j}].quantity must be > 0`);
        if (!s.city?.trim())   errors.push(`items[${i}].splits[${j}].city required`);
        if (!isIso(s.date))    errors.push(`items[${i}].splits[${j}].date must be yyyy-mm-dd`);
        if (!isIso(s.opsExpectedDate)) errors.push(`items[${i}].splits[${j}].opsExpectedDate must be yyyy-mm-dd`);
      }
    }
  }
  if (!Array.isArray(body.actions) || body.actions.length === 0) {
    errors.push("actions required (at least one picked)");
  }
  return errors;
}

function isIso(s?: string | null): boolean {
  if (!s) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

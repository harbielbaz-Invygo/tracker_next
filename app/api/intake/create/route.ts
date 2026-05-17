/**
 * POST /api/intake/create — submit a Post-PO Intake.
 *
 * One PO becomes one batch per (item × split). Actions picked at Intake
 * apply to every batch created. Dependencies determine initial status:
 *   - action with no parent dependencies → waiting
 *   - action with any parent dependency  → blocked
 * Once Ops marks a parent done in the Action Center, dependents auto-promote.
 *
 * If the dealer doesn't exist yet, we create one with the dealer name as
 * given and the first split's city as home_city.
 */
import { eq, inArray, and } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  batches, dealers, batchActions, actionDependencies, actionTypes, batchDeliveryLegs,
  vinChaseStages, batchVinStages, batchForecasts,
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
  /**
   * True when ops confirmed at intake that the dealer shared VIN numbers
   * along with the PO PDF. Persists as `batches.vin_received_at_intake`
   * and pre-marks the first two VIN-chase steps (Send Dealer Confirmation
   * Email + VIN) as done at the PO date.
   */
  vinReceivedAtIntake?: boolean;
  notes?: string | null;
  /**
   * Optional — when set, this Intake fulfils the named Forecast.
   * If exactly one batch is produced, the Forecast's pre_po row flips
   * to post_po in place (same record). If multiple batches are
   * produced, the Forecast is marked superseded and each new batch
   * gets `parentForecastBatchId` set.
   */
  forecastBatchId?: number | null;
  /**
   * Optional historical submission date — used when ops backfills an
   * old PO. When set, becomes `batches.requestedAt`, anchors the
   * Plan-vs-Reality timeline, and seeds the action expected-date
   * offsets. When null/undefined, defaults to today (the default).
   * Must be ISO yyyy-mm-dd and not in the future.
   */
  submittedAt?: string | null;
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
  // A child is initially "blocked" only when it has an UNSATISFIED
  // parent on this specific batch — i.e. a parent action_type that is
  // ALSO being picked at this intake. If the parent isn't on the
  // batch, the dep is dormant and the child should start as `waiting`,
  // not blocked-forever-with-no-way-to-unblock. (Earlier bug: a child
  // depending on two parents, with only one picked, stayed blocked
  // even after the picked parent was marked done — the cascade had
  // no row to read for the absent parent.)
  const pickedActionIds = body.actions.map((a) => a.actionTypeId);
  const pickedSet = new Set(pickedActionIds);
  const depsRows = pickedActionIds.length
    ? await db.select().from(actionDependencies)
        .where(inArray(actionDependencies.actionTypeId, pickedActionIds))
    : [];
  const hasParentDep = new Set<number>(); // actionTypeId → has any parent dep on THIS batch
  for (const d of depsRows) {
    if (pickedSet.has(d.dependsOnActionTypeId)) {
      hasParentDep.add(d.actionTypeId);
    }
  }

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

  // ── Load the canonical VIN chase stages once. Every new batch gets
  //    a `batch_vin_stages` row per stage so the drawer's stepper has
  //    state from creation. If the migration hasn't run on this DB
  //    yet (no stages exist), we silently skip — drawer falls back to
  //    an empty VIN-chase section.
  const allVinStages = await (async () => {
    try {
      return await db.select({
        id:   vinChaseStages.id,
        name: vinChaseStages.name,
      }).from(vinChaseStages);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such table/i.test(msg)) return [];
      throw err;
    }
  })();
  // Find the "VIN Receiving" stage so we can pre-mark it when ops
  // checked "VIN received at intake". Substring scan keeps it tolerant
  // of admin renames as long as the new name still mentions VIN.
  const vinReceivingStageId = allVinStages.find(
    (s) => s.name.toLowerCase().includes("vin"),
  )?.id ?? null;

  // Canonical Delivery action_type. Auto-attached to every new Intake
  // batch — it's the closure trigger that the drawer's "Mark as
  // Delivered" button completes. We hide it from the Intake action
  // picker (lib/intake-data.ts already filters it out) because every
  // batch needs one, so user-picking is just a chance to forget.
  const [deliveryActionType] = await db.select({
    id:           actionTypes.id,
    offsetDays:   actionTypes.offsetDays,
    offsetAnchor: actionTypes.offsetAnchor,
    defaultDepartmentId: actionTypes.defaultDepartmentId,
  })
    .from(actionTypes)
    .where(eq(actionTypes.name, "Delivery"))
    .limit(1);

  // ── Optional: Forecast linkage ────────────────────────────────
  // When set, this Intake fulfils a Partnership pre-PO bet. We need
  // the parent's existing Pre-PO App Listing batch_action so we can
  // either leave it in place (1:1) or copy it to each child (split).
  let forecastParent: typeof batches.$inferSelect | null = null;
  let prePoActionOnParent: typeof batchActions.$inferSelect | null = null;
  if (body.forecastBatchId != null) {
    const [parent] = await db.select().from(batches)
      .innerJoin(batchForecasts, eq(batchForecasts.batchId, batches.id))
      .where(eq(batches.id, body.forecastBatchId))
      .limit(1);
    if (!parent) {
      return NextResponse.json({ error: `Forecast batch ${body.forecastBatchId} not found` }, { status: 400 });
    }
    if (parent.batches.lifecycleState !== "pre_po") {
      return NextResponse.json({ error: "Forecast has already been fulfilled" }, { status: 409 });
    }
    if (parent.batches.closedAt) {
      return NextResponse.json({ error: "Forecast has been cancelled" }, { status: 409 });
    }
    if (parent.batches.forecastSupersededAt) {
      return NextResponse.json({ error: "Forecast has already been split" }, { status: 409 });
    }
    forecastParent = parent.batches;
    // Find the Pre-PO App Listing action on the parent (auto-created at
    // Forecast submission). Match by action_type name so admin renames
    // of the canonical row don't break us — substring tolerance.
    const prePoActionType = (await db.select({ id: actionTypes.id }).from(actionTypes)
      .where(eq(actionTypes.name, "Pre-PO App Listing")).limit(1))[0];
    if (prePoActionType) {
      const [row] = await db.select().from(batchActions)
        .where(and(
          eq(batchActions.batchId, forecastParent.id),
          eq(batchActions.actionTypeId, prePoActionType.id),
        ))
        .limit(1);
      prePoActionOnParent = row ?? null;
    }
  }

  // ── Create batches × splits — single transaction ──────────────
  // If any insert below throws (FK violation, disk full, …), the whole
  // submission rolls back so we never leave half-created batches.
  const today = todayIso();
  const leadTimeDays = await getLeadTimeDays();
  const splitTotal = body.items.reduce((sum, it) => sum + it.splits.length, 0);

  // Submission anchor — today for new POs, or a historical date when
  // ops is backfilling. Validated here: must be a real ISO date and
  // not in the future. Everything downstream that anchors on
  // "submission" (action expectedDate offsets, the Plan-vs-Reality
  // timeline) reads this single variable.
  const requestedAt = (() => {
    const raw = body.submittedAt?.trim() || "";
    if (!raw) return today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      // Bad format — silently fall through to today rather than 500.
      return today;
    }
    if (raw > today) {
      // Future-dated submission makes no sense.
      return today;
    }
    return raw;
  })();

  // ── Feasibility flag — Ops behind dealer promise? ──────────────
  // The form locks PO Availability (the dealer date) and auto-floors
  // Ops Expected to today + leadTimeDays. So the only risk signal at
  // submit time is: did Ops's commitment land later than the dealer's
  // promised date? If so, mark the batch at_risk so dashboards flag it.
  // No hard server block — the form has already mediated the floor.
  const feasibilityStatus: "feasible" | "at_risk" = body.items.some((it) =>
    it.splits.some((s) => (s.opsExpectedDate || s.date) > s.date),
  ) ? "at_risk" : "feasible";

  // ── Group items × splits into batches by the agreed key ──────────
  // Decided in design chat (Q1-Q8): one batch per
  //   (po_number, model, year, availability_date,
  //    unit_price, tax_pct, buy_back_rate, contract_length_months).
  // Multiple splits with different cities under the same key become
  // sibling LEGS under one batch (batch_delivery_legs table).
  //
  // Commercial-term mismatches block the merge — same model + date but
  // different unit price = two separate batches.
  type Group = {
    /** Stable representative for batch-level fields. */
    item: typeof body.items[number];
    /** Availability date for this group (shared across all legs). */
    availabilityDate: string;
    /** Legs: per-city qty. May contain ONE city (no merge happened). */
    legs: { city: string; quantity: number; opsExpectedDate: string }[];
  };
  const groupsByKey = new Map<string, Group>();
  for (const item of body.items) {
    for (const split of item.splits) {
      // Key fields per design Q3: model + year + date + all commercial terms.
      // po_number is already implicit (one PO per submit).
      const key = JSON.stringify({
        m:  item.model,
        y:  item.year,
        d:  split.date,
        up: item.unitPriceSar ?? null,
        tx: item.taxPct ?? null,
        bb: item.buyBackRate ?? null,
        cl: item.contractLengthMonths ?? null,
      });
      const existing = groupsByKey.get(key);
      if (existing) {
        existing.legs.push({
          city: split.city,
          quantity: split.quantity,
          opsExpectedDate: split.opsExpectedDate,
        });
      } else {
        groupsByKey.set(key, {
          item,
          availabilityDate: split.date,
          legs: [{
            city: split.city,
            quantity: split.quantity,
            opsExpectedDate: split.opsExpectedDate,
          }],
        });
      }
    }
  }
  const groups = Array.from(groupsByKey.values());
  const groupTotal = groups.length;

  type CreatedBatch = {
    id: number;
    batchCode: string;
    modelYear: string;
    /** Comma-joined city list for the success summary. */
    cities: string[];
    quantity: number;
    legCount: number;
  };

  // 1:1 Forecast fulfilment means we UPDATE the existing pre_po batch
  // instead of inserting a new one. Detect once, up front.
  const isOneToOneFulfilment = forecastParent != null && groups.length === 1;
  const isSplitFulfilment    = forecastParent != null && groups.length > 1;

  // libSQL transactions take an async callback. All inserts/updates
  // inside must be `await`-ed; if any throws, the whole submission rolls
  // back and we never leave half-created batches.
  const created: CreatedBatch[] = await db.transaction(async (tx) => {
    const out: CreatedBatch[] = [];

    // Split case: mark the parent superseded right at the start of
    // the transaction. Children created below get parentForecastBatchId.
    if (isSplitFulfilment && forecastParent) {
      await tx.update(batches).set({
        forecastSupersededAt: today,
      }).where(eq(batches.id, forecastParent.id));
    }

    let groupN = 0;
    for (const group of groups) {
      groupN++;
      const { item, availabilityDate, legs } = group;
      // Sum across legs for the batch-level quantity. Legs are the
      // source of truth for per-city qty.
      const totalQty = legs.reduce((sum, l) => sum + l.quantity, 0);
      // Conservatively take the LATEST opsExpectedDate across legs —
      // the batch can't be "done" until the slowest leg is done.
      const opsExpected = legs
        .map((l) => l.opsExpectedDate)
        .filter(Boolean)
        .sort()
        .at(-1) ?? availabilityDate;
      // City fields on the batch row: single leg → as-is; multi-leg →
      // comma-joined for fast filtering. `batch_delivery_legs` is the
      // source of truth for per-city qty + delivery.
      const cityLabel = legs.map((l) => l.city).join(", ");
      const batchCode = makeBatchCode({
        poNumber:   body.po.number,
        dealerName,
        splitN:     groupN,
        splitTotal: groupTotal,
        city:       legs[0].city,
        model:      item.model,
        qty:        totalQty,
      });
      const targetPoDate = isoMinusDays(availabilityDate, leadTimeDays);

      // Shared field set — used for both the INSERT (new batch / split
      // child) and the UPDATE (1:1 Forecast flip in place).
      const intakeFields = {
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

        requestedQuantity: totalQty,
        requestedAt,
        dealerPromisedDeliveryDate: availabilityDate,
        targetPoDate,
        expectedPoDate: body.po.date,
        actualPoDate:   body.po.date,
        currentProjectedDeliveryDate: opsExpected || availabilityDate,

        appDisplayCities:    cityLabel,
        dealerReceivingCity: cityLabel,
        requiresInterCityTransit: legs.length > 1,
        vinReceivingDate:    null,

        currentStage: "po_issued",
        lifecycleState: "post_po" as const,
        feasibilityStatus,

        vinReceivedAtIntake: body.vinReceivedAtIntake ?? false,

        notes: body.notes ?? undefined,
      };

      // Three paths:
      //   1:1 fulfilment → UPDATE the existing Forecast batch in place
      //                    (same record), wipe its old legs, skip
      //                    Pre-PO App Listing in the actions loop.
      //   Split child    → INSERT new batch with parentForecastBatchId
      //                    set; later copy Pre-PO App Listing from parent.
      //   Standard       → INSERT new batch, no Forecast linkage.
      let batchRow: { id: number };
      if (isOneToOneFulfilment && forecastParent) {
        await tx.update(batches).set(intakeFields)
          .where(eq(batches.id, forecastParent.id));
        batchRow = { id: forecastParent.id };
        // Wipe the Forecast-era legs — Intake legs replace them.
        await tx.delete(batchDeliveryLegs).where(eq(batchDeliveryLegs.batchId, forecastParent.id));
      } else {
        const [inserted] = await tx.insert(batches).values({
          ...intakeFields,
          parentForecastBatchId: isSplitFulfilment && forecastParent ? forecastParent.id : undefined,
        }).returning({ id: batches.id });
        batchRow = inserted;
      }

      // ── Write per-city legs ─────────────────────────────────────
      // Defensive: if the new table is missing (Phase α migration not
      // applied yet to this DB), warn and continue without legs.
      // dealerReceivingCity carries the comma-joined fallback already.
      try {
        await tx.insert(batchDeliveryLegs).values(
          legs.map((l) => ({
            batchId:           batchRow.id,
            city:              l.city,
            requestedQuantity: l.quantity,
            deliveredQuantity: 0,
          })),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/no such table/i.test(msg)) {
          // eslint-disable-next-line no-console
          console.warn(
            "[intake] batch_delivery_legs missing — leg rows skipped. " +
            "Run the Phase α migration in the Turso shell.",
          );
        } else {
          throw err;
        }
      }

      // ── Per-picked-action batch_actions (one set per BATCH, not per leg) ──
      // 1:1 fulfilment: the Pre-PO App Listing action is already on the
      //                 parent row — skip any duplicate pick.
      // Split child:    the parent's Pre-PO App Listing is copied onto
      //                 each child below the standard action loop, so
      //                 likewise skip any duplicate pick here.
      const prePoActionTypeId = prePoActionOnParent?.actionTypeId ?? null;
      for (const a of body.actions) {
        if (prePoActionTypeId != null && a.actionTypeId === prePoActionTypeId) continue;
        const status = hasParentDep.has(a.actionTypeId) ? "blocked" : "waiting";
        const type = typeById.get(a.actionTypeId);
        const expectedDate = type
          ? computeExpectedDate({
              anchor:     type.offsetAnchor,
              offsetDays: type.offsetDays,
              submission: requestedAt,
              vin:        null,
              promised:   availabilityDate,
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

      // ── Auto-attach Delivery action on every new batch.
      //    Hidden from the Intake picker because every batch needs
      //    one — letting ops opt-in is just a chance to forget. The
      //    drawer's Mark-as-Delivered button completes this action,
      //    which in turn auto-closes the batch.
      //
      //    For the 1:1 fulfilment path the existing batch (formerly
      //    pre_po) already has its action set from the Forecast flow,
      //    and the Pre-PO App Listing carries over — but Delivery
      //    wasn't created on the Forecast row, so it needs adding
      //    here regardless of fulfilment mode.
      if (deliveryActionType) {
        const deliveryExpectedDate = computeExpectedDate({
          anchor:     deliveryActionType.offsetAnchor,
          offsetDays: deliveryActionType.offsetDays,
          submission: requestedAt,
          vin:        null,
          promised:   availabilityDate,
        });
        await tx.insert(batchActions).values({
          batchId:      batchRow.id,
          actionTypeId: deliveryActionType.id,
          departmentId: deliveryActionType.defaultDepartmentId ?? undefined,
          status:       "waiting",
          expectedDate: deliveryExpectedDate ?? undefined,
        });
      }

      // ── Split case: copy the Pre-PO App Listing action from the
      //    parent Forecast onto this child. Preserves status (which
      //    might already be "done" if Ops listed the cars before PO
      //    arrived) so accuracy tracking in PR 4 stays correct.
      if (isSplitFulfilment && prePoActionOnParent) {
        await tx.insert(batchActions).values({
          batchId:      batchRow.id,
          actionTypeId: prePoActionOnParent.actionTypeId,
          departmentId: prePoActionOnParent.departmentId ?? undefined,
          assignedStakeholderId: prePoActionOnParent.assignedStakeholderId ?? undefined,
          status:       prePoActionOnParent.status,
          expectedDate: prePoActionOnParent.expectedDate ?? undefined,
          completedAt:  prePoActionOnParent.completedAt ?? undefined,
          notes:        prePoActionOnParent.notes ?? undefined,
        });
      }

      // ── VIN chase stages — one batch_vin_stages row per canonical
      //    stage. Created here so the drawer's stepper has full state
      //    on first render. If body.vinReceivedAtIntake is set, the
      //    "VIN Receiving" stage starts as done (timestamped at PO
      //    date noon UTC) instead of waiting.
      const vinIntakeCompletedAt = `${body.po.date}T12:00:00Z`;
      for (const stage of allVinStages) {
        const isPreMarked = body.vinReceivedAtIntake && stage.id === vinReceivingStageId;
        await tx.insert(batchVinStages).values({
          batchId:     batchRow.id,
          stageId:     stage.id,
          status:      isPreMarked ? "done" : "waiting",
          completedAt: isPreMarked ? vinIntakeCompletedAt : undefined,
          notes:       isPreMarked
            ? "Auto-completed: VIN received with the PO at intake."
            : undefined,
        });
      }

      out.push({
        id: batchRow.id,
        batchCode,
        modelYear: `${item.model} ${item.year}`,
        cities: legs.map((l) => l.city),
        quantity: totalQty,
        legCount: legs.length,
      });
    }
    return out;
  });

  return NextResponse.json({
    ok: true,
    created,
    /** Useful for the success-summary UI to say "N splits grouped into M batches". */
    inputSplits: splitTotal,
    groupedBatches: groupTotal,
  });
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

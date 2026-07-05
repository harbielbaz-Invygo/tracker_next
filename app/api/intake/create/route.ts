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
  batchForecasts,
  // Phase 5b — `actions` (scope-aware) is now the only home for new
  // action data. batch_actions remains imported only for the
  // forecast-split Pre-PO App Listing copy (the forecast flow
  // pre-dates the restructure and hasn't been migrated yet).
  pos, waves, actions as actionsTable,
} from "@/lib/db/schema";
import { makeBatchCode } from "@/lib/utils";
import { getLeadTimeDays } from "@/lib/rules";
import { requireAuth } from "@/lib/api-auth";
import { computeExpectedDate } from "@/lib/expected-date";
import { stampSlaStartForScopes } from "@/lib/sla";
import { snapshotPoBaseline, snapshotPoBaselineModel } from "@/lib/po-baseline";

export const runtime = "nodejs";
// A large multi-item PO can expand to 100+ delivery batches; give the
// creation transaction headroom beyond the default function timeout.
export const maxDuration = 60;

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

  // ── Resolve or reject existing PO (phase 2 new model) ─────────
  // `pos.po_number` is UNIQUE — if a row already exists we either:
  //   (a) Reject when batches still reference one of its waves —
  //       a real duplicate submission attempt.
  //   (b) Auto-clean and proceed when no batches remain under any
  //       wave of this PO — the previous submission's batches were
  //       deleted (e.g. via Settings → Delete), leaving orphaned
  //       pos / waves / actions rows that block re-upload otherwise.
  const existingPo = await db.select({ id: pos.id })
    .from(pos).where(eq(pos.poNumber, body.po.number)).limit(1);
  if (existingPo.length > 0) {
    const existingPoId = existingPo[0].id;
    // Find the waves under this PO and any batches still pointing at them.
    const wavesForPo = await db.select({ id: waves.id })
      .from(waves).where(eq(waves.poId, existingPoId));
    const waveIds = wavesForPo.map((w) => w.id);
    const liveBatches = waveIds.length === 0 ? [] : await db
      .select({ id: batches.id })
      .from(batches).where(inArray(batches.waveId, waveIds));

    if (liveBatches.length > 0) {
      // Real duplicate — refuse.
      return NextResponse.json(
        { error: `PO ${body.po.number} already exists with ${liveBatches.length} batch${liveBatches.length === 1 ? "" : "es"}. Delete those first to re-submit.` },
        { status: 409 },
      );
    }

    // Orphaned PO row (batches were deleted but pos/waves/actions
    // weren't cascaded). Clean up so the fresh submission proceeds.
    await db.transaction(async (tx) => {
      // Delete actions referencing the orphan pos/waves directly.
      // (Actions don't have FK cascade pointing back to pos/waves.)
      if (waveIds.length > 0) {
        await tx.delete(actionsTable).where(and(
          eq(actionsTable.scope, "wave"),
          inArray(actionsTable.scopeId, waveIds),
        ));
      }
      await tx.delete(actionsTable).where(and(
        eq(actionsTable.scope, "po"),
        eq(actionsTable.scopeId, existingPoId),
      ));
      // waves.po_id is FK with cascade → deleting pos cascades waves.
      await tx.delete(pos).where(eq(pos.id, existingPoId));
    });
    // eslint-disable-next-line no-console
    console.info(
      `[intake] PO ${body.po.number} had an orphaned pos row ` +
      `(no batches under any wave) — cleaned up before re-submission.`,
    );
  }

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
  // `scope` is pulled in for the new attach-by-scope routing.
  const typeRows = pickedActionIds.length
    ? await db.select({
        id: actionTypes.id,
        offsetDays: actionTypes.offsetDays,
        offsetAnchor: actionTypes.offsetAnchor,
        scope: actionTypes.scope,
        defaultDepartmentId: actionTypes.defaultDepartmentId,
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

  // Phase 5b — legacy batch_actions / batch_vin_stages writes removed.
  // Wave-scope VIN actions and batch-scope Delivery are auto-attached
  // further down via the scope-aware `actions` table. The canonical
  // Delivery action_type lookup also lives in that block now (was
  // duplicated here pre-cutover).

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
  // Captured out of the tx so the post-commit SLA stamp (below) can reach
  // the new PO / wave ids without re-querying.
  let slaPoId = 0;
  const slaWaveIds: number[] = [];
  const created: CreatedBatch[] = await db.transaction(async (tx) => {
    const out: CreatedBatch[] = [];

    // ── Phase 2: create the canonical PO row ─────────────────────
    // First batch's commercial-term fields seed the PO record.
    // (All groups under one PO share these per the model.)
    const firstItem = body.items[0];
    const [poRow] = await tx.insert(pos).values({
      poNumber:             body.po.number,
      dealerId,
      poDate:               body.po.date,
      poReference:          body.po.reference ?? undefined,
      buyBackRate:          firstItem?.buyBackRate ?? undefined,
      contractLengthMonths: firstItem?.contractLengthMonths ?? undefined,
      unitPriceSar:         firstItem?.unitPriceSar ?? undefined,
      taxPct:               firstItem?.taxPct ?? undefined,
      notes:                body.notes ?? undefined,
    }).returning({ id: pos.id });
    const poId = poRow.id;

    // ── Phase 2: create one wave per distinct availability date ──
    // VIN-chase actions attach to waves; batches join via wave_id.
    const distinctDates = new Set<string>();
    for (const g of groups) distinctDates.add(g.availabilityDate);
    const waveIdByDate = new Map<string, number>();
    for (const availabilityDate of distinctDates) {
      // Ops-expected for the wave = latest ops-expected across all
      // legs landing on this date (slowest leg paces the wave).
      const opsExpected = groups
        .filter((g) => g.availabilityDate === availabilityDate)
        .flatMap((g) => g.legs.map((l) => l.opsExpectedDate))
        .filter(Boolean)
        .sort()
        .at(-1) ?? availabilityDate;
      const [waveRow] = await tx.insert(waves).values({
        poId,
        availabilityDate,
        opsExpectedDate: opsExpected,
        vinReceivedAtIntake: body.vinReceivedAtIntake ?? false,
      }).returning({ id: waves.id });
      waveIdByDate.set(availabilityDate, waveRow.id);
    }

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
        // Lock the original PO Expected Date — the partnership-
        // dealer agreement. Stays frozen forever; future shifts
        // only move dealerPromisedDeliveryDate. PO Reliability is
        // measured against this snapshot.
        poExpectedDateAtLock:       availabilityDate,
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
      // Phase 2: every batch belongs to a wave keyed by its
      // availability date. Map lookup is exact since we created the
      // wave above using the same dates from the groups list.
      const waveIdForBatch = waveIdByDate.get(availabilityDate) ?? null;

      let batchRow: { id: number };
      if (isOneToOneFulfilment && forecastParent) {
        await tx.update(batches).set({
          ...intakeFields,
          waveId: waveIdForBatch ?? undefined,
        }).where(eq(batches.id, forecastParent.id));
        batchRow = { id: forecastParent.id };
        // Wipe the Forecast-era legs — Intake legs replace them.
        await tx.delete(batchDeliveryLegs).where(eq(batchDeliveryLegs.batchId, forecastParent.id));
      } else {
        const [inserted] = await tx.insert(batches).values({
          ...intakeFields,
          waveId: waveIdForBatch ?? undefined,
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

      // Phase 5b — legacy per-action / VIN-stage writes removed. The
      // scope-aware `actions` table block below handles user-picked
      // batch + wave + PO scopes, plus auto-Delivery on every batch.
      //
      // Forecast split-fulfilment still copies Pre-PO App Listing
      // from the parent forecast — that row lives in batch_actions
      // because forecast/create predates the restructure. The copy
      // below remains until the forecast flow is migrated separately.
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

      out.push({
        id: batchRow.id,
        batchCode,
        modelYear: `${item.model} ${item.year}`,
        cities: legs.map((l) => l.city),
        quantity: totalQty,
        legCount: legs.length,
      });
    }

    // ──────────────────────────────────────────────────────────
    // Phase 2 — write the scope-aware action rows on the new
    // `actions` table. Runs in addition to the legacy batch_actions
    // inserts above so phase 3 can read the new shape without
    // breaking the existing UI which still reads batch_actions.
    //
    // Routing: each picked action_type lands at its declared scope.
    //   po    → ONE row per picked action, attached to the PO
    //   wave  → ONE row per (wave, picked action), attached to wave
    //   batch → ONE row per (batch, picked action), attached to batch
    // Delivery (always batch) is also auto-attached.
    // ──────────────────────────────────────────────────────────
    // Accumulate every scope-aware action row and bulk-insert them at the
    // end (see the flush below). A large multi-item PO produces hundreds
    // of these; one round-trip per row would blow the function timeout.
    const actionRows: (typeof actionsTable.$inferInsert)[] = [];

    type AttachPlan = { scope: "po" | "wave" | "batch"; scopeId: number; anchorSubmission: string; anchorPromised: string };
    const insertAction = (a: typeof body.actions[number], plan: AttachPlan) => {
      const type = typeById.get(a.actionTypeId);
      if (!type) return;
      const expected = computeExpectedDate({
        anchor:     type.offsetAnchor,
        offsetDays: type.offsetDays,
        submission: plan.anchorSubmission,
        vin:        null,
        promised:   plan.anchorPromised,
      });
      const status: "waiting" | "blocked" = hasParentDep.has(a.actionTypeId) ? "blocked" : "waiting";
      actionRows.push({
        scope:                 plan.scope,
        scopeId:               plan.scopeId,
        actionTypeId:          a.actionTypeId,
        departmentId:          a.departmentId ?? type.defaultDepartmentId ?? undefined,
        assignedStakeholderId: a.assignedStakeholderId ?? undefined,
        status,
        expectedDate:          expected ?? undefined,
      });
    };

    // PO-scope actions — one row each, regardless of how many batches.
    const poAnchorPromised = groups[0]?.availabilityDate ?? today;
    for (const a of body.actions) {
      const type = typeById.get(a.actionTypeId);
      if (!type || type.scope !== "po") continue;
      insertAction(a, {
        scope: "po", scopeId: poId,
        anchorSubmission: requestedAt, anchorPromised: poAnchorPromised,
      });
    }

    // Wave-scope actions — auto-attach ALL wave-scope action_types
    // to every wave (not just user-picked). VIN chase is mandatory
    // per the new model; the form filters wave-scope rows out of the
    // picker entirely so ops can't accidentally skip one.
    const allWaveActionTypes = await tx
      .select({
        id:                  actionTypes.id,
        offsetDays:          actionTypes.offsetDays,
        offsetAnchor:        actionTypes.offsetAnchor,
        defaultDepartmentId: actionTypes.defaultDepartmentId,
      })
      .from(actionTypes)
      .where(eq(actionTypes.scope, "wave"));
    for (const [waveDate, waveId] of waveIdByDate) {
      for (const at of allWaveActionTypes) {
        const expected = computeExpectedDate({
          anchor:     at.offsetAnchor,
          offsetDays: at.offsetDays,
          submission: requestedAt,
          vin:        null,
          promised:   waveDate,
        });
        actionRows.push({
          scope:        "wave",
          scopeId:      waveId,
          actionTypeId: at.id,
          departmentId: at.defaultDepartmentId ?? undefined,
          status:       "waiting",
          expectedDate: expected ?? undefined,
        });
      }
    }

    // Batch-scope actions — one row per batch per picked batch-action.
    // Delivery is included here as an auto-attachment regardless of
    // whether ops picked it (mirroring the existing legacy behaviour).
    const deliveryRow = await tx.select({
      id: actionTypes.id,
      offsetDays: actionTypes.offsetDays,
      offsetAnchor: actionTypes.offsetAnchor,
      defaultDepartmentId: actionTypes.defaultDepartmentId,
    })
      .from(actionTypes)
      .where(eq(actionTypes.name, "Delivery"))
      .limit(1);
    for (const b of out) {
      const groupForBatch = groups.find((g) => `${g.item.model} ${g.item.year}` === b.modelYear)
                          ?? groups[0];
      const batchPromised = groupForBatch?.availabilityDate ?? today;
      // User-picked batch-scope actions.
      for (const a of body.actions) {
        const type = typeById.get(a.actionTypeId);
        if (!type || type.scope !== "batch") continue;
        insertAction(a, {
          scope: "batch", scopeId: b.id,
          anchorSubmission: requestedAt, anchorPromised: batchPromised,
        });
      }
      // Auto-Delivery (always batch, always present, idempotent).
      if (deliveryRow.length > 0) {
        const d = deliveryRow[0];
        const expected = computeExpectedDate({
          anchor:     d.offsetAnchor,
          offsetDays: d.offsetDays,
          submission: requestedAt,
          vin:        null,
          promised:   batchPromised,
        });
        actionRows.push({
          scope:        "batch",
          scopeId:      b.id,
          actionTypeId: d.id,
          departmentId: d.defaultDepartmentId ?? undefined,
          status:       "waiting",
          expectedDate: expected ?? undefined,
        });
      }

      // Per-batch external-phase copies. Each wave-scope action_type
      // also gets a batch-scope row on every batch so ops can track
      // dealer-side execution per car-group instead of only at the
      // window level. The window-scope row stays as the "bulk" handle;
      // ticking it cascades to all batch copies (see lib/scope-cascade).
      for (const at of allWaveActionTypes) {
        const expected = computeExpectedDate({
          anchor:     at.offsetAnchor,
          offsetDays: at.offsetDays,
          submission: requestedAt,
          vin:        null,
          promised:   batchPromised,
        });
        actionRows.push({
          scope:        "batch",
          scopeId:      b.id,
          actionTypeId: at.id,
          departmentId: at.defaultDepartmentId ?? undefined,
          status:       "waiting",
          expectedDate: expected ?? undefined,
        });
      }
    }

    // ── Bulk-insert every accumulated action row ────────────────────
    // One round-trip per ~100 rows instead of one per action (a large
    // multi-item PO can produce 800+). On the rare UNIQUE conflict
    // (idempotent re-attach on (scope, scope_id, action_type_id)) fall
    // back to per-row so a single dup can't fail the whole chunk.
    for (let i = 0; i < actionRows.length; i += 100) {
      const chunk = actionRows.slice(i, i + 100);
      try {
        await tx.insert(actionsTable).values(chunk);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/UNIQUE constraint failed|already exists/i.test(msg)) throw err;
        for (const r of chunk) {
          try {
            await tx.insert(actionsTable).values(r);
          } catch (e2) {
            const m2 = e2 instanceof Error ? e2.message : String(e2);
            if (!/UNIQUE constraint failed|already exists/i.test(m2)) throw e2;
          }
        }
      }
    }

    slaPoId = poId;
    slaWaveIds.push(...waveIdByDate.values());
    return out;
  });

  // ── SLA clock (Phase 1b) ──────────────────────────────────────────
  // Start the countdown for the freshly-created `waiting` actions on the
  // two authoritative layers:
  //   • PO-scope    — Internal-Phase root actions.
  //   • batch-scope — External-Phase per-batch action rows (the source of
  //     truth the drawer + Inbox read; see WaveSection / MineView).
  // The wave-scope "bulk" external set is deliberately NOT stamped — it's a
  // roll-up handle that drifts out of sync with the per-batch work, so it's
  // excluded from SLA everywhere (Inbox uses batch-scope; getSlaMetrics
  // filters wave-scope out). Anchored to creation time (= the intake-submit
  // moment) so a new PO never starts already-overdue. Dependent (`blocked`)
  // actions are skipped here; the unblock cascade stamps them on unblock.
  // Best-effort + tolerant of the un-migrated column (see lib/sla.ts).
  const slaNow = new Date().toISOString();
  await stampSlaStartForScopes(
    [
      { scope: "po" as const, scopeId: slaPoId },
      ...created.map((b) => ({ scope: "batch" as const, scopeId: b.id })),
    ],
    slaNow,
  );

  // Freeze the delivery plan as the reliability baseline (Idea 1) — the
  // immutable promise that car redistribution is later scored against.
  // Both the per-window total and the per-(window × model) breakdown.
  // Best-effort + tolerant of the un-migrated tables (see lib/po-baseline).
  await snapshotPoBaseline(slaPoId);
  await snapshotPoBaselineModel(slaPoId);

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

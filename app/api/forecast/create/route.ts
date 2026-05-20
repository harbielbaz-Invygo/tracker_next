/**
 * POST /api/forecast/create — submit a new Partnership Forecast.
 *
 * Body shape (v2):
 *   {
 *     dealerId?:           number,        // existing dealer
 *     dealerName?:         string,        // OR new dealer name (auto-created)
 *     items: {                            // ≥ 1 city+qty rows
 *       city: string,
 *       quantity: number,
 *     }[],
 *     expectedDeliveryDate: string,       // ISO yyyy-mm-dd
 *     expectedPoSigningDate?: string,     // ISO yyyy-mm-dd, optional
 *     submittedByUserId: number,
 *   }
 *
 * Persisted state:
 *   1. `batches` row with lifecycleState='pre_po', currentStage='pre_po_bet',
 *      total qty = sum across items, expectedPoDate set if supplied.
 *   2. One `batch_delivery_legs` row per item (city + qty).
 *   3. `batch_forecasts` row carrying submittedAt + submittedByUserId.
 *   4. `batch_actions` row for "Pre-PO App Listing" (status='waiting').
 *      Lazy-creates the action_type if missing.
 *
 * Back-compat: legacy callers passing { dealerId, quantity, city,
 * expectedDate, submittedByUserId } still work — the validator
 * normalises to the v2 shape on entry.
 */
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  batches, batchForecasts, batchDeliveryLegs, batchActions,
  actionTypes, departments, dealers,
} from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";
import { makeForecastBatchCode } from "@/lib/utils";

export const runtime = "nodejs";

const PRE_PO_APP_LISTING = "Pre-PO App Listing";

interface CreateBody {
  dealerId?: number;
  dealerName?: string;
  items: { city: string; quantity: number }[];
  expectedDeliveryDate: string;
  expectedPoSigningDate: string | null;
  submittedByUserId: number;
}

function validate(body: unknown): { ok: true; data: CreateBody } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, reason: "Missing body" };
  const b = body as Record<string, unknown>;

  // Submitter — required in both v1 + v2.
  if (typeof b.submittedByUserId !== "number" || b.submittedByUserId <= 0)
    return { ok: false, reason: "submittedByUserId is required" };

  // Dealer — accept either id OR name (new dealer).
  const hasDealerId   = typeof b.dealerId === "number"   && (b.dealerId   as number) > 0;
  const hasDealerName = typeof b.dealerName === "string" && (b.dealerName as string).trim() !== "";
  if (!hasDealerId && !hasDealerName)
    return { ok: false, reason: "dealerId or dealerName is required" };

  // Items — v2 array, OR legacy single { city, quantity } at top level.
  let items: { city: string; quantity: number }[] = [];
  if (Array.isArray(b.items)) {
    for (const [i, raw] of b.items.entries()) {
      if (!raw || typeof raw !== "object") return { ok: false, reason: `items[${i}] must be an object` };
      const it = raw as Record<string, unknown>;
      if (typeof it.city !== "string" || !it.city.trim()) return { ok: false, reason: `items[${i}].city is required` };
      if (typeof it.quantity !== "number" || it.quantity <= 0 || !Number.isInteger(it.quantity))
        return { ok: false, reason: `items[${i}].quantity must be a positive integer` };
      items.push({ city: it.city.trim(), quantity: it.quantity });
    }
  } else if (typeof b.city === "string" && typeof b.quantity === "number") {
    if (!b.city.trim()) return { ok: false, reason: "city is required" };
    if (b.quantity <= 0 || !Number.isInteger(b.quantity))
      return { ok: false, reason: "quantity must be a positive integer" };
    items = [{ city: b.city.trim(), quantity: b.quantity }];
  } else {
    return { ok: false, reason: "items[] (or legacy city+quantity) is required" };
  }
  if (items.length === 0) return { ok: false, reason: "items[] must contain at least one row" };

  // Dates — expectedDate (v1) becomes expectedDeliveryDate (v2).
  const expectedDeliveryRaw = typeof b.expectedDeliveryDate === "string"
    ? b.expectedDeliveryDate
    : (typeof b.expectedDate === "string" ? b.expectedDate : "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDeliveryRaw))
    return { ok: false, reason: "expectedDeliveryDate must be yyyy-mm-dd" };
  const expectedPoRaw = typeof b.expectedPoSigningDate === "string"
    ? b.expectedPoSigningDate
    : null;
  if (expectedPoRaw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expectedPoRaw))
    return { ok: false, reason: "expectedPoSigningDate must be yyyy-mm-dd or null" };

  return {
    ok: true,
    data: {
      dealerId:              hasDealerId ? (b.dealerId as number) : undefined,
      dealerName:            hasDealerName ? (b.dealerName as string).trim() : undefined,
      items,
      expectedDeliveryDate:  expectedDeliveryRaw,
      expectedPoSigningDate: expectedPoRaw,
      submittedByUserId:     b.submittedByUserId as number,
    },
  };
}

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["admin", "ops"]);
  if (!gate.ok) return gate.response;

  const parsed = validate(await req.json().catch(() => null));
  if (!parsed.ok) return apiError(parsed.reason, 400);
  const { dealerId, dealerName, items, expectedDeliveryDate, expectedPoSigningDate, submittedByUserId } = parsed.data;

  // Resolve dealer — existing id wins, otherwise create-or-find by name.
  let resolvedDealerId: number;
  let resolvedDealerName: string;
  if (dealerId) {
    const [row] = await db.select({ id: dealers.id, name: dealers.name })
      .from(dealers).where(eq(dealers.id, dealerId)).limit(1);
    if (!row) return apiError("Unknown dealerId", 400);
    resolvedDealerId = row.id;
    resolvedDealerName = row.name;
  } else {
    // Idempotent dealer creation: if a dealer with the same name
    // already exists, reuse it. Otherwise create with safe defaults
    // (homeCity inferred from the first item, dealerType='old').
    const name = dealerName!.trim();
    const existing = await db.select({ id: dealers.id, name: dealers.name })
      .from(dealers).where(eq(dealers.name, name)).limit(1);
    if (existing.length > 0) {
      resolvedDealerId = existing[0].id;
      resolvedDealerName = existing[0].name;
    } else {
      const [created] = await db.insert(dealers).values({
        name,
        dealerType: "new",
        homeCity:   items[0].city,
      }).returning({ id: dealers.id, name: dealers.name });
      resolvedDealerId = created.id;
      resolvedDealerName = created.name;
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const totalQty = items.reduce((acc, it) => acc + it.quantity, 0);
  // Pick the first city for the legacy batch_code slug + the legacy
  // single-city display field. The legs table is the source of truth.
  const firstCity = items[0].city;
  const batchCode = makeForecastBatchCode({ dealerName: resolvedDealerName, city: firstCity, qty: totalQty });

  // Lazy-create the Pre-PO App Listing action_type if missing.
  let preActionType = (await db.select().from(actionTypes)
    .where(eq(actionTypes.name, PRE_PO_APP_LISTING)).limit(1))[0];
  if (!preActionType) {
    const ops = await db.select().from(departments)
      .where(eq(departments.name, "Operations")).limit(1);
    const [created] = await db.insert(actionTypes).values({
      name:                PRE_PO_APP_LISTING,
      waitingLabel:        "Pre-PO list pending",
      doneLabel:           "Pre-PO listed",
      defaultDepartmentId: ops[0]?.id ?? null,
      sortOrder:           0,
      offsetDays:          0,
      offsetAnchor:        "submission",
    }).returning();
    preActionType = created;
  }

  const [batch] = await db.insert(batches).values({
    batchCode,
    dealerId:                   resolvedDealerId,
    requestedQuantity:          totalQty,
    requestedAt:                today,
    dealerPromisedDeliveryDate: expectedDeliveryDate,
    // expectedPoDate stores the partnership's predicted PO signing
    // date so Insights can track signing-drift later.
    expectedPoDate:             expectedPoSigningDate ?? undefined,
    lifecycleState:             "pre_po",
    dealerReceivingCity:        firstCity,
    currentStage:               "pre_po_bet",
  }).returning();

  // Per-city legs. Each item becomes one row so multi-city forecasts
  // are tracked the same way post-PO multi-leg batches are.
  for (const it of items) {
    await db.insert(batchDeliveryLegs).values({
      batchId:           batch.id,
      city:              it.city,
      requestedQuantity: it.quantity,
    });
  }

  await db.insert(batchForecasts).values({
    batchId:           batch.id,
    submittedAt:       today,
    submittedByUserId,
  });

  await db.insert(batchActions).values({
    batchId:      batch.id,
    actionTypeId: preActionType.id,
    status:       "waiting",
    departmentId: preActionType.defaultDepartmentId,
    expectedDate: today,
  });

  return NextResponse.json({
    batchId:   batch.id,
    batchCode,
    dealerId:  resolvedDealerId,
    dealerCreated: !dealerId, // true when a new dealer row was inserted
    totalQty,
  });
}

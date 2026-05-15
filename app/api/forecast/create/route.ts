/**
 * POST /api/forecast/create — submit a new Partnership Forecast.
 *
 * Body shape:
 *   {
 *     dealerId: number,
 *     quantity: number,
 *     city: string,
 *     expectedDate: string (ISO yyyy-mm-dd),
 *     submittedByUserId: number,
 *   }
 *
 * Persisted state:
 *   1. `batches` row with lifecycleState='pre_po', currentStage='pre_po_bet'.
 *      Most fields are null/default — Forecast carries only the minimums
 *      until the real PO arrives via Intake and fills in the rest.
 *   2. `batch_delivery_legs` row (single leg with the submitted city + qty).
 *      We treat every Forecast as multi-leg-capable from day one so
 *      Intake doesn't need a special-case path later.
 *   3. `batch_forecasts` row carrying submittedAt + submittedByUserId.
 *   4. `batch_actions` row for "Pre-PO App Listing" (status='waiting').
 *      We lazy-create the action_type if it's missing — no admin
 *      endpoint required.
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
  dealerId: number;
  quantity: number;
  city: string;
  expectedDate: string;
  submittedByUserId: number;
}

function validate(body: unknown): { ok: true; data: CreateBody } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, reason: "Missing body" };
  const b = body as Record<string, unknown>;
  if (typeof b.dealerId !== "number" || b.dealerId <= 0)
    return { ok: false, reason: "dealerId must be a positive integer" };
  if (typeof b.quantity !== "number" || b.quantity <= 0 || !Number.isInteger(b.quantity))
    return { ok: false, reason: "quantity must be a positive integer" };
  if (typeof b.city !== "string" || !b.city.trim())
    return { ok: false, reason: "city is required" };
  if (typeof b.expectedDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.expectedDate))
    return { ok: false, reason: "expectedDate must be yyyy-mm-dd" };
  if (typeof b.submittedByUserId !== "number" || b.submittedByUserId <= 0)
    return { ok: false, reason: "submittedByUserId is required" };
  return {
    ok: true,
    data: {
      dealerId: b.dealerId,
      quantity: b.quantity,
      city: b.city.trim(),
      expectedDate: b.expectedDate,
      submittedByUserId: b.submittedByUserId,
    },
  };
}

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["admin", "ops"]);
  if (!gate.ok) return gate.response;

  const parsed = validate(await req.json().catch(() => null));
  if (!parsed.ok) return apiError(parsed.reason, 400);
  const { dealerId, quantity, city, expectedDate, submittedByUserId } = parsed.data;

  // Resolve dealer name for the batch code slug.
  const dealerRows = await db.select({ name: dealers.name })
    .from(dealers).where(eq(dealers.id, dealerId)).limit(1);
  if (dealerRows.length === 0) return apiError("Unknown dealer", 400);
  const dealerName = dealerRows[0].name;

  const today = new Date().toISOString().slice(0, 10);
  const batchCode = makeForecastBatchCode({ dealerName, city, qty: quantity });

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

  // ── Create the records. SQLite (libSQL) doesn't support multi-
  // statement transactions through the libsql client today, but each
  // INSERT is atomic and we capture the new batch id from RETURNING.
  const [batch] = await db.insert(batches).values({
    batchCode,
    dealerId,
    requestedQuantity:          quantity,
    requestedAt:                today,
    dealerPromisedDeliveryDate: expectedDate,
    lifecycleState:             "pre_po",
    dealerReceivingCity:        city,
    currentStage:               "pre_po_bet",
  }).returning();

  await db.insert(batchDeliveryLegs).values({
    batchId:           batch.id,
    city,
    requestedQuantity: quantity,
  });

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

  return NextResponse.json({ batchId: batch.id, batchCode });
}

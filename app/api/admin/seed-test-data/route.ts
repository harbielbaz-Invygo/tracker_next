/**
 * POST /api/admin/seed-test-data — one-off test-data seeder for the
 * "test" dealer. Admin-only. Idempotent: wipes prior `test`-dealer rows
 * before inserting, so re-running shifts dates as needed.
 *
 * Loads 12 batches covering every scenario added in Items 1-4:
 *   • Pre-VIN / Post-VIN phase chip + days-to-availability colour escalation
 *   • Alert engine — no_vin_before_avail (high & critical) + action_overdue
 *   • Customer impact — mild / moderate / severe + delivered vs projected
 *   • Dealer reliability — date / qty / colour / cancellation
 *
 * To run: POST while logged in as admin.
 *   curl -X POST https://<your-app>/api/admin/seed-test-data \
 *        -H 'cookie: <your-session-cookie>'
 *   …or just open the URL in a browser with `?confirm=yes` after logging in.
 */
import { eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  dealers, batches, batchActions, batchColorMatrix, actionTypes,
  alerts, alertRules, vehicles, milestones, milestoneEvents,
} from "@/lib/db/schema";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";

/** All TEST-* batch codes seeded by this endpoint. */
const TEST_BATCH_CODES = [
  "TEST-001", "TEST-002", "TEST-003", "TEST-004", "TEST-005", "TEST-006",
  "TEST-007", "TEST-008", "TEST-009", "TEST-010", "TEST-011", "TEST-012",
];

/** Alert rules seeded so the engine fires on the test scenarios. */
const SEED_RULES = [
  { name: "VIN approaching", triggerType: "no_vin_before_avail" as const, thresholdDays: 7, severity: "high" as const },
  { name: "VIN critical",    triggerType: "no_vin_before_avail" as const, thresholdDays: 3, severity: "critical" as const },
  { name: "Action overdue",  triggerType: "action_overdue"      as const, thresholdDays: 0, severity: "medium" as const },
];

export async function GET(req: NextRequest)  { return runHandler(req); }
export async function POST(req: NextRequest) { return runHandler(req); }

async function runHandler(req: NextRequest) {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;

  // For GET requests, require ?confirm=yes so this isn't fired by a
  // crawler or stray link click.
  if (req.method === "GET" && req.nextUrl.searchParams.get("confirm") !== "yes") {
    return NextResponse.json({
      ok: false,
      hint: "This endpoint mutates the DB. To run, POST or GET with ?confirm=yes.",
    }, { status: 400 });
  }

  try {
    const result = await seedTestData();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

async function seedTestData() {
  // ── 1. Ensure dealer exists ──────────────────────────────────
  const existingDealer = await db
    .select({ id: dealers.id })
    .from(dealers)
    .where(eq(dealers.name, "test"))
    .limit(1);

  let dealerId: number;
  if (existingDealer.length > 0) {
    dealerId = existingDealer[0].id;
  } else {
    const [inserted] = await db
      .insert(dealers)
      .values({
        name: "test",
        dealerType: "new",
        homeCity: "Riyadh",
        policyStatus: "existing",
        avgResponseDays: 2.5,
      })
      .returning({ id: dealers.id });
    dealerId = inserted.id;
  }

  // ── 2. Cleanup: find old test-batch IDs, then delete dependent rows ──
  const oldBatchRows = await db
    .select({ id: batches.id })
    .from(batches)
    .where(eq(batches.dealerId, dealerId));
  const oldBatchIds = oldBatchRows.map((b) => b.id);

  if (oldBatchIds.length > 0) {
    await db.delete(alerts).where(inArray(alerts.batchId, oldBatchIds));
    await db.delete(batchActions).where(inArray(batchActions.batchId, oldBatchIds));
    await db.delete(batchColorMatrix).where(inArray(batchColorMatrix.batchId, oldBatchIds));
    await db.delete(milestoneEvents).where(inArray(milestoneEvents.batchId, oldBatchIds));
    await db.delete(milestones).where(inArray(milestones.batchId, oldBatchIds));
    await db.delete(vehicles).where(inArray(vehicles.batchId, oldBatchIds));
    await db.delete(batches).where(inArray(batches.id, oldBatchIds));
  }

  // ── 3. Default alert rules — skip if same name already present ──
  const existingRuleNames = new Set(
    (await db.select({ name: alertRules.name }).from(alertRules))
      .map((r) => r.name),
  );
  let rulesInserted = 0;
  for (const r of SEED_RULES) {
    if (existingRuleNames.has(r.name)) continue;
    await db.insert(alertRules).values({
      name: r.name,
      triggerType: r.triggerType,
      thresholdDays: r.thresholdDays,
      actionTypeId: null,
      severity: r.severity,
      isActive: true,
    });
    rulesInserted++;
  }

  // ── 4. Insert the 12 test batches ──────────────────────────────
  const common = {
    dealerId,
    lifecycleState: "post_po" as const,
    year: 2026,
  };

  await db.insert(batches).values([
    {
      ...common,
      batchCode: "TEST-001", model: "Sonata", requestedQuantity: 2,
      requestedAt: "2026-04-01", dealerPromisedDeliveryDate: "2026-07-12",
      currentStage: "po_issued", feasibilityStatus: "feasible",
      partnershipConfidence: 80, operationsConfidence: 75,
      colorSummary: "Black, White", appDisplayCities: "Riyadh", dealerReceivingCity: "Riyadh",
      poNumber: "TEST-PO-001", actualPoDate: "2026-04-05",
      notes: "Healthy pre-VIN 60d runway",
    },
    {
      ...common,
      batchCode: "TEST-002", model: "Tucson", requestedQuantity: 3,
      requestedAt: "2026-04-15", dealerPromisedDeliveryDate: "2026-05-17",
      currentStage: "po_issued", feasibilityStatus: "feasible",
      partnershipConfidence: 70, operationsConfidence: 50,
      colorSummary: "Silver, Gray", appDisplayCities: "Riyadh, Jeddah", dealerReceivingCity: "Riyadh",
      poNumber: "TEST-PO-002", actualPoDate: "2026-04-18",
      notes: "Pre-VIN 5d to avail — high alert",
    },
    {
      ...common,
      batchCode: "TEST-003", model: "Elantra", requestedQuantity: 1,
      requestedAt: "2026-04-20", dealerPromisedDeliveryDate: "2026-05-14",
      currentStage: "po_issued", feasibilityStatus: "at_risk",
      partnershipConfidence: 50, operationsConfidence: 30,
      colorSummary: "Red", appDisplayCities: "Dammam", dealerReceivingCity: "Dammam",
      poNumber: "TEST-PO-003", actualPoDate: "2026-04-22",
      notes: "Pre-VIN 2d to avail — critical alert",
    },
    {
      ...common,
      batchCode: "TEST-004", model: "Kona", requestedQuantity: 2,
      requestedAt: "2026-03-15", dealerPromisedDeliveryDate: "2026-06-11",
      currentStage: "vin_assigned", feasibilityStatus: "feasible",
      partnershipConfidence: 85, operationsConfidence: 80,
      colorSummary: "Blue", appDisplayCities: "Riyadh", dealerReceivingCity: "Riyadh",
      poNumber: "TEST-PO-004", actualPoDate: "2026-03-20", vinReceivingDate: "2026-05-01",
      notes: "Post-VIN — VIN received",
    },
    {
      ...common,
      batchCode: "TEST-005", model: "Sonata", requestedQuantity: 3,
      requestedAt: "2026-03-01", dealerPromisedDeliveryDate: "2026-04-12",
      currentStage: "delivered", feasibilityStatus: "feasible",
      partnershipConfidence: 90, operationsConfidence: 85,
      colorSummary: "Black", appDisplayCities: "Riyadh", dealerReceivingCity: "Riyadh",
      poNumber: "TEST-PO-005", actualPoDate: "2026-03-05", vinReceivingDate: "2026-03-25",
      closedAt: "2026-04-17", closureReason: "delivered", deliveredQuantity: 3,
      notes: "Delivered 5d late — mild",
    },
    {
      ...common,
      batchCode: "TEST-006", model: "Tucson", requestedQuantity: 5,
      requestedAt: "2026-02-15", dealerPromisedDeliveryDate: "2026-04-12",
      currentStage: "delivered", feasibilityStatus: "feasible",
      partnershipConfidence: 75, operationsConfidence: 65,
      colorSummary: "White, Black", appDisplayCities: "Jeddah", dealerReceivingCity: "Jeddah",
      poNumber: "TEST-PO-006", actualPoDate: "2026-02-20", vinReceivingDate: "2026-03-10",
      closedAt: "2026-04-27", closureReason: "delivered", deliveredQuantity: 5,
      notes: "Delivered 15d late — moderate",
    },
    {
      ...common,
      batchCode: "TEST-007", model: "Sonata", requestedQuantity: 10,
      requestedAt: "2026-01-20", dealerPromisedDeliveryDate: "2026-04-01",
      currentStage: "delivered", feasibilityStatus: "feasible",
      partnershipConfidence: 55, operationsConfidence: 45,
      colorSummary: "Various", appDisplayCities: "Riyadh, Jeddah", dealerReceivingCity: "Riyadh",
      poNumber: "TEST-PO-007", actualPoDate: "2026-01-25", vinReceivingDate: "2026-02-15",
      closedAt: "2026-05-01", closureReason: "delivered", deliveredQuantity: 10,
      deliveryDateRevisionCount: 2,
      notes: "Delivered 30d late — severe, 2 re-promises",
    },
    {
      ...common,
      batchCode: "TEST-008", model: "Kona", requestedQuantity: 4,
      requestedAt: "2026-03-20", dealerPromisedDeliveryDate: "2026-05-20",
      currentProjectedDeliveryDate: "2026-06-05",
      currentStage: "vin_assigned", feasibilityStatus: "at_risk",
      partnershipConfidence: 60, operationsConfidence: 40,
      colorSummary: "Black", appDisplayCities: "Riyadh", dealerReceivingCity: "Riyadh",
      poNumber: "TEST-PO-008", actualPoDate: "2026-03-25", vinReceivingDate: "2026-04-30",
      deliveryDateRevisionCount: 1,
      notes: "Open, projected 16d late — moderate",
    },
    {
      ...common,
      batchCode: "TEST-009", model: "Elantra", requestedQuantity: 5,
      requestedAt: "2026-03-15", dealerPromisedDeliveryDate: "2026-05-15",
      currentStage: "request_submitted", feasibilityStatus: "infeasible",
      partnershipConfidence: 20, operationsConfidence: 15,
      colorSummary: "Black", appDisplayCities: "Riyadh", dealerReceivingCity: "Riyadh",
      poNumber: "TEST-PO-009", actualPoDate: "2026-03-20",
      closedAt: "2026-04-10", closureReason: "cancelled",
      cancellationNote: "Dealer pulled out — colour matrix mismatch",
      notes: "Cancelled — counts in cancellation rate, NOT customer impact",
    },
    {
      ...common,
      batchCode: "TEST-010", model: "Tucson", requestedQuantity: 2,
      requestedAt: "2026-02-20", dealerPromisedDeliveryDate: "2026-04-12",
      currentStage: "delivered", feasibilityStatus: "feasible",
      partnershipConfidence: 95, operationsConfidence: 90,
      colorSummary: "White", appDisplayCities: "Riyadh", dealerReceivingCity: "Riyadh",
      poNumber: "TEST-PO-010", actualPoDate: "2026-02-25", vinReceivingDate: "2026-03-15",
      closedAt: "2026-04-10", closureReason: "delivered", deliveredQuantity: 2,
      notes: "Delivered 2d early — on-time control",
    },
    {
      ...common,
      batchCode: "TEST-011", model: "Sonata", requestedQuantity: 2,
      requestedAt: "2026-04-01", dealerPromisedDeliveryDate: "2026-06-12",
      currentStage: "po_issued", feasibilityStatus: "feasible",
      partnershipConfidence: 70, operationsConfidence: 60,
      colorSummary: "Black", appDisplayCities: "Riyadh", dealerReceivingCity: "Riyadh",
      poNumber: "TEST-PO-011", actualPoDate: "2026-04-05",
      notes: "Has overdue action — fires action_overdue alert",
    },
    {
      ...common,
      batchCode: "TEST-012", model: "Kona", requestedQuantity: 6,
      requestedAt: "2026-03-25", dealerPromisedDeliveryDate: "2026-06-20",
      currentProjectedDeliveryDate: "2026-07-05",
      currentStage: "po_issued", feasibilityStatus: "at_risk",
      partnershipConfidence: 55, operationsConfidence: 40,
      colorSummary: "Black, Silver", appDisplayCities: "Jeddah", dealerReceivingCity: "Jeddah",
      poNumber: "TEST-PO-012", actualPoDate: "2026-03-28", vinReceivingDate: "2026-05-25",
      deliveryDateRevisionCount: 3,
      notes: "Open, projected 15d late, re-promised 3× — moderate",
    },
  ]);

  // Fetch the freshly-inserted batches so we have IDs for actions/colors.
  const insertedBatches = await db
    .select({ id: batches.id, code: batches.batchCode, vinDate: batches.vinReceivingDate, closedAt: batches.closedAt, promised: batches.dealerPromisedDeliveryDate })
    .from(batches)
    .where(inArray(batches.batchCode, TEST_BATCH_CODES));
  const byCode = new Map(insertedBatches.map((b) => [b.code, b]));

  // ── 5. Batch actions ──────────────────────────────────────────
  // Resolve action_type IDs by name. Tries exact "VIN"/"Delivery" first,
  // then falls back to a case-insensitive substring match so a renamed
  // action type ("VIN Assignment", "Final Delivery", etc.) still works.
  const types = await db.select({ id: actionTypes.id, name: actionTypes.name, sortOrder: actionTypes.sortOrder }).from(actionTypes);

  function findType(exact: string, substring: string) {
    const byExact = types.find((t) => t.name === exact);
    if (byExact) return byExact;
    return types.find((t) => t.name.toLowerCase().includes(substring.toLowerCase()));
  }
  const vinType = findType("VIN", "vin");
  const deliveryType = findType("Delivery", "deliver");
  const firstNonVinDelivery = types
    .filter((t) => t !== vinType && t !== deliveryType)
    .sort((a, b) => a.sortOrder - b.sortOrder)[0];

  const actionInserts: (typeof batchActions.$inferInsert)[] = [];

  // VIN done for post-VIN open batches + all delivered batches
  if (vinType) {
    for (const code of ["TEST-004", "TEST-005", "TEST-006", "TEST-007", "TEST-008", "TEST-010", "TEST-012"]) {
      const b = byCode.get(code);
      if (!b || !b.vinDate) continue;
      actionInserts.push({
        batchId: b.id,
        actionTypeId: vinType.id,
        status: "done",
        completedAt: `${b.vinDate}T12:00:00Z`,
        expectedDate: b.vinDate,
      });
    }
  }

  // Delivery done for the 4 delivered batches
  if (deliveryType) {
    for (const code of ["TEST-005", "TEST-006", "TEST-007", "TEST-010"]) {
      const b = byCode.get(code);
      if (!b || !b.closedAt) continue;
      actionInserts.push({
        batchId: b.id,
        actionTypeId: deliveryType.id,
        status: "done",
        completedAt: `${b.closedAt}T15:00:00Z`,
        expectedDate: b.promised,
      });
    }
  }

  // Overdue waiting action for TEST-011 (fires action_overdue alert)
  if (firstNonVinDelivery) {
    const b = byCode.get("TEST-011");
    if (b) {
      actionInserts.push({
        batchId: b.id,
        actionTypeId: firstNonVinDelivery.id,
        status: "waiting",
        expectedDate: "2026-04-28",
        notes: "Seeded overdue — exercises action_overdue alert rule",
      });
    }
  }

  if (actionInserts.length > 0) {
    await db.insert(batchActions).values(actionInserts);
  }

  // ── 6. Color matrix for colour-reliability metric ─────────────
  const t006 = byCode.get("TEST-006");
  const t007 = byCode.get("TEST-007");
  const colorInserts: (typeof batchColorMatrix.$inferInsert)[] = [];
  if (t006) {
    colorInserts.push(
      { batchId: t006.id, color: "Black", requestedQuantity: 3, confirmedQuantity: 2, deliveredQuantity: 2 },
      { batchId: t006.id, color: "White", requestedQuantity: 2, confirmedQuantity: 2, deliveredQuantity: 2 },
    );
  }
  if (t007) {
    colorInserts.push(
      { batchId: t007.id, color: "Black",  requestedQuantity: 6, confirmedQuantity: 6, deliveredQuantity: 6 },
      { batchId: t007.id, color: "Silver", requestedQuantity: 4, confirmedQuantity: 4, deliveredQuantity: 4 },
    );
  }
  if (colorInserts.length > 0) {
    await db.insert(batchColorMatrix).values(colorInserts);
  }

  return {
    dealerId,
    batchesInserted: TEST_BATCH_CODES.length,
    alertRulesInserted: rulesInserted,
    batchActionsInserted: actionInserts.length,
    colorMatrixInserted: colorInserts.length,
    /** Diagnostics — which action_types we resolved. `null` = none found. */
    resolved: {
      actionTypesAvailable: types.length,
      actionTypeNames: types.map((t) => t.name),
      vinTypeName: vinType?.name ?? null,
      deliveryTypeName: deliveryType?.name ?? null,
      overdueAnchorName: firstNonVinDelivery?.name ?? null,
    },
    note: "Refresh Dashboard, Action Center, and Reports to see the seeded scenarios. Filter by dealer 'test' to isolate.",
  };
}

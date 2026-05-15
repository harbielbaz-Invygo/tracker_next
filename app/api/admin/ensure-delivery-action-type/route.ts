/**
 * One-time admin endpoint: ensure a canonical "Delivery" action_type
 * exists in the catalogue.
 *
 * Production never seeded one. Side effects of the missing row:
 *   • Settings → Action Types can't show the 🔒 batch-closing lock
 *   • Plan-vs-Reality timeline can't render the Delivery tick
 *   • /api/batch-action's auto-close cascade (if ops marks Delivery
 *     done directly) never fires (works fine via /api/batch-close
 *     modal, which is the canonical path anyway)
 *
 * What this endpoint does:
 *   1. Check if any action_type named "Delivery" exists (case-insensitive)
 *   2. If yes — no-op, return existing row id
 *   3. If no — insert canonical row:
 *        name: "Delivery"
 *        waitingLabel: "Waiting Delivery"
 *        doneLabel: "Delivered"
 *        defaultDepartmentId: <Logistics if found, else null>
 *        sortOrder: max(existing sortOrders) + 10
 *        offsetAnchor: "promised", offsetDays: 0
 *
 * Idempotent (case-insensitive name check). Admin-gated.
 *
 *   GET /api/admin/ensure-delivery-action-type
 *
 * Delete this file in a follow-up PR after running on production.
 */
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { actionTypes, departments } from "@/lib/db/schema";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;

  const log: string[] = [];
  const push = (s: string) => { log.push(s); };

  try {
    push("→ Checking for an existing Delivery action_type…");
    // Case-insensitive lookup — admin might have created
    // "delivery" / "DELIVERY" / "Delivery " (trailing space) etc.
    const existing = await db.all<{ id: number; name: string }>(sql.raw(
      `SELECT id, name FROM action_types WHERE LOWER(TRIM(name)) = 'delivery' LIMIT 1`,
    ));
    if (existing.length > 0) {
      push(`  ✓ Found existing row #${existing[0].id} "${existing[0].name}". No-op.`);
      // If the existing name isn't EXACTLY "Delivery", warn the
      // admin — the batch-close + auto-close cascade match by
      // case-sensitive literal "Delivery". A row called
      // "delivery" or "DELIVERY" wouldn't trigger those paths.
      if (existing[0].name !== "Delivery") {
        push(`  ⚠ Existing row name "${existing[0].name}" does NOT match the literal "Delivery" the code expects.`);
        push("    Rename it via Settings → Action Types (Delivery row will be locked from rename after this fix, so do it now).");
      }
      return NextResponse.json({ ok: true, log, created: false, actionTypeId: existing[0].id });
    }

    push("  ✓ No Delivery row exists. Creating…");

    // Pick a defaultDepartmentId — prefer "Logistics" if it
    // exists, else null. Admin can change later via Settings.
    const [logisticsDept] = await db
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .where(eq(departments.name, "Logistics"))
      .limit(1);
    const defaultDepartmentId = logisticsDept?.id ?? null;
    push(logisticsDept
      ? `→ Default department: "${logisticsDept.name}" (#${logisticsDept.id}).`
      : "→ No Logistics department found; defaultDepartmentId = null.");

    // sortOrder: end of the list so it doesn't disrupt existing
    // ordering. Take max + 10.
    const [maxRow] = await db.all<{ m: number | null }>(sql.raw(
      `SELECT MAX(sort_order) as m FROM action_types`,
    ));
    const sortOrder = (maxRow?.m ?? 0) + 10;

    const [created] = await db.insert(actionTypes).values({
      name:                "Delivery",
      waitingLabel:        "Waiting Delivery",
      doneLabel:           "Delivered",
      defaultDepartmentId,
      sortOrder,
      offsetDays:          0,
      offsetAnchor:        "promised",
    }).returning({ id: actionTypes.id });

    push(`✓ Created action_type #${created.id} "Delivery".`);
    push("  → Settings → Action Types now shows the 🔒 batch-closing lock on this row.");
    push("  → Mark-as-delivered will continue to work (it already did via /api/batch-close).");
    push("  → New batches with this action picked at intake will register the Delivery batch_action when closed.");

    return NextResponse.json({ ok: true, log, created: true, actionTypeId: created.id });
  } catch (err) {
    push(`✗ Failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ ok: false, log }, { status: 500 });
  }
}

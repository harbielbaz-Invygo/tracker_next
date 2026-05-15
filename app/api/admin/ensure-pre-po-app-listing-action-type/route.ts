/**
 * POST /api/admin/ensure-pre-po-app-listing-action-type
 *
 * One-shot admin endpoint that ensures the canonical "Pre-PO App
 * Listing" action_type exists on production. The seed script picks
 * this up on fresh installs; for an existing deployment we need to
 * insert the row once.
 *
 * Idempotent — returns the existing row if it's already there.
 *
 * Delete this file after running it on every environment that needs
 * it (mirrors the pattern used for the Delivery action_type backfill).
 *
 *   curl -X POST https://<host>/api/admin/ensure-pre-po-app-listing-action-type
 *        -H 'cookie: <admin-session-cookie>'
 */
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { actionTypes, departments } from "@/lib/db/schema";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";

const ACTION_NAME = "Pre-PO App Listing";

export async function POST() {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;

  // Already there? Return it.
  const existing = await db.select().from(actionTypes).where(eq(actionTypes.name, ACTION_NAME)).limit(1);
  if (existing.length > 0) {
    return NextResponse.json({ status: "already_exists", actionType: existing[0] });
  }

  // Resolve Operations department for the default — fall back to null
  // if the catalog hasn't been seeded with it yet.
  const ops = await db.select().from(departments).where(eq(departments.name, "Operations")).limit(1);

  const [created] = await db.insert(actionTypes).values({
    name:             ACTION_NAME,
    waitingLabel:     "Pre-PO list pending",
    doneLabel:        "Pre-PO listed",
    defaultDepartmentId: ops[0]?.id ?? null,
    sortOrder:        0,
    offsetDays:       0,
    offsetAnchor:     "submission",
  }).returning();

  return NextResponse.json({ status: "created", actionType: created });
}

/**
 * POST /api/alerts — alert mutations for the Action Center.
 *
 * Supported ops:
 *   { op: "acknowledge", alertId: number }
 *     Mark an alert as acknowledged (does not resolve it — condition still holds).
 */
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { alerts } from "@/lib/db/schema";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["admin", "ops"]);
  if (!gate.ok) return gate.response;

  let body: { op: string; alertId?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.op === "acknowledge") {
    const alertId = Number(body.alertId);
    if (!Number.isFinite(alertId) || alertId <= 0) {
      return NextResponse.json({ error: "alertId required" }, { status: 400 });
    }

    const [existing] = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(eq(alerts.id, alertId))
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: "alert not found" }, { status: 404 });
    }

    await db
      .update(alerts)
      .set({
        acknowledged:   true,
        acknowledgedBy: gate.user.username ?? null,
        acknowledgedAt: new Date().toISOString(),
      })
      .where(eq(alerts.id, alertId));

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown op" }, { status: 400 });
}

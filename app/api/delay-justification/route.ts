/**
 * Delay justifications — submit + list.
 *
 *   POST /api/delay-justification
 *     Body: { actionId, reasonId?, reasonText? }
 *     Ops/admin submit (or replace the open submission) explaining a late
 *     task. Needs a catalog reasonId and/or free text. Works regardless of
 *     the action's / PO's status (closed POs included).
 *
 *   GET /api/delay-justification?status=pending
 *     List justifications (optionally by status) — feeds the Inbox review
 *     queue. Admin only (it's a review surface).
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireAuth, apiError } from "@/lib/api-auth";
import {
  submitJustification,
  listJustifications,
  type JustificationStatus,
} from "@/lib/delay-justifications";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => null)) as
    | { actionId?: unknown; reasonId?: unknown; reasonText?: unknown }
    | null;
  const actionId = Number(body?.actionId);
  if (!Number.isInteger(actionId) || actionId <= 0) return apiError("actionId required", 400);

  const reasonId = body?.reasonId == null ? null : Number(body.reasonId);
  if (reasonId != null && (!Number.isInteger(reasonId) || reasonId <= 0)) {
    return apiError("reasonId must be a positive integer or omitted", 400);
  }
  const reasonText = typeof body?.reasonText === "string" ? body.reasonText : null;
  if (reasonId == null && !(reasonText && reasonText.trim())) {
    return apiError("Pick a reason or enter a description", 400);
  }

  const id = await submitJustification({
    actionId,
    reasonId,
    reasonText,
    submittedBy: gate.user.username,
  });
  if (id == null) {
    return apiError("Could not save — run the delay-justification tables migration first.", 409);
  }
  return NextResponse.json({ ok: true, id, actionId });
}

export async function GET(req: NextRequest) {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  const statusParam = new URL(req.url).searchParams.get("status");
  const valid: JustificationStatus[] = ["pending", "accepted", "rejected"];
  const status = valid.includes(statusParam as JustificationStatus)
    ? (statusParam as JustificationStatus)
    : undefined;
  return NextResponse.json({ ok: true, justifications: await listJustifications(status) });
}

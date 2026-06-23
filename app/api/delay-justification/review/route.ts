/**
 * PATCH /api/delay-justification/review
 *
 * Admin accept/reject of a delay justification, taken from the Inbox.
 *   Body: { id, decision: "accepted" | "rejected", note? }
 *
 * Accepting excuses the action's lateness (the metrics treat it as on-time
 * and the UI relabels the slip as excused). Rejecting leaves it a delay;
 * the optional note is shown back to the submitter.
 *
 * Admin only. Works for actions on closed/completed POs too.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireAuth, apiError } from "@/lib/api-auth";
import { reviewJustification } from "@/lib/delay-justifications";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest) {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => null)) as
    | { id?: unknown; decision?: unknown; note?: unknown }
    | null;
  const id = Number(body?.id);
  if (!Number.isInteger(id) || id <= 0) return apiError("id required", 400);

  const decision = body?.decision;
  if (decision !== "accepted" && decision !== "rejected") {
    return apiError('decision must be "accepted" or "rejected"', 400);
  }
  const note = typeof body?.note === "string" ? body.note : null;

  const ok = await reviewJustification({
    id,
    decision,
    note,
    reviewedBy: gate.user.username,
  });
  if (!ok) return apiError("Justification not found", 404);
  return NextResponse.json({ ok: true, id, decision });
}

/**
 * /api/action-touchpoint — CRUD for the per-action follow-up log.
 *
 * GET  ?actionId=NN  — list touchpoints for one action, newest first.
 * POST              — log a new touchpoint.
 *
 * Used by the test page at /action-center-flow. Will fold into the
 * main Action Center once the design lands.
 *
 * Body for POST:
 *   {
 *     actionId:        number,
 *     channel:         "email"|"phone"|"whatsapp"|"meeting"|"other",
 *     direction?:      "outbound"|"inbound"|"internal",   // default outbound
 *     outcome?:        "no_response"|"partial"|"confirmed"|
 *                       "excuse"|"counter_proposal"|"other",  // default no_response
 *     note?:           string | null,
 *     nextFollowupAt?: string (ISO yyyy-mm-dd) | null,
 *     escalated?:      boolean,
 *   }
 */
import { desc, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { actionTouchpoints, actions as actionsTable } from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const CHANNELS = ["email", "phone", "whatsapp", "meeting", "other"] as const;
const DIRECTIONS = ["outbound", "inbound", "internal"] as const;
const OUTCOMES = [
  "no_response", "partial", "confirmed",
  "excuse", "counter_proposal", "other",
] as const;
type Channel   = (typeof CHANNELS)[number];
type Direction = (typeof DIRECTIONS)[number];
type Outcome   = (typeof OUTCOMES)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;
  const idRaw = req.nextUrl.searchParams.get("actionId");
  const actionId = Number(idRaw);
  if (!Number.isInteger(actionId) || actionId <= 0) {
    return apiError("actionId query param required", 400);
  }
  try {
    const rows = await db
      .select()
      .from(actionTouchpoints)
      .where(eq(actionTouchpoints.actionId, actionId))
      .orderBy(desc(actionTouchpoints.contactedAt), desc(actionTouchpoints.id));
    return NextResponse.json({ ok: true, touchpoints: rows });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(msg)) {
      return NextResponse.json({
        ok: true,
        touchpoints: [],
        warning: "action_touchpoints table missing — run /api/admin/ensure-action-touchpoints-table",
      });
    }
    throw err;
  }
}

interface Body {
  actionId:        number;
  channel:         Channel;
  direction?:      Direction;
  outcome?:        Outcome;
  note?:           string | null;
  nextFollowupAt?: string | null;
  escalated?:      boolean;
  /** Optional ISO datetime override — backdate / forward-date the
   *  contact moment. Defaults to CURRENT_TIMESTAMP at insert time. */
  contactedAt?:    string | null;
}

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return apiError("Invalid JSON", 400);
  }

  if (!Number.isInteger(body.actionId) || body.actionId <= 0) {
    return apiError("actionId required", 400);
  }
  if (!CHANNELS.includes(body.channel)) {
    return apiError(`channel must be one of ${CHANNELS.join(", ")}`, 400);
  }
  const direction: Direction = body.direction ?? "outbound";
  if (!DIRECTIONS.includes(direction)) {
    return apiError(`direction must be one of ${DIRECTIONS.join(", ")}`, 400);
  }
  const outcome: Outcome = body.outcome ?? "no_response";
  if (!OUTCOMES.includes(outcome)) {
    return apiError(`outcome must be one of ${OUTCOMES.join(", ")}`, 400);
  }
  if (
    body.nextFollowupAt != null
    && body.nextFollowupAt !== ""
    && !ISO_DATE.test(body.nextFollowupAt)
  ) {
    return apiError("nextFollowupAt must be yyyy-mm-dd or null", 400);
  }
  // contactedAt override (backdate / forward-date). Accept full ISO
  // datetime (the UI uses datetime-local, which we convert to ISO).
  let contactedAtIso: string | null = null;
  if (body.contactedAt != null && body.contactedAt !== "") {
    if (typeof body.contactedAt !== "string") {
      return apiError("contactedAt must be a string or null", 400);
    }
    const parsed = new Date(body.contactedAt);
    if (Number.isNaN(parsed.getTime())) {
      return apiError("contactedAt must parse as a date", 400);
    }
    contactedAtIso = parsed.toISOString();
  }

  // Sanity check the action exists — keeps log entries from
  // referencing deleted/typo'd ids.
  const [action] = await db
    .select({ id: actionsTable.id })
    .from(actionsTable)
    .where(eq(actionsTable.id, body.actionId))
    .limit(1);
  if (!action) return apiError(`Action ${body.actionId} not found`, 404);

  try {
    const [inserted] = await db.insert(actionTouchpoints).values({
      actionId:       body.actionId,
      channel:        body.channel,
      direction,
      outcome,
      note:           body.note?.trim() || null,
      // contactedAt override only when supplied; otherwise let the
      // schema's CURRENT_TIMESTAMP default kick in so timestamps are
      // server-clock-consistent.
      ...(contactedAtIso ? { contactedAt: contactedAtIso } : {}),
      nextFollowupAt: body.nextFollowupAt ? body.nextFollowupAt : null,
      loggedBy:       gate.user.username,
      escalated:      body.escalated ?? false,
    }).returning();
    return NextResponse.json({ ok: true, touchpoint: inserted });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(msg)) {
      return apiError(
        "action_touchpoints table missing — run /api/admin/ensure-action-touchpoints-table",
        503,
      );
    }
    throw err;
  }
}

/**
 * DELETE — undo a just-logged touchpoint. Body: { id }.
 *
 * The UI surfaces this via the "Undo" toast that fades after 10s
 * post-log. No soft-delete here: the touchpoint row is removed.
 * That's the correct semantics for "I clicked the wrong chip"
 * rather than "I want to retract a recorded conversation".
 */
export async function DELETE(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;
  let body: { id?: number };
  try {
    body = (await req.json()) as { id?: number };
  } catch {
    return apiError("Invalid JSON", 400);
  }
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return apiError("id required", 400);
  }
  try {
    const result = await db
      .delete(actionTouchpoints)
      .where(eq(actionTouchpoints.id, id))
      .returning({ id: actionTouchpoints.id });
    if (result.length === 0) {
      return apiError(`Touchpoint ${id} not found`, 404);
    }
    return NextResponse.json({ ok: true, deletedId: id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(msg)) {
      return apiError(
        "action_touchpoints table missing — run /api/admin/ensure-action-touchpoints-table",
        503,
      );
    }
    throw err;
  }
}

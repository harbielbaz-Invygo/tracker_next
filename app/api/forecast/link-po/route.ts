/**
 * POST /api/forecast/link-po — manually link a Forecast (pre-PO batch)
 * to a post-PO batch that fulfils it.
 *
 * Why manual: real-world drift between Forecast and signed PO is the
 * rule, not the exception. City spellings change (Jeedah → Jeddah),
 * dealers swap models (Accent → MG5), quantities grow or shrink. A
 * fuzzy auto-match would silently bind the wrong records. Ops is the
 * authority on "this PO covers that Forecast" — the system records
 * the link with a free-text note for audit trail.
 *
 * Body:
 *   {
 *     forecastBatchId: number,   // batches.id with lifecycleState='pre_po'
 *     poBatchId:       number,   // batches.id with lifecycleState='post_po'
 *     note?:           string,   // optional reason / context for the link
 *   }
 *
 * Effects:
 *   • Sets `parent_forecast_batch_id` on the post-PO batch to point at
 *     the Forecast. Reuses the existing column the Intake create
 *     route already uses for split-fulfilment lineage.
 *   • Sets `forecast_superseded_at` on the Forecast so its status
 *     flips from "Open" to "Superseded" — the active workflow now
 *     lives on the post-PO batch.
 *   • Appends the note (if any) to the Forecast batch's `notes` field
 *     with a "linked to PO <code> on <date>" prefix so the audit
 *     trail is human-readable inside the existing Notes UI.
 *
 * Constraints:
 *   • Both batches must exist.
 *   • Forecast batch must currently be lifecycle='pre_po' and not yet
 *     superseded (no double-linking).
 *   • PO batch must be lifecycle='post_po'.
 *   • Dealer match isn't required (the diff is exactly what the link
 *     UI surfaces to the operator) but is logged in the response so
 *     the UI can show "linked across dealers" if it happens.
 */
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { batches } from "@/lib/db/schema";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

interface Body {
  forecastBatchId: number;
  poBatchId: number;
  note?: string | null;
}

function validate(body: unknown): { ok: true; data: Body } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, reason: "Missing body" };
  const b = body as Record<string, unknown>;
  if (typeof b.forecastBatchId !== "number" || b.forecastBatchId <= 0)
    return { ok: false, reason: "forecastBatchId is required" };
  if (typeof b.poBatchId !== "number" || b.poBatchId <= 0)
    return { ok: false, reason: "poBatchId is required" };
  if (b.forecastBatchId === b.poBatchId)
    return { ok: false, reason: "forecastBatchId and poBatchId must be different" };
  const note = typeof b.note === "string" ? b.note.trim() : null;
  return {
    ok: true,
    data: {
      forecastBatchId: b.forecastBatchId as number,
      poBatchId:       b.poBatchId as number,
      note:            note && note.length > 0 ? note : null,
    },
  };
}

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["admin", "ops"]);
  if (!gate.ok) return gate.response;

  const parsed = validate(await req.json().catch(() => null));
  if (!parsed.ok) return apiError(parsed.reason, 400);
  const { forecastBatchId, poBatchId, note } = parsed.data;

  // Load both batches in parallel for the gates below.
  const [forecastRows, poRows] = await Promise.all([
    db.select({
      id:                    batches.id,
      batchCode:             batches.batchCode,
      dealerId:              batches.dealerId,
      lifecycleState:        batches.lifecycleState,
      forecastSupersededAt:  batches.forecastSupersededAt,
      notes:                 batches.notes,
    }).from(batches).where(eq(batches.id, forecastBatchId)).limit(1),
    db.select({
      id:             batches.id,
      batchCode:      batches.batchCode,
      dealerId:       batches.dealerId,
      lifecycleState: batches.lifecycleState,
      poNumber:       batches.poNumber,
      parentForecastBatchId: batches.parentForecastBatchId,
    }).from(batches).where(eq(batches.id, poBatchId)).limit(1),
  ]);

  const forecast = forecastRows[0];
  const po = poRows[0];
  if (!forecast) return apiError("Forecast batch not found", 404);
  if (!po) return apiError("PO batch not found", 404);
  if (forecast.lifecycleState !== "pre_po")
    return apiError(
      `Forecast batch ${forecast.batchCode} is not in pre_po state (currently ${forecast.lifecycleState}).`,
      409,
    );
  if (forecast.forecastSupersededAt)
    return apiError(
      `Forecast batch ${forecast.batchCode} is already linked (superseded on ${forecast.forecastSupersededAt}).`,
      409,
    );
  if (po.lifecycleState !== "post_po")
    return apiError(
      `Target batch ${po.batchCode} is not a post-PO batch (currently ${po.lifecycleState}).`,
      409,
    );
  if (po.parentForecastBatchId && po.parentForecastBatchId !== forecast.id)
    return apiError(
      `Target batch ${po.batchCode} is already linked to a different Forecast.`,
      409,
    );

  const today = new Date().toISOString().slice(0, 10);
  const linkNote = `[${today}] Linked to PO ${po.batchCode}${po.poNumber ? ` (${po.poNumber})` : ""}` +
    (note ? `: ${note}` : "");
  const mergedNotes = forecast.notes ? `${forecast.notes}\n${linkNote}` : linkNote;

  // Two writes — no transaction wrapper because libSQL/Turso single-
  // statement writes are already atomic on their own; the Forecast
  // batch state update is the source of truth ("did it link?") so
  // ordering is: stamp the PO first, then mark the Forecast superseded.
  // If the second write fails the Forecast still reads as Open and ops
  // can retry; the PO's parent pointer is idempotent for a re-run.
  await db
    .update(batches)
    .set({ parentForecastBatchId: forecast.id })
    .where(eq(batches.id, po.id));
  await db
    .update(batches)
    .set({
      forecastSupersededAt: today,
      notes:                mergedNotes,
    })
    .where(eq(batches.id, forecast.id));

  return NextResponse.json({
    ok: true,
    forecastBatchId: forecast.id,
    poBatchId: po.id,
    sameDealer: forecast.dealerId === po.dealerId,
    linkedAt: today,
  });
}

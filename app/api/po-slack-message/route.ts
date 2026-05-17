/**
 * GET /api/po-slack-message?code={batchCode}
 *
 * Returns the PO-level Slack status-check message as plain text. The
 * source batch's PO number determines the cohort; every sibling under
 * the same PO is rolled into a single delivery-wave-grouped summary
 * (wave → city → model → qty) plus commercial terms and a flat list
 * of pending actions across all the batches.
 *
 * Replaces the older per-batch Slack message (still available via
 * lib/action-center-slack.ts:formatStatusCheckMessage if anyone wants
 * it back).
 *
 * Returns `{ message: string }` JSON so the client can copy verbatim
 * to the clipboard.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getPoStatusCheckData } from "@/lib/action-center-data";
import { formatPoStatusCheckMessage } from "@/lib/action-center-slack";
import { apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code")?.trim();
  if (!code) return apiError("Missing ?code= batch code", 400);

  const data = await getPoStatusCheckData(code);
  if (!data) {
    return apiError(
      "No PO context for that batch (legacy data or pre-PO batch with no PO number yet)",
      404,
    );
  }

  const message = formatPoStatusCheckMessage(data);
  return NextResponse.json({ message });
}

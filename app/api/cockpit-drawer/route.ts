/**
 * GET /api/cockpit-drawer?code=BATCH-CODE
 *
 * Returns the DrawerData for a single batch — full action list + dept list
 * + both confidence values. Public read; mutations live on
 * /api/batch-action and /api/batch-confidence.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getDrawerData } from "@/lib/cockpit-data";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Cockpit is an Ops surface — gate this drawer endpoint to match.
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;

  const code = req.nextUrl.searchParams.get("code")?.trim();
  if (!code) {
    return NextResponse.json({ error: "Missing ?code=" }, { status: 400 });
  }
  const data = await getDrawerData(code);
  if (!data) {
    return NextResponse.json({ error: `No batch with code ${code}` }, { status: 404 });
  }
  return NextResponse.json(data);
}

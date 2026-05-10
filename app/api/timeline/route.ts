/**
 * GET /api/timeline?code=BATCH-CODE
 *
 * Returns the TimelineData object for a single batch. Used by the
 * Dashboard drawer to render the Plan vs Reality SVG without re-querying
 * every batch on the page.
 *
 * Public read — same access policy as the dashboard table itself.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getTimelineData } from "@/lib/dashboard-data";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code")?.trim();
  if (!code) {
    return NextResponse.json({ error: "Missing ?code=" }, { status: 400 });
  }

  const data = await getTimelineData(code);
  if (!data) {
    return NextResponse.json({ error: `No batch found for code: ${code}` }, { status: 404 });
  }

  return NextResponse.json(data);
}

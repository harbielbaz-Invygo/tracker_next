/**
 * Delay-reason catalog — the admin-curated preset reasons ops can pick when
 * explaining a late task.
 *
 *   GET   /api/delay-reason            → list (ops+admin; active only unless
 *                                        ?all=1 and admin)
 *   POST  /api/delay-reason            → add a reason  { label }   (admin)
 *   PATCH /api/delay-reason            → toggle active { id, active } (admin)
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireAuth, apiError } from "@/lib/api-auth";
import { listReasonCatalog, createReason, setReasonActive } from "@/lib/delay-justifications";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const gate = await requireAuth(["ops", "admin"]);
  if (!gate.ok) return gate.response;
  const all = new URL(req.url).searchParams.get("all") === "1" && gate.user.role === "admin";
  return NextResponse.json({ ok: true, reasons: await listReasonCatalog(all) });
}

export async function POST(req: NextRequest) {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  const body = (await req.json().catch(() => null)) as { label?: unknown } | null;
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  if (!label) return apiError("label required", 400);
  const id = await createReason(label);
  if (id == null) {
    return apiError("Could not add — run the delay-justification tables migration first.", 409);
  }
  return NextResponse.json({ ok: true, id, label });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  const body = (await req.json().catch(() => null)) as { id?: unknown; active?: unknown } | null;
  const id = Number(body?.id);
  if (!Number.isInteger(id) || id <= 0) return apiError("id required", 400);
  if (typeof body?.active !== "boolean") return apiError("active (boolean) required", 400);
  await setReasonActive(id, body.active);
  return NextResponse.json({ ok: true, id, active: body.active });
}

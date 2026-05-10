/**
 * GET /api/health — public liveness/readiness probe.
 *
 * Returns 200 when the process can reach the database, 503 otherwise.
 * Used by load balancers, container orchestrators, and uptime monitors.
 *
 * No auth required — probes are typically unauthenticated and the
 * response is intentionally minimal (no DB stats, no schema info).
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const ts = new Date().toISOString();
  try {
    // Round-trip a trivial query to verify the DB connection is alive.
    await db.run(sql`SELECT 1`);
    return Response.json({ ok: true, ts });
  } catch (e) {
    return Response.json(
      {
        ok: false,
        ts,
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 503 },
    );
  }
}

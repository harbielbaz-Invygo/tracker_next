/**
 * GET/POST /api/admin/cleanup-orphan-actions
 *
 * Deletes scope-aware `actions` rows whose `scope_id` no longer points at a
 * live row in the matching scope table (po / wave / batch). These have no
 * FK to their parent (scope_id is a plain int), so deleting a batch / wave /
 * PO outside the few paths that clear actions explicitly orphans them.
 *
 * Why it matters: an orphaned `waiting` action is counted forever by
 * lib/sla-metrics.ts as "Delayed now / Critical" and by the Stuck Stages
 * panel — dead work silently inflating live operational metrics.
 *
 * GET  → dry-run: how many orphans per scope (no writes).
 * POST → delete them.
 *
 * Admin-only. Destructive (but only removes rows already pointing at
 * nothing). Idempotent.
 */
import { NextResponse, type NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

// scope → the table its scope_id must exist in.
const SCOPES: { scope: "po" | "wave" | "batch"; table: string }[] = [
  { scope: "po", table: "pos" },
  { scope: "wave", table: "waves" },
  { scope: "batch", table: "batches" },
];

async function countOrphans(scope: string, table: string): Promise<number> {
  const rows = await db.all<{ n: number }>(sql.raw(
    `SELECT COUNT(*) AS n FROM actions
       WHERE scope = '${scope}'
         AND scope_id NOT IN (SELECT id FROM ${table})`,
  ));
  return Number(rows[0]?.n ?? 0);
}

async function deleteOrphans(scope: string, table: string): Promise<void> {
  await db.run(sql.raw(
    `DELETE FROM actions
       WHERE scope = '${scope}'
         AND scope_id NOT IN (SELECT id FROM ${table})`,
  ));
}

async function buildReport(write: boolean) {
  const perScope: Record<string, number> = {};
  let total = 0;
  for (const { scope, table } of SCOPES) {
    const n = await countOrphans(scope, table);
    perScope[scope] = n;
    total += n;
  }
  if (write && total > 0) {
    // Each delete is an independent, idempotent NOT-IN sweep — no
    // cross-scope invariant to protect, so run them sequentially.
    for (const { scope, table } of SCOPES) await deleteOrphans(scope, table);
  }
  return { perScope, total, dryRun: !write };
}

export async function GET() {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  try {
    return NextResponse.json({ ok: true, ...(await buildReport(false)) });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err), 500);
  }
}

export async function POST(_req: NextRequest) {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  try {
    return NextResponse.json({ ok: true, ...(await buildReport(true)) });
  } catch (err) {
    return apiError(`Cleanup failed: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}

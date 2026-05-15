/**
 * One-time admin endpoint: decouple App Listing from action_types.
 *
 * App Listing is now a fixed system concept stored as
 * `batches.app_listed_at`. This migration:
 *
 *   1. CREATE COLUMN IF NOT EXISTS batches.app_listed_at (TEXT).
 *      SQLite doesn't support IF NOT EXISTS on ADD COLUMN, so we
 *      check PRAGMA table_info first and skip the ALTER if present.
 *   2. Backfill: for every batch whose current "App Listing"
 *      batch_action is done, copy its completedAt into
 *      batches.app_listed_at (preserves history).
 *   3. Delete the App Listing batch_actions rows.
 *   4. Delete action_dependencies referencing App Listing
 *      (in either direction — parent or child).
 *   5. Delete the App Listing action_type row itself.
 *
 * Idempotent: re-running on a migrated DB is a no-op (no App Listing
 * action_type left to match, no batch_actions to copy).
 *
 * Admin-gated. Hit while logged in as admin:
 *   GET /api/admin/migrate-app-listing
 *
 * Delete this file in a follow-up PR after running on production.
 */
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;

  const log: string[] = [];
  const push = (s: string) => { log.push(s); };

  try {
    // ── 1. ADD COLUMN IF NOT EXISTS ────────────────────────────
    push("→ Checking batches.app_listed_at column…");
    const colInfo = await db.all<{ name: string }>(
      sql.raw(`PRAGMA table_info(batches)`),
    );
    const hasColumn = colInfo.some((c) => c.name === "app_listed_at");
    if (hasColumn) {
      push("  ✓ already present.");
    } else {
      await db.run(sql.raw(`ALTER TABLE batches ADD COLUMN app_listed_at TEXT`));
      push("  ✓ ALTER TABLE added the column.");
    }

    // ── 2. Find the App Listing action_type ────────────────────
    push("→ Looking for the legacy App Listing action_type…");
    const types = await db.all<{ id: number; name: string }>(
      sql.raw(`SELECT id, name FROM action_types WHERE LOWER(name) LIKE '%app listing%'`),
    );
    if (types.length === 0) {
      push("  ✓ No App Listing action_type found — nothing to migrate.");
      push("✓ Done.");
      return NextResponse.json({ ok: true, log });
    }
    push(`  ✓ Found ${types.length}: ${types.map((t) => `#${t.id} "${t.name}"`).join(", ")}`);
    const typeIds = types.map((t) => t.id);
    const typeIdsCsv = typeIds.join(",");

    // ── 3. Backfill batches.app_listed_at from done batch_actions ──
    push("→ Backfilling batches.app_listed_at from done App Listing batch_actions…");
    // SQLite: correlated UPDATE…SET col = (SELECT … FROM ba WHERE …).
    // Only update rows that actually have a match — avoids clobbering
    // existing values with NULL for batches whose App Listing wasn't done.
    const beforeBackfill = await db.all<{ count: number }>(
      sql.raw(`SELECT COUNT(*) as count FROM batches WHERE app_listed_at IS NOT NULL`),
    );
    await db.run(sql.raw(`
      UPDATE batches
      SET app_listed_at = (
        SELECT ba.completed_at FROM batch_actions ba
        WHERE ba.batch_id = batches.id
          AND ba.action_type_id IN (${typeIdsCsv})
          AND ba.status = 'done'
          AND ba.completed_at IS NOT NULL
        LIMIT 1
      )
      WHERE EXISTS (
        SELECT 1 FROM batch_actions ba
        WHERE ba.batch_id = batches.id
          AND ba.action_type_id IN (${typeIdsCsv})
          AND ba.status = 'done'
          AND ba.completed_at IS NOT NULL
      )
    `));
    const afterBackfill = await db.all<{ count: number }>(
      sql.raw(`SELECT COUNT(*) as count FROM batches WHERE app_listed_at IS NOT NULL`),
    );
    const backfilled = (afterBackfill[0]?.count ?? 0) - (beforeBackfill[0]?.count ?? 0);
    push(`  ✓ ${backfilled} batch(es) gained an app_listed_at timestamp.`);

    // ── 4. Delete dependent rows ───────────────────────────────
    push("→ Nulling alert_rules.action_type_id pointing at App Listing…");
    await db.run(sql.raw(
      `UPDATE alert_rules SET action_type_id = NULL WHERE action_type_id IN (${typeIdsCsv})`,
    ));
    push("→ Deleting action_dependencies referencing App Listing (parent or child)…");
    await db.run(sql.raw(
      `DELETE FROM action_dependencies WHERE action_type_id IN (${typeIdsCsv}) OR depends_on_action_type_id IN (${typeIdsCsv})`,
    ));
    push("→ Deleting App Listing batch_actions…");
    await db.run(sql.raw(
      `DELETE FROM batch_actions WHERE action_type_id IN (${typeIdsCsv})`,
    ));
    push("→ Deleting the App Listing action_type rows…");
    await db.run(sql.raw(
      `DELETE FROM action_types WHERE id IN (${typeIdsCsv})`,
    ));

    push("✓ Migration complete. App Listing is now a fixed system concept.");
    return NextResponse.json({ ok: true, log });
  } catch (err) {
    push(`✗ Failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ ok: false, log }, { status: 500 });
  }
}

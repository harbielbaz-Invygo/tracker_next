/**
 * One-time admin endpoint: run the VIN chase migration against
 * whichever DB this Next.js instance is connected to. Hosted in-app
 * so production migrations don't require copying Turso credentials
 * to a local machine — Vercel masks DATABASE_URL + TURSO_AUTH_TOKEN
 * on `env pull`, making the local script unusable.
 *
 * GET /api/admin/migrate-vin-stages
 *   - admin-gated (middleware + handler check)
 *   - returns JSON { ok: true, log: string[] }
 *   - idempotent: re-running on an already-migrated DB is a no-op
 *
 * Same operations as scripts/migrate-vin-stages.ts:
 *   1. CREATE TABLE IF NOT EXISTS for vin_chase_stages + batch_vin_stages
 *   2. Seed the 6 canonical stages (idempotent)
 *   3. Delete legacy VIN-chase action_types + their batch_actions +
 *      action_dependencies + null alert_rules.action_type_id
 *   4. Backfill batch_vin_stages for every existing batch
 *
 * After running successfully ONCE on production, delete this file in
 * a follow-up PR. Leaving it around is low-risk (idempotent + admin
 * gated) but it has no reason to live long-term.
 */
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { vinChaseStages, batchVinStages, batches } from "@/lib/db/schema";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CANONICAL_STAGES = [
  { name: "VIN Receiving",  waitingLabel: "Awaiting VIN from dealer",       doneLabel: "VIN received",        sortOrder: 10 },
  { name: "Plate",          waitingLabel: "Plate transfer pending",         doneLabel: "Plate shared",        sortOrder: 20 },
  { name: "Customs",        waitingLabel: "Awaiting customs clearance",     doneLabel: "Customs cleared",     sortOrder: 30 },
  { name: "Tracking",       waitingLabel: "Awaiting tracking installation", doneLabel: "Tracking installed",  sortOrder: 40 },
  { name: "Inspection",     waitingLabel: "Awaiting inspection",            doneLabel: "Inspection passed",   sortOrder: 50 },
  { name: "Showroom Ready", waitingLabel: "Preparing for showroom",         doneLabel: "Showroom ready",      sortOrder: 60 },
] as const;

/**
 * Same keyword set the runtime classifier used. Kept inline here (not
 * imported) because cluster-keywords.ts is already deleted in the
 * codebase; this endpoint is the last consumer.
 */
const VIN_CHASE_KEYWORDS = [
  "vin", "plate", "customs", "tracking", "inspection",
  "showroom", "confirmation email", "dealer email",
];

function buildKeywordWhere(): string {
  return VIN_CHASE_KEYWORDS
    .map((kw) => `LOWER(name) LIKE '%${kw}%'`)
    .join(" OR ");
}

export async function GET() {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;

  const log: string[] = [];
  const push = (s: string) => { log.push(s); };

  try {
    push("→ Ensuring schema (CREATE TABLE IF NOT EXISTS) …");
    await db.run(sql.raw(`
      CREATE TABLE IF NOT EXISTS vin_chase_stages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        waiting_label TEXT NOT NULL,
        done_label TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `));
    await db.run(sql.raw(`
      CREATE TABLE IF NOT EXISTS batch_vin_stages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        stage_id INTEGER NOT NULL REFERENCES vin_chase_stages(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'waiting',
        completed_at TEXT,
        notes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `));
    await db.run(sql.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS batch_vin_stage_uniq ON batch_vin_stages (batch_id, stage_id)`,
    ));
    await db.run(sql.raw(
      `CREATE INDEX IF NOT EXISTS batch_vin_stages_batch_idx ON batch_vin_stages (batch_id)`,
    ));
    await db.run(sql.raw(
      `CREATE INDEX IF NOT EXISTS batch_vin_stages_status_idx ON batch_vin_stages (status)`,
    ));
    push("  ✓ schema in place.");

    push("→ Seeding canonical VIN chase stages…");
    for (const stage of CANONICAL_STAGES) {
      await db
        .insert(vinChaseStages)
        .values(stage)
        .onConflictDoNothing({ target: vinChaseStages.name });
    }
    const stages = await db.select().from(vinChaseStages);
    push(`  ✓ ${stages.length} stages present.`);

    push("→ Identifying legacy VIN-chase action_types…");
    const legacy = await db.all<{ id: number; name: string }>(sql.raw(
      `SELECT id, name FROM action_types WHERE ${buildKeywordWhere()}`,
    ));
    push(`  ✓ ${legacy.length} action_types match the legacy VIN-chase classifier.`);
    if (legacy.length > 0) {
      push(`    ${legacy.map((r) => `#${r.id} "${r.name}"`).join(", ")}`);

      const ids = legacy.map((r) => r.id).join(",");
      push("→ Nulling alert_rules.action_type_id pointing at legacy rows…");
      await db.run(sql.raw(
        `UPDATE alert_rules SET action_type_id = NULL WHERE action_type_id IN (${ids})`,
      ));
      push("→ Deleting action_dependencies (parent or child)…");
      await db.run(sql.raw(
        `DELETE FROM action_dependencies WHERE action_type_id IN (${ids}) OR depends_on_action_type_id IN (${ids})`,
      ));
      push("→ Deleting batch_actions for legacy types…");
      await db.run(sql.raw(
        `DELETE FROM batch_actions WHERE action_type_id IN (${ids})`,
      ));
      push("→ Deleting the action_types themselves…");
      await db.run(sql.raw(
        `DELETE FROM action_types WHERE id IN (${ids})`,
      ));
    }

    push("→ Backfilling batch_vin_stages for every existing batch…");
    const allBatches = await db.select({ id: batches.id }).from(batches);
    let inserted = 0;
    for (const b of allBatches) {
      for (const s of stages) {
        const res = await db
          .insert(batchVinStages)
          .values({ batchId: b.id, stageId: s.id, status: "waiting" })
          .onConflictDoNothing()
          .returning({ id: batchVinStages.id });
        if (res.length > 0) inserted++;
      }
    }
    push(`  ✓ Inserted ${inserted} batch_vin_stages rows across ${allBatches.length} batches.`);
    push("✓ Migration complete.");

    return NextResponse.json({ ok: true, log });
  } catch (err) {
    push(`✗ Migration failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ ok: false, log }, { status: 500 });
  }
}

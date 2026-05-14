/**
 * One-shot migration: VIN chase moves out of `action_types` into its
 * own first-class `vin_chase_stages` + `batch_vin_stages` tables.
 *
 *   1. Seed the 6 canonical stages (idempotent — skips if names exist).
 *   2. Identify VIN-chase `action_types` via the keyword classifier
 *      that previously routed them into the drawer's VIN cluster.
 *   3. Delete the dependent rows in the right order to satisfy FKs:
 *        - alert_rules pointing at those action_types (FK set null)
 *        - action_dependencies referencing them as parent OR child
 *        - batch_actions for those action_types
 *        - the action_types themselves
 *   4. Backfill: for every existing batch, insert a `batch_vin_stages`
 *      row per canonical stage with status="waiting". Idempotent — uses
 *      the (batch_id, stage_id) unique index to skip duplicates.
 *
 * Run after `npm run db:push` has applied the new tables:
 *     npx tsx scripts/migrate-vin-stages.ts
 *
 * Safe to run multiple times; each step is idempotent.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { vinChaseStages, batchVinStages, batches } from "@/lib/db/schema";

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
 * imported) because the classifier module is being deleted in this PR;
 * the migration is the last thing that needs to know what counts as
 * VIN-chase under the old model.
 */
const VIN_CHASE_KEYWORDS = [
  "vin", "plate", "customs", "tracking", "inspection",
  "showroom", "confirmation email", "dealer email",
];

function buildKeywordWhere(): string {
  // Returns a SQL WHERE clause body matching any keyword in the name.
  return VIN_CHASE_KEYWORDS
    .map((kw) => `LOWER(name) LIKE '%${kw}%'`)
    .join(" OR ");
}

async function main() {
  console.log("→ Seeding canonical VIN chase stages…");
  for (const stage of CANONICAL_STAGES) {
    await db
      .insert(vinChaseStages)
      .values(stage)
      .onConflictDoNothing({ target: vinChaseStages.name });
  }
  const stages = await db.select().from(vinChaseStages);
  console.log(`  ✓ ${stages.length} stages present.`);

  console.log("→ Identifying legacy VIN-chase action_types…");
  const legacy = await db.all<{ id: number; name: string }>(sql.raw(
    `SELECT id, name FROM action_types WHERE ${buildKeywordWhere()}`,
  ));
  console.log(`  ✓ ${legacy.length} action_types match the legacy VIN-chase classifier.`);
  if (legacy.length > 0) {
    console.log(`    ${legacy.map((r) => `#${r.id} "${r.name}"`).join(", ")}`);
  }

  if (legacy.length > 0) {
    const ids = legacy.map((r) => r.id).join(",");

    console.log("→ Nulling alert_rules.action_type_id pointing at legacy rows…");
    await db.run(sql.raw(
      `UPDATE alert_rules SET action_type_id = NULL WHERE action_type_id IN (${ids})`,
    ));

    console.log("→ Deleting action_dependencies (parent or child)…");
    await db.run(sql.raw(
      `DELETE FROM action_dependencies WHERE action_type_id IN (${ids}) OR depends_on_action_type_id IN (${ids})`,
    ));

    console.log("→ Deleting batch_actions for legacy types…");
    await db.run(sql.raw(
      `DELETE FROM batch_actions WHERE action_type_id IN (${ids})`,
    ));

    console.log("→ Deleting the action_types themselves…");
    await db.run(sql.raw(
      `DELETE FROM action_types WHERE id IN (${ids})`,
    ));
  }

  console.log("→ Backfilling batch_vin_stages for every existing batch…");
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
  console.log(`  ✓ Inserted ${inserted} batch_vin_stages rows across ${allBatches.length} batches.`);

  console.log("✓ Migration complete.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("✗ Migration failed:", err);
    process.exit(1);
  });

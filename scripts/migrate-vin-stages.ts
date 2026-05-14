/**
 * One-shot migration: VIN chase moves out of `action_types` into its
 * own first-class `vin_chase_stages` + `batch_vin_stages` tables.
 *
 *   0. CREATE TABLE IF NOT EXISTS for the two new tables + indexes.
 *      Self-contained — does not require `npm run db:push` first.
 *      (drizzle-kit push trips on unrelated schema drift; doing the
 *      DDL inline keeps this safe.)
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
 * Local run:
 *     npx tsx scripts/migrate-vin-stages.ts
 *
 * Production (Turso) run — recommended:
 *     npx vercel env pull .env.production --environment=production
 *     npx tsx scripts/migrate-vin-stages.ts
 *   (The script auto-loads `.env.production` if it exists, so the
 *   second command is enough — no need to copy-paste secrets into
 *   the shell.)
 *
 * Safe to run multiple times; each step is idempotent.
 *
 * IMPLEMENTATION NOTE — why we dynamic-import @/lib/db:
 *   ESM hoists static `import` statements to the top of the module,
 *   so any `import { db } from "@/lib/db"` would run BEFORE this
 *   file's top-level env-loader code. That triggers @/lib/env's
 *   validation against process.env *before* we've had a chance to
 *   populate it from .env.production, and the DB client boots
 *   pointed at the local file fallback. Dynamic `await import()`
 *   inside main() defers loading until after env vars are set.
 */
import { readFileSync, existsSync } from "node:fs";

// ──────────────────────────────────────────────────────────────────
// 0. Env loading — MUST happen before any module that reads process.env
// ──────────────────────────────────────────────────────────────────
//
// Order, first wins:
//   1. process.env (already set in the shell)
//   2. .env.production  (pulled from Vercel — convenient for prod migrations)
//   3. .env.local
//   4. .env
//
// Verbose by design: prints which files were found and which keys we
// set from each. Catches the case where `.env.production` exists but
// doesn't actually contain DATABASE_URL (Vercel project mis-config).
console.log("→ Loading env files (first wins):");
for (const envFile of [".env.production", ".env.local", ".env"]) {
  if (!existsSync(envFile)) {
    console.log(`    ${envFile}: not found`);
    continue;
  }
  const content = readFileSync(envFile, "utf-8");
  const setFromThisFile: string[] = [];
  const skipped: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key]) {
      skipped.push(key);
      continue;
    }
    const v = rawValue.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
    process.env[key] = v;
    setFromThisFile.push(key);
  }
  console.log(`    ${envFile}: set ${setFromThisFile.length} key(s)` +
              (setFromThisFile.length ? ` [${setFromThisFile.join(", ")}]` : "") +
              (skipped.length ? `; skipped ${skipped.length} already-set` : ""));
}
// Spot-check: is DATABASE_URL actually present after env loading?
if (!process.env.DATABASE_URL) {
  console.error("\n❌ DATABASE_URL is still unset after env loading.");
  console.error("   Check that .env.production actually contains a line like:");
  console.error("       DATABASE_URL=\"libsql://your-db.turso.io\"");
  console.error("   If not, the Vercel project may store the URL under a different");
  console.error("   key (e.g. TURSO_DATABASE_URL). Pull and inspect:");
  console.error("       npx vercel env pull .env.production --environment=production");
  console.error("       Get-Content .env.production | Select-String DATABASE|TURSO\n");
  process.exit(1);
}

// Fail FAST on the common foot-gun: pasting a placeholder like
// `libsql://<your-db>.turso.io` instead of the real value. Without
// this guard, the libsql client tries to parse the URL, encodes the
// angle brackets, and throws a confusing ERR_INVALID_URL deep in
// node:internal.
const _dbUrl = process.env.DATABASE_URL ?? "";
if (/<|>/.test(_dbUrl)) {
  // eslint-disable-next-line no-console
  console.error("\n❌ DATABASE_URL still contains placeholder characters (< or >):");
  console.error(`   ${_dbUrl}`);
  console.error("\nReplace <your-db> and <your-turso-token> with the actual values.\n");
  console.error("Easiest path:");
  console.error("   npx vercel env pull .env.production --environment=production");
  console.error("   npx tsx scripts/migrate-vin-stages.ts\n");
  process.exit(1);
}

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
  // Loudly announce which DB we're hitting so a wrong-target migration
  // (most common failure: forgetting to override DATABASE_URL in
  // PowerShell and hitting local file:./data/tracker.db instead of
  // the Turso remote) is obvious from the first line of output.
  const url = process.env.DATABASE_URL ?? "(unset)";
  const masked = url.startsWith("libsql://")
    ? url.replace(/^(libsql:\/\/[^.]{4})[^.]*/, "$1…")
    : url;
  const kind = url.startsWith("libsql://") || url.startsWith("https://") || url.startsWith("wss://")
    ? "REMOTE (Turso)"
    : url.startsWith("file:")
    ? "LOCAL file"
    : "unknown";
  console.log(`→ Target: ${kind}  ${masked}`);
  if (kind === "LOCAL file") {
    console.log("  ⚠ This is your LOCAL DB. If you meant Turso, abort (Ctrl-C),");
    console.log("    then: npx vercel env pull .env.production --environment=production");
    console.log("          npx tsx scripts/migrate-vin-stages.ts");
  }

  // Dynamic imports — see header note. These MUST stay below the env
  // loader above or the DB client boots with the wrong DATABASE_URL.
  const { sql } = await import("drizzle-orm");
  const { db } = await import("@/lib/db");
  const { vinChaseStages, batchVinStages, batches } = await import("@/lib/db/schema");

  console.log("→ Ensuring schema (CREATE TABLE IF NOT EXISTS) …");
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
  console.log("  ✓ schema in place.");

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

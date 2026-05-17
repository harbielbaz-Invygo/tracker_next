/**
 * Phase 1 of the scope-aware restructure:
 *
 *   1. ALTER TABLE action_types ADD COLUMN scope TEXT NOT NULL DEFAULT 'batch'
 *   2. ALTER TABLE batches ADD COLUMN wave_id INTEGER
 *   3. CREATE TABLE pos
 *   4. CREATE TABLE waves
 *   5. CREATE TABLE actions
 *   6. Backfill action_types.scope per the canonical mapping:
 *        po    → Car Specs / Pricing / SKU / App Listing
 *        wave  → Send Dealer Confirmation Email / VIN / Plate / Customs Card
 *                / Tracking System Installed / Car Inspection
 *                / Car Ready in Showroom
 *        batch → Delivery / Pre-PO App Listing
 *
 * Phase 1 is PURELY ADDITIVE — old tables (batches workflow columns,
 * batch_actions, batch_vin_stages, vin_chase_stages, batch_delivery_legs)
 * stay intact so the existing app keeps working. Phases 2-5 progressively
 * migrate logic to the new tables; phase 5 drops the legacy ones.
 *
 * Safe to re-run.
 *
 * Run on prod:
 *     npx vercel env pull .env.production --environment=production
 *     npx tsx scripts/migrate-scope-restructure.ts
 */
import { readFileSync, existsSync } from "node:fs";

console.log("→ Loading env files (first wins):");
for (const envFile of [".env.production", ".env.local", ".env"]) {
  if (!existsSync(envFile)) {
    console.log(`    ${envFile}: not found`);
    continue;
  }
  const content = readFileSync(envFile, "utf-8");
  let setCount = 0;
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (key in process.env) continue;
    const v = rawValue.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
    process.env[key] = v;
    setCount++;
  }
  console.log(`    ${envFile}: set ${setCount} key(s)`);
}

if (process.env.DATABASE_URL === "") {
  console.error("\n❌ DATABASE_URL was loaded as an empty string (Vercel-masked).");
  console.error("   Set manually in PowerShell first:");
  console.error("       $env:DATABASE_URL = 'libsql://your-db.turso.io'");
  console.error("       $env:TURSO_AUTH_TOKEN = 'eyJ…'");
  console.error("       npx tsx scripts/migrate-scope-restructure.ts\n");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("\n❌ DATABASE_URL unset.");
  process.exit(1);
}

const SCOPE_MAP: Record<string, "po" | "wave" | "batch"> = {
  // Internal phase — PO scope
  "Car Specs":                       "po",
  "Pricing":                         "po",
  "SKU":                             "po",
  "App Listing":                     "po",
  // VIN chase — wave scope
  "Send Dealer Confirmation Email":  "wave",
  "VIN":                             "wave",
  "Plate":                           "wave",
  "Customs Card":                    "wave",
  "Tracking System Installed":       "wave",
  "Car Inspection":                  "wave",
  "Car Ready in Showroom":           "wave",
  // Batch — closure trigger + pre-PO listing
  "Delivery":                        "batch",
  "Pre-PO App Listing":              "batch",
};

async function main() {
  const { db } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");

  const urlPreview = (process.env.DATABASE_URL ?? "").replace(/(authToken=).+/, "$1***");
  console.log(`\n→ Connected to ${urlPreview}`);

  // ── 1. action_types.scope ─────────────────────────────────
  const actionTypeCols = await db.all<{ name: string }>(
    sql.raw("PRAGMA table_info(action_types)"),
  );
  if (actionTypeCols.some((c) => c.name === "scope")) {
    console.log("✓ action_types.scope already exists");
  } else {
    await db.run(sql.raw(
      "ALTER TABLE action_types ADD COLUMN scope TEXT NOT NULL DEFAULT 'batch'",
    ));
    console.log("✚ action_types.scope added");
  }

  // ── 2. batches.wave_id ────────────────────────────────────
  const batchesCols = await db.all<{ name: string }>(
    sql.raw("PRAGMA table_info(batches)"),
  );
  if (batchesCols.some((c) => c.name === "wave_id")) {
    console.log("✓ batches.wave_id already exists");
  } else {
    await db.run(sql.raw("ALTER TABLE batches ADD COLUMN wave_id INTEGER"));
    console.log("✚ batches.wave_id added");
  }

  // ── 3. pos table ──────────────────────────────────────────
  await db.run(sql.raw(`
    CREATE TABLE IF NOT EXISTS pos (
      id                              INTEGER PRIMARY KEY AUTOINCREMENT,
      po_number                       TEXT NOT NULL UNIQUE,
      dealer_id                       INTEGER NOT NULL REFERENCES dealers(id),
      po_date                         TEXT,
      po_reference                    TEXT,
      po_terms_notes                  TEXT,
      buy_back_rate                   REAL,
      contract_length_months          INTEGER,
      unit_price_sar                  REAL,
      tax_pct                         INTEGER,
      partnership_confidence          REAL DEFAULT 50,
      partnership_confidence_at_lock  REAL,
      operations_confidence           REAL DEFAULT 40,
      operations_confidence_at_lock   REAL,
      notes                           TEXT,
      closed_at                       TEXT,
      created_at                      TEXT DEFAULT (CURRENT_TIMESTAMP),
      updated_at                      TEXT DEFAULT (CURRENT_TIMESTAMP)
    )
  `));
  console.log("✓ pos table ensured");
  await db.run(sql.raw("CREATE INDEX IF NOT EXISTS pos_dealer_idx     ON pos(dealer_id)"));
  await db.run(sql.raw("CREATE INDEX IF NOT EXISTS pos_po_date_idx    ON pos(po_date)"));
  await db.run(sql.raw("CREATE INDEX IF NOT EXISTS pos_closed_at_idx  ON pos(closed_at)"));

  // ── 4. waves table ────────────────────────────────────────
  await db.run(sql.raw(`
    CREATE TABLE IF NOT EXISTS waves (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id                    INTEGER NOT NULL REFERENCES pos(id) ON DELETE CASCADE,
      availability_date        TEXT NOT NULL,
      vin_receiving_date       TEXT,
      ops_expected_date        TEXT,
      vin_received_at_intake   INTEGER NOT NULL DEFAULT 0,
      closed_at                TEXT,
      created_at               TEXT DEFAULT (CURRENT_TIMESTAMP),
      updated_at               TEXT DEFAULT (CURRENT_TIMESTAMP)
    )
  `));
  console.log("✓ waves table ensured");
  await db.run(sql.raw("CREATE INDEX IF NOT EXISTS waves_po_idx              ON waves(po_id)"));
  await db.run(sql.raw("CREATE INDEX IF NOT EXISTS waves_availability_idx    ON waves(availability_date)"));
  await db.run(sql.raw("CREATE UNIQUE INDEX IF NOT EXISTS waves_po_availability_uniq ON waves(po_id, availability_date)"));

  // ── 5. actions table ──────────────────────────────────────
  await db.run(sql.raw(`
    CREATE TABLE IF NOT EXISTS actions (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      scope                      TEXT NOT NULL CHECK (scope IN ('po','wave','batch')),
      scope_id                   INTEGER NOT NULL,
      action_type_id             INTEGER NOT NULL REFERENCES action_types(id) ON DELETE RESTRICT,
      department_id              INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      assigned_stakeholder_id    INTEGER REFERENCES stakeholders(id) ON DELETE SET NULL,
      status                     TEXT NOT NULL DEFAULT 'waiting'
                                   CHECK (status IN ('waiting','blocked','done','skipped')),
      expected_date              TEXT,
      completed_at               TEXT,
      notes                      TEXT,
      created_at                 TEXT DEFAULT (CURRENT_TIMESTAMP),
      updated_at                 TEXT DEFAULT (CURRENT_TIMESTAMP)
    )
  `));
  console.log("✓ actions table ensured");
  await db.run(sql.raw("CREATE INDEX IF NOT EXISTS actions_scope_idx        ON actions(scope, scope_id)"));
  await db.run(sql.raw("CREATE INDEX IF NOT EXISTS actions_action_type_idx  ON actions(action_type_id)"));
  await db.run(sql.raw("CREATE INDEX IF NOT EXISTS actions_stakeholder_idx  ON actions(assigned_stakeholder_id)"));
  await db.run(sql.raw("CREATE INDEX IF NOT EXISTS actions_status_idx       ON actions(status)"));
  await db.run(sql.raw("CREATE UNIQUE INDEX IF NOT EXISTS actions_scope_type_uniq ON actions(scope, scope_id, action_type_id)"));

  // ── 6. Backfill action_types.scope ────────────────────────
  // Update every known canonical action_type to its mapped scope.
  // Rows not in the map keep their default ('batch') so admin-added
  // custom actions don't get silently re-routed.
  let updated = 0;
  for (const [name, scope] of Object.entries(SCOPE_MAP)) {
    const before = await db.all<{ id: number; scope: string }>(
      sql.raw(`SELECT id, scope FROM action_types WHERE name = '${name.replace(/'/g, "''")}'`),
    );
    if (before.length === 0) continue;
    if (before[0].scope === scope) continue;
    await db.run(sql.raw(
      `UPDATE action_types SET scope = '${scope}' WHERE name = '${name.replace(/'/g, "''")}'`,
    ));
    updated++;
    console.log(`✚ action_types[${name}].scope = ${scope}`);
  }
  if (updated === 0) console.log("✓ action_types scopes already set");

  console.log("\n✅ Phase 1 migration complete. Old tables untouched.\n");
  console.log("Next: phase 2 (Intake rewrite) will start using these new tables.");
}

main().catch((err) => {
  console.error("\n❌ Migration failed:", err);
  process.exit(1);
});

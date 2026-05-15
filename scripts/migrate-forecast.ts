/**
 * One-shot migration for the Forecast feature (PR 1 of #118).
 *
 *   1. ALTER TABLE `batches` ADD COLUMN `parent_forecast_batch_id` (nullable INTEGER).
 *   2. ALTER TABLE `batches` ADD COLUMN `forecast_superseded_at`   (nullable TEXT).
 *   3. CREATE TABLE IF NOT EXISTS `batch_forecasts` + its three indexes.
 *   4. INSERT INTO action_types the canonical "Pre-PO App Listing" row.
 *
 * `drizzle-kit push` against the prod DB hit the "data-loss" warning on
 * the unrelated `vin_received_at_intake` column and bailed before
 * applying the additions above. This script is self-contained — each
 * step is idempotent, so it's safe to re-run.
 *
 * Local run:
 *     npx tsx scripts/migrate-forecast.ts
 *
 * Production (Turso) run:
 *     npx vercel env pull .env.production --environment=production
 *     npx tsx scripts/migrate-forecast.ts
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

if (!process.env.DATABASE_URL) {
  console.error("\n❌ DATABASE_URL is unset. Run `npx vercel env pull .env.production --environment=production` first.\n");
  process.exit(1);
}

async function main() {
  const { db } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");

  const urlPreview = (process.env.DATABASE_URL ?? "").replace(/(authToken=).+/, "$1***");
  console.log(`\n→ Connected to ${urlPreview}`);

  // ── 1+2. batches columns ──────────────────────────────────────
  const batchesCols = await db.all<{ name: string }>(sql.raw("PRAGMA table_info(batches)"));
  const colNames = new Set(batchesCols.map((c) => c.name));

  if (colNames.has("parent_forecast_batch_id")) {
    console.log("✓ batches.parent_forecast_batch_id already exists");
  } else {
    await db.run(sql.raw("ALTER TABLE batches ADD COLUMN parent_forecast_batch_id INTEGER"));
    console.log("✚ batches.parent_forecast_batch_id added");
  }

  if (colNames.has("forecast_superseded_at")) {
    console.log("✓ batches.forecast_superseded_at already exists");
  } else {
    await db.run(sql.raw("ALTER TABLE batches ADD COLUMN forecast_superseded_at TEXT"));
    console.log("✚ batches.forecast_superseded_at added");
  }

  // ── 3. batch_forecasts table + indexes ────────────────────────
  await db.run(sql.raw(`
    CREATE TABLE IF NOT EXISTS batch_forecasts (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id             INTEGER NOT NULL UNIQUE
                             REFERENCES batches(id) ON DELETE CASCADE,
      submitted_at         TEXT NOT NULL,
      submitted_by_user_id INTEGER NOT NULL REFERENCES users(id),
      created_at           TEXT DEFAULT (CURRENT_TIMESTAMP),
      updated_at           TEXT DEFAULT (CURRENT_TIMESTAMP)
    )
  `));
  console.log("✓ batch_forecasts table ensured");

  await db.run(sql.raw("CREATE INDEX IF NOT EXISTS batch_forecasts_batch_idx        ON batch_forecasts(batch_id)"));
  await db.run(sql.raw("CREATE INDEX IF NOT EXISTS batch_forecasts_submitted_by_idx ON batch_forecasts(submitted_by_user_id)"));
  await db.run(sql.raw("CREATE INDEX IF NOT EXISTS batch_forecasts_submitted_at_idx ON batch_forecasts(submitted_at)"));
  console.log("✓ batch_forecasts indexes ensured");

  // ── 4. Pre-PO App Listing action_type ─────────────────────────
  const existing = await db.all<{ id: number }>(
    sql.raw("SELECT id FROM action_types WHERE name = 'Pre-PO App Listing' LIMIT 1"),
  );
  if (existing.length > 0) {
    console.log("✓ Pre-PO App Listing action_type already exists");
  } else {
    const ops = await db.all<{ id: number }>(
      sql.raw("SELECT id FROM departments WHERE name = 'Operations' LIMIT 1"),
    );
    const deptId = ops[0]?.id ?? null;
    if (deptId == null) {
      await db.run(sql.raw(`
        INSERT INTO action_types (name, waiting_label, done_label, default_department_id, sort_order, offset_days, offset_anchor)
        VALUES ('Pre-PO App Listing', 'Pre-PO list pending', 'Pre-PO listed', NULL, 0, 0, 'submission')
      `));
    } else {
      await db.run(sql.raw(`
        INSERT INTO action_types (name, waiting_label, done_label, default_department_id, sort_order, offset_days, offset_anchor)
        VALUES ('Pre-PO App Listing', 'Pre-PO list pending', 'Pre-PO listed', ${deptId}, 0, 0, 'submission')
      `));
    }
    console.log("✚ Pre-PO App Listing action_type added");
  }

  console.log("\n✅ Forecast migration complete.\n");
}

main().catch((err) => {
  console.error("\n❌ Migration failed:", err);
  process.exit(1);
});

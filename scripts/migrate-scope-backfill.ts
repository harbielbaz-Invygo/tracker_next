/**
 * Phase 1b — backfill the actual catalog state observed in prod.
 *
 * The earlier scope migration (scripts/migrate-scope-restructure.ts)
 * used the canonical seed names. Prod's catalog has diverged:
 *
 *   - Internal phase rows use custom names ("Cars specs", "Car Trim",
 *     "Dealer Extra Prices", "Color Split", "Car Photos", "Create SKU",
 *     "Uploade Cars", "Pricing")
 *   - VIN-chase rows live in `vin_chase_stages` (separate table from
 *     an old migration) instead of `action_types`
 *
 * This script:
 *   1. UPDATEs the 7 internal-phase action_types (the ones we have
 *      consensus on as PO-wide) to scope='po'. Pricing is already
 *      'po' from the first script — left untouched.
 *   2. For each row in `vin_chase_stages`, ensures an action_type
 *      with the same name exists at scope='wave'. If it exists, just
 *      sets the scope. If it doesn't, inserts a new row with name +
 *      waiting_label + done_label copied from the stage.
 *
 * Safe to re-run. Doesn't touch Delivery / Pre-PO App Listing (they
 * stay batch-scoped per the spec) or any admin-added custom action.
 *
 * Run:
 *     $env:DATABASE_URL = "libsql://...turso.io"
 *     $env:TURSO_AUTH_TOKEN = "eyJ..."
 *     npx tsx scripts/migrate-scope-backfill.ts
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

if (process.env.DATABASE_URL === "" || !process.env.DATABASE_URL) {
  console.error("\n❌ DATABASE_URL unset / masked. Set it manually:");
  console.error("    $env:DATABASE_URL = 'libsql://...turso.io'");
  console.error("    $env:TURSO_AUTH_TOKEN = 'eyJ...'");
  process.exit(1);
}

// Internal-phase action_types — promote to PO scope. Names match the
// prod catalog exactly (see the Drizzle Studio listing).
const PO_SCOPE_NAMES = [
  "Cars specs",
  "Car Trim",
  "Dealer Extra Prices",
  "Pricing",
  "Color Split",
  "Car Photos",
  "Create SKU",
  "Uploade Cars",
];

// Sort-order base for newly-inserted wave-scope rows. Placed above
// the existing internal-phase rows so the Action Center drawer lists
// VIN-chase below internal phase in sorted views.
const WAVE_SORT_ORDER_BASE = 100;

async function main() {
  const { db } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");

  const urlPreview = (process.env.DATABASE_URL ?? "").replace(/(authToken=).+/, "$1***");
  console.log(`\n→ Connected to ${urlPreview}`);

  // ── 1. Internal-phase rows → scope='po' ───────────────────
  let poUpdates = 0;
  for (const name of PO_SCOPE_NAMES) {
    const esc = name.replace(/'/g, "''");
    const before = await db.all<{ id: number; scope: string }>(
      sql.raw(`SELECT id, scope FROM action_types WHERE name = '${esc}'`),
    );
    if (before.length === 0) {
      console.log(`  – ${name}: not in DB, skipped`);
      continue;
    }
    if (before[0].scope === "po") {
      console.log(`✓ ${name}: already po`);
      continue;
    }
    await db.run(sql.raw(
      `UPDATE action_types SET scope = 'po' WHERE name = '${esc}'`,
    ));
    poUpdates++;
    console.log(`✚ ${name}: scope = po`);
  }
  console.log(`  → ${poUpdates} internal-phase rows updated to scope='po'`);

  // ── 2. VIN-chase rows in vin_chase_stages → action_types  ──
  //      with scope='wave'. Copy labels from the stage row.
  let waveExisting = 0;
  let waveCreated = 0;
  let stages: { id: number; name: string; waitingLabel: string; doneLabel: string; sortOrder: number }[] = [];
  try {
    stages = await db.all<{ id: number; name: string; waitingLabel: string; doneLabel: string; sortOrder: number }>(
      sql.raw("SELECT id, name, waiting_label AS waitingLabel, done_label AS doneLabel, sort_order AS sortOrder FROM vin_chase_stages ORDER BY sort_order"),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(msg)) {
      console.log("  – vin_chase_stages table missing — skipping wave-scope backfill");
    } else {
      throw err;
    }
  }
  for (const stage of stages) {
    const esc = stage.name.replace(/'/g, "''");
    const existing = await db.all<{ id: number; scope: string }>(
      sql.raw(`SELECT id, scope FROM action_types WHERE name = '${esc}'`),
    );
    if (existing.length > 0) {
      if (existing[0].scope === "wave") {
        console.log(`✓ ${stage.name}: action_type already wave`);
        continue;
      }
      await db.run(sql.raw(`UPDATE action_types SET scope = 'wave' WHERE name = '${esc}'`));
      waveExisting++;
      console.log(`✚ ${stage.name}: existing action_type → scope = wave`);
      continue;
    }
    // Insert new row.
    const escWait = stage.waitingLabel.replace(/'/g, "''");
    const escDone = stage.doneLabel.replace(/'/g, "''");
    // Anchor: first stage anchors on submission; subsequent ones on
    // vin (mirrors the old canonical seed).
    const anchor = stage.sortOrder <= 20 ? "submission" : "vin";
    await db.run(sql.raw(`
      INSERT INTO action_types
        (name, waiting_label, done_label, default_department_id,
         offset_days, offset_anchor, scope, sort_order)
      VALUES
        ('${esc}', '${escWait}', '${escDone}', NULL,
         ${stage.sortOrder / 10}, '${anchor}', 'wave',
         ${WAVE_SORT_ORDER_BASE + stage.sortOrder})
    `));
    waveCreated++;
    console.log(`✚ ${stage.name}: new action_type inserted (scope=wave)`);
  }
  console.log(`  → ${waveExisting} promoted, ${waveCreated} created`);

  // ── 3. Final state report ─────────────────────────────────
  const final = await db.all<{ name: string; scope: string }>(
    sql.raw("SELECT name, scope FROM action_types ORDER BY scope, sort_order"),
  );
  console.log("\nFinal action_types catalog (name → scope):");
  for (const row of final) {
    console.log(`  ${row.scope.padEnd(6)} ${row.name}`);
  }

  console.log("\n✅ Phase 1b backfill complete.");
  console.log("Next: phase 2 (Intake rewrite) — uses these scopes to attach actions at the right level.");
}

main().catch((err) => {
  console.error("\n❌ Backfill failed:", err);
  process.exit(1);
});

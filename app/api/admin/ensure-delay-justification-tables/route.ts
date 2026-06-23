/**
 * POST/GET /api/admin/ensure-delay-justification-tables
 *
 * Creates the two tables behind the "excused delay" workflow:
 *   • delay_reason_catalog        — admin-curated preset reasons ops can
 *                                   pick when explaining a late task.
 *   • action_delay_justifications — one row per submission against an
 *                                   action: the reason (preset and/or free
 *                                   text), status (pending/accepted/
 *                                   rejected), and who submitted / decided.
 *
 * On first creation the catalog is seeded with a sensible default set.
 * Purely additive + data-safe: new tables, no ALTER/drop, idempotent.
 *
 * GET  → status (tables exist? catalog/justification counts)
 * POST → create tables + indexes + seed default reasons
 *
 * Admin-only.
 */
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const CATALOG_SQL = `
  CREATE TABLE IF NOT EXISTS delay_reason_catalog (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT    NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    DEFAULT (CURRENT_TIMESTAMP)
  )
`;
const JUSTIFICATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS action_delay_justifications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    action_id     INTEGER NOT NULL,
    reason_id     INTEGER,
    reason_text   TEXT,
    status        TEXT    NOT NULL DEFAULT 'pending',
    submitted_by  TEXT,
    submitted_at  TEXT    DEFAULT (CURRENT_TIMESTAMP),
    reviewed_by   TEXT,
    reviewed_at   TEXT,
    decision_note TEXT
  )
`;
const INDEX_ACTION_SQL = `
  CREATE INDEX IF NOT EXISTS action_delay_just_action_idx
    ON action_delay_justifications (action_id)
`;
const INDEX_STATUS_SQL = `
  CREATE INDEX IF NOT EXISTS action_delay_just_status_idx
    ON action_delay_justifications (status)
`;

// Seeded only when the catalog table is first created (never overwrites
// admin edits on re-run).
const DEFAULT_REASONS = [
  "Tech issue",
  "System outage",
  "Sudden / force-majeure event",
  "Dealer-side delay",
  "Customs / logistics hold",
];

async function tableExists(name: string): Promise<boolean> {
  try {
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name=${name}`,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function count(table: string): Promise<number> {
  try {
    const n = await db.all<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM ${table}`));
    return Number(n[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

async function buildReport(write: boolean) {
  const catalogExisted = await tableExists("delay_reason_catalog");
  const justExisted = await tableExists("action_delay_justifications");
  let seeded = 0;

  if (write) {
    await db.run(sql.raw(CATALOG_SQL));
    await db.run(sql.raw(JUSTIFICATIONS_SQL));
    await db.run(sql.raw(INDEX_ACTION_SQL));
    await db.run(sql.raw(INDEX_STATUS_SQL));
    // Seed defaults only when the catalog was empty (fresh create).
    if (!catalogExisted || (await count("delay_reason_catalog")) === 0) {
      for (let i = 0; i < DEFAULT_REASONS.length; i++) {
        await db.run(sql`
          INSERT INTO delay_reason_catalog (label, active, sort_order)
          VALUES (${DEFAULT_REASONS[i]}, 1, ${i})
        `);
        seeded++;
      }
    }
  }

  return {
    catalogTableExisted: catalogExisted,
    justificationsTableExisted: justExisted,
    reasonsSeeded: seeded,
    reasonCount: await count("delay_reason_catalog"),
    justificationCount: await count("action_delay_justifications"),
    dryRun: !write,
  };
}

export async function GET() {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  return NextResponse.json({ ok: true, ...(await buildReport(false)) });
}

export async function POST(_req: NextRequest) {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  try {
    return NextResponse.json({ ok: true, ...(await buildReport(true)) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return apiError(`Ensure failed: ${msg}`, 500);
  }
}

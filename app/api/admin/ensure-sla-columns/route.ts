/**
 * POST /api/admin/ensure-sla-columns
 *
 * Defensive migration for the SLA countdown system (Phase 1 — foundation).
 * Adds the two clock columns if missing:
 *
 *   • action_types.sla_hours   INTEGER  (nullable) — the SLA budget for
 *     this action type, in whole hours. NULL = no SLA → the action is
 *     exempt from the countdown/overdue engine. Set per type in Settings.
 *
 *   • actions.sla_started_at   TEXT     (nullable, ISO-8601) — the moment
 *     this action's clock started. Stamped when the action becomes
 *     unblocked (no deps → at creation from the PO submission anchor;
 *     has deps → when the last parent is marked done/skipped). NULL until
 *     the clock starts (still blocked) or for exempt types.
 *
 * Both are read/written via raw SQL (NOT declared on the Drizzle schema)
 * so a deploy never 500s the Action Center before this migration runs —
 * `select().from(actions)` in the cascade would otherwise request a
 * column that doesn't exist yet on prod.
 *
 * Backfill (POST only): stamps sla_started_at = created_at for every
 * currently-`waiting` action that has no clock yet, so in-flight work
 * gets a sensible anchor instead of staying NULL forever. `blocked`
 * rows are intentionally left NULL — their clock only starts on unblock.
 * Harmless until durations are configured (NULL sla_hours = exempt).
 *
 * GET  → status check (columns exist? how many waiting rows still NULL?)
 * POST → ALTER TABLE for whichever column is missing + backfill + counts
 *
 * Idempotent. Admin-only.
 */
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const ALTER_SLA_HOURS = `
  ALTER TABLE action_types ADD COLUMN sla_hours INTEGER
`;
const ALTER_SLA_STARTED_AT = `
  ALTER TABLE actions ADD COLUMN sla_started_at TEXT
`;
const BACKFILL_SQL = `
  UPDATE actions
     SET sla_started_at = created_at
   WHERE status = 'waiting'
     AND sla_started_at IS NULL
     AND created_at IS NOT NULL
`;

interface Report {
  slaHoursExisted:      boolean;
  slaHoursCreated:      boolean;
  slaStartedAtExisted:  boolean;
  slaStartedAtCreated:  boolean;
  backfilledRows:       number;
  waitingMissingClock:  number;
  dryRun:               boolean;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  try {
    const rows = await db.all<{ name: string }>(
      sql.raw(`SELECT name FROM pragma_table_info('${table}') WHERE name='${column}'`),
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function buildReport(write: boolean): Promise<Report> {
  const hoursExisted = await columnExists("action_types", "sla_hours");
  const startedExisted = await columnExists("actions", "sla_started_at");

  let hoursCreated = false;
  let startedCreated = false;
  if (write) {
    if (!hoursExisted) {
      await db.run(sql.raw(ALTER_SLA_HOURS));
      hoursCreated = true;
    }
    if (!startedExisted) {
      await db.run(sql.raw(ALTER_SLA_STARTED_AT));
      startedCreated = true;
    }
  }

  const startedOk = startedExisted || startedCreated;
  let backfilled = 0;
  let stillMissing = 0;
  if (startedOk) {
    if (write) {
      const res = await db.run(sql.raw(BACKFILL_SQL));
      // libSQL exposes affected rows as rowsAffected.
      backfilled = Number((res as { rowsAffected?: number }).rowsAffected ?? 0);
    }
    const miss = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM actions WHERE status = 'waiting' AND sla_started_at IS NULL`,
    );
    stillMissing = Number(miss[0]?.n ?? 0);
  }

  return {
    slaHoursExisted:     hoursExisted,
    slaHoursCreated:     hoursCreated,
    slaStartedAtExisted: startedExisted,
    slaStartedAtCreated: startedCreated,
    backfilledRows:      backfilled,
    waitingMissingClock: stillMissing,
    dryRun:              !write,
  };
}

export async function GET() {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  const report = await buildReport(false);
  return NextResponse.json({ ok: true, ...report });
}

export async function POST(_req: NextRequest) {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;
  try {
    const report = await buildReport(true);
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return apiError(`Ensure failed: ${msg}`, 500);
  }
}

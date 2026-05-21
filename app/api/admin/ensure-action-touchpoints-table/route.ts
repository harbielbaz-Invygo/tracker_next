/**
 * POST /api/admin/ensure-action-touchpoints-table
 *
 * Creates `action_touchpoints` if it's missing. Surfaces the
 * follow-up log that drives the test page at /action-center-flow.
 *
 * Admin-only. GET reports state.
 */
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS action_touchpoints (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    action_id         INTEGER NOT NULL,
    channel           TEXT NOT NULL DEFAULT 'email',
    direction         TEXT NOT NULL DEFAULT 'outbound',
    outcome           TEXT NOT NULL DEFAULT 'no_response',
    note              TEXT,
    contacted_at      TEXT DEFAULT CURRENT_TIMESTAMP,
    next_followup_at  TEXT,
    logged_by         TEXT,
    escalated         INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT DEFAULT CURRENT_TIMESTAMP
  )
`;
const CREATE_ACTION_IDX_SQL = `
  CREATE INDEX IF NOT EXISTS action_touchpoints_action_idx
  ON action_touchpoints(action_id)
`;
const CREATE_FOLLOWUP_IDX_SQL = `
  CREATE INDEX IF NOT EXISTS action_touchpoints_followup_idx
  ON action_touchpoints(next_followup_at)
`;

async function tableExists(): Promise<boolean> {
  try {
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='action_touchpoints'`,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function buildReport(write: boolean) {
  const existed = await tableExists();
  let created = false;
  if (!existed && write) {
    await db.run(sql.raw(CREATE_TABLE_SQL));
    await db.run(sql.raw(CREATE_ACTION_IDX_SQL));
    await db.run(sql.raw(CREATE_FOLLOWUP_IDX_SQL));
    created = true;
  }
  const exists = existed || created;
  let rowCount = 0;
  if (exists) {
    const rows = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM action_touchpoints`);
    rowCount = Number(rows[0]?.n ?? 0);
  }
  return {
    tableExisted: existed,
    tableCreated: created,
    rowCount,
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

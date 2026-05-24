/**
 * POST /api/admin/ensure-forecast-stakeholder-column
 *
 * Defensive migration: adds the `submitted_by_stakeholder_id` column
 * to `batch_forecasts` if it's missing. The column is a nullable FK
 * to `stakeholders.id` and stores which Partnership stakeholder the
 * Forecast is attributed to (separate from `submitted_by_user_id`
 * which holds the auth account that clicked submit).
 *
 * Pattern matches the other ensure-* endpoints: GET → dry-run,
 * POST → ALTER TABLE if missing + counts. Admin-only.
 */
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

// libsql / SQLite can't add a FK constraint via ALTER TABLE, so the
// column is plain integer here. Referential integrity is enforced at
// write-time in /api/forecast/create + at read-time when we join.
const ALTER_SQL = `
  ALTER TABLE batch_forecasts ADD COLUMN submitted_by_stakeholder_id INTEGER
`;

interface Report {
  columnExisted: boolean;
  columnCreated: boolean;
  forecastsWithStakeholder: number;
  totalForecasts:           number;
  dryRun:                   boolean;
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
  const existed = await columnExists("batch_forecasts", "submitted_by_stakeholder_id");
  let created = false;
  if (!existed && write) {
    await db.run(sql.raw(ALTER_SQL));
    created = true;
  }

  const ok = existed || created;
  let withStakeholder = 0;
  let total = 0;
  if (ok) {
    const tot = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM batch_forecasts`);
    total = Number(tot[0]?.n ?? 0);
    const ws = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM batch_forecasts WHERE submitted_by_stakeholder_id IS NOT NULL`,
    );
    withStakeholder = Number(ws[0]?.n ?? 0);
  }

  return {
    columnExisted:           existed,
    columnCreated:           created,
    forecastsWithStakeholder: withStakeholder,
    totalForecasts:          total,
    dryRun:                  !write,
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

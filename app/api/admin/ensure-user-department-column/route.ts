/**
 * POST /api/admin/ensure-user-department-column
 *
 * Adds the `department_id` column to the `users` table if missing.
 * Drives feature gating like "only Partnership users can submit a
 * Forecast" — without the column the dropdown can't filter and the
 * page falls back to showing everyone.
 *
 * Admin-only. GET reports the current state without writing.
 */
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const ALTER_SQL = `
  ALTER TABLE users ADD COLUMN department_id INTEGER
`;

interface Report {
  columnExisted: boolean;
  columnCreated: boolean;
  totalUsers:    number;
  usersWithDept: number;
  dryRun:        boolean;
}

async function columnExists(): Promise<boolean> {
  try {
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM pragma_table_info('users') WHERE name='department_id'`,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function buildReport(write: boolean): Promise<Report> {
  const existed = await columnExists();
  let created = false;
  if (!existed && write) {
    await db.run(sql.raw(ALTER_SQL));
    created = true;
  }
  const exists = existed || created;
  let total = 0;
  let withDept = 0;
  if (exists) {
    const tot = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM users`);
    total = Number(tot[0]?.n ?? 0);
    const wd = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM users WHERE department_id IS NOT NULL`,
    );
    withDept = Number(wd[0]?.n ?? 0);
  }
  return {
    columnExisted: existed,
    columnCreated: created,
    totalUsers:    total,
    usersWithDept: withDept,
    dryRun:        !write,
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

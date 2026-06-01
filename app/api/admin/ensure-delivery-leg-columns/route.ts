/**
 * POST /api/admin/ensure-delivery-leg-columns
 *
 * Defensive migration for the Forecast pre-PO listing flow (PR #259).
 * Adds the four `batch_delivery_legs` columns that the Forecast tab,
 * the Action Center pre-PO booking drawer, and the Forecast Reliability
 * tab all depend on:
 *
 *   car_model                 TEXT     — model committed per city × row
 *   listed_at                 TEXT     — ISO date the row went live in-app
 *   promised_availability_date TEXT    — per-row availability promise
 *   bookings_count            INTEGER  — running pre-PO booking counter (≥0)
 *
 * Unlike the other `ensure-*` routes, these columns ARE declared on the
 * Drizzle schema (see `batchDeliveryLegs`). That makes the migration
 * *mandatory* rather than best-effort: Drizzle selects every declared
 * column, so on a DB still missing them EVERY `db.select().from(
 * batchDeliveryLegs)` query 500s — not just the new write paths. Run
 * this once per environment if `drizzle-kit push` didn't land them
 * (the repo's long-standing push warning routinely skips additions).
 *
 * Idempotent — each column is checked before it's added. GET is a
 * dry-run that reports which columns are present without writing.
 *
 * Admin-only.
 *
 * Run from an admin session in browser devtools:
 *   await fetch("/api/admin/ensure-delivery-leg-columns", { method: "POST" }).then(r => r.json())
 */
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const TABLE = "batch_delivery_legs";

/**
 * One ALTER per column — SQLite only adds a single column per statement.
 * `bookings_count` is NOT NULL, which SQLite permits on ADD COLUMN only
 * because we supply a DEFAULT (existing rows backfill to 0).
 */
const COLUMNS: { name: string; ddl: string }[] = [
  { name: "car_model",                  ddl: `ALTER TABLE ${TABLE} ADD COLUMN car_model TEXT` },
  { name: "listed_at",                  ddl: `ALTER TABLE ${TABLE} ADD COLUMN listed_at TEXT` },
  { name: "promised_availability_date", ddl: `ALTER TABLE ${TABLE} ADD COLUMN promised_availability_date TEXT` },
  { name: "bookings_count",             ddl: `ALTER TABLE ${TABLE} ADD COLUMN bookings_count INTEGER NOT NULL DEFAULT 0` },
];

type ColumnStatus = { column: string; status: "added" | "exists" | "missing" };

interface Report {
  columns: ColumnStatus[];
  totalLegs: number;
  dryRun: boolean;
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
  const columns: ColumnStatus[] = [];
  for (const col of COLUMNS) {
    const existed = await columnExists(TABLE, col.name);
    if (existed) {
      columns.push({ column: col.name, status: "exists" });
      continue;
    }
    if (write) {
      await db.run(sql.raw(col.ddl));
      columns.push({ column: col.name, status: "added" });
    } else {
      // Dry-run: flag as missing (would be added) without touching the DB.
      columns.push({ column: col.name, status: "missing" });
    }
  }

  let totalLegs = 0;
  try {
    const tot = await db.all<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM ${TABLE}`));
    totalLegs = Number(tot[0]?.n ?? 0);
  } catch {
    // Table itself missing — leave at 0; the forecast scaffolding
    // migration (run-forecast-migration) owns table creation.
  }

  return { columns, totalLegs, dryRun: !write };
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

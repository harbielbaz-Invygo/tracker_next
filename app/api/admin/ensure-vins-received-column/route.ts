/**
 * POST /api/admin/ensure-vins-received-column
 *
 * Defensive migration: adds the `vins_received_quantity` column to the
 * `batches` table if it's missing, then reports how many rows have a
 * non-zero value (i.e. dealer has actually shared VINs for that batch).
 *
 * Background: ops captures VIN reception per batch — the dealer sometimes
 * only ships N out of M VINs in the first round. That partial count caps
 * how many cars can be Mark-as-delivered later.
 *
 * GET  → status check (column exists? row counts)
 * POST → ALTER TABLE if missing + counts
 *
 * Admin-only.
 */
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

const ALTER_BATCHES_SQL = `
  ALTER TABLE batches ADD COLUMN vins_received_quantity INTEGER NOT NULL DEFAULT 0
`;
const ALTER_LEGS_SQL = `
  ALTER TABLE batch_delivery_legs ADD COLUMN vins_received_quantity INTEGER NOT NULL DEFAULT 0
`;

interface Report {
  batchesColumnExisted: boolean;
  batchesColumnCreated: boolean;
  legsColumnExisted:    boolean;
  legsColumnCreated:    boolean;
  legsTableExists:      boolean;
  batchesWithVins:      number;
  totalBatches:         number;
  legsWithVins:         number;
  totalLegs:            number;
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

async function tableExists(table: string): Promise<boolean> {
  try {
    const rows = await db.all<{ name: string }>(
      sql.raw(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`),
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function buildReport(write: boolean): Promise<Report> {
  const batchesExisted = await columnExists("batches", "vins_received_quantity");
  let batchesCreated = false;
  if (!batchesExisted && write) {
    await db.run(sql.raw(ALTER_BATCHES_SQL));
    batchesCreated = true;
  }

  const hasLegsTable = await tableExists("batch_delivery_legs");
  const legsExisted = hasLegsTable
    ? await columnExists("batch_delivery_legs", "vins_received_quantity")
    : false;
  let legsCreated = false;
  if (hasLegsTable && !legsExisted && write) {
    await db.run(sql.raw(ALTER_LEGS_SQL));
    legsCreated = true;
  }

  const batchesOk = batchesExisted || batchesCreated;
  const legsOk    = hasLegsTable && (legsExisted || legsCreated);
  let withVins = 0;
  let total = 0;
  let legsWithVins = 0;
  let totalLegs = 0;
  if (batchesOk) {
    const tot = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM batches`);
    total = Number(tot[0]?.n ?? 0);
    const wv = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM batches WHERE vins_received_quantity > 0`,
    );
    withVins = Number(wv[0]?.n ?? 0);
  }
  if (legsOk) {
    const tot = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM batch_delivery_legs`);
    totalLegs = Number(tot[0]?.n ?? 0);
    const wv = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM batch_delivery_legs WHERE vins_received_quantity > 0`,
    );
    legsWithVins = Number(wv[0]?.n ?? 0);
  }

  return {
    batchesColumnExisted: batchesExisted,
    batchesColumnCreated: batchesCreated,
    legsColumnExisted:    legsExisted,
    legsColumnCreated:    legsCreated,
    legsTableExists:      hasLegsTable,
    batchesWithVins:      withVins,
    totalBatches:         total,
    legsWithVins,
    totalLegs,
    dryRun:               !write,
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

/**
 * GET /api/admin/export-all — download the entire database as a
 * multi-sheet Excel workbook (one worksheet per table).
 *
 * Dependency-free: emits SpreadsheetML 2003 (`.xls` XML) which Excel,
 * Google Sheets and LibreOffice all open. Every table is exported
 * dynamically (schema + the off-schema baseline/redistribution tables),
 * so it stays complete as the schema grows.
 *
 * Admin-only. Secrets (password hashes) are never exported.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAuth, apiError } from "@/lib/api-auth";

export const runtime = "nodejs";

/** Columns we never export, whatever table they appear on. */
const REDACT = new Set(["password_hash", "passwordhash"]);

function escXml(v: unknown): string {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // strip control chars XML 1.0 can't carry
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function cellXml(v: unknown): string {
  if (v === null || v === undefined) return "<Cell></Cell>";
  if (typeof v === "number" && Number.isFinite(v)) {
    return `<Cell><Data ss:Type="Number">${v}</Data></Cell>`;
  }
  return `<Cell><Data ss:Type="String">${escXml(v)}</Data></Cell>`;
}

/** Excel worksheet names: ≤31 chars, none of : \ / ? * [ ], unique. */
function uniqueSheetName(raw: string, used: Set<string>): string {
  let base = raw.replace(/[:\\/?*[\]]/g, "_").slice(0, 31) || "Sheet";
  let name = base;
  let i = 1;
  while (used.has(name.toLowerCase())) {
    const suffix = `_${i++}`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

export async function GET() {
  const gate = await requireAuth(["admin"]);
  if (!gate.ok) return gate.response;

  try {
    const tables = await db.all<{ name: string }>(sql`
      SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '\\_\\_%' ESCAPE '\\'
         AND name NOT LIKE '_litestream%'
       ORDER BY name
    `);

    const usedNames = new Set<string>();
    const worksheets: string[] = [];

    for (const t of tables) {
      const table = String(t.name);
      const safeTable = table.replace(/"/g, '""');

      const colRows = await db.all<{ name: string }>(
        sql.raw(`SELECT name FROM pragma_table_info('${table.replace(/'/g, "''")}')`),
      );
      const cols = colRows.map((c) => c.name).filter((c) => !REDACT.has(c.toLowerCase()));
      if (cols.length === 0) continue;

      const colList = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
      const rows = await db.all<Record<string, unknown>>(
        sql.raw(`SELECT ${colList} FROM "${safeTable}"`),
      );

      const header = `<Row>${cols
        .map((c) => `<Cell><Data ss:Type="String">${escXml(c)}</Data></Cell>`)
        .join("")}</Row>`;
      const body = rows
        .map((r) => `<Row>${cols.map((c) => cellXml(r[c])).join("")}</Row>`)
        .join("");

      worksheets.push(
        `<Worksheet ss:Name="${escXml(uniqueSheetName(table, usedNames))}">`
        + `<Table>${header}${body}</Table></Worksheet>`,
      );
    }

    const xml =
      `<?xml version="1.0"?>\n`
      + `<?mso-application progid="Excel.Sheet"?>\n`
      + `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" `
      + `xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n`
      + worksheets.join("\n")
      + `\n</Workbook>`;

    const date = new Date().toISOString().slice(0, 10);
    return new Response(xml, {
      headers: {
        "Content-Type": "application/vnd.ms-excel; charset=utf-8",
        "Content-Disposition": `attachment; filename="vehicles-tracker-export-${date}.xls"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return apiError(`Export failed: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}

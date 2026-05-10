/**
 * Single source of truth for editable, system-wide rules.
 *
 * Backed by the `settings` key/value table. Values are stored as text
 * (JSON-stringified for non-strings). Use the typed helpers below — direct
 * DB access is fine but defeats the centralised default-fallback story.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";

/** Catalogue of every rule key the system understands. */
export const RULE_KEYS = {
  PRE_PO_OPS_LEAD_TIME_DAYS: "pre_po_ops_lead_time_days",
} as const;

/** Defaults if the row is missing — fallback only, the seed inserts these. */
const DEFAULTS = {
  [RULE_KEYS.PRE_PO_OPS_LEAD_TIME_DAYS]: 21,
} as Record<string, number | string | boolean>;

// ──────────────────────────────────────────────────────────────────
// Generic getters / setters
// ──────────────────────────────────────────────────────────────────

export async function getRuleNumber(key: string): Promise<number> {
  const raw = await getRuleRaw(key);
  if (raw == null) return Number(DEFAULTS[key] ?? 0);
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number(DEFAULTS[key] ?? 0);
}

export async function setRuleNumber(key: string, value: number): Promise<void> {
  await setRuleRaw(key, String(value));
}

async function getRuleRaw(key: string): Promise<string | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return row?.value ?? null;
}

async function setRuleRaw(key: string, value: string): Promise<void> {
  // Atomic UPSERT — avoids the read-then-write race two concurrent saves
  // would otherwise hit. Works on SQLite and Postgres via Drizzle.
  await db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value },
    });
}

// ──────────────────────────────────────────────────────────────────
// Typed convenience helpers
// ──────────────────────────────────────────────────────────────────

export async function getLeadTimeDays(): Promise<number> {
  return getRuleNumber(RULE_KEYS.PRE_PO_OPS_LEAD_TIME_DAYS);
}

export async function setLeadTimeDays(days: number): Promise<void> {
  await setRuleNumber(RULE_KEYS.PRE_PO_OPS_LEAD_TIME_DAYS, days);
}

/** Bulk-read used by the Settings page so it gets every rule in one call. */
export async function getAllRules(): Promise<{
  prePoOpsLeadTimeDays: number;
}> {
  const [leadTime] = await Promise.all([getLeadTimeDays()]);
  return { prePoOpsLeadTimeDays: leadTime };
}

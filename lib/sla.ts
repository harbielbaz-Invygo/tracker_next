/**
 * SLA clock helpers (Phase 1b of the SLA countdown rebuild).
 *
 * These stamp / clear `actions.sla_started_at` — the moment an action's
 * SLA countdown begins. The anchor rule (locked with ops):
 *
 *   • Root action (no dependencies) → clock starts when it's created at
 *     intake (the PO-submission moment). New actions never back-date to
 *     instant-overdue, so we anchor to creation time, not a (possibly
 *     backdated) submitted-at date.
 *   • Dependent action → clock starts when it becomes `waiting`, i.e.
 *     when its last blocking parent is marked done/skipped (the unblock
 *     cascade). Re-opening an action restarts its clock.
 *   • Reverting an action back to `blocked` stops the clock (cleared to
 *     NULL) so the next unblock re-stamps a fresh start.
 *   • `done` / `skipped` keep their start so Phase 4 can compute whether
 *     the work landed inside its SLA.
 *
 * ── Why everything here is best-effort + tolerant ──
 * `sla_started_at` is added by /api/admin/ensure-sla-columns and is NOT
 * declared on the Drizzle schema (lib/scope-cascade.ts does
 * `select().from(actions)`, which would request an un-migrated column and
 * 500 every status change). So we read/write it via raw SQL and swallow
 * errors: before the migration runs the column doesn't exist and these
 * calls simply no-op (the action is treated as exempt — NULL clock).
 * SLA stamping must NEVER break a status change or an intake.
 *
 * All helpers run OUTSIDE the caller's transaction on purpose — a failed
 * statement inside a libSQL tx aborts the whole tx, which would roll back
 * the status flip we just committed. Running after commit keeps the core
 * mutation safe even if the SLA write fails.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

function cleanIds(ids: number[]): number[] {
  return Array.from(new Set(ids.filter((n) => Number.isInteger(n) && n > 0)));
}

/**
 * Start (or restart) the SLA clock for the given action rows — used when
 * rows transition INTO `waiting` (manual reopen, unblock cascade).
 */
export async function stampSlaStart(ids: number[], startedAt: string): Promise<void> {
  const clean = cleanIds(ids);
  if (clean.length === 0) return;
  try {
    const idList = sql.join(clean.map((n) => sql`${n}`), sql`, `);
    await db.run(sql`UPDATE actions SET sla_started_at = ${startedAt} WHERE id IN (${idList})`);
  } catch {
    /* sla_started_at not migrated yet — treat as exempt, no-op. */
  }
}

/**
 * Stop the SLA clock for the given action rows — used when rows revert to
 * `blocked` (the clock only runs while an action is actually actionable).
 */
export async function clearSlaStart(ids: number[]): Promise<void> {
  const clean = cleanIds(ids);
  if (clean.length === 0) return;
  try {
    const idList = sql.join(clean.map((n) => sql`${n}`), sql`, `);
    await db.run(sql`UPDATE actions SET sla_started_at = NULL WHERE id IN (${idList})`);
  } catch {
    /* not migrated — no-op. */
  }
}

/**
 * Start the clock for freshly-created `waiting` actions on the given
 * scopes (intake). Only touches rows that are still `waiting` with no
 * clock yet, so it's idempotent and won't disturb an action that already
 * has a running clock. Dependent rows are created `blocked` and are left
 * alone — they'll get stamped when the unblock cascade promotes them.
 */
export async function stampSlaStartForScopes(
  targets: Array<{ scope: "po" | "wave" | "batch"; scopeId: number }>,
  startedAt: string,
): Promise<void> {
  if (targets.length === 0) return;
  try {
    for (const t of targets) {
      if (!Number.isInteger(t.scopeId) || t.scopeId <= 0) continue;
      await db.run(sql`
        UPDATE actions
           SET sla_started_at = ${startedAt}
         WHERE scope = ${t.scope}
           AND scope_id = ${t.scopeId}
           AND status = 'waiting'
           AND sla_started_at IS NULL
      `);
    }
  } catch {
    /* not migrated — no-op. */
  }
}

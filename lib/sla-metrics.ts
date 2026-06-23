/**
 * SLA performance metrics (Phase 4a of the SLA countdown rebuild).
 *
 * Computes the headline SLA numbers for the Insights "SLA health" panel:
 *   • currentlyOverdue / Critical — waiting actions past their deadline
 *   • avg / max overdue hours       — how late the breaches are right now
 *   • compliancePct                 — of completed actions that HAD an SLA,
 *                                     what fraction landed within budget
 *   • byType                        — which action types breach the most
 *
 * This is a NOW snapshot (not period-scoped): "currently overdue" is
 * inherently about the present moment. The page is force-dynamic, so it
 * recomputes on every load.
 *
 * Both SLA columns live off the Drizzle schema (raw-SQL pattern), so we
 * read them via raw SQL and return an empty/unavailable result if the
 * ensure-sla-columns migration hasn't run yet — the panel then renders a
 * "not enabled" hint instead of bogus zeros.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getExcusedActionIds } from "@/lib/delay-justifications";

export interface SlaMetrics {
  /** False when the SLA columns aren't migrated yet — UI shows a hint. */
  available:        boolean;
  /** Actions with a budget + running/closed clock (waiting or done). */
  trackedActions:   number;
  /** Waiting actions currently past their deadline ("total delayed"). */
  currentlyOverdue: number;
  /** Subset of the above overdue by ≥ one full budget. */
  currentlyCritical:number;
  /** Mean overdue hours across currently-overdue actions. */
  avgOverdueHours:  number | null;
  /** Worst single overdue, in hours. */
  maxOverdueHours:  number | null;
  /** Completed actions that had an SLA budget. */
  doneTotal:        number;
  /** Of those, how many landed within budget. */
  doneOnTime:       number;
  /** doneOnTime / doneTotal, as a whole percent. Null when doneTotal=0. */
  compliancePct:    number | null;
  /** Per action-type breach breakdown, worst first (overdue>0 only). */
  byType:           { name: string; overdue: number; tracked: number }[];
}

const EMPTY: SlaMetrics = {
  available: false, trackedActions: 0, currentlyOverdue: 0, currentlyCritical: 0,
  avgOverdueHours: null, maxOverdueHours: null, doneTotal: 0, doneOnTime: 0,
  compliancePct: null, byType: [],
};

function round1(n: number): number { return Math.round(n * 10) / 10; }

export async function getSlaMetrics(now: number = Date.now()): Promise<SlaMetrics> {
  let rows: {
    id: number; status: string; completed_at: string | null;
    sla_started_at: string | null; sla_hours: number | null; type_name: string;
  }[];
  try {
    rows = await db.all(sql`
      SELECT a.id             AS id,
             a.status         AS status,
             a.completed_at    AS completed_at,
             a.sla_started_at  AS sla_started_at,
             t.sla_hours       AS sla_hours,
             t.name            AS type_name
        FROM actions a
        JOIN action_types t ON t.id = a.action_type_id
       WHERE t.sla_hours      IS NOT NULL
         AND a.sla_started_at IS NOT NULL
         AND a.status IN ('waiting', 'done')
         -- External SLA is tracked on the authoritative batch-scope rows;
         -- the wave-scope "bulk" set is a roll-up that drifts out of sync,
         -- so exclude it to avoid double-counting / stale breaches.
         AND a.scope != 'wave'
    `);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such (column|table)/i.test(msg)) return EMPTY;
    throw err;
  }

  // Actions whose lateness an admin excused — not counted as a breach.
  const excused = await getExcusedActionIds();

  const byType = new Map<string, { name: string; overdue: number; tracked: number }>();
  let trackedActions = 0, currentlyOverdue = 0, currentlyCritical = 0;
  let doneTotal = 0, doneOnTime = 0;
  let overdueSumMs = 0, overdueCount = 0, maxOverdueMs = 0;

  for (const r of rows) {
    const hours = Number(r.sla_hours);
    const start = new Date(String(r.sla_started_at)).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(hours) || hours <= 0) continue;
    const budgetMs = hours * 3_600_000;
    const deadline = start + budgetMs;

    const isExcused = excused.has(Number(r.id));

    trackedActions++;
    const bt = byType.get(r.type_name) ?? { name: r.type_name, overdue: 0, tracked: 0 };
    bt.tracked++;

    if (r.status === "waiting") {
      const overdueMs = now - deadline;
      // An accepted justification excuses the breach — don't count it as
      // overdue/critical (it would otherwise inflate the live SLA panel).
      if (overdueMs > 0 && !isExcused) {
        currentlyOverdue++;
        bt.overdue++;
        overdueSumMs += overdueMs;
        overdueCount++;
        if (overdueMs > maxOverdueMs) maxOverdueMs = overdueMs;
        if (overdueMs >= budgetMs) currentlyCritical++;
      }
    } else { // done
      doneTotal++;
      const completed = r.completed_at ? new Date(r.completed_at).getTime() : null;
      // Within budget when completed at/before the deadline. A missing
      // completion timestamp can't be judged late, so it counts on-time
      // rather than penalising incomplete legacy data. An excused breach
      // also counts on-time.
      if (isExcused || completed == null || completed <= deadline) doneOnTime++;
    }
    byType.set(r.type_name, bt);
  }

  return {
    available:        true,
    trackedActions,
    currentlyOverdue,
    currentlyCritical,
    avgOverdueHours:  overdueCount > 0 ? round1(overdueSumMs / overdueCount / 3_600_000) : null,
    maxOverdueHours:  overdueCount > 0 ? round1(maxOverdueMs / 3_600_000) : null,
    doneTotal,
    doneOnTime,
    compliancePct:    doneTotal > 0 ? Math.round((doneOnTime / doneTotal) * 100) : null,
    byType: Array.from(byType.values())
      .filter((b) => b.overdue > 0)
      .sort((a, b) => b.overdue - a.overdue),
  };
}

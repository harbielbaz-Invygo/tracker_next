/**
 * Alert Engine — evaluates all open batches against admin-configured alert rules.
 *
 * - Creates new alerts (fingerprint-deduped) when conditions are met.
 * - Auto-resolves existing alerts when their condition clears.
 * - Returns active (unresolved) alerts grouped by batchId.
 *
 * Called from the Action Center page server component on every load so the
 * alert state in the DB is always fresh before the table renders.
 *
 * Three trigger types:
 *   no_vin_before_avail         — VIN action not done, ≤ N days to availability date
 *   action_overdue              — a waiting/blocked action is past its expectedDate
 *   action_pending_before_avail — a specific actionTypeId not done, ≤ N days to avail date
 */
import { eq, and, isNull, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batches, batchActions, actionTypes, alertRules, alerts,
} from "@/lib/db/schema";

// ──────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────

export interface ActiveAlert {
  id: number;
  fingerprint: string;
  /**
   * The batch_action this alert points at, or null for batch-level alerts
   * that aren't tied to a specific action (none today, but reserved for
   * future trigger types). Derived from the fingerprint's `-action-{id}`
   * suffix so no DB-column migration is needed.
   */
  actionId: number | null;
  severity: "critical" | "high" | "medium" | "info";
  alertType: string;
  message: string;
  raisedAt: string;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
}

/** Parse the `-action-{id}` suffix from a fingerprint, if any. */
function actionIdFromFingerprint(fp: string): number | null {
  const m = fp.match(/-action-(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** Map<batchId, ActiveAlert[]> */
export type AlertsByBatch = Map<number, ActiveAlert[]>;

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysUntil(dateStr: string): number {
  return Math.round(
    (new Date(dateStr).getTime() - new Date(todayIso()).getTime()) / DAY_MS,
  );
}

function daysOverdue(expectedDate: string): number {
  return Math.round(
    (new Date(todayIso()).getTime() - new Date(expectedDate).getTime()) / DAY_MS,
  );
}

function fp(ruleId: number, batchId: number, suffix?: string): string {
  return suffix
    ? `rule-${ruleId}-batch-${batchId}-${suffix}`
    : `rule-${ruleId}-batch-${batchId}`;
}

// ──────────────────────────────────────────────────────────────────
// Main engine
// ──────────────────────────────────────────────────────────────────

/**
 * Detect "no such table" errors from libSQL / SQLite. We use a string
 * match because the libSQL client wraps the error in a generic `LibsqlError`
 * with a `code` of `SQLITE_UNKNOWN` — the most reliable signal is the message.
 */
function isMissingTableError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table/i.test(msg);
}

export async function runAlertEngine(): Promise<AlertsByBatch> {
  // 1. Load active rules — bail early if none configured.
  // Defensive: if the `alert_rules` table hasn't been migrated yet (e.g. a
  // production DB that pre-dates the alert engine), don't crash the page —
  // log and return no alerts. Run `npm run db:push` to enable the engine.
  let rules: (typeof alertRules.$inferSelect)[] = [];
  try {
    rules = await db
      .select()
      .from(alertRules)
      .where(eq(alertRules.isActive, true));
  } catch (err) {
    if (isMissingTableError(err)) {
      // eslint-disable-next-line no-console
      console.warn("[alert-engine] alert_rules table missing — skipping. Run `npm run db:push` to enable.");
      return new Map();
    }
    throw err;
  }

  if (rules.length === 0) return new Map();

  // 2. Load all open (non-closed) batches.
  const openBatches = await db
    .select()
    .from(batches)
    .where(isNull(batches.closedAt));

  if (openBatches.length === 0) return new Map();

  const batchIds = openBatches.map((b) => b.id);

  // 3. Load all batch actions for open batches (one round-trip).
  const allActions = await db
    .select({
      ba:     batchActions,
      atName: actionTypes.name,
    })
    .from(batchActions)
    .innerJoin(actionTypes, eq(batchActions.actionTypeId, actionTypes.id))
    .where(inArray(batchActions.batchId, batchIds));

  // Group by batchId for O(1) lookup.
  const actionsByBatch = new Map<number, typeof allActions>();
  for (const a of allActions) {
    const arr = actionsByBatch.get(a.ba.batchId) ?? [];
    arr.push(a);
    actionsByBatch.set(a.ba.batchId, arr);
  }

  // 4. Load existing active (unresolved) alerts for open batches.
  const existingAlerts = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.resolved, false),
        inArray(alerts.batchId, batchIds),
      ),
    );

  // Index by fingerprint for dedup.
  const activeByFp = new Map<string, (typeof existingAlerts)[number]>();
  for (const a of existingAlerts) {
    activeByFp.set(a.fingerprint, a);
  }

  // 5. Evaluate every rule × batch.
  const todayStr = todayIso();
  const now      = new Date().toISOString();

  const toCreate: {
    batchId: number;
    fingerprint: string;
    severity: "critical" | "high" | "medium" | "info";
    alertType: string;
    message: string;
  }[] = [];

  const conditionMet = new Set<string>(); // fingerprints that are currently triggered

  for (const batch of openBatches) {
    const acts = actionsByBatch.get(batch.id) ?? [];
    const availDate = batch.dealerPromisedDeliveryDate; // "Planned" availability date

    for (const rule of rules) {
      // ── A. VIN (or specific action) not done before availability date ──────
      if (
        rule.triggerType === "no_vin_before_avail" ||
        rule.triggerType === "action_pending_before_avail"
      ) {
        // Resolve the target action for this rule.
        let targetAction: (typeof allActions)[number] | undefined;

        if (rule.triggerType === "no_vin_before_avail") {
          // Find the first action whose name contains "VIN" (case-insensitive).
          targetAction = acts.find((a) =>
            a.atName.toUpperCase().includes("VIN"),
          );
        } else if (rule.actionTypeId != null) {
          targetAction = acts.find(
            (a) => a.ba.actionTypeId === rule.actionTypeId,
          );
        }

        if (!targetAction || !availDate) continue;

        // Fingerprint now includes the action id so the drawer can match
        // alerts to specific action rows. Old fingerprints (rule-X-batch-Y
        // without the suffix) auto-resolve on the next engine run.
        const fingerprint = fp(rule.id, batch.id, `action-${targetAction.ba.id}`);
        const isNotDone   = targetAction.ba.status !== "done" && targetAction.ba.status !== "skipped";
        const daysLeft    = daysUntil(availDate);

        if (isNotDone && daysLeft <= rule.thresholdDays) {
          conditionMet.add(fingerprint);
          if (!activeByFp.has(fingerprint)) {
            const direction = daysLeft < 0 ? `${Math.abs(daysLeft)}d past` : `${daysLeft}d until`;
            toCreate.push({
              batchId:     batch.id,
              fingerprint,
              severity:    rule.severity as ActiveAlert["severity"],
              alertType:   rule.triggerType,
              message:     `"${targetAction.atName}" not completed — ${direction} availability date (${availDate})`,
            });
          }
        }
      }

      // ── B. Any waiting action is overdue ──────────────────────────────────
      // Skip BLOCKED actions — their delay belongs to the parent they're
      // waiting on, not them. Alerting on a blocked child would blame the
      // wrong owner; the upstream waiting parent will fire its own alert.
      if (rule.triggerType === "action_overdue") {
        for (const { ba, atName } of acts) {
          if (ba.status !== "waiting") continue;
          if (!ba.expectedDate || ba.expectedDate >= todayStr) continue;

          const fingerprint = fp(rule.id, batch.id, `action-${ba.id}`);
          const late = daysOverdue(ba.expectedDate);

          conditionMet.add(fingerprint);
          if (!activeByFp.has(fingerprint)) {
            toCreate.push({
              batchId:     batch.id,
              fingerprint,
              severity:    rule.severity as ActiveAlert["severity"],
              alertType:   "action_overdue",
              message:     `"${atName}" is ${late} day${late !== 1 ? "s" : ""} overdue (expected ${ba.expectedDate})`,
            });
          }
        }
      }
    }
  }

  // 6. Auto-resolve alerts whose condition is no longer met.
  const toResolveIds: number[] = [];
  for (const [fingerprint, alert] of activeByFp) {
    if (!conditionMet.has(fingerprint)) {
      toResolveIds.push(alert.id);
    }
  }

  // 7. Write to DB — creates + resolves in parallel.
  await Promise.all([
    toCreate.length > 0
      ? db.insert(alerts).values(
          toCreate.map((a) => ({
            batchId:     a.batchId,
            fingerprint: a.fingerprint,
            severity:    a.severity,
            alertType:   a.alertType,
            message:     a.message,
            audience:    "ops",
            raisedAt:    now,
            resolved:    false,
            acknowledged: false,
          })),
        )
      : Promise.resolve(),
    ...toResolveIds.map((id) =>
      db
        .update(alerts)
        .set({ resolved: true, resolvedAt: now })
        .where(eq(alerts.id, id)),
    ),
  ]);

  // 8. Re-fetch final active state after mutations.
  const finalAlerts = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.resolved, false),
        inArray(alerts.batchId, batchIds),
      ),
    );

  // 9. Group by batchId and return.
  const result: AlertsByBatch = new Map();
  for (const a of finalAlerts) {
    if (a.batchId == null) continue;
    const arr = result.get(a.batchId) ?? [];
    arr.push({
      id:             a.id,
      fingerprint:    a.fingerprint,
      actionId:       actionIdFromFingerprint(a.fingerprint),
      severity:       a.severity as ActiveAlert["severity"],
      alertType:      a.alertType,
      message:        a.message,
      raisedAt:       a.raisedAt ?? now,
      acknowledged:   a.acknowledged ?? false,
      acknowledgedBy: a.acknowledgedBy ?? null,
      acknowledgedAt: a.acknowledgedAt ?? null,
    });
    result.set(a.batchId, arr);
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────
// Severity ordering helper (for "highest severity" badge)
// ──────────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<ActiveAlert["severity"], number> = {
  critical: 4,
  high:     3,
  medium:   2,
  info:     1,
};

export function highestSeverity(
  alertList: ActiveAlert[],
): ActiveAlert["severity"] | null {
  if (alertList.length === 0) return null;
  return alertList.reduce((best, a) =>
    SEVERITY_ORDER[a.severity] > SEVERITY_ORDER[best.severity] ? a : best,
  ).severity;
}

/** Fetch active alerts for a single batch (used by drawer API). */
export async function getAlertsForBatch(batchId: number): Promise<ActiveAlert[]> {
  const rows = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.batchId, batchId),
        eq(alerts.resolved, false),
      ),
    );

  return rows.map((a) => ({
    id:             a.id,
    fingerprint:    a.fingerprint,
    actionId:       actionIdFromFingerprint(a.fingerprint),
    severity:       a.severity as ActiveAlert["severity"],
    alertType:      a.alertType,
    message:        a.message,
    raisedAt:       a.raisedAt ?? new Date().toISOString(),
    acknowledged:   a.acknowledged ?? false,
    acknowledgedBy: a.acknowledgedBy ?? null,
    acknowledgedAt: a.acknowledgedAt ?? null,
  }));
}

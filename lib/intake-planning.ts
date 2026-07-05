/**
 * Pure planning helpers extracted from POST /api/intake/create.
 *
 * These contain NO database, transaction, error-handling, or HTTP-payload
 * logic — only the deterministic transforms the intake handler runs before
 * (and while building) its transaction. Keeping them here makes the handler
 * readable and lets us characterization-test the tricky bits (grouping,
 * dependency flags, the submission-date anchor) without a database.
 *
 * Behaviour is a 1:1 move of the original inline code — do not "improve" it
 * here without a matching characterization test.
 */

export interface IntakeSplit {
  quantity: number;
  city: string;
  /** ISO yyyy-mm-dd — dealer-promised availability date. */
  date: string;
  /** ISO yyyy-mm-dd — Ops's own expected delivery date. */
  opsExpectedDate: string;
}

export interface IntakeItem {
  model: string;
  year: number;
  buyBackRate?: number | null;
  contractLength?: string | null;
  contractLengthMonths?: number | null;
  colorsRaw?: string | null;
  unitPriceSar?: number | null;
  taxPct?: number | null;
  splits: IntakeSplit[];
}

/** One batch = one (model, year, availability-date, commercial-terms) key;
 *  multiple cities on the same key become sibling legs. */
export interface IntakeBatchGroup {
  item: IntakeItem;
  availabilityDate: string;
  legs: { city: string; quantity: number; opsExpectedDate: string }[];
}

export interface ActionDependencyRow {
  actionTypeId: number;
  dependsOnActionTypeId: number;
}

/**
 * Resolve the submission anchor date. Today for a new PO, or a validated
 * historical date when ops backfills an old PO. Bad format or a future date
 * silently falls back to `today` (never throws — matches the original IIFE).
 */
export function resolveRequestedAt(submittedAt: string | null | undefined, today: string): string {
  const raw = submittedAt?.trim() || "";
  if (!raw) return today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return today;
  if (raw > today) return today;
  return raw;
}

/**
 * "at_risk" when any split's Ops-expected date lands after the dealer's
 * promised date; otherwise "feasible". A soft flag — no hard block.
 */
export function computeFeasibility(items: IntakeItem[]): "feasible" | "at_risk" {
  const opsBehindPromise = items.some((it) =>
    it.splits.some((s) => (s.opsExpectedDate || s.date) > s.date),
  );
  return opsBehindPromise ? "at_risk" : "feasible";
}

/**
 * The action_type ids that start `blocked` at intake: those with at least
 * one parent dependency whose parent is ALSO being picked at this intake.
 * A dep whose parent isn't picked is dormant → the child starts `waiting`.
 */
export function buildParentDepSet(
  pickedActionTypeIds: number[],
  deps: ActionDependencyRow[],
): Set<number> {
  const picked = new Set(pickedActionTypeIds);
  const hasParent = new Set<number>();
  for (const d of deps) {
    if (picked.has(d.dependsOnActionTypeId)) hasParent.add(d.actionTypeId);
  }
  return hasParent;
}

/**
 * Group items × splits into batches. Key per design Q3:
 *   (model, year, availability-date, unitPrice, taxPct, buyBack, contractMonths).
 * po_number is implicit (one PO per submit). Same key + different city →
 * sibling legs under one batch; a commercial-term mismatch splits them.
 */
export function groupItemsIntoBatches(items: IntakeItem[]): IntakeBatchGroup[] {
  const byKey = new Map<string, IntakeBatchGroup>();
  for (const item of items) {
    for (const split of item.splits) {
      const key = JSON.stringify({
        m:  item.model,
        y:  item.year,
        d:  split.date,
        up: item.unitPriceSar ?? null,
        tx: item.taxPct ?? null,
        bb: item.buyBackRate ?? null,
        cl: item.contractLengthMonths ?? null,
      });
      const leg = { city: split.city, quantity: split.quantity, opsExpectedDate: split.opsExpectedDate };
      const existing = byKey.get(key);
      if (existing) {
        existing.legs.push(leg);
        continue;
      }
      byKey.set(key, { item, availabilityDate: split.date, legs: [leg] });
    }
  }
  return Array.from(byKey.values());
}

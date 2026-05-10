/**
 * Pure helper for computing a batch_action's `expectedDate` from its
 * action-type offset, the anchor it's measured from, and the batch's
 * known dates.
 *
 * No DB access — safe to import from anywhere (server or client).
 *
 * Anchor semantics:
 *   "submission" → submission date + offsetDays
 *   "vin"        → vinReceivingDate + offsetDays   (post-VIN dealer/ops work)
 *   "promised"   → dealerPromisedDeliveryDate     (offsetDays ignored)
 *
 * If a required input for the chosen anchor is missing (e.g. anchor="vin"
 * but `vin` is null), returns null — the batch_action's expectedDate
 * stays unset until the required input lands.
 */
export interface ExpectedDateArgs {
  anchor:     "submission" | "vin" | "promised";
  offsetDays: number;
  submission: string;                 // ISO yyyy-mm-dd
  vin:        string | null;          // ISO yyyy-mm-dd
  promised:   string;                 // ISO yyyy-mm-dd
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeExpectedDate(args: ExpectedDateArgs): string | null {
  switch (args.anchor) {
    case "submission":
      return addDays(args.submission, args.offsetDays);
    case "vin":
      return args.vin ? addDays(args.vin, args.offsetDays) : null;
    case "promised":
      return args.promised;
  }
}

/** Add `days` calendar days to an ISO date. Always returns ISO yyyy-mm-dd. */
export function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00Z");          // anchor at noon UTC to dodge tz roll
  return new Date(d.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole-day signed difference: a - b. Positive = a is later. */
export function daysBetween(a: string, b: string): number {
  const t = (s: string) => new Date(s + "T12:00:00Z").getTime();
  return Math.round((t(a) - t(b)) / DAY_MS);
}

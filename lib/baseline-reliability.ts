/**
 * Baseline reliability scoring (frozen baseline + working allocation).
 *
 * Pure — NO database / server imports — so both the server data layer and
 * client components can use it.
 *
 * Scores actual deliveries against the FROZEN baseline (the original
 * promise), not the current/working windows. Greedy schedule-adherence:
 * the earliest deliveries fill the earliest promised slots; a car counts
 * "on time" only if it was delivered by the date of the baseline slot it
 * fills. Because the baseline never moves, redistributing cars to later
 * windows correctly shows up as a lower on-time rate.
 *
 * Worked example — baseline 10/20/30 on 1st/10th/20th (cum 10/30/60);
 * actual delivered-by 5 / 25 / 60:
 *   • 1st  : available 5  → 5 on-time of 10
 *   • 10th : available 25−10 = 15 → 15 on-time of 20
 *   • 20th : available 60−30 = 30 → 30 on-time of 30
 *   ⇒ 50 / 60 = 83% on-time.
 */

export interface BaselineWindowInput {
  windowDate: string; // yyyy-mm-dd
  quantity: number;
}

export interface DeliveryInput {
  date: string; // yyyy-mm-dd the cars were delivered (batch closedAt)
  quantity: number;
}

export interface BaselineReliability {
  promisedTotal:  number;
  deliveredTotal: number;
  /** Cars delivered by the date of the baseline slot they fill. */
  onTime:         number;
  /** onTime / promisedTotal as a whole percent; null when nothing promised. */
  onTimeRate:     number | null;
  /** Cars promised by now (passed baseline dates) but not yet delivered. */
  shortfallToDate: number;
  perWindow: {
    windowDate:      string;
    promised:        number;
    deliveredByDate: number; // cumulative cars delivered on/before this date
    onTime:          number; // of this window's promised cars, how many on time
  }[];
}

export function computeBaselineReliability(
  baseline: BaselineWindowInput[],
  deliveries: DeliveryInput[],
  today?: string,
): BaselineReliability {
  const windows = baseline
    .filter((w) => w.windowDate && Number.isFinite(w.quantity) && w.quantity > 0)
    .slice()
    .sort((a, b) => a.windowDate.localeCompare(b.windowDate));
  const deliv = deliveries
    .filter((d) => d.date && Number.isFinite(d.quantity) && d.quantity > 0)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  const promisedTotal = windows.reduce((s, w) => s + w.quantity, 0);
  const deliveredTotal = deliv.reduce((s, d) => s + d.quantity, 0);
  const deliveredBy = (date: string) =>
    deliv.reduce((s, d) => (d.date <= date ? s + d.quantity : s), 0);

  let consumed = 0;
  let onTime = 0;
  let shortfallToDate = 0;
  const perWindow = windows.map((w) => {
    const cumDelivered = deliveredBy(w.windowDate);
    const availableForThis = cumDelivered - consumed;
    const ot = Math.max(0, Math.min(availableForThis, w.quantity));
    onTime += ot;
    consumed += w.quantity;
    // Shortfall only counts windows whose date has passed.
    if (!today || w.windowDate <= today) {
      shortfallToDate += Math.max(0, w.quantity - Math.max(0, availableForThis));
    }
    return {
      windowDate: w.windowDate,
      promised: w.quantity,
      deliveredByDate: cumDelivered,
      onTime: ot,
    };
  });

  return {
    promisedTotal,
    deliveredTotal,
    onTime,
    onTimeRate: promisedTotal > 0 ? Math.round((onTime / promisedTotal) * 100) : null,
    shortfallToDate,
    perWindow,
  };
}

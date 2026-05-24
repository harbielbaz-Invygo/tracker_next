/**
 * Plan vs Reality — Gantt chart, pure SVG, server-renderable.
 *
 * Layout (text representation):
 *
 *                     Apr 8      Apr 15      Apr 22      May 1
 *   Submit → PO       ▒▒▒▒▒▒▒
 *                     █████████████  +5d
 *
 *   PO → Ready                ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
 *                                  █████████  (ongoing)
 *
 *   Delivery                                      ▒  (point)
 *                                                          █  +Nd
 *
 *   ─────────────────────────────────────────────────────────
 *   Apr 8   Apr 15   Apr 22   May 1
 *
 * Each lifecycle phase = one row. Plan bar (ghost / striped) sits
 * above the Reality bar (solid, colored by delay). On-time = green,
 * delayed = flame, ahead = blue. A dotted "today" line marks the
 * present moment when relevant.
 *
 * Same TimelineData input as the previous two-track timeline, so no
 * data-layer change is required.
 */
import { Brand } from "@/lib/brand";
import type { TimelineData } from "@/lib/dashboard-data";

// ── helpers ──────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function asDate(iso: string): Date {
  return new Date(iso + "T12:00:00Z");
}
function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / DAY_MS);
}
function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function fmtAxis(d: Date): string {
  return `${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// ── phase model ──────────────────────────────────────────────────

interface Span {
  start: Date;
  end:   Date;
  /** When true, the right end is "now" rather than a known completion
   *  (renders as an open chevron + dashed cap). */
  ongoing?: boolean;
  /** Optional small label shown at the right end of the bar. */
  badge?: string | null;
}

interface Phase {
  label:     string;
  plan:      Span | null;
  reality:   Span | null;
  /**
   * Signed delay in days (positive = late). Drives the reality bar
   * colour: > 0 → flame, < 0 → blue, 0 → green. Null = unknown
   * (treated as green/neutral).
   */
  delayDays: number | null;
}

/**
 * Map TimelineData → Gantt rows. Each phase only renders when at
 * least one of its plan / reality spans is computable. Skipping a
 * phase is normal: pre-PO bets have no expectedPo, batches without
 * an actual PO date can't fill phase 2, etc.
 */
function computePhases(data: TimelineData): Phase[] {
  const today = asDate(todayIso());
  const phases: Phase[] = [];

  // Phase 1 — Submit → PO. Only meaningful when we tracked an
  // expected PO date OR captured an actual PO. Without either, the
  // pre-PO phase collapses into Phase 2 below.
  const hasPrePoPlan    = !!data.planExpectedPo;
  const hasPrePoReality = !!data.realityActualPo;
  if (hasPrePoPlan || hasPrePoReality) {
    phases.push({
      label: "Submit → PO",
      plan: hasPrePoPlan ? {
        start: asDate(data.planRequested),
        end:   asDate(data.planExpectedPo!),
      } : null,
      reality: hasPrePoReality ? {
        start: asDate(data.realityRequested),
        end:   asDate(data.realityActualPo!),
      } : {
        // Plan exists but reality doesn't → still chasing the PO.
        start:   asDate(data.realityRequested),
        end:     today,
        ongoing: true,
      },
      delayDays: data.poDelayDays ?? null,
    });
  }

  // Phase 2 — PO → Ready. Always rendered (every batch has a
  // promised date). When there's no expectedPo, the Plan bar spans
  // requested → promised (full plan duration).
  const planStart  = data.planExpectedPo ? asDate(data.planExpectedPo) : asDate(data.planRequested);
  const realStart  = data.realityActualPo ? asDate(data.realityActualPo) : asDate(data.realityRequested);
  // Reality "end" for phase 2 = the latest non-Delivery completed
  // action, or — when nothing's been done yet — today.
  const lastActionDate = (data.realityActions ?? [])
    .map((a) => asDate(a.date))
    .reduce<Date | null>((acc, d) => acc == null || d > acc ? d : acc, null);
  const phase2RealityEnd = lastActionDate ?? today;
  const phase2Ongoing    = lastActionDate == null
    || (data.realityDelivery == null);
  phases.push({
    label: "PO → Ready",
    plan: {
      start: planStart,
      end:   asDate(data.planPromised),
    },
    reality: {
      start:   realStart,
      end:     phase2RealityEnd,
      ongoing: phase2Ongoing,
    },
    delayDays: null, // no top-level metric for this phase
  });

  // Phase 3 — Delivery. Plan is a single point (the promised date).
  // Reality is the closure / projection. Always rendered so the
  // chart always shows the final outcome (or its absence).
  const deliveryEnd = data.realityDelivery ? asDate(data.realityDelivery) : null;
  phases.push({
    label: "Delivery",
    plan: {
      start: asDate(data.planPromised),
      end:   asDate(data.planPromised),
    },
    reality: deliveryEnd ? {
      start: deliveryEnd,
      end:   deliveryEnd,
      badge: data.realityDeliveryLabel ?? null,
    } : {
      start:   today,
      end:     today,
      ongoing: true,
      badge:   "Projected",
    },
    delayDays: data.deliveryDelayDays ?? null,
  });

  return phases;
}

// ── colour ───────────────────────────────────────────────────────

function realityColor(delayDays: number | null): string {
  if (delayDays == null) return Brand.GREEN;
  if (delayDays > 0)     return Brand.ORANGE;
  if (delayDays < 0)     return Brand.BLUE;
  return Brand.GREEN;
}

function realityFill(delayDays: number | null): string {
  if (delayDays == null) return Brand.GREEN_PALE;
  if (delayDays > 0)     return Brand.ORANGE_PALE;
  if (delayDays < 0)     return Brand.BLUE_PALE;
  return Brand.GREEN_PALE;
}

// ── component ────────────────────────────────────────────────────

interface Props {
  data: TimelineData;
}

export default function TimelineSvg({ data }: Props) {
  const phases = computePhases(data);

  // Date scale — covers every plan + reality span plus today, so an
  // ongoing reality bar always has somewhere to extend to.
  const today = asDate(todayIso());
  const allDates: Date[] = [today];
  for (const p of phases) {
    if (p.plan)    { allDates.push(p.plan.start,    p.plan.end); }
    if (p.reality) { allDates.push(p.reality.start, p.reality.end); }
  }
  const minD = new Date(Math.min(...allDates.map((d) => d.getTime())));
  const maxD = new Date(Math.max(...allDates.map((d) => d.getTime())));
  const spanDays = Math.max(daysBetween(maxD, minD), 1);
  const pad = Math.max(Math.floor(spanDays * 0.06), 1);
  const chartMin = addDays(minD, -pad);
  const chartMax = addDays(maxD, pad);
  const chartSpan = daysBetween(chartMax, chartMin);

  // Layout
  const W      = 1100;
  const M_L    = 150;   // label column on the left
  const M_R    = 60;
  const PLOT_W = W - M_L - M_R;

  const ROW_H        = 56;  // total per phase
  const PLAN_BAR_H   = 14;
  const REAL_BAR_H   = 18;
  const BAR_GAP      = 4;
  const HEADER_H     = 24;  // legend strip
  const AXIS_H       = 36;

  const x = (d: Date) =>
    M_L + (daysBetween(d, chartMin) / chartSpan) * PLOT_W;

  const H = HEADER_H + phases.length * ROW_H + AXIS_H;

  // Y of each row
  const rowTop = (i: number) => HEADER_H + i * ROW_H + 8;

  // Date axis ticks
  const nTicks = Math.min(7, Math.max(3, Math.floor(spanDays / 7) + 2));
  const axisTicks: { x: number; label: string }[] = [];
  for (let i = 0; i < nTicks; i++) {
    const d = addDays(chartMin, Math.round((i * chartSpan) / (nTicks - 1)));
    axisTicks.push({ x: x(d), label: fmtAxis(d) });
  }
  const axisY = HEADER_H + phases.length * ROW_H + 16;

  // Render a Plan or Reality bar inside a row. Plan = striped/ghost,
  // Reality = solid colour. Point-spans (start == end) render as a
  // narrow diamond so they're still visible.
  function Bar({
    span, y, h, fill, stroke, striped, label,
  }: {
    span: Span;
    y: number;
    h: number;
    fill:   string;
    stroke: string;
    striped?: boolean;
    label?:  string | null;
  }) {
    const x1 = x(span.start);
    const x2 = x(span.end);
    const width = Math.max(2, x2 - x1);
    const isPoint = Math.abs(x2 - x1) < 2;
    const dur = daysBetween(span.end, span.start);

    if (isPoint) {
      // Diamond marker for point spans (e.g. Delivery promised date).
      const cx = x1, cy = y + h / 2;
      return (
        <g>
          <polygon
            points={`${cx},${cy - 6} ${cx + 6},${cy} ${cx},${cy + 6} ${cx - 6},${cy}`}
            fill={fill}
            stroke={stroke}
            strokeWidth={1.5}
          >
            <title>{`${span.start.toISOString().slice(0, 10)}`}</title>
          </polygon>
          {label && (
            <text
              x={cx + 10} y={cy + 4}
              fontSize={11} fontWeight={600} fill={stroke}
            >{label}</text>
          )}
        </g>
      );
    }

    return (
      <g>
        <rect
          x={x1} y={y}
          width={width} height={h}
          rx={4}
          fill={fill}
          stroke={stroke}
          strokeWidth={1.5}
          strokeDasharray={span.ongoing ? "4 3" : undefined}
        >
          <title>
            {`${span.start.toISOString().slice(0, 10)} → ${span.end.toISOString().slice(0, 10)} · ${dur}d`}
          </title>
        </rect>
        {striped && (
          // Diagonal stripe overlay to differentiate Plan from Reality
          // without colour. Pattern is inline so the whole SVG remains
          // self-contained / server-renderable.
          <rect
            x={x1} y={y}
            width={width} height={h}
            rx={4}
            fill="url(#planStripes)"
            pointerEvents="none"
          />
        )}
        {span.ongoing && (
          // Chevron at the right end to signal "still in progress".
          <polygon
            points={`${x2},${y} ${x2 + 8},${y + h / 2} ${x2},${y + h}`}
            fill={stroke}
            opacity={0.65}
          />
        )}
        {label && (
          <text
            x={x2 + (span.ongoing ? 14 : 6)}
            y={y + h / 2 + 4}
            fontSize={11}
            fontWeight={600}
            fill={stroke}
          >{label}</text>
        )}
      </g>
    );
  }

  const todayX = x(today);
  const todayInChart = today >= chartMin && today <= chartMax;

  return (
    <div className="overflow-x-auto" role="img" aria-label={`Plan vs Reality Gantt for ${data.batchCode}`}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ fontFamily: "Alexandria, sans-serif", display: "block" }}
      >
        {/* Pattern defs — diagonal stripes for the Plan bars. */}
        <defs>
          <pattern
            id="planStripes"
            patternUnits="userSpaceOnUse"
            width={6} height={6}
            patternTransform="rotate(45)"
          >
            <line x1={0} y1={0} x2={0} y2={6} stroke={Brand.MIDNIGHT} strokeWidth={1.2} opacity={0.35} />
          </pattern>
        </defs>

        {/* Header legend */}
        <g transform={`translate(${M_L}, 4)`}>
          <rect x={0} y={4} width={14} height={10} rx={2}
                fill={Brand.MIDNIGHT_PALE ?? "#E5E8EE"}
                stroke={Brand.MIDNIGHT} strokeWidth={1} />
          <rect x={0} y={4} width={14} height={10} rx={2}
                fill="url(#planStripes)" pointerEvents="none" />
          <text x={20} y={13} fontSize={11} fill={Brand.GREY_600}>Plan</text>
          <rect x={64} y={4} width={14} height={10} rx={2}
                fill={Brand.GREEN_PALE} stroke={Brand.GREEN} strokeWidth={1} />
          <text x={84} y={13} fontSize={11} fill={Brand.GREY_600}>Reality (on time)</text>
          <rect x={196} y={4} width={14} height={10} rx={2}
                fill={Brand.ORANGE_PALE} stroke={Brand.ORANGE} strokeWidth={1} />
          <text x={216} y={13} fontSize={11} fill={Brand.GREY_600}>Delayed</text>
          <rect x={272} y={4} width={14} height={10} rx={2}
                fill={Brand.BLUE_PALE} stroke={Brand.BLUE} strokeWidth={1} />
          <text x={292} y={13} fontSize={11} fill={Brand.GREY_600}>Ahead</text>
        </g>

        {/* Today vertical guide */}
        {todayInChart && (
          <g>
            <line
              x1={todayX} x2={todayX}
              y1={HEADER_H} y2={axisY}
              stroke={Brand.ORANGE}
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.8}
            />
            <text
              x={todayX} y={HEADER_H - 4}
              textAnchor="middle"
              fontSize={10}
              fontWeight={600}
              fill={Brand.ORANGE_DARK}
            >today</text>
          </g>
        )}

        {/* Rows */}
        {phases.map((p, i) => {
          const top = rowTop(i);
          const planY    = top;
          const realityY = top + PLAN_BAR_H + BAR_GAP;
          const stroke   = realityColor(p.delayDays);
          const fill     = realityFill(p.delayDays);
          const delayBadge = p.reality && p.delayDays != null && p.delayDays !== 0
            ? (p.delayDays > 0 ? `+${p.delayDays}d` : `${p.delayDays}d`)
            : (p.reality?.badge ?? null);

          return (
            <g key={i}>
              {/* Row label */}
              <text
                x={M_L - 14} y={top + (PLAN_BAR_H + BAR_GAP + REAL_BAR_H) / 2 + 4}
                textAnchor="end"
                fontSize={13}
                fontWeight={700}
                fill={Brand.MIDNIGHT}
              >{p.label}</text>

              {/* Faint row separator under each row */}
              <line
                x1={M_L} x2={W - M_R}
                y1={top + PLAN_BAR_H + BAR_GAP + REAL_BAR_H + 10}
                y2={top + PLAN_BAR_H + BAR_GAP + REAL_BAR_H + 10}
                stroke={Brand.GREY_300}
                strokeWidth={1}
                opacity={0.4}
              />

              {/* Plan bar */}
              {p.plan && (
                <Bar
                  span={p.plan}
                  y={planY}
                  h={PLAN_BAR_H}
                  fill={Brand.MIDNIGHT_PALE ?? "#E5E8EE"}
                  stroke={Brand.MIDNIGHT}
                  striped
                />
              )}

              {/* Reality bar */}
              {p.reality && (
                <Bar
                  span={p.reality}
                  y={realityY}
                  h={REAL_BAR_H}
                  fill={fill}
                  stroke={stroke}
                  label={delayBadge}
                />
              )}
            </g>
          );
        })}

        {/* Date axis */}
        <line
          x1={M_L} x2={W - M_R}
          y1={axisY} y2={axisY}
          stroke={Brand.GREY_300}
          strokeWidth={1}
        />
        {axisTicks.map((t, i) => (
          <g key={`a-${i}`}>
            <line
              x1={t.x} x2={t.x} y1={axisY} y2={axisY + 4}
              stroke={Brand.GREY_400}
            />
            <text
              x={t.x} y={axisY + 18}
              textAnchor="middle"
              fontSize={10}
              fill={Brand.GREY_500}
            >{t.label}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

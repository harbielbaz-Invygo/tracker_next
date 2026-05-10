/**
 * Plan vs Reality timeline — pure SVG, server-renderable.
 *
 * Ported almost line-for-line from
 *   tracker_v1/dashboard.py:_build_plan_vs_reality_timeline
 *
 * Layout (text representation):
 *   Reality  ━━┷━━━━━━┷━━━━━━━━━━━━━━━━━━━━┷━━
 *   Plan     ━━┷━━━━━━┷━━━━━━━━━━━━┷
 *                          └── PO delay +5d ──┘
 *                                    └─ Delivery delay +Nd ─┘
 *
 * Time flows left → right. Reality runs above, Plan below.
 * Reality colour follows the worst delay: ahead → blue, on track → green,
 * delayed → flame.
 */
import { Brand } from "@/lib/brand";
import type { TimelineData } from "@/lib/dashboard-data";

// ── helpers ──────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function asDate(iso: string): Date {
  // Anchor at UTC noon to dodge timezone roll-back when displaying.
  return new Date(iso + "T12:00:00Z");
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / DAY_MS);
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtAxis(d: Date): string {
  return `${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * Estimate how wide a label needs (mirrors the Python heuristic
 * `len(s) * 6.5 + 14`). It only has to be roughly right — used purely
 * to decide which labels need to climb to a higher row.
 */
function labelWidth(s: string): number {
  return s.length * 6.5 + 14;
}

/**
 * For each tick, return the row offset that avoids overlap with earlier
 * ticks. 0 means "default row," 1 means "one row up/down," etc.
 */
function staggerOffsets(xs: number[], labels: string[]): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    let chosen = 0;
    for (let step = 0; step < 4; step++) {
      let collides = false;
      for (let j = 0; j < i; j++) {
        if (offsets[j] !== step) continue;
        const gap = xs[i] - xs[j];
        const needed = (labelWidth(labels[j]) + labelWidth(labels[i])) / 2;
        if (gap < needed) { collides = true; break; }
      }
      if (!collides) { chosen = step; break; }
    }
    offsets.push(chosen);
  }
  return offsets;
}

// ── component ────────────────────────────────────────────────────

interface Props {
  data: TimelineData;
}

export default function TimelineSvg({ data }: Props) {
  // ─── Plan track ──────────────────────────────────────────────
  const plan: { date: Date; label: string }[] = [
    { date: asDate(data.planRequested), label: "Submitted" },
  ];
  if (data.planExpectedPo) {
    plan.push({ date: asDate(data.planExpectedPo), label: "PO Expected" });
  }
  plan.push({ date: asDate(data.planPromised), label: "Promised Availability Date" });

  // ─── Reality track ───────────────────────────────────────────
  // Each Reality tick can carry a `delayDays` value that's appended to
  // the label as a "+Nd" / "−Nd" chip when nonzero.
  const reality: { date: Date; label: string; delayDays?: number; tone?: "delay" | "ahead" }[] = [];

  // Optional PO Issued tick — only rendered when there's a pre-tracking
  // gap (we uploaded the PO after the dealer issued it).
  if (data.poIssuedDate && data.preTrackingGapDays > 0) {
    reality.push({
      date: asDate(data.poIssuedDate),
      label: `PO Issued (gap +${data.preTrackingGapDays}d)`,
      delayDays: data.preTrackingGapDays,
      tone: "delay",
    });
  }
  reality.push({ date: asDate(data.realityRequested), label: "Submitted" });
  if (data.realityActualPo && data.realityActualPo !== data.poIssuedDate) {
    reality.push({ date: asDate(data.realityActualPo), label: "PO Received" });
  }
  // Every completed action becomes a Reality tick (excluding "Delivery").
  // Delay chip ("+Nd" or "−Nd") appended when the action's actual completion
  // missed (or beat) its expectedDate.
  for (const a of data.realityActions ?? []) {
    const label = a.delayDays === 0
      ? a.label
      : `${a.label} ${a.delayDays > 0 ? `+${a.delayDays}d` : `${a.delayDays}d`}`;
    reality.push({
      date: asDate(a.date),
      label,
      delayDays: a.delayDays,
      tone: a.delayDays > 0 ? "delay" : a.delayDays < 0 ? "ahead" : undefined,
    });
  }
  if (data.realityDelivery && data.realityDeliveryLabel) {
    // For "Projected" labels, append the shift relative to the promised
    // availability so the operator sees the auto-shift (e.g. VIN delay
    // pushed projected forward).
    let label: string = data.realityDeliveryLabel;
    if (data.realityDeliveryLabel === "Projected" && (data.deliveryDelayDays ?? 0) !== 0) {
      const d = data.deliveryDelayDays!;
      label = `Projected ${d > 0 ? `+${d}d` : `${d}d`}`;
    }
    reality.push({ date: asDate(data.realityDelivery), label });
  }
  // Sort chronologically so the stagger algorithm sees them in left-to-right
  // order — required for the collision-avoidance heuristic below.
  reality.sort((a, b) => a.date.getTime() - b.date.getTime());

  // ─── Reality colour from worst delay ─────────────────────────
  const worst = Math.max(data.poDelayDays ?? 0, data.deliveryDelayDays ?? 0);
  const realityColor =
    worst > 0 ? Brand.ORANGE : worst < 0 ? Brand.BLUE : Brand.GREEN;

  // ─── Date scaling ────────────────────────────────────────────
  const allDates = [...plan, ...reality].map((p) => p.date);
  const minD = new Date(Math.min(...allDates.map((d) => d.getTime())));
  const maxD = new Date(Math.max(...allDates.map((d) => d.getTime())));
  const spanDays = Math.max(daysBetween(maxD, minD), 1);
  const pad = Math.max(Math.floor(spanDays * 0.06), 1);
  const chartMin = addDays(minD, -pad);
  const chartMax = addDays(maxD, pad);
  const chartSpan = daysBetween(chartMax, chartMin);

  // ─── Layout dimensions ───────────────────────────────────────
  const W = 1100;
  const M_L = 90;
  const M_R = 50;
  const Y_REALITY = 75;
  const Y_PLAN = 165;
  const PLOT_W = W - M_L - M_R;

  const x = (d: Date) =>
    M_L + (daysBetween(d, chartMin) / chartSpan) * PLOT_W;

  // ─── Stagger offsets ─────────────────────────────────────────
  const rx = reality.map((p) => x(p.date));
  const px = plan.map((p) => x(p.date));
  const realityOffsets = staggerOffsets(rx, reality.map((p) => p.label));
  const planOffsets    = staggerOffsets(px, plan.map((p) => p.label));
  const LABEL_ROW_GAP = 14;
  const maxPlanOff    = Math.max(0, ...planOffsets);
  const TICK = 9;

  const nBrackets =
    ((data.poDelayDays ?? 0) > 0 ? 1 : 0) +
    ((data.deliveryDelayDays ?? 0) > 0 ? 1 : 0);

  const bracketStartY =
    Y_PLAN + TICK + 14 + maxPlanOff * LABEL_ROW_GAP + 24;
  const BRACKET_DROP = 26;
  const BRACKET_PILL_H = 28;
  const BRACKET_GAP = BRACKET_DROP + BRACKET_PILL_H + 16; // 70

  let H: number;
  if (nBrackets > 0) {
    const lastBracketBottom =
      bracketStartY + (nBrackets - 1) * BRACKET_GAP + BRACKET_DROP + BRACKET_PILL_H;
    H = lastBracketBottom + 36; // axis space
  } else {
    H = Y_PLAN + TICK + 14 + maxPlanOff * LABEL_ROW_GAP + 12 + 36;
  }

  // ─── Bracket renderer ────────────────────────────────────────
  function Bracket({ x1, x2, text, yTop }: { x1: number; x2: number; text: string; yTop: number }) {
    const midpoint = (x1 + x2) / 2;
    const yH = yTop + BRACKET_DROP;
    return (
      <g>
        <path
          d={`M ${x1} ${yTop} L ${x1} ${yH} L ${x2} ${yH} L ${x2} ${yTop}`}
          stroke={Brand.ORANGE}
          strokeWidth={2}
          fill="none"
          strokeLinejoin="round"
        />
        <rect
          x={midpoint - 70}
          y={yH + 4}
          width={140}
          height={22}
          rx={11}
          fill={Brand.ORANGE_PALE}
        />
        <text
          x={midpoint}
          y={yH + 19}
          textAnchor="middle"
          fontSize={12}
          fontWeight={600}
          fill={Brand.ORANGE_DARK}
        >
          {text}
        </text>
      </g>
    );
  }

  // Bracket positioning
  let curBracketY = bracketStartY;
  const brackets: { x1: number; x2: number; text: string; yTop: number }[] = [];
  if ((data.poDelayDays ?? 0) > 0 && data.planExpectedPo && data.realityActualPo) {
    brackets.push({
      x1: x(asDate(data.planExpectedPo)),
      x2: x(asDate(data.realityActualPo)),
      text: `PO delay  ·  +${data.poDelayDays}d`,
      yTop: curBracketY,
    });
    curBracketY += BRACKET_GAP;
  }
  if ((data.deliveryDelayDays ?? 0) > 0 && data.realityDelivery) {
    brackets.push({
      x1: x(asDate(data.planPromised)),
      x2: x(asDate(data.realityDelivery)),
      text: `Delivery delay  ·  +${data.deliveryDelayDays}d`,
      yTop: curBracketY,
    });
  }

  // ─── Date axis ───────────────────────────────────────────────
  const AXIS_Y = H - 30;
  const nTicks = Math.min(7, Math.max(3, Math.floor(spanDays / 7) + 2));
  const axisTicks: { x: number; label: string }[] = [];
  for (let i = 0; i < nTicks; i++) {
    const d = addDays(chartMin, Math.round((i * chartSpan) / (nTicks - 1)));
    axisTicks.push({ x: x(d), label: fmtAxis(d) });
  }

  return (
    <div className="overflow-x-auto" role="img" aria-label={`Plan vs Reality timeline for ${data.batchCode}`}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ fontFamily: "Alexandria, sans-serif", display: "block" }}
      >
        {/* Track labels */}
        <text
          x={M_L - 14} y={Y_REALITY + 5} textAnchor="end"
          fontSize={14} fontWeight={700} fill={Brand.MIDNIGHT}
        >Reality</text>
        <text
          x={M_L - 14} y={Y_PLAN + 5} textAnchor="end"
          fontSize={14} fontWeight={700} fill={Brand.MIDNIGHT}
        >Plan</text>

        {/* Reality track line */}
        {rx.length > 1 && (
          <line
            x1={rx[0]} x2={rx[rx.length - 1]}
            y1={Y_REALITY} y2={Y_REALITY}
            stroke={realityColor} strokeWidth={3} strokeLinecap="round"
          />
        )}

        {/* Plan track line */}
        <line
          x1={px[0]} x2={px[px.length - 1]}
          y1={Y_PLAN} y2={Y_PLAN}
          stroke={Brand.MIDNIGHT} strokeWidth={3} strokeLinecap="round"
        />

        {/* Reality ticks + labels (above the line) */}
        {reality.map((m, i) => {
          const xx = rx[i];
          const off = realityOffsets[i];
          const yLabel = Y_REALITY - TICK - 8 - off * LABEL_ROW_GAP;
          return (
            <g key={`r-${i}`}>
              <line
                x1={xx} x2={xx}
                y1={Y_REALITY - TICK} y2={Y_REALITY + TICK}
                stroke={realityColor} strokeWidth={2} strokeLinecap="round"
              >
                <title>{`${m.label} · ${m.date.toISOString().slice(0, 10)}`}</title>
              </line>
              <text
                x={xx} y={yLabel} textAnchor="middle"
                fontSize={11} fontWeight={500} fill={realityColor}
              >{m.label}</text>
            </g>
          );
        })}

        {/* Plan ticks + labels (below the line) */}
        {plan.map((m, i) => {
          const xx = px[i];
          const off = planOffsets[i];
          const yLabel = Y_PLAN + TICK + 14 + off * LABEL_ROW_GAP;
          return (
            <g key={`p-${i}`}>
              <line
                x1={xx} x2={xx}
                y1={Y_PLAN - TICK} y2={Y_PLAN + TICK}
                stroke={Brand.MIDNIGHT} strokeWidth={2} strokeLinecap="round"
              >
                <title>{`${m.label} · ${m.date.toISOString().slice(0, 10)}`}</title>
              </line>
              <text
                x={xx} y={yLabel} textAnchor="middle"
                fontSize={11} fontWeight={500} fill={Brand.GREY_600}
              >{m.label}</text>
            </g>
          );
        })}

        {/* Delay brackets */}
        {brackets.map((b, i) => (
          <Bracket key={`bk-${i}`} {...b} />
        ))}

        {/* Date axis */}
        <line
          x1={M_L} x2={W - M_R} y1={AXIS_Y} y2={AXIS_Y}
          stroke={Brand.GREY_300} strokeWidth={1}
        />
        {axisTicks.map((t, i) => (
          <g key={`a-${i}`}>
            <line
              x1={t.x} x2={t.x} y1={AXIS_Y} y2={AXIS_Y + 4}
              stroke={Brand.GREY_400}
            />
            <text
              x={t.x} y={AXIS_Y + 18} textAnchor="middle"
              fontSize={10} fill={Brand.GREY_500}
            >{t.label}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

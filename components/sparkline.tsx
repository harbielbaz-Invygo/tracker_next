/**
 * Sparkline — tiny pure-SVG trend line.
 *
 * Renders a polyline through `values`. Null entries break the path,
 * so weeks with no data render as gaps instead of false zeroes. Dot
 * markers on non-null points let isolated buckets (one week of data
 * surrounded by silence) still register visually. Optional dashed
 * baseline at a fixed y-value (useful for "50%" or "0" anchors).
 *
 * Width / height are configurable so the same primitive works in
 * both the Reports hero (96×24, big) and table rows (60×16, tight).
 *
 * Used by the Reports page (on-time rate trend, hero + per-row) and
 * the Dashboard (delayed-count trend on the hero tile).
 */
import { cn } from "@/lib/utils";

export function Sparkline({
  values,
  stroke,
  width  = 96,
  height = 24,
  /**
   * Y-axis domain. Defaults to [0, 100] (percentage). Pass [0, max]
   * or a fixed range when plotting non-rate series like counts.
   */
  domain = [0, 100],
  /** Optional y-value to draw a dashed baseline at. null = no baseline. */
  baseline = 50,
  className,
  ariaLabel = "trend",
}: {
  values: (number | null)[];
  /** Stroke colour — typically a brand token hex for consistency with the surrounding tile. */
  stroke: string;
  width?: number;
  height?: number;
  domain?: [number, number];
  baseline?: number | null;
  className?: string;
  ariaLabel?: string;
}) {
  const PAD = 2;
  const innerW = width - PAD * 2;
  const innerH = height - PAD * 2;
  const [dMin, dMax] = domain;
  const range = Math.max(dMax - dMin, 1);
  const yFor = (v: number) => PAD + innerH - ((v - dMin) / range) * innerH;
  const xFor = (i: number) => PAD + (values.length <= 1 ? 0 : (i / (values.length - 1)) * innerW);

  let d = "";
  let onPath = false;
  values.forEach((v, i) => {
    if (v === null) { onPath = false; return; }
    d += `${onPath ? " L" : "M"}${xFor(i).toFixed(1)} ${yFor(v).toFixed(1)}`;
    onPath = true;
  });

  const dots = values
    .map((v, i) => v === null ? null : { x: xFor(i), y: yFor(v) })
    .filter((p): p is { x: number; y: number } => p !== null);

  if (dots.length === 0) {
    return (
      <span className={cn("text-[0.6rem] text-ink-400 italic", className)}>
        no trend yet
      </span>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("shrink-0", className)}
      aria-label={ariaLabel}
      role="img"
    >
      {baseline !== null && baseline >= dMin && baseline <= dMax && (
        <line
          x1={PAD} y1={yFor(baseline)}
          x2={width - PAD} y2={yFor(baseline)}
          stroke="#E5E7EB"
          strokeDasharray="2 2"
        />
      )}
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {dots.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={1.25} fill={stroke} />
      ))}
    </svg>
  );
}

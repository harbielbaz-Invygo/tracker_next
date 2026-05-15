"use client";

/**
 * CompactMetric — small KPI tile shared across the metric strips on
 * Action Center and Insights. Renders a label + numeric value with an
 * optional second line ("subtitle") and a colored left-edge accent
 * stripe that signals the tile's semantic role.
 *
 * Lives in its own file so multiple shells can reuse the styling
 * without copy-pasting (and drifting apart).
 */
import { cn } from "@/lib/utils";

export type CompactAccent = "green" | "brand" | "gold" | "flame" | "ink";

const ACCENT_CLASSES: Record<CompactAccent, string> = {
  green: "border-l-2 border-l-green",
  brand: "border-l-2 border-l-brand",
  gold:  "border-l-2 border-l-gold",
  flame: "border-l-2 border-l-flame",
  ink:   "border-l-2 border-l-ink-300",
};

export interface CompactMetricProps {
  label: string;
  value: number | string;
  /** Tailwind text colour class for the value. Default: text-midnight. */
  valueColor?: string;
  /** Native title tooltip. */
  title?: string;
  /** Optional second line — usually a car-level or context breakdown. */
  subtitle?: string;
  /** Colored left-edge stripe matching the tile's semantic role. */
  accent?: CompactAccent;
}

export default function CompactMetric({
  label, value, valueColor, title, subtitle, accent,
}: CompactMetricProps) {
  return (
    <div
      title={title}
      className={cn(
        "px-3 py-2 rounded-md bg-ink-50 border border-ink-100",
        ACCENT_CLASSES[accent ?? "ink"],
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-ink-600">{label}</span>
        <span className={cn(
          "text-lg font-semibold tabular-nums",
          valueColor ?? "text-midnight",
        )}>
          {value}
        </span>
      </div>
      {subtitle && (
        <p className="text-[0.65rem] text-ink-500 mt-0.5 tabular-nums leading-tight">
          {subtitle}
        </p>
      )}
    </div>
  );
}

"use client";

/**
 * Period selector — segmented control that lives at the top of
 * Reports. Reads the active period from the `period` URL search
 * param and writes back on change, so the choice survives reload
 * and is shareable.
 *
 * The actual filtering happens server-side in getPerformanceReport
 * — this control just navigates with a different searchParam value
 * and Next.js re-runs the server component with the new period.
 */
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { REPORT_PERIODS, type ReportPeriod } from "@/lib/reports-period";
import { cn } from "@/lib/utils";

export function PeriodSelect({ active }: { active: ReportPeriod }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function selectPeriod(next: ReportPeriod) {
    if (next === active) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === "all") {
      // Don't clutter URLs with the default value.
      params.delete("period");
    } else {
      params.set("period", next);
    }
    const qs = params.toString();
    // Cast through any — Next.js typed routes don't recognise URLs
    // composed at runtime, but the path is always /reports here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.push((qs ? `${pathname}?${qs}` : pathname) as any);
  }

  return (
    <div
      role="group"
      aria-label="Report period"
      className="inline-flex items-center gap-1 bg-ink-50 rounded-md p-1 border border-ink-200"
    >
      {REPORT_PERIODS.map((p) => {
        const isActive = p.value === active;
        return (
          <button
            key={p.value}
            type="button"
            onClick={() => selectPeriod(p.value)}
            aria-pressed={isActive}
            className={cn(
              "text-xs font-medium px-3 py-1 rounded transition-colors",
              isActive
                ? "bg-white text-brand-dark border border-ink-200 shadow-sm"
                : "text-ink-600 hover:text-midnight hover:bg-white/60",
            )}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Period filter constants for the Reports page.
 *
 * Lives in its own file (with no server-only imports) so the client
 * <PeriodSelect> can import the type + option list without dragging
 * `@/lib/db` → `node:fs` into the client bundle. Same pattern as
 * `lib/action-center-predicates.ts` (the lesson from PR #69).
 *
 * The server-side filter logic stays in `lib/reports-data.ts`.
 */

export type ReportPeriod = "30d" | "90d" | "6m" | "all";

export const REPORT_PERIODS: { value: ReportPeriod; label: string }[] = [
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "6m",  label: "Last 6 months" },
  { value: "all", label: "All time" },
];

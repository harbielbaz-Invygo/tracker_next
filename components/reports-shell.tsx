"use client";

/**
 * Reports shell — renders the performance report.
 *
 * Three sections:
 *   1. Summary metric strip (totals across all batches).
 *   2. Departments table — one row per department, ranked by avg delay.
 *   3. Stakeholders table — one row per stakeholder, same shape.
 *
 * No interactivity beyond hover tooltips for now. CSV export, drill-down,
 * and date-range filters are deferred — let real usage shape them.
 */
import type { PerformanceReport, DepartmentRow, StakeholderRow } from "@/lib/reports-data";
import { cn } from "@/lib/utils";

interface Props {
  report: PerformanceReport;
}

export default function ReportsShell({ report }: Props) {
  const { totals, departments, stakeholders } = report;
  const onTimeRate = totals.deliveredOnTime + totals.deliveredLate > 0
    ? Math.round((totals.deliveredOnTime / (totals.deliveredOnTime + totals.deliveredLate)) * 100)
    : null;

  return (
    <div className="space-y-6">
      {/* ── Summary strip ──────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Metric label="Total batches" value={totals.totalBatches} />
        <Metric label="Open"          value={totals.open} />
        <Metric label="✅ Delivered on time" value={totals.deliveredOnTime} valueColor="text-green-dark" />
        <Metric label="⚠️ Delivered late"   value={totals.deliveredLate}   valueColor="text-flame-dark" />
        <Metric label="🚫 Cancelled"        value={totals.cancelled}       valueColor="text-ink-600" />
      </div>

      {onTimeRate !== null && (
        <div className="card flex flex-wrap items-baseline justify-between gap-3">
          <p className="text-sm text-midnight">
            <span className="font-bold tabular-nums text-2xl mr-1">{onTimeRate}%</span>
            <span className="text-ink-600">on-time delivery rate</span>
            <span className="text-ink-400 mx-2">·</span>
            <span className="text-xs text-ink-500">
              {totals.deliveredOnTime} on time of {totals.deliveredOnTime + totals.deliveredLate} delivered
            </span>
          </p>
          <p className="text-[0.7rem] text-ink-500">
            Generated {new Date(report.generatedAt).toLocaleString()}
          </p>
        </div>
      )}

      {/* ── Departments table ──────────────────────────────────── */}
      <PerformanceTable
        title="Departments"
        description="Ranked by average action delay (worst first)."
        rows={departments.map((d) => ({
          key: `dept-${d.id}`,
          primary: d.name,
          secondary: null,
          row: d,
        }))}
      />

      {/* ── Stakeholders table ─────────────────────────────────── */}
      <PerformanceTable
        title="Stakeholders"
        description="Same metrics, per individual / sub-team."
        rows={stakeholders.map((s) => ({
          key: `sh-${s.id}`,
          primary: s.name,
          secondary: s.departmentName,
          row: s,
        }))}
      />

      <p className="text-xs text-ink-500 px-1 leading-relaxed">
        <strong>Reading the columns:</strong>{" "}
        <em>Total / Done / Active / Skipped</em> — counts.{" "}
        <em>On-time rate</em> — % of done actions where{" "}
        <code className="text-midnight bg-ink-100 px-1 rounded">completedAt ≤ expectedDate</code>.{" "}
        <em>Avg delay</em> — mean signed delay across done actions with a planned date{" "}
        (negative = ahead of plan).{" "}
        <em>Worst</em> — single largest delay.{" "}
        <em>Delayed batches</em> — distinct batches where this owner has at least one late action,{" "}
        whether that action is already done late or still pending past its planned date.
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Table
// ──────────────────────────────────────────────────────────────────

interface TableRow {
  key: string;
  primary: string;
  secondary: string | null;
  row: DepartmentRow | StakeholderRow;
}

function PerformanceTable({
  title, description, rows,
}: {
  title: string;
  description: string;
  rows: TableRow[];
}) {
  return (
    <div className="card p-0 overflow-hidden">
      <header className="px-4 py-3 border-b border-ink-200">
        <h2 className="text-base font-bold text-midnight">{title}</h2>
        <p className="text-xs text-ink-500 mt-0.5">{description}</p>
      </header>

      {rows.length === 0 ? (
        <p className="px-4 py-8 text-sm text-ink-500 text-center">
          No data yet. Once batches start moving through Intake and Cockpit,
          metrics will populate here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-ink-50">
              <tr className="text-left text-xs font-medium text-ink-600 border-b border-ink-200">
                <Th align="left">Name</Th>
                <Th align="right">Total</Th>
                <Th align="right">Done</Th>
                <Th align="right">Active</Th>
                <Th align="right">Skipped</Th>
                <Th align="right">On-time rate</Th>
                <Th align="right">Avg delay</Th>
                <Th align="right">Worst</Th>
                <Th align="right">Delayed batches</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ key, primary, secondary, row }) => (
                <tr key={key} className="border-b border-ink-200/60">
                  <Td>
                    <div className="font-medium text-midnight">{primary}</div>
                    {secondary && (
                      <div className="text-[0.7rem] text-ink-500 mt-0.5">{secondary}</div>
                    )}
                  </Td>
                  <Td align="right" tabular>{row.totalActions}</Td>
                  <Td align="right" tabular>{row.doneActions}</Td>
                  <Td align="right" tabular>{row.activeActions}</Td>
                  <Td align="right" tabular className="text-ink-500">{row.skippedActions}</Td>
                  <Td align="right" tabular>
                    <OnTimeChip rate={row.onTimeRate} />
                  </Td>
                  <Td align="right" tabular>
                    <DelayValue days={row.avgDelayDays} />
                  </Td>
                  <Td align="right" tabular>
                    <DelayValue days={row.worstDelayDays} bold />
                  </Td>
                  <Td align="right" tabular>
                    {row.delayedBatchesOwned > 0 ? (
                      <span className="font-semibold text-flame-dark">{row.delayedBatchesOwned}</span>
                    ) : (
                      <span className="text-ink-400">0</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Tiny presentational helpers
// ──────────────────────────────────────────────────────────────────

function Metric({
  label, value, valueColor,
}: {
  label: string;
  value: number;
  valueColor?: string;
}) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className={cn("metric-value", valueColor)}>{value}</span>
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      scope="col"
      className={cn(
        "px-3 py-2 font-medium uppercase tracking-wide whitespace-nowrap",
        align === "right" && "text-right",
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children, align = "left", tabular = false, className,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  tabular?: boolean;
  className?: string;
}) {
  return (
    <td
      className={cn(
        "px-3 py-2 align-middle text-midnight",
        align === "right" && "text-right",
        tabular && "tabular-nums",
        className,
      )}
    >
      {children}
    </td>
  );
}

function OnTimeChip({ rate }: { rate: number | null }) {
  if (rate == null) return <span className="text-ink-400">—</span>;
  const cls = rate >= 90 ? "text-green-dark"
    : rate >= 75 ? "text-gold-dark"
    : "text-flame-dark";
  return <span className={cn("font-medium", cls)}>{rate}%</span>;
}

function DelayValue({ days, bold = false }: { days: number | null; bold?: boolean }) {
  if (days == null) return <span className="text-ink-400">—</span>;
  if (days === 0) {
    return <span className={cn(bold ? "font-semibold" : "", "text-ink-500")}>0d</span>;
  }
  const cls = days > 0 ? "text-flame-dark" : "text-green-dark";
  const text = days > 0 ? `+${days}d` : `${days}d`;
  return <span className={cn(cls, bold && "font-semibold")}>{text}</span>;
}

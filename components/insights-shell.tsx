"use client";

/**
 * Insights shell — the unified Dashboard + Reports view.
 *
 * Four stacked sections, leadership-down-to-operational:
 *   1. Hero row     — North Star + at-a-glance health tiles
 *   2. Customer Impact — severity bars + top-impact batches table
 *   3. Trust tabs   — Dealer Reliability | Ops Performance | Risk Engine
 *   4. Batch Explorer — filterable list + Plan-vs-Reality drawer per row
 *
 * Lives at /insights so it doesn't disrupt the current /dashboard or
 * /reports pages. Period filter is a UI scaffold today (always "All time")
 * — wire it through the data layer in a follow-up once the shape lands.
 */
import { useEffect, useMemo, useState } from "react";
import type { InsightsData } from "@/lib/insights-data";
import type {
  DepartmentRow, StakeholderRow, DealerReliabilityRow, CityReliabilityRow,
  CustomerImpactReport, CustomerImpactBatch,
} from "@/lib/reports-data";
import type { DashboardRow, TimelineData, StatusBucket } from "@/lib/dashboard-data";
import BatchTable from "./batch-table";
import TimelineSvg from "./timeline-svg";
import { cn } from "@/lib/utils";

interface Props {
  data: InsightsData;
}

type TrustTab = "dealer" | "ops" | "cities" | "risk";

export default function InsightsShell({ data }: Props) {
  const [trustTab, setTrustTab] = useState<TrustTab>("dealer");

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold mb-1">📊 Insights</h1>
        <p className="text-sm text-ink-500 max-w-prose">
          The unified view — leadership-level health up top, drilling into
          customer impact, the three trust lenses, and the per-batch
          Plan-vs-Reality timeline at the bottom.
        </p>
      </header>

      <HeroRow hero={data.hero} />

      <div className="card flex flex-wrap items-baseline justify-between gap-3 text-xs text-ink-500">
        <span>
          Scope: <strong className="text-midnight">All time</strong>
          <span className="ml-2 text-[0.7rem] text-ink-400">
            (period filter wiring is in the roadmap)
          </span>
        </span>
        <span className="tabular-nums">
          Generated {new Date(data.generatedAt).toLocaleString()}
        </span>
      </div>

      <CustomerImpactBlock impact={data.report.customerImpact} />

      <TrustPanel
        active={trustTab}
        onChange={setTrustTab}
        report={data.report}
      />

      <BatchExplorer rows={data.batchRows} />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Hero row
// ──────────────────────────────────────────────────────────────────

function HeroRow({ hero }: { hero: InsightsData["hero"] }) {
  return (
    <section
      aria-label="Health summary"
      className="grid grid-cols-2 md:grid-cols-6 gap-3"
    >
      <HeroTile
        label="Customer-days lost"
        value={hero.customerDaysLost.toLocaleString()}
        accent="flame"
        emphasis
        sub="North Star — total slip × bookings"
      />
      <HeroTile
        label="Active batches"
        value={hero.activeBatches.toLocaleString()}
        sub="open + in flight"
      />
      <HeroTile
        label="⚠️ Pre-VIN critical"
        value={hero.preVinCritical.toLocaleString()}
        accent={hero.preVinCritical > 0 ? "flame" : "neutral"}
        sub="≤ 14d to avail, no VIN"
      />
      <HeroTile
        label="On-time rate"
        value={hero.onTimeRate === null ? "—" : `${hero.onTimeRate}%`}
        accent={
          hero.onTimeRate === null ? "neutral"
            : hero.onTimeRate >= 80 ? "green"
            : hero.onTimeRate >= 60 ? "gold"
            : "flame"
        }
        sub="delivered on/before promise"
      />
      <HeroTile
        label="Re-promises"
        value={hero.rePromisesIssued.toLocaleString()}
        accent={hero.rePromisesIssued > 0 ? "gold" : "neutral"}
        sub="date shifts issued"
      />
      <HeroTile
        label="🚫 Cancelled"
        value={hero.cancelled.toLocaleString()}
        accent={hero.cancelled > 0 ? "flame" : "neutral"}
        sub="batches the dealer pulled"
      />
    </section>
  );
}

function HeroTile({
  label, value, sub, accent = "neutral", emphasis = false,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: "neutral" | "green" | "gold" | "flame";
  emphasis?: boolean;
}) {
  const valueCls = {
    neutral: "text-midnight",
    green:   "text-green-dark",
    gold:    "text-gold-dark",
    flame:   "text-flame-dark",
  }[accent];

  return (
    <div className={cn(
      "rounded-md border bg-white px-3 py-2.5",
      emphasis ? "border-flame border-2" : "border-ink-200",
    )}>
      <p className="text-[0.65rem] font-medium text-ink-500 uppercase tracking-wide">
        {label}
      </p>
      <p className={cn(
        "tabular-nums font-bold mt-0.5",
        emphasis ? "text-3xl" : "text-2xl",
        valueCls,
      )}>
        {value}
      </p>
      <p className="text-[0.65rem] text-ink-500 mt-0.5 leading-tight">{sub}</p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Customer Impact block — North Star detail
// ──────────────────────────────────────────────────────────────────

function CustomerImpactBlock({ impact }: { impact: CustomerImpactReport }) {
  const { totals, batches } = impact;
  if (totals.affectedBatches === 0) {
    return (
      <section className="card border-green/40 bg-green-pale/30">
        <h2 className="text-base font-bold text-green-dark">💸 Customer Impact</h2>
        <p className="text-sm text-ink-600 mt-2">
          🎉 No customer impact recorded — every delivered batch landed
          on or before the promised date and no open batch is currently
          projected late.
        </p>
      </section>
    );
  }

  const pct = (n: number) => totals.affectedBatches > 0 ? Math.round((n / totals.affectedBatches) * 100) : 0;
  return (
    <section className="card p-0 overflow-hidden">
      <header className="px-4 py-3 border-b border-ink-200">
        <h2 className="text-base font-bold text-midnight">💸 Customer Impact</h2>
        <p className="text-xs text-ink-500 mt-0.5">
          Where the {totals.customerDaysLost.toLocaleString()} customer-days lost are coming from.
          Delivered-late events are historical truth; projected-late are open batches we're still on the hook for.
        </p>
      </header>

      {/* Severity bars */}
      <div className="px-4 py-3 border-b border-ink-200 bg-ink-50">
        <p className="text-[0.7rem] font-medium text-ink-600 uppercase tracking-wide mb-2">
          By severity ({totals.affectedBatches} batches)
        </p>
        <div className="space-y-1.5">
          <SeverityBar label="Mild (1–7d)"      count={totals.mild}     pct={pct(totals.mild)}     tone="gold" />
          <SeverityBar label="Moderate (8–21d)" count={totals.moderate} pct={pct(totals.moderate)} tone="flame-pale" />
          <SeverityBar label="Severe (>21d)"    count={totals.severe}   pct={pct(totals.severe)}   tone="flame" />
        </div>
        <p className="text-[0.65rem] text-ink-500 mt-2">
          Realised: {totals.deliveredLateCount} delivered late · Projected: {totals.projectedLateCount} still open
        </p>
      </div>

      {/* Top-impact batches table */}
      <CustomerImpactTable batches={batches} />
    </section>
  );
}

function SeverityBar({
  label, count, pct, tone,
}: {
  label: string; count: number; pct: number;
  tone: "gold" | "flame-pale" | "flame";
}) {
  const barCls = tone === "gold" ? "bg-gold"
    : tone === "flame-pale" ? "bg-flame/60"
    : "bg-flame-dark";
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-ink-600 w-32 shrink-0">{label}</span>
      <div className="flex-1 h-3 bg-ink-200 rounded overflow-hidden">
        <div className={cn("h-full", barCls)} style={{ width: `${pct}%` }} aria-hidden="true" />
      </div>
      <span className="text-xs tabular-nums text-midnight w-20 text-right shrink-0">
        <span className="font-semibold">{count}</span>
        <span className="text-ink-400 ml-1">({pct}%)</span>
      </span>
    </div>
  );
}

function CustomerImpactTable({ batches }: { batches: CustomerImpactBatch[] }) {
  const top = batches.slice(0, 10);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-ink-50">
          <tr className="text-left text-xs font-medium text-ink-600 border-b border-ink-200">
            <Th>Batch</Th>
            <Th>Dealer / Model</Th>
            <Th align="right">Qty</Th>
            <Th align="right">Late</Th>
            <Th align="right">Cust-days</Th>
            <Th align="right">Re-promises</Th>
            <Th>State</Th>
          </tr>
        </thead>
        <tbody>
          {top.map((b) => (
            <tr key={b.batchId} className="border-b border-ink-200/60">
              <Td><code className="font-mono text-midnight text-xs">{b.batchCode}</code></Td>
              <Td>
                <div className="font-medium">{b.dealerName}</div>
                <div className="text-[0.7rem] text-ink-500">{b.modelYear}</div>
              </Td>
              <Td align="right" tabular>{b.quantity}</Td>
              <Td align="right" tabular>
                <span className="font-semibold text-flame-dark">+{b.delayDays}d</span>
              </Td>
              <Td align="right" tabular>
                <span className="font-bold text-flame-dark">{b.customerDaysImpact.toLocaleString()}</span>
              </Td>
              <Td align="right" tabular>
                {b.revisionCount > 0
                  ? <span className="font-medium text-gold-dark">{b.revisionCount}</span>
                  : <span className="text-ink-400">0</span>}
              </Td>
              <Td>
                <span className={cn(
                  "inline-block px-2 py-0.5 rounded-md text-[0.7rem] font-medium border whitespace-nowrap",
                  b.state === "delivered_late"
                    ? "bg-ink-100 text-ink-700 border-ink-300"
                    : "bg-gold-pale text-gold-dark border-gold",
                )}>
                  {b.state === "delivered_late" ? "Delivered late" : "Projected late"}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
      {batches.length > 10 && (
        <p className="px-4 py-2 text-[0.7rem] text-ink-500 bg-ink-50">
          Showing top 10 by customer-days impact · {batches.length - 10} more affected.
        </p>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Trust panel — three tabs
// ──────────────────────────────────────────────────────────────────

function TrustPanel({
  active, onChange, report,
}: {
  active: TrustTab;
  onChange: (t: TrustTab) => void;
  report: InsightsData["report"];
}) {
  return (
    <section className="card p-0 overflow-hidden">
      <header className="px-4 py-3 border-b border-ink-200">
        <h2 className="text-base font-bold text-midnight">🤝 Trust</h2>
        <p className="text-xs text-ink-500 mt-0.5">
          Why we're slipping — three lenses: who we partner with, how we
          execute internally, and how well the risk engine catches problems.
        </p>
      </header>

      <div role="tablist" className="flex border-b border-ink-200 bg-ink-50">
        <TrustTabButton id="dealer" active={active} onChange={onChange} label="Dealer Reliability" />
        <TrustTabButton id="ops"    active={active} onChange={onChange} label="Ops Performance" />
        <TrustTabButton id="cities" active={active} onChange={onChange} label="Cities" />
        <TrustTabButton id="risk"   active={active} onChange={onChange} label="Risk Engine" />
      </div>

      <div className="p-3">
        {active === "dealer" && <DealerTab rows={report.dealerReliability} />}
        {active === "ops"    && <OpsTab depts={report.departments} stakeholders={report.stakeholders} />}
        {active === "cities" && <CitiesTab rows={report.cityReliability} />}
        {active === "risk"   && <RiskTab report={report} />}
      </div>
    </section>
  );
}

function TrustTabButton({
  id, active, onChange, label,
}: {
  id: TrustTab;
  active: TrustTab;
  onChange: (t: TrustTab) => void;
  label: string;
}) {
  const isActive = active === id;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={() => onChange(id)}
      className={cn(
        "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
        isActive
          ? "border-brand text-brand-dark bg-white"
          : "border-transparent text-ink-600 hover:text-midnight hover:bg-ink-100",
      )}
    >
      {label}
    </button>
  );
}

// Tab 1 — Dealer reliability
function DealerTab({ rows }: { rows: DealerReliabilityRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-ink-500 italic px-2 py-4">No dealers yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs font-medium text-ink-600 border-b border-ink-200">
            <Th>Dealer</Th>
            <Th align="right">Batches</Th>
            <Th align="right">Delivered</Th>
            <Th align="right">Cancelled</Th>
            <Th align="right">Date %</Th>
            <Th align="right">Variance</Th>
            <Th align="right">Qty %</Th>
            <Th align="right">Colour %</Th>
            <Th align="right">Cancel %</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.dealerId} className="border-b border-ink-200/60">
              <Td>
                <div className="font-medium text-midnight">{d.dealerName}</div>
                {d.dealerType && (
                  <div className={cn(
                    "text-[0.65rem] font-medium uppercase tracking-wide mt-0.5",
                    d.dealerType === "new" ? "text-gold-dark" : "text-ink-400",
                  )}>
                    {d.dealerType === "new" ? "New" : "Existing"}
                  </div>
                )}
              </Td>
              <Td align="right" tabular>{d.totalBatches}</Td>
              <Td align="right" tabular>
                {d.deliveredBatches > 0
                  ? <span className="text-green-dark">{d.deliveredBatches}</span>
                  : <span className="text-ink-400">0</span>}
              </Td>
              <Td align="right" tabular>
                {d.cancelledBatches > 0
                  ? <span className="text-flame-dark">{d.cancelledBatches}</span>
                  : <span className="text-ink-400">0</span>}
              </Td>
              <Td align="right" tabular><RateChip rate={d.dateReliabilityRate} /></Td>
              <Td align="right" tabular>
                {d.avgDateVarianceDays == null
                  ? <span className="text-ink-400">—</span>
                  : <span className={cn(
                      "font-medium tabular-nums",
                      d.avgDateVarianceDays > 0 ? "text-flame-dark"
                        : d.avgDateVarianceDays < 0 ? "text-green-dark"
                        : "text-ink-500",
                    )}>
                      {d.avgDateVarianceDays > 0 ? `+${d.avgDateVarianceDays}` : d.avgDateVarianceDays}d
                    </span>}
              </Td>
              <Td align="right" tabular><RateChip rate={d.qtyFulfillmentRate} /></Td>
              <Td align="right" tabular><RateChip rate={d.colorReliabilityRate} /></Td>
              <Td align="right" tabular><RateChip rate={d.cancellationRate} invert /></Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RateChip({ rate, invert = false }: { rate: number | null; invert?: boolean }) {
  if (rate == null) return <span className="text-ink-400">—</span>;
  const cls = invert
    ? (rate === 0 ? "text-green-dark" : rate <= 10 ? "text-gold-dark" : "text-flame-dark")
    : (rate >= 90 ? "text-green-dark" : rate >= 70 ? "text-gold-dark" : "text-flame-dark");
  return <span className={cn("font-medium", cls)}>{rate}%</span>;
}

// Tab 2 — Ops performance (departments + stakeholders)
function OpsTab({
  depts, stakeholders,
}: {
  depts: DepartmentRow[]; stakeholders: StakeholderRow[];
}) {
  return (
    <div className="space-y-5">
      <PerfTable title="Departments" rows={depts.map((d) => ({
        primary: d.name, secondary: null, row: d, key: `d-${d.id}`,
      }))} />
      <PerfTable title="Stakeholders" rows={stakeholders.map((s) => ({
        primary: s.name, secondary: s.departmentName, row: s, key: `s-${s.id}`,
      }))} />
    </div>
  );
}

interface PerfRow {
  key: string;
  primary: string;
  secondary: string | null;
  row: DepartmentRow | StakeholderRow;
}
function PerfTable({ title, rows }: { title: string; rows: PerfRow[] }) {
  return (
    <div>
      <h3 className="text-sm font-bold text-midnight mb-1.5">{title}</h3>
      <div className="overflow-x-auto rounded-md border border-ink-200">
        <table className="w-full text-sm">
          <thead className="bg-ink-50">
            <tr className="text-left text-xs font-medium text-ink-600 border-b border-ink-200">
              <Th>Name</Th>
              <Th align="right">Total</Th>
              <Th align="right">Done</Th>
              <Th align="right">Active</Th>
              <Th align="right">On-time</Th>
              <Th align="right">Avg delay</Th>
              <Th align="right">Worst</Th>
              <Th align="right">Delayed batches</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-sm text-ink-500 italic">
                  No data yet.
                </td>
              </tr>
            ) : rows.map(({ key, primary, secondary, row }) => (
              <tr key={key} className="border-b border-ink-200/60 last:border-b-0">
                <Td>
                  <div className="font-medium text-midnight">{primary}</div>
                  {secondary && <div className="text-[0.7rem] text-ink-500">{secondary}</div>}
                </Td>
                <Td align="right" tabular>{row.totalActions}</Td>
                <Td align="right" tabular>{row.doneActions}</Td>
                <Td align="right" tabular>{row.activeActions}</Td>
                <Td align="right" tabular>
                  {row.onTimeRate == null
                    ? <span className="text-ink-400">—</span>
                    : <span className={cn(
                        "font-medium",
                        row.onTimeRate >= 90 ? "text-green-dark"
                          : row.onTimeRate >= 75 ? "text-gold-dark"
                          : "text-flame-dark",
                      )}>{row.onTimeRate}%</span>}
                </Td>
                <Td align="right" tabular><DelayValue days={row.avgDelayDays} /></Td>
                <Td align="right" tabular><DelayValue days={row.worstDelayDays} bold /></Td>
                <Td align="right" tabular>
                  {row.delayedBatchesOwned > 0
                    ? <span className="font-semibold text-flame-dark">{row.delayedBatchesOwned}</span>
                    : <span className="text-ink-400">0</span>}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DelayValue({ days, bold = false }: { days: number | null; bold?: boolean }) {
  if (days == null) return <span className="text-ink-400">—</span>;
  if (days === 0) return <span className={cn(bold && "font-semibold", "text-ink-500")}>0d</span>;
  const cls = days > 0 ? "text-flame-dark" : "text-green-dark";
  const text = days > 0 ? `+${days}d` : `${days}d`;
  return <span className={cn(cls, bold && "font-semibold")}>{text}</span>;
}

// Tab 3 — Cities (Phase δ): per-city delivery reliability.
function CitiesTab({ rows }: { rows: CityReliabilityRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-500 italic px-2 py-4">
        No city data yet. This lens populates once batches with delivery
        legs land (Phase α/β output).
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs font-medium text-ink-600 border-b border-ink-200">
            <Th>City</Th>
            <Th align="right">Batches</Th>
            <Th align="right">Delivered</Th>
            <Th align="right">Cars requested</Th>
            <Th align="right">Cars delivered</Th>
            <Th align="right">Qty %</Th>
            <Th align="right">Date %</Th>
            <Th align="right">Variance</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.city} className="border-b border-ink-200/60">
              <Td>
                <div className="font-medium text-midnight">{c.city}</div>
              </Td>
              <Td align="right" tabular>{c.totalBatches}</Td>
              <Td align="right" tabular>
                {c.deliveredBatches > 0
                  ? <span className="text-green-dark">{c.deliveredBatches}</span>
                  : <span className="text-ink-400">0</span>}
              </Td>
              <Td align="right" tabular>{c.carsRequested}</Td>
              <Td align="right" tabular>{c.carsDelivered}</Td>
              <Td align="right" tabular>
                {c.qtyFulfillmentRate == null
                  ? <span className="text-ink-400">—</span>
                  : <span className={cn(
                      "font-medium",
                      c.qtyFulfillmentRate >= 90 ? "text-green-dark"
                        : c.qtyFulfillmentRate >= 70 ? "text-gold-dark"
                        : "text-flame-dark",
                    )}>{c.qtyFulfillmentRate}%</span>}
              </Td>
              <Td align="right" tabular>
                {c.dateReliabilityRate == null
                  ? <span className="text-ink-400">—</span>
                  : <span className={cn(
                      "font-medium",
                      c.dateReliabilityRate >= 90 ? "text-green-dark"
                        : c.dateReliabilityRate >= 70 ? "text-gold-dark"
                        : "text-flame-dark",
                    )}>{c.dateReliabilityRate}%</span>}
              </Td>
              <Td align="right" tabular>
                {c.avgDateVarianceDays == null
                  ? <span className="text-ink-400">—</span>
                  : <span className={cn(
                      "font-medium tabular-nums",
                      c.avgDateVarianceDays > 0 ? "text-flame-dark"
                        : c.avgDateVarianceDays < 0 ? "text-green-dark"
                        : "text-ink-500",
                    )}>
                      {c.avgDateVarianceDays > 0 ? `+${c.avgDateVarianceDays}` : c.avgDateVarianceDays}d
                    </span>}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Tab 4 — Risk engine effectiveness
function RiskTab({ report }: { report: InsightsData["report"] }) {
  const { customerImpact } = report;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <RiskMetric label="Re-promises issued" value={customerImpact.totals.totalRePromises} sub="date shifts logged" tone="gold" />
        <RiskMetric label="Currently delivered-late" value={customerImpact.totals.deliveredLateCount} sub="closed past promise" tone="flame" />
        <RiskMetric label="Projected late (open)" value={customerImpact.totals.projectedLateCount} sub="still in flight" tone="flame" />
        <RiskMetric label="Severe slips (>21d)" value={customerImpact.totals.severe} sub="worst-tier impacts" tone="flame" />
      </div>
      <p className="text-xs text-ink-500 px-1 leading-relaxed">
        The alert engine fires on every Action Center load — runway-shrinking and overdue-action
        rules surface as inline alerts on the action rows. Acked / dismissed alerts have been
        retired; alerts now auto-resolve when the underlying action lands.
      </p>
    </div>
  );
}

function RiskMetric({
  label, value, sub, tone,
}: {
  label: string; value: number; sub: string;
  tone: "gold" | "flame";
}) {
  const cls = tone === "gold" ? "text-gold-dark" : "text-flame-dark";
  return (
    <div className="rounded-md border border-ink-200 bg-white px-3 py-2.5">
      <p className="text-[0.65rem] font-medium text-ink-500 uppercase tracking-wide">{label}</p>
      <p className={cn("tabular-nums font-bold text-2xl mt-0.5", cls)}>{value.toLocaleString()}</p>
      <p className="text-[0.65rem] text-ink-500 mt-0.5 leading-tight">{sub}</p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Batch Explorer — filterable list + Plan-vs-Reality drawer
// ──────────────────────────────────────────────────────────────────

function BatchExplorer({ rows }: { rows: DashboardRow[] }) {
  const [search,       setSearch]       = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusBucket | "all">("all");
  const [phaseFilter,  setPhaseFilter]  = useState<"all" | "pre_vin" | "post_vin">("all");
  const [activeOnly,   setActiveOnly]   = useState(true);
  const [selected,     setSelected]     = useState<string | null>(null);
  const [timeline,     setTimeline]     = useState<TimelineData | null>(null);
  const [tlBusy,       setTlBusy]       = useState(false);
  const [tlError,      setTlError]      = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (activeOnly && r.status === "delivered") return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (phaseFilter !== "all" && r.vinPhase !== phaseFilter) return false;
      if (q) {
        const hay = `${r.batchCode} ${r.poNumber ?? ""} ${r.dealerName} ${r.modelYear}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, statusFilter, phaseFilter, activeOnly]);

  useEffect(() => {
    if (!selected) { setTimeline(null); setTlError(null); return; }
    let cancelled = false;
    setTlBusy(true);
    setTlError(null);
    fetch(`/api/timeline?code=${encodeURIComponent(selected)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.json() as Promise<TimelineData>;
      })
      .then((d) => { if (!cancelled) setTimeline(d); })
      .catch((e) => { if (!cancelled) setTlError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setTlBusy(false); });
    return () => { cancelled = true; };
  }, [selected]);

  return (
    <section className="card p-0 overflow-hidden">
      <header className="px-4 py-3 border-b border-ink-200">
        <h2 className="text-base font-bold text-midnight">🔍 Batch Explorer</h2>
        <p className="text-xs text-ink-500 mt-0.5">
          Filter the requests below; click a row to view its Plan-vs-Reality timeline.
        </p>
      </header>

      <div className="p-3 grid grid-cols-1 md:grid-cols-4 gap-3 border-b border-ink-200">
        <label className="block md:col-span-2">
          <span className="block text-xs font-medium text-ink-600 mb-1">🔎 Search</span>
          <input
            className="input"
            placeholder="batch code, PO number, dealer, model"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-ink-600 mb-1">Status</span>
          <select
            className="input"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusBucket | "all")}
          >
            <option value="all">All</option>
            <option value="on_track">🟢 On track</option>
            <option value="ahead">🔵 Ahead</option>
            <option value="delayed">🔴 Delayed</option>
            <option value="delivered">🎉 Delivered</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-ink-600 mb-1">VIN phase</span>
          <select
            className="input"
            value={phaseFilter}
            onChange={(e) => setPhaseFilter(e.target.value as "all" | "pre_vin" | "post_vin")}
          >
            <option value="all">All phases</option>
            <option value="pre_vin">⚠️ Pre-VIN</option>
            <option value="post_vin">✅ Post-VIN</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none md:col-span-4">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
            className="h-4 w-4 accent-brand"
          />
          Active only (hide delivered)
        </label>
      </div>

      <div className="p-3">
        <BatchTable
          rows={filtered}
          selectedCode={selected}
          onSelect={(code) => setSelected((cur) => cur === code ? null : code)}
          totalCount={rows.length}
        />
      </div>

      {selected && (
        <div className="border-t border-ink-200 p-3">
          {tlBusy ? (
            <p className="text-sm text-ink-500">Loading timeline…</p>
          ) : tlError ? (
            <p role="alert" className="text-sm text-flame-dark bg-flame-pale border border-flame px-3 py-2 rounded-md">
              Could not load timeline: {tlError}
            </p>
          ) : timeline ? (
            <TimelineDrawer data={timeline} />
          ) : null}
        </div>
      )}
    </section>
  );
}

function TimelineDrawer({ data }: { data: TimelineData }) {
  return (
    <div>
      <h3 className="text-sm font-bold text-midnight mb-1">
        📍 Plan vs Reality
        <code className="ml-2 text-xs font-mono text-ink-600">{data.batchCode}</code>
      </h3>
      <p className="text-xs text-ink-500 mb-3">
        {data.quantity}× {data.modelYear} · {data.dealerName} · {data.stageDisplay}
      </p>
      <TimelineSvg data={data} />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Tiny table helpers
// ──────────────────────────────────────────────────────────────────

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
  children, align = "left", tabular = false,
}: {
  children: React.ReactNode; align?: "left" | "right"; tabular?: boolean;
}) {
  return (
    <td className={cn(
      "px-3 py-2 align-middle text-midnight",
      align === "right" && "text-right",
      tabular && "tabular-nums",
    )}>
      {children}
    </td>
  );
}

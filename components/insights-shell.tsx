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
import React, { useEffect, useMemo, useState } from "react";
import type {
  InsightsData, ClosureSummary, ForecastReliabilityRow,
  UpcomingAtRiskRow, InternalPhaseActionStat, StuckStageRow,
  KpiDelta,
} from "@/lib/insights-data";
import type {
  DepartmentRow, StakeholderRow, DealerReliabilityRow, CityReliabilityRow,
  CustomerImpactReport, CustomerImpactBatch,
  PoReliabilityRowFull,
} from "@/lib/reports-data";
import type { DashboardRow, TimelineData, StatusBucket } from "@/lib/dashboard-data";
import type { SlaMetrics } from "@/lib/sla-metrics";
import BatchTable from "./batch-table";
import CompactMetric from "./compact-metric";
import PageHeader from "./page-header";
import TimelineSvg from "./timeline-svg";
import { PeriodSelect } from "./period-select";
import { Sparkline } from "./sparkline";
import { Brand } from "@/lib/brand";
import { REPORT_PERIODS, type ReportPeriod } from "@/lib/reports-period";
import { cn } from "@/lib/utils";
// Fluent UI v9 — first integration test, scoped to the Insights page
// only. FluentProvider supplies the theme; TabList + Tab replace the
// home-rolled trust-tab buttons. Other pages remain Tailwind-only.
import {
  FluentProvider,
  webLightTheme,
  TabList,
  Tab,
} from "@fluentui/react-components";

interface Props {
  data: InsightsData;
  /** Active period filter from the URL — scopes the entire payload. */
  period: ReportPeriod;
  /** Live SLA health snapshot (not period-scoped). */
  sla: SlaMetrics;
}

type TrustTab = "dealer" | "ops" | "cities" | "forecast" | "po" | "risk";

export default function InsightsShell({ data, period, sla }: Props) {
  const [trustTab, setTrustTab] = useState<TrustTab>("dealer");
  const periodLabel = REPORT_PERIODS.find((p) => p.value === period)?.label ?? "All time";

  return (
    // FluentProvider wraps the whole Insights surface so any Fluent UI
    // component inside picks up the web-light theme. Scoped to this
    // page only — no other pages render under a Fluent provider yet.
    // First Fluent component test below: the Trust panel's TabList.
    <FluentProvider theme={webLightTheme}>
     <div className="space-y-6">
      <PageHeader
        view="Insights"
        subtitle="The unified view — leadership-level health up top, drilling into customer impact, the three trust lenses, and the per-batch Plan-vs-Reality timeline at the bottom."
        className="mb-0"
      />

      <HeroRow hero={data.hero} />

      <SlaHealthPanel sla={sla} />

      {/* Period selector + scope + generation timestamp. Replaces the
          "(period filter wiring is in the roadmap)" placeholder.
          The selected period scopes hero + Customer Impact + Trust
          tables + Batch Explorer rows. */}
      <div className="card flex flex-wrap items-center justify-between gap-3 text-xs text-ink-500">
        <span className="flex items-baseline gap-2">
          <span>Scope:</span>
          <strong className="text-midnight">{periodLabel}</strong>
        </span>
        <PeriodSelect active={period} />
        <span className="tabular-nums">
          Generated {new Date(data.generatedAt).toLocaleString()}
        </span>
      </div>

      <ClosureStrip closure={data.closure} />

      <UpcomingAtRiskBlock rows={data.upcomingAtRisk} />

      <InternalPhaseBreakdown stats={data.internalPhaseStats} />

      <StuckStagesBlock rows={data.stuckStages} />

      <CustomerImpactBlock impact={data.report.customerImpact} />

      <TrustPanel
        active={trustTab}
        onChange={setTrustTab}
        report={data.report}
        forecastReliability={data.forecastReliability}
      />

      <BatchExplorer rows={data.batchRows} />
     </div>
    </FluentProvider>
  );
}

// ──────────────────────────────────────────────────────────────────
// SLA health — live snapshot of the SLA countdown system
// ──────────────────────────────────────────────────────────────────

function SlaHealthPanel({ sla }: { sla: SlaMetrics }) {
  // Not migrated yet → quiet hint instead of a wall of zeros.
  if (!sla.available) {
    return (
      <section aria-label="SLA health" className="card">
        <h2 className="text-sm font-semibold text-midnight">⏱ SLA health</h2>
        <p className="text-xs text-ink-500 mt-1">
          SLA tracking isn’t enabled yet. Run <strong>Settings → Maintenance → “SLA countdown columns”</strong>,
          then set an SLA on the action types you want measured.
        </p>
      </section>
    );
  }

  // Nothing configured / tracked yet → encourage setting durations.
  if (sla.trackedActions === 0) {
    return (
      <section aria-label="SLA health" className="card">
        <h2 className="text-sm font-semibold text-midnight">⏱ SLA health</h2>
        <p className="text-xs text-ink-500 mt-1">
          No actions are under an SLA yet. Set an <strong>SLA (hours)</strong> on action types in
          Settings → Action Types and the live compliance, delayed count and overdue stats appear here.
        </p>
      </section>
    );
  }

  const breaching = sla.currentlyOverdue;
  const complianceAccent: "neutral" | "green" | "gold" | "flame" =
    sla.compliancePct == null ? "neutral"
      : sla.compliancePct >= 90 ? "green"
      : sla.compliancePct >= 70 ? "gold"
      : "flame";

  return (
    <section aria-label="SLA health" className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-midnight">⏱ SLA health</h2>
        <span className="text-[0.65rem] text-ink-400">
          Live snapshot · {sla.trackedActions} action{sla.trackedActions === 1 ? "" : "s"} under SLA
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <HeroTile
          label="SLA compliance"
          value={sla.compliancePct == null ? "—" : `${sla.compliancePct}%`}
          accent={complianceAccent}
          emphasis
          sub={sla.doneTotal > 0
            ? `${sla.doneOnTime}/${sla.doneTotal} completed on time`
            : "no completed SLA actions yet"}
          title="Of completed actions that had an SLA budget, the share that finished within budget."
        />
        <HeroTile
          label="Delayed now"
          value={breaching.toLocaleString()}
          accent={breaching > 0 ? "flame" : "green"}
          sub={sla.currentlyCritical > 0
            ? `${sla.currentlyCritical} critical (overdue ≥ budget)`
            : "actions currently past SLA"}
          title="Waiting actions whose live countdown is past the deadline right now."
        />
        <HeroTile
          label="Avg overdue"
          value={sla.avgOverdueHours == null ? "—" : fmtHours(sla.avgOverdueHours)}
          accent={sla.avgOverdueHours == null ? "neutral" : "gold"}
          sub="mean lateness of current breaches"
          title="Average time past deadline across all currently-overdue actions."
        />
        <HeroTile
          label="Worst overdue"
          value={sla.maxOverdueHours == null ? "—" : fmtHours(sla.maxOverdueHours)}
          accent={sla.maxOverdueHours == null ? "neutral" : "flame"}
          sub="single most-overdue action"
          title="The largest current overdue duration."
        />
      </div>

      {sla.byType.length > 0 && (
        <div className="card">
          <h3 className="text-xs font-semibold text-ink-600 uppercase tracking-wide mb-2">
            Breaches by action type
          </h3>
          <ul className="space-y-1">
            {sla.byType.map((b) => (
              <li key={b.name} className="flex items-center justify-between text-xs">
                <span className="text-ink-700">{b.name}</span>
                <span className="tabular-nums text-flame-dark font-medium">
                  {b.overdue} overdue
                  <span className="text-ink-400 font-normal"> / {b.tracked} tracked</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Compact "Xd Yh" / "Zh" for an hours value (may be fractional). */
function fmtHours(hours: number): string {
  if (hours >= 24) {
    const d = Math.floor(hours / 24);
    const h = Math.round(hours - d * 24);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  if (hours >= 1) return `${Math.round(hours)}h`;
  return `${Math.round(hours * 60)}m`;
}

// ──────────────────────────────────────────────────────────────────
// Hero row
// ──────────────────────────────────────────────────────────────────

function HeroRow({ hero }: { hero: InsightsData["hero"] }) {
  return (
    <section
      aria-label="Health summary"
      className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3"
    >
      <HeroTile
        label="Customer-days lost"
        value={hero.customerDaysLost.toLocaleString()}
        accent="flame"
        emphasis
        sub="North Star — total slip × bookings"
        delta={hero.comparison
          ? { d: hero.comparison.customerDaysLost, mode: "pct", periodLabel: hero.comparison.periodLabel }
          : undefined}
        trend={{
          values:    hero.customerDaysLostWeekly,
          domain:    "auto",
          ariaLabel: "Customer-days lost — last 12 weeks",
        }}
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
      {(() => {
        // Audit 5 #3 — surface the commitment-honor-rate gap when it
        // materially diverges from the raw on-time rate (cancellation
        // drag). Subtitle shows both numbers so leadership can't miss
        // a clean on-time rate hiding a high cancellation share.
        const gap = hero.onTimeRate != null && hero.commitmentHonorRate != null
          && hero.onTimeRate - hero.commitmentHonorRate >= 3
          ? hero.commitmentHonorRate
          : null;
        return (
          <HeroTile
            label="On-time rate"
            value={hero.onTimeRate === null ? "—" : `${hero.onTimeRate}%`}
            accent={
              hero.onTimeRate === null ? "neutral"
                : hero.onTimeRate >= 80 ? "green"
                : hero.onTimeRate >= 60 ? "gold"
                : "flame"
            }
            sub={gap !== null
              ? `delivered on time · honoring ${gap}% incl. cancellations`
              : "delivered on/before promise"}
            title={gap !== null
              ? `Raw on-time rate excludes cancellations from the denominator. The 'honor rate' (${gap}%) counts cancellations as missed commitments — the gap shows how much trust the cancellation rate is silently eating.`
              : "% of delivered batches that landed on or before the dealer-promised availability date."}
            delta={hero.comparison
              ? { d: hero.comparison.onTimeRate, mode: "pp", periodLabel: hero.comparison.periodLabel }
              : undefined}
            trend={{
              values:    hero.onTimeRateWeekly,
              domain:    "rate",
              ariaLabel: "On-time rate — last 12 weeks",
            }}
          />
        );
      })()}
      {(() => {
        // Audit 5 #5 — Re-promises split by booking state. When the
        // split is available, the HEADLINE becomes the post-booking
        // count (the trust-erosion number) and the subtitle keeps the
        // pre-booking count for context. Falls back to the unsplit
        // batch-level total on pre-migration DBs.
        const hasSplit = hero.rePromisesPreBooking !== null && hero.rePromisesPostBooking !== null;
        const headline = hasSplit ? hero.rePromisesPostBooking! : hero.rePromisesIssued;
        const sub = hasSplit
          ? hero.rePromisesPreBooking! > 0
            ? `after booking · ${hero.rePromisesPreBooking} before booking (internal)`
            : "after booking · no internal churn"
          : "date shifts issued";
        const accent = hasSplit
          ? hero.rePromisesPostBooking! > 0 ? "flame" : "neutral"
          : hero.rePromisesIssued > 0 ? "gold" : "neutral";
        const tipTitle = hasSplit
          ? `Date-shift events split by whether customer bookings existed at the moment of the shift. The headline is post-booking re-promises — the broken-trust number that drives customer-days lost. Pre-booking shifts (in the subtitle) are operationally normal: ops re-projecting before any customer was on the hook.`
          : "Sum of revision-count across all affected batches — every re-promise is trust erosion.";
        return (
          <HeroTile
            label="Re-promises"
            value={headline.toLocaleString()}
            accent={accent}
            sub={sub}
            title={tipTitle}
          />
        );
      })()}
      <HeroTile
        label="🚫 Cancelled"
        value={hero.cancelled.toLocaleString()}
        accent={hero.cancelled > 0 ? "flame" : "neutral"}
        sub="batches the dealer pulled"
      />
      {/* Listing-speed KPI (Review #2). Pairs the headline median
          with the count of overdue (>14d unlisted) so a healthy
          median can't hide a backlog growing in the open queue. */}
      <HeroTile
        label="📱 Days PO → Listed"
        value={hero.medianDaysToListed === null
          ? "—"
          : `${hero.medianDaysToListed}d`}
        accent={hero.medianDaysToListed === null
          ? "neutral"
          : hero.medianDaysToListed <= 7
            ? "green"
            : hero.medianDaysToListed <= 14
              ? "gold"
              : "flame"}
        // Audit 5 #4 — pair median with p90 to expose tail risk that
        // a healthy median can hide; surface the actionable unlisted
        // count when there is one.
        sub={(() => {
          const parts: string[] = ["median"];
          if (hero.p90DaysToListed !== null) parts.push(`p90 ${hero.p90DaysToListed}d`);
          if (hero.unlistedOverThreshold > 0) {
            parts.push(`${hero.unlistedOverThreshold} unlisted > 14d`);
          }
          return parts.length === 1 ? "median across listed batches" : parts.join(" · ");
        })()}
        title={hero.p90DaysToListed !== null
          ? `Median (typical) PO → app-listing days vs. p90 (slow tail). A healthy median with a large p90 means most batches list quickly but a minority take significantly longer — investigate those.`
          : "Median days from PO submission to App Listing across batches listed in scope."}
        delta={hero.comparison
          ? { d: hero.comparison.medianDaysToListed, mode: "pct", periodLabel: hero.comparison.periodLabel }
          : undefined}
        trend={{
          values:    hero.medianDaysToListedWeekly,
          domain:    "auto",
          ariaLabel: "Median days PO → Listed — last 12 weeks",
        }}
      />
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// Closure + volume strip — mirrors the Action Center summary tiles so
// the same operational headline numbers (Total cars, Listed, Delivered,
// Partly, Cancelled) are reachable from the unified Insights view.
// ──────────────────────────────────────────────────────────────────

function ClosureStrip({ closure }: { closure: ClosureSummary }) {
  const pct = (n: number) =>
    closure.totalQuantity === 0 ? 0 : Math.round((n / closure.totalQuantity) * 100);
  return (
    <section
      aria-label="Closure and volume summary"
      className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2"
    >
      <CompactMetric
        label="Total PO cars"
        value={closure.totalQuantity}
        accent="ink"
        valueColor="text-midnight"
        subtitle={`across ${closure.totalBatches} ${closure.totalBatches === 1 ? "batch" : "batches"}`}
        title="Total cars across every batch in scope (gross — includes cancelled units)."
      />
      <CompactMetric
        label="Listed on app"
        value={closure.listed}
        accent="brand"
        valueColor="text-brand-dark"
        subtitle={(() => {
          const main = `${closure.carsListed} / ${closure.totalQuantity} cars · ${pct(closure.carsListed)}%`;
          // "X confirmed · Y forecast-only" — confirmed = listed on a
          // post_po batch (normal flow); forecast-only = a pre_po batch
          // where Pre-PO App Listing was done before the PO arrived.
          const splitParts: string[] = [];
          if (closure.carsListedConfirmed > 0)    splitParts.push(`${closure.carsListedConfirmed} confirmed`);
          if (closure.carsListedForecastOnly > 0) splitParts.push(`${closure.carsListedForecastOnly} forecast-only`);
          return splitParts.length > 0 ? `${main} · ${splitParts.join(" · ")}` : main;
        })()}
        title="Batches marked live in the customer app. Subtitle: cars in those batches as a share of total PO quantity. The split shows cars listed through the standard Intake → list flow (confirmed) vs. cars listed pre-PO on Partnership's commitment (forecast-only)."
      />
      <CompactMetric
        label="Delivered"
        value={closure.delivered}
        accent="green"
        valueColor="text-green-dark"
        subtitle={`${closure.carsDelivered} / ${closure.totalQuantity} cars · ${pct(closure.carsDelivered)}%`}
        title="Batches formally closed as delivered. Subtitle: cars actually shipped as a share of total PO quantity."
      />
      <CompactMetric
        label="Partly delivered"
        value={closure.partlyDelivered}
        accent="gold"
        valueColor="text-gold-dark"
        subtitle={closure.partlyDelivered > 0
          ? `${closure.carsPartlyDelivered} shipped · ${closure.carsPartlyRequested - closure.carsPartlyDelivered} cancelled`
          : "—"}
        title="Batches where some units shipped but not all — includes in-flight partials and cancelled-after-partial."
      />
      <CompactMetric
        label="Cancelled"
        value={closure.cancelled}
        accent="flame"
        valueColor="text-flame-dark"
        subtitle={closure.cancelled > 0
          ? `${closure.carsCancelled} ${closure.carsCancelled === 1 ? "car" : "cars"} cancelled`
          : "—"}
        title="Batches closed with a cancellation reason. Subtitle: gross car count across cancelled batches."
      />
    </section>
  );
}

/**
 * Audit 7 — period-over-period delta caption under a hero value.
 *
 * Arrow follows the raw direction of the value (▲ up / ▼ down / → flat);
 * colour follows whether that move is *good* (green) or *bad* (flame),
 * which the data layer already decided in `KpiDelta.improved`. `mode`
 * picks the magnitude unit: "pct" = relative % change (customer-days,
 * median days), "pp" = percentage-point gap (on-time rate). Renders
 * nothing when there's no prior window to compare against.
 */
function DeltaCaption({
  d, mode, periodLabel,
}: {
  d: KpiDelta;
  mode: "pct" | "pp";
  periodLabel: ReportPeriod;
}) {
  if (d.current == null || d.prior == null) return null;
  const flat  = d.current === d.prior;
  const arrow = flat ? "→" : d.current > d.prior ? "▲" : "▼";
  const colorCls = d.improved == null
    ? "text-ink-400"
    : d.improved ? "text-green-dark" : "text-flame-dark";
  const mag = flat
    ? "no change"
    : mode === "pp"
      ? `${Math.abs(d.current - d.prior)}pp`
      : d.deltaPct == null ? "new" : `${Math.abs(d.deltaPct)}%`;
  return (
    <p className={cn("text-[0.6rem] font-semibold mt-0.5 leading-tight", colorCls)}>
      {arrow} {mag}{" "}
      <span className="text-ink-400 font-normal">vs prior {periodLabel}</span>
    </p>
  );
}

function HeroTile({
  label, value, sub, accent = "neutral", emphasis = false, trend, title, delta,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: "neutral" | "green" | "gold" | "flame";
  emphasis?: boolean;
  /**
   * Optional weekly trend (12 buckets, oldest first). When supplied,
   * renders a small sparkline beneath the headline value.
   * `domain` controls the y-axis: "rate" = 0-100, "auto" scales to
   * the max value in the series. (Audit 3 #7 + #10.)
   */
  trend?: {
    values: (number | null)[];
    domain: "rate" | "auto";
    ariaLabel: string;
  };
  /** Audit 5 — native tooltip surfaces the canonical metric definition. */
  title?: string;
  /** Audit 7 — period-over-period delta caption under the value. */
  delta?: { d: KpiDelta; mode: "pct" | "pp"; periodLabel: ReportPeriod };
}) {
  const valueCls = {
    neutral: "text-midnight",
    green:   "text-green-dark",
    gold:    "text-gold-dark",
    flame:   "text-flame-dark",
  }[accent];

  const strokeForAccent = {
    neutral: Brand.MIDNIGHT,
    green:   Brand.GREEN,
    gold:    Brand.YELLOW,
    flame:   Brand.ORANGE,
  }[accent];

  return (
    <div
      title={title}
      className={cn(
        "rounded-md border bg-white px-3 py-2.5",
        emphasis ? "border-flame border-2" : "border-ink-200",
      )}
    >
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
      {delta && <DeltaCaption {...delta} />}
      {trend && (() => {
        // Auto-domain: pick [0, max(1, max(values))] so a flat-zero
        // series doesn't crash the sparkline's range math.
        const nums = trend.values.filter((v): v is number => v != null);
        const max  = nums.length > 0 ? Math.max(...nums) : 0;
        const domain: [number, number] = trend.domain === "rate"
          ? [0, 100]
          : [0, Math.max(1, max)];
        return (
          <div className="mt-1">
            <Sparkline
              values={trend.values}
              stroke={strokeForAccent}
              domain={domain}
              baseline={trend.domain === "rate" ? 80 : null}
              width={120}
              height={20}
              ariaLabel={trend.ariaLabel}
            />
          </div>
        );
      })()}
      <p className="text-[0.65rem] text-ink-500 mt-0.5 leading-tight">{sub}</p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Upcoming at risk — proactive feed (Audit 3 #1 + #2)
// ──────────────────────────────────────────────────────────────────

function UpcomingAtRiskBlock({ rows }: { rows: UpcomingAtRiskRow[] }) {
  if (rows.length === 0) {
    return (
      <section className="card border-green/40 bg-green-pale/30">
        <h2 className="text-base font-bold text-green-dark">🚨 Upcoming at risk (next 30 days)</h2>
        <p className="text-sm text-ink-600 mt-2">
          🎉 No batches in the next 30 days are flagged at risk — every open batch is
          either post-VIN with comfortable runway or has a strong historical signal.
        </p>
      </section>
    );
  }

  const levelChip = (level: UpcomingAtRiskRow["confidenceLevel"]) => {
    const cls = {
      critical: "bg-flame-pale text-flame-dark border-flame",
      high:     "bg-gold-pale  text-gold-dark  border-gold",
      medium:   "bg-blue-pale  text-blue-dark  border-blue",
      low:      "bg-green-pale text-green-dark border-green",
    }[level];
    return (
      <span className={cn(
        "text-[0.6rem] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border",
        cls,
      )}>{level}</span>
    );
  };

  return (
    <section className="card">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 className="text-base font-bold text-midnight">🚨 Upcoming at risk (next 30 days)</h2>
        <span className="text-[0.7rem] text-ink-500 tabular-nums">
          {rows.length} batch{rows.length === 1 ? "" : "es"} · sorted by confidence ↑
        </span>
      </div>
      <p className="text-xs text-ink-500 mb-3">
        Open batches whose promise lands inside 30 days, scored 0–100 on a
        composite of runway, VIN phase, current delay, and historical risk.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[0.65rem] uppercase tracking-wide text-ink-500 border-b border-ink-200">
              <th className="py-1.5 pr-2">Batch</th>
              <th className="py-1.5 pr-2">Dealer / model</th>
              <th className="py-1.5 pr-2 text-right tabular-nums">Qty</th>
              <th className="py-1.5 pr-2 text-right tabular-nums">Promised</th>
              <th className="py-1.5 pr-2 text-right tabular-nums">Days</th>
              <th className="py-1.5 pr-2 text-right tabular-nums">Conf.</th>
              <th className="py-1.5">Why</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.batchCode} className="border-b border-ink-100 last:border-b-0 align-top">
                <td className="py-1.5 pr-2">
                  <code className="font-mono text-midnight">{r.batchCode}</code>
                  {r.poNumber && <div className="text-[0.6rem] text-ink-500">{r.poNumber}</div>}
                </td>
                <td className="py-1.5 pr-2">
                  <div className="text-midnight">{r.dealerName}</div>
                  <div className="text-[0.65rem] text-ink-500">{r.modelYear}</div>
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{r.quantity}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-ink-600">{r.promisedDate}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  {r.daysToAvailability == null
                    ? "—"
                    : r.daysToAvailability < 0
                      ? <span className="text-flame-dark">+{-r.daysToAvailability}d late</span>
                      : <span className="text-ink-700">{r.daysToAvailability}d</span>}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  <div className="flex items-center justify-end gap-1.5">
                    <span className="font-semibold text-midnight">{r.confidenceScore}</span>
                    {levelChip(r.confidenceLevel)}
                  </div>
                </td>
                <td className="py-1.5">
                  <ul className="text-[0.65rem] text-ink-600 leading-snug space-y-0.5">
                    {r.reasons.length === 0
                      ? <li className="italic text-ink-400">—</li>
                      : r.reasons.map((why, i) => <li key={i}>· {why}</li>)}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// Internal-phase per-action-type breakdown (Audit 2 #1)
// ──────────────────────────────────────────────────────────────────

function InternalPhaseBreakdown({ stats }: { stats: InternalPhaseActionStat[] }) {
  if (stats.length === 0) {
    return (
      <section className="card border-ink-200">
        <h2 className="text-base font-bold text-midnight">📱 Internal Phase — per stage</h2>
        <p className="text-sm text-ink-500 mt-2 italic">
          No Internal-Phase completions yet for this period. Will populate once
          Specs / Pricing / SKU / App Listing chips start landing.
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 className="text-base font-bold text-midnight">📱 Internal Phase — per stage</h2>
        <span className="text-[0.7rem] text-ink-500">PO scope · sorted by chip order</span>
      </div>
      <p className="text-xs text-ink-500 mb-3">
        Cumulative days from PO submission to each stage landing. Gaps between
        adjacent rows show where time pools — e.g. if SKU lands day 7 and App
        Listing lands day 11, the four extra days are waiting on listing after
        SKU is in.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[0.65rem] uppercase tracking-wide text-ink-500 border-b border-ink-200">
              <th className="py-1.5 pr-3">Stage</th>
              <th className="py-1.5 pr-3 text-right tabular-nums">Done</th>
              <th className="py-1.5 pr-3 text-right tabular-nums">Open</th>
              <th className="py-1.5 pr-3 text-right tabular-nums">Median days from submission</th>
              <th className="py-1.5 pr-3 text-right tabular-nums">Avg delay</th>
              <th className="py-1.5 pr-3 text-right tabular-nums">On-time</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.actionTypeId} className="border-b border-ink-100 last:border-b-0">
                <td className="py-1.5 pr-3 text-midnight">{s.actionTypeName}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-ink-700">{s.doneCount}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {s.openCount === 0
                    ? <span className="text-ink-400">0</span>
                    : <span className="text-gold-dark font-semibold">{s.openCount}</span>}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {s.medianDaysFromSubmission == null
                    ? <span className="text-ink-400">—</span>
                    : <span className="text-midnight font-semibold">{s.medianDaysFromSubmission}d</span>}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {s.avgDelayDays == null
                    ? <span className="text-ink-400">—</span>
                    : s.avgDelayDays > 0
                      ? <span className="text-flame-dark">+{s.avgDelayDays}d</span>
                      : s.avgDelayDays < 0
                        ? <span className="text-blue-dark">{s.avgDelayDays}d</span>
                        : <span className="text-green-dark">0d</span>}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {s.onTimeRate == null
                    ? <span className="text-ink-400">—</span>
                    : s.onTimeRate >= 80
                      ? <span className="text-green-dark font-semibold">{s.onTimeRate}%</span>
                      : s.onTimeRate >= 60
                        ? <span className="text-gold-dark font-semibold">{s.onTimeRate}%</span>
                        : <span className="text-flame-dark font-semibold">{s.onTimeRate}%</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// Stuck stages right now (Audit 2 #6)
// ──────────────────────────────────────────────────────────────────

function StuckStagesBlock({ rows }: { rows: StuckStageRow[] }) {
  if (rows.length === 0) {
    return (
      <section className="card border-green/40 bg-green-pale/30">
        <h2 className="text-base font-bold text-green-dark">🧱 Stuck stages right now</h2>
        <p className="text-sm text-ink-600 mt-2">
          🎉 No open actions in the system. Either nothing's in flight or
          every chip has landed — either way, no pile-ups.
        </p>
      </section>
    );
  }

  const scopeLabel = (s: StuckStageRow["scope"]) =>
    s === "po" ? "Internal" : s === "wave" ? "VIN chase" : "Batch close";
  const scopeTone = (s: StuckStageRow["scope"]) =>
    s === "po"    ? "bg-brand-pastel/40 text-brand-dark border-brand" :
    s === "wave"  ? "bg-gold-pale       text-gold-dark  border-gold"  :
                    "bg-ink-50          text-ink-700    border-ink-300";

  return (
    <section className="card">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 className="text-base font-bold text-midnight">🧱 Stuck stages right now</h2>
        <span className="text-[0.7rem] text-ink-500">
          {rows.length} type{rows.length === 1 ? "" : "s"} with open work · sorted by pile-up size
        </span>
      </div>
      <p className="text-xs text-ink-500 mb-3">
        Snapshot of every action_type with at least one open (waiting or blocked) row.
        Median + oldest age tell you whether a backlog is fresh churn or a long-standing pile.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[0.65rem] uppercase tracking-wide text-ink-500 border-b border-ink-200">
              <th className="py-1.5 pr-3">Stage</th>
              <th className="py-1.5 pr-3">Phase</th>
              <th className="py-1.5 pr-3 text-right tabular-nums">Open</th>
              <th className="py-1.5 pr-3 text-right tabular-nums">Blocked</th>
              <th className="py-1.5 pr-3 text-right tabular-nums">Median age</th>
              <th className="py-1.5 pr-3 text-right tabular-nums">Oldest</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.actionTypeId}-${r.scope}`} className="border-b border-ink-100 last:border-b-0">
                <td className="py-1.5 pr-3 text-midnight">{r.actionTypeName}</td>
                <td className="py-1.5 pr-3">
                  <span className={cn(
                    "text-[0.6rem] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border",
                    scopeTone(r.scope),
                  )}>
                    {scopeLabel(r.scope)}
                  </span>
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  <span className={cn(
                    "font-semibold",
                    r.openCount >= 10 ? "text-flame-dark" :
                    r.openCount >= 5  ? "text-gold-dark"  :
                    "text-ink-700",
                  )}>{r.openCount}</span>
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {r.blockedCount === 0
                    ? <span className="text-ink-400">0</span>
                    : <span className="text-flame-dark font-semibold">{r.blockedCount}</span>}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {r.medianAgeDays == null
                    ? <span className="text-ink-400">—</span>
                    : r.medianAgeDays >= 14
                      ? <span className="text-flame-dark font-semibold">{r.medianAgeDays}d</span>
                      : r.medianAgeDays >= 7
                        ? <span className="text-gold-dark font-semibold">{r.medianAgeDays}d</span>
                        : <span className="text-ink-700">{r.medianAgeDays}d</span>}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {r.oldestAgeDays == null
                    ? <span className="text-ink-400">—</span>
                    : r.oldestAgeDays >= 21
                      ? <span className="text-flame-dark">{r.oldestAgeDays}d</span>
                      : <span className="text-ink-600">{r.oldestAgeDays}d</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
          <SeverityBar label="Moderate (8–21d)" count={totals.moderate} pct={pct(totals.moderate)} tone="gold-pale" />
          <SeverityBar label="Severe (>21d)"    count={totals.severe}   pct={pct(totals.severe)}   tone="flame" />
        </div>
        <p className="text-[0.65rem] text-ink-500 mt-2">
          Realised: {totals.deliveredLateCount} delivered late · Projected: {totals.projectedLateCount} still open
        </p>
      </div>

      {/* Audit 3 #4 — by-reason breakdown of customer-days lost.
          Tells leadership *what kind* of slip is doing the damage, not
          just how much. "uncategorized" rolls up legacy shifts predating
          the reason-taxonomy capture so the total reconciles to 100%. */}
      <ImpactBreakdownBars
        title="By reason (customer-days lost)"
        totals={totals.customerDaysByReason}
        labels={REASON_LABELS}
        emptyHint="Reason taxonomy hasn't been captured yet — open a shift on the Action Center and pick a category to start populating this."
      />

      {/* Audit 3 #6 — by-phase breakdown. Same shape, but answers
          "which phase owned the work when the slip happened?" so ops
          can tell internal-side from external-side from pre-PO drift. */}
      <ImpactBreakdownBars
        title="By phase (customer-days lost)"
        totals={totals.customerDaysByPhase}
        labels={PHASE_LABELS}
        emptyHint="Phase attribution hasn't been recorded yet — run /api/admin/ensure-shift-phase-column once, then any new shifts will populate this."
      />

      {/* Top-impact batches table */}
      <CustomerImpactTable batches={batches} />
    </section>
  );
}

/**
 * Generic horizontal-bar breakdown for the customer-impact section.
 * Sorted descending by impact so the biggest contributor sits on top.
 * The "uncategorized" bucket always renders last (when present) with
 * a muted tone so legacy / untagged shifts don't visually compete with
 * the categorised data.
 *
 * Hides itself entirely when the totals map is empty — prevents an
 * empty bar block when the migration / capture hasn't run yet.
 */
function ImpactBreakdownBars({
  title, totals, labels, emptyHint,
}: {
  title: string;
  totals: Record<string, number>;
  labels: Record<string, string>;
  emptyHint: string;
}) {
  const entries = Object.entries(totals).filter(([, v]) => v > 0);
  const total   = entries.reduce((s, [, v]) => s + v, 0);
  if (total === 0) {
    return (
      <div className="px-4 py-3 border-b border-ink-200 bg-ink-50/40">
        <p className="text-[0.7rem] font-medium text-ink-600 uppercase tracking-wide mb-1">
          {title}
        </p>
        <p className="text-[0.65rem] text-ink-500 italic">{emptyHint}</p>
      </div>
    );
  }
  const sorted = entries.sort(([ak, av], [bk, bv]) => {
    // "uncategorized" always sinks to the bottom regardless of value.
    if (ak === "uncategorized") return 1;
    if (bk === "uncategorized") return -1;
    return bv - av;
  });
  return (
    <div className="px-4 py-3 border-b border-ink-200 bg-ink-50">
      <p className="text-[0.7rem] font-medium text-ink-600 uppercase tracking-wide mb-2">
        {title} · {total.toLocaleString()} days total
      </p>
      <div className="space-y-1.5">
        {sorted.map(([key, value]) => {
          const pct = Math.round((value / total) * 100);
          const label = labels[key] ?? key;
          const muted = key === "uncategorized";
          return (
            <div key={key} className="flex items-center gap-3">
              <span className={cn(
                "text-xs w-40 shrink-0",
                muted ? "text-ink-400 italic" : "text-ink-600",
              )}>
                {label}
              </span>
              <div className="flex-1 h-3 bg-ink-200 rounded overflow-hidden">
                <div
                  className={cn(
                    "h-full",
                    muted ? "bg-ink-300"
                      : pct >= 40 ? "bg-flame-dark"
                      : pct >= 20 ? "bg-gold"
                      : "bg-brand",
                  )}
                  style={{ width: `${Math.max(2, pct)}%` }}
                  aria-hidden="true"
                />
              </div>
              <span className="text-xs tabular-nums text-midnight w-24 text-right shrink-0">
                <span className="font-semibold">{value.toLocaleString()}</span>
                <span className="text-ink-400 ml-1">({pct}%)</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Labels match the ShiftReasonCategory enum from the batch-shift API.
const REASON_LABELS: Record<string, string> = {
  dealer_supply:  "🏭 Dealer supply",
  internal_specs: "📋 Internal specs",
  customs:        "🛃 Customs / shipping",
  logistics:      "🚚 Logistics",
  demand_change:  "🔁 Demand change",
  other:          "· Other",
  uncategorized:  "untagged",
};

// Labels match the ShiftPhase enum from the batch-shift API.
const PHASE_LABELS: Record<string, string> = {
  pre_po:        "🔮 Pre-PO (Partnership)",
  internal:      "📋 Internal phase",
  external:      "🚚 External phase",
  uncategorized: "untagged",
};

function SeverityBar({
  label, count, pct, tone,
}: {
  label: string; count: number; pct: number;
  tone: "gold" | "gold-pale" | "flame";
}) {
  const barCls = tone === "gold" ? "bg-gold"
    : tone === "gold-pale" ? "bg-gold/60"
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
  // Audit 3 #9 — multi-leg expand state. Only batches with >1 leg are
  // expandable; single-leg batches show no chevron. Storing the open
  // set on the table component (not per-row) keeps the toggle stateful
  // across the re-renders that period switching triggers.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  function toggle(batchId: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  }
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
          {top.map((b) => {
            const hasLegs = b.legs.length > 1;
            const isOpen = expanded.has(b.batchId);
            return (
              <React.Fragment key={b.batchId}>
                <tr className="border-b border-ink-200/60">
                  <Td>
                    <div className="flex items-center gap-1.5">
                      {hasLegs && (
                        <button
                          type="button"
                          onClick={() => toggle(b.batchId)}
                          aria-expanded={isOpen}
                          aria-label={isOpen ? "Hide leg breakdown" : "Show leg breakdown"}
                          className="text-ink-400 hover:text-midnight text-[0.65rem] w-3 shrink-0"
                          title={isOpen ? "Hide per-city breakdown" : `Show per-city breakdown (${b.legs.length} legs)`}
                        >
                          {isOpen ? "▾" : "▸"}
                        </button>
                      )}
                      <code className="font-mono text-midnight text-xs">{b.batchCode}</code>
                      {hasLegs && !isOpen && (
                        <span
                          className="text-[0.6rem] text-ink-500"
                          title="Multi-city batch — click ▸ to see per-city breakdown."
                        >
                          {b.legs.length} legs
                        </span>
                      )}
                    </div>
                  </Td>
                  <Td>
                    <div className="font-medium">{b.dealerName}</div>
                    <div className="text-[0.7rem] text-ink-500">{b.modelYear}</div>
                  </Td>
                  <Td align="right" tabular>{b.quantity}</Td>
                  <Td align="right" tabular>
                    <span className="font-semibold text-gold-dark">+{b.delayDays}d</span>
                  </Td>
                  <Td align="right" tabular>
                    <span className="font-bold text-gold-dark">{b.customerDaysImpact.toLocaleString()}</span>
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
                {hasLegs && isOpen && (
                  <tr className="bg-ink-50/40 border-b border-ink-200/60">
                    <td colSpan={7} className="px-4 py-2">
                      <p className="text-[0.6rem] font-semibold uppercase tracking-wide text-ink-500 mb-1.5">
                        Per-city breakdown — bottleneck is the row with the most pending cars
                      </p>
                      <table className="w-full text-[0.7rem]">
                        <thead className="text-ink-500">
                          <tr className="text-left">
                            <th className="px-2 py-1 font-medium">City</th>
                            <th className="px-2 py-1 font-medium text-right">Requested</th>
                            <th className="px-2 py-1 font-medium text-right">Delivered</th>
                            <th className="px-2 py-1 font-medium text-right">Pending</th>
                            <th className="px-2 py-1 font-medium text-right">Fulfilment</th>
                          </tr>
                        </thead>
                        <tbody>
                          {b.legs
                            // Sort by pending descending — biggest bottleneck first.
                            .slice()
                            .sort((x, y) => y.pendingQuantity - x.pendingQuantity)
                            .map((leg) => {
                              const fulfilment = leg.requestedQuantity === 0
                                ? null
                                : Math.round((leg.deliveredQuantity / leg.requestedQuantity) * 100);
                              const isStuck = leg.pendingQuantity > 0 && b.state === "projected_late";
                              return (
                                <tr key={leg.city} className="border-t border-ink-200/60">
                                  <td className={cn(
                                    "px-2 py-1",
                                    isStuck ? "text-flame-dark font-medium" : "text-midnight",
                                  )}>
                                    {leg.city}
                                  </td>
                                  <td className="px-2 py-1 text-right tabular-nums text-ink-600">
                                    {leg.requestedQuantity}
                                  </td>
                                  <td className="px-2 py-1 text-right tabular-nums">
                                    {leg.deliveredQuantity > 0
                                      ? <span className="text-green-dark font-medium">{leg.deliveredQuantity}</span>
                                      : <span className="text-ink-400">0</span>}
                                  </td>
                                  <td className="px-2 py-1 text-right tabular-nums">
                                    {leg.pendingQuantity === 0
                                      ? <span className="text-green-dark">0</span>
                                      : <span className="text-flame-dark font-semibold">{leg.pendingQuantity}</span>}
                                  </td>
                                  <td className="px-2 py-1 text-right tabular-nums">
                                    {fulfilment == null
                                      ? <span className="text-ink-400">—</span>
                                      : <span className={cn(
                                          "font-medium",
                                          fulfilment === 100 ? "text-green-dark"
                                            : fulfilment >= 50 ? "text-gold-dark"
                                            : "text-flame-dark",
                                        )}>{fulfilment}%</span>}
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
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
  active, onChange, report, forecastReliability,
}: {
  active: TrustTab;
  onChange: (t: TrustTab) => void;
  report: InsightsData["report"];
  forecastReliability: ForecastReliabilityRow[];
}) {
  return (
    <section className="card p-0 overflow-hidden">
      <header className="px-4 py-3 border-b border-ink-200">
        <h2 className="text-base font-bold text-midnight">🤝 Trust</h2>
        <p className="text-xs text-ink-500 mt-0.5">
          Why we're slipping — five lenses: who we partner with, how we
          execute internally, how well the risk engine catches problems,
          and how reliable Partnership's pre-PO commitments are.
        </p>
      </header>

      {/* Fluent UI v9 TabList — replaces the home-rolled TrustTabButton
          row. `appearance="subtle"` is closest to our previous
          underline-on-active look; FluentProvider above supplies the
          theme tokens. */}
      <div className="border-b border-ink-200 bg-ink-50 px-2 overflow-x-auto">
        <TabList
          selectedValue={active}
          onTabSelect={(_, d) => onChange(d.value as TrustTab)}
          appearance="subtle"
        >
          <Tab value="dealer">Dealer Reliability</Tab>
          <Tab value="ops">Ops Performance</Tab>
          <Tab value="cities">Cities</Tab>
          <Tab value="forecast">Forecast Reliability</Tab>
          <Tab value="po">PO Reliability</Tab>
          <Tab value="risk">Risk Engine</Tab>
        </TabList>
      </div>

      <div className="p-3">
        {active === "dealer"   && <DealerTab rows={report.dealerReliability} />}
        {active === "ops"      && <OpsTab depts={report.departments} stakeholders={report.stakeholders} />}
        {active === "cities"   && <CitiesTab rows={report.cityReliability} />}
        {active === "forecast" && <ForecastReliabilityTab rows={forecastReliability} />}
        {active === "po"       && <PoReliabilityTab rows={report.poReliability} />}
        {active === "risk"     && <RiskTab report={report} />}
      </div>
    </section>
  );
}

function ForecastReliabilityTab({ rows }: { rows: ForecastReliabilityRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-500 italic px-2 py-4">
        No Forecasts submitted in this period yet. Forecasts created on the Forecast page will show up here grouped by submitter.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-600 px-1 leading-snug">
        Per-Partnership-member accuracy on pre-PO commitments. <strong>Drift</strong> = days between
        forecast submission and signed PO; pair the average with <strong>p90</strong> to expose tail risk a
        clean average can hide. <strong>Model swap</strong> tracks when the dealer pivoted between the
        forecast and the signed PO. <strong>Bookings</strong> is the total customer exposure each user
        generated against their pre-PO bets — high values mean cancellations / mis-forecasts hurt real
        customers.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-[0.65rem] text-ink-500 uppercase tracking-wide">
            <tr>
              <Th>Partnership member</Th>
              <Th align="right">Submitted</Th>
              <Th align="right">Fulfilled</Th>
              <Th align="right">Split</Th>
              <Th align="right">Cancelled</Th>
              <Th align="right">Open</Th>
              <Th align="right">Avg drift</Th>
              <Th align="right">p90 drift</Th>
              <Th align="right">Model swap %</Th>
              <Th align="right">Bookings</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const realized = r.fulfilled + r.superseded;
              const ratio = r.submitted === 0 ? 0 : Math.round((realized / r.submitted) * 100);
              return (
                <tr key={r.userId} className="border-t border-ink-200/60">
                  <Td>
                    <span className="font-medium text-midnight">{r.name}</span>
                    <span className="text-[0.65rem] text-ink-500 ml-2 tabular-nums">{ratio}% realized</span>
                  </Td>
                  <Td align="right" tabular>{r.submitted}</Td>
                  <Td align="right" tabular>{r.fulfilled}</Td>
                  <Td align="right" tabular>{r.superseded}</Td>
                  <Td align="right" tabular>{r.cancelled}</Td>
                  <Td align="right" tabular>{r.open}</Td>
                  <Td align="right" tabular>
                    <DriftCell days={r.avgDriftDays} />
                  </Td>
                  <Td align="right" tabular>
                    {r.p90DriftDays == null
                      ? <span className="text-ink-400" title="Need ≥ 3 fulfilled forecasts for a meaningful p90.">—</span>
                      : <DriftCell days={r.p90DriftDays} />}
                  </Td>
                  <Td align="right" tabular>
                    {r.modelSwapRate == null
                      ? <span className="text-ink-400" title="No realized forecasts with model data on both sides.">—</span>
                      : <span
                          title={`${r.modelSwapRate}% of this user's 1:1 fulfilled forecasts had the dealer pivot the car model between forecast and signed PO.`}
                          className={cn(
                            "font-medium",
                            r.modelSwapRate === 0  ? "text-green-dark"
                              : r.modelSwapRate <= 20 ? "text-gold-dark"
                              : "text-flame-dark",
                          )}>
                          {r.modelSwapRate}%
                        </span>}
                  </Td>
                  <Td align="right" tabular>
                    {r.totalBookings === 0
                      ? <span className="text-ink-400">0</span>
                      : <span
                          title={`${r.totalBookings} customer bookings landed against this user's pre-PO commitments. High values mean cancellations / mis-forecasts hurt real customers.`}
                          className={cn(
                            "font-medium",
                            r.totalBookings >= 20 ? "text-flame-dark"
                              : r.totalBookings >= 5 ? "text-gold-dark"
                              : "text-ink-600",
                          )}>
                          {r.totalBookings}
                        </span>}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Drift cell with tone: 0d green, |d| ≤ 7 gold, else flame. */
function DriftCell({ days }: { days: number | null }) {
  if (days == null) return <span className="text-ink-400">—</span>;
  const abs = Math.abs(days);
  const cls =
    days === 0 ? "text-green-dark"
      : abs <= 7  ? "text-gold-dark"
      : "text-flame-dark";
  const text = days > 0 ? `+${days}d` : `${days}d`;
  return <span className={cn("font-medium tabular-nums", cls)}>{text}</span>;
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
        // Slightly more breathing room + Fluent-style reveal: the
        // background eases in with a brand tint rather than a flat
        // grey, so the hover state previews the active state.
        "px-4 py-2 text-sm font-medium border-b-2 -mb-px",
        "transition-[background-color,color,border-color] duration-200",
        isActive
          ? "border-brand text-brand-dark bg-white shadow-[inset_0_-2px_0_rgba(0,0,0,0)]"
          : "border-transparent text-ink-600 hover:text-midnight hover:bg-brand-pastel/40",
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
            <Th align="right">List d</Th>
            <Th align="right">List on-time</Th>
            <Th align="right">PO Score</Th>
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
              <Td align="right" tabular>
                {d.medianDaysToListed == null
                  ? <span className="text-ink-400">—</span>
                  : <span className={cn(
                      "font-medium tabular-nums",
                      d.medianDaysToListed <= 7  ? "text-green-dark" :
                      d.medianDaysToListed <= 14 ? "text-gold-dark" :
                      "text-flame-dark",
                    )}>{d.medianDaysToListed}d</span>}
              </Td>
              <Td align="right" tabular><RateChip rate={d.listingOnTimeRate} /></Td>
              <Td align="right" tabular>
                <DealerPoScoreCell
                  mean={d.poReliabilityMean}
                  weighted={d.poReliabilityCarWeighted}
                  n={d.poReliabilityPoCount}
                />
              </Td>
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

/**
 * Audit 4 #2 — Dealer PO Reliability rollup cell.
 *
 * Headline is the car-weighted composite — the number leadership
 * should trust, since it can't be inflated by a handful of tiny
 * perfect POs. Secondary mention of the unweighted mean appears
 * when the two diverge by ≥ 3 points (uneven PO sizes signal). The
 * `n=2` style hint flags small-sample cells so a one-PO dealer
 * isn't read as authoritative.
 */
function DealerPoScoreCell({
  mean, weighted, n,
}: { mean: number | null; weighted: number | null; n: number }) {
  if (weighted == null || n === 0) return <span className="text-ink-400">—</span>;
  const cls =
    weighted >= 80 ? "text-green-dark font-semibold" :
    weighted >= 60 ? "text-brand-dark font-medium" :
    weighted >= 40 ? "text-gold-dark font-medium" :
    "text-flame-dark font-semibold";
  const showDelta = mean != null && Math.abs(mean - weighted) >= 3;
  const title =
    `Car-weighted mean across ${n} PO${n === 1 ? "" : "s"} (large POs carry more weight)` +
    (showDelta && mean != null
      ? `. Unweighted mean: ${mean}. The gap means this dealer's PO sizes are uneven — trust the car-weighted number.`
      : ".") +
    (n < 3 ? " ⚠ Small sample — interpret with caution." : "");
  return (
    <span className={cn("tabular-nums", cls)} title={title}>
      {weighted}
      {showDelta && mean != null && (
        <span className="text-[0.65rem] text-ink-400 ml-0.5 font-normal">
          (mean {mean})
        </span>
      )}
      {n < 3 && (
        <span className="text-[0.6rem] text-gold-dark ml-0.5 font-normal italic">
          n={n}
        </span>
      )}
    </span>
  );
}

// Tab 2 — Ops performance (departments + stakeholders)
function OpsTab({
  depts, stakeholders,
}: {
  depts: DepartmentRow[]; stakeholders: StakeholderRow[];
}) {
  return (
    <div className="space-y-5">
      {/* Audit 2 #3 — Departments row carries an internal/external
          phase split so a dept lead can see which side of the
          handoff is failing without doing the math from Action
          Center themselves. Stakeholders intentionally don't get
          the split (the role view is about who, not which phase). */}
      <PerfTable title="Departments" rows={depts.map((d) => ({
        primary: d.name, secondary: null, row: d, key: `d-${d.id}`,
        phaseSplit: {
          internalOnTime: d.internal.onTimeRate,
          internalTotal:  d.internal.totalActions,
          externalOnTime: d.external.onTimeRate,
          externalTotal:  d.external.totalActions,
        },
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
  /**
   * Audit 2 #3 — optional internal/external phase split rendered as a
   * small caption under the on-time cell. Only populated for
   * Department rows; stakeholder rows leave this undefined and the
   * cell renders unchanged.
   */
  phaseSplit?: {
    internalOnTime: number | null;
    internalTotal:  number;
    externalOnTime: number | null;
    externalTotal:  number;
  };
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
            ) : rows.map(({ key, primary, secondary, row, phaseSplit }) => (
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
                  {phaseSplit && <PhaseSplitCaption split={phaseSplit} />}
                </Td>
                <Td align="right" tabular><DelayValue days={row.avgDelayDays} /></Td>
                <Td align="right" tabular><DelayValue days={row.worstDelayDays} bold /></Td>
                <Td align="right" tabular>
                  {row.delayedBatchesOwned > 0
                    ? <span className="font-semibold text-gold-dark">{row.delayedBatchesOwned}</span>
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

/**
 * Audit 2 #3 — small two-line caption rendered under a department's
 * blended on-time rate showing the internal vs external split.
 * Each side is tone-coloured the same way as the headline so the eye
 * can spot a green-headline-with-red-external mismatch immediately
 * (the "we look fine overall but our external side is failing" signal).
 *
 * Hidden when neither phase has any action data — keeps the cell
 * compact for departments that haven't accumulated activity yet.
 */
function PhaseSplitCaption({
  split,
}: {
  split: {
    internalOnTime: number | null;
    internalTotal:  number;
    externalOnTime: number | null;
    externalTotal:  number;
  };
}) {
  if (split.internalTotal === 0 && split.externalTotal === 0) return null;
  const toneCls = (rate: number | null) =>
    rate == null   ? "text-ink-400"
    : rate >= 90   ? "text-green-dark"
    : rate >= 75   ? "text-gold-dark"
    : "text-flame-dark";
  const cell = (label: string, rate: number | null, total: number) => {
    if (total === 0) return <span className="text-ink-300">{label} —</span>;
    return (
      <span
        className={cn("font-medium", toneCls(rate))}
        title={`${label} phase — ${total} action${total === 1 ? "" : "s"}${
          rate == null ? "" : `, ${rate}% on-time`
        }`}
      >
        {label} {rate == null ? "—" : `${rate}%`}
      </span>
    );
  };
  return (
    <div className="text-[0.6rem] text-ink-500 mt-0.5 tabular-nums flex gap-1.5 justify-end">
      {cell("i", split.internalOnTime, split.internalTotal)}
      <span className="text-ink-300">·</span>
      {cell("e", split.externalOnTime, split.externalTotal)}
    </div>
  );
}

/**
 * Tab — PO Reliability (Review #4 R1+R2+R3+R6).
 *
 * Per-PO composite 0–100 score with 5 components, plus a sibling
 * Ops Reliability score using the locked Ops projection anchor.
 * `opsAddedValue = ops − po` quantifies "did ops's first projection
 * land closer to reality than the original PO commitment?".
 *
 * Sorted ascending by PO score so the most problematic POs surface
 * to the top — same triage pattern as the Customer Impact tab.
 */
function PoReliabilityTab({ rows }: { rows: PoReliabilityRowFull[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-500 italic px-2 py-4">
        No closed POs yet. PO Reliability becomes computable once at
        least one PO has reached a closed state.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-600">
        Per-PO 0–100 composite score across <em>Date · Qty · Color ·
        Cancellation · Stability</em>. Two parallel scores:{" "}
        <span className="text-brand-dark font-medium">PO</span> uses
        the original partnership-dealer commitment;{" "}
        <span className="text-gold-dark font-medium">Ops</span> uses
        ops&apos;s first locked projection. The{" "}
        <span className="text-ink-500">+ value</span> column =
        Ops − PO (positive means ops knew earlier than the PO
        suggested).
      </p>
      <div className="overflow-x-auto border border-ink-200 rounded-md">
        <table className="w-full text-xs">
          <thead className="bg-ink-50 text-[0.65rem] text-ink-500 uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2">PO</th>
              <th className="text-left px-3 py-2">Dealer</th>
              <th className="text-right px-3 py-2" title="PO Reliability composite (0-100)">PO Score</th>
              <th className="text-right px-3 py-2" title="Ops Reliability composite (0-100)">Ops Score</th>
              <th className="text-right px-3 py-2" title="Ops − PO. Positive = ops projected earlier than PO suggested.">Δ</th>
              <th className="text-right px-3 py-2">Date</th>
              <th className="text-right px-3 py-2">Qty</th>
              <th className="text-right px-3 py-2">Color</th>
              <th className="text-right px-3 py-2">Cancel</th>
              <th className="text-right px-3 py-2">Stability</th>
              <th className="text-right px-3 py-2">Closed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.poNumber}:${r.poId}`} className="border-t border-ink-200/60">
                <td className="px-3 py-2 font-mono text-[0.7rem] text-midnight">
                  {r.poNumber}
                  {!r.fullyClosed && (
                    <span className="ml-1 text-[0.6rem] text-gold-dark italic">
                      partial
                    </span>
                  )}
                  {/* Audit 1 #4 — closure outcome badge. Derived from
                      batches under the PO; only shows when something
                      meaningful has happened (open is implicit by
                      absence of "delivered" / "partial" / "cancelled"). */}
                  {r.closureOutcome !== "open" && (
                    <span className={cn(
                      "ml-1 text-[0.6rem] font-semibold px-1.5 py-0.5 rounded border whitespace-nowrap",
                      r.closureOutcome === "delivered_in_full"     && "border-green text-green-dark bg-green-pale",
                      r.closureOutcome === "partly_delivered"      && "border-gold  text-gold-dark  bg-gold-pale",
                      r.closureOutcome === "cancelled_mid_flight"  && "border-flame text-flame-dark bg-flame-pale",
                    )}>
                      {r.closureOutcome === "delivered_in_full"
                        ? "✓ in full"
                        : r.closureOutcome === "partly_delivered"
                          ? "⚠ partial"
                          : "🚫 cancelled"}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-midnight">{r.dealerName}</td>
                <td className="px-3 py-2 text-right">
                  <ScoreCell value={r.po.composite} />
                </td>
                <td className="px-3 py-2 text-right">
                  <ScoreCell value={r.ops.composite} tone="gold" />
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  <span className={cn(
                    "font-medium",
                    r.opsAddedValue > 0 ? "text-green-dark" :
                    r.opsAddedValue < 0 ? "text-flame-dark" :
                    "text-ink-500",
                  )}>
                    {r.opsAddedValue > 0 ? `+${r.opsAddedValue}` : r.opsAddedValue}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-600">
                  {Math.round(r.po.components.date)}
                  {r.po.dateVarianceDays != null && (
                    <span className="text-[0.6rem] text-ink-400 ml-0.5">
                      ({r.po.dateVarianceDays > 0 ? "+" : ""}{r.po.dateVarianceDays}d)
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-600">
                  {Math.round(r.po.components.qty)}
                  <span className="text-[0.6rem] text-ink-400 ml-0.5">
                    ({r.raw.deliveredCars}/{r.raw.requestedCars})
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-600">
                  {Math.round(r.po.components.color)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-600">
                  {Math.round(r.po.components.cancellation)}
                  {r.raw.cancelledCars > 0 && (
                    <span className="text-[0.6rem] text-flame-dark ml-0.5">
                      ({r.raw.cancelledCars} cars)
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-600">
                  {Math.round(r.po.components.stability)}
                  {r.raw.shiftCount > 0 && (
                    <span className="text-[0.6rem] text-gold-dark ml-0.5">
                      ({r.raw.shiftCount} shifts)
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-500">
                  {r.closedAt ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Compact 0-100 score cell with tone-by-band coloring. */
function ScoreCell({ value, tone = "brand" }: { value: number; tone?: "brand" | "gold" }) {
  const cls =
    value >= 80 ? "text-green-dark font-bold" :
    value >= 60 ? (tone === "gold" ? "text-gold-dark font-semibold" : "text-brand-dark font-semibold") :
    value >= 40 ? "text-gold-dark font-medium" :
    "text-flame-dark font-bold";
  return (
    <span className={cn("tabular-nums", cls)}>
      {value}
    </span>
  );
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
            <Th align="right">Pending</Th>
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
              <Td align="right" tabular>
                {/* Audit 3 #9 — pending cars + open batches. Surfaces
                    in-flight backlog so leadership can spot which
                    cities are absorbing the most undelivered inventory
                    right now (not just historical fulfilment rates). */}
                {c.pendingCars === 0
                  ? <span className="text-ink-400">0</span>
                  : <span
                      title={`${c.pendingCars} car${c.pendingCars === 1 ? "" : "s"} pending across ${c.pendingBatches} open batch${c.pendingBatches === 1 ? "" : "es"}.`}
                      className={cn(
                        "font-semibold",
                        c.pendingCars >= 20 ? "text-flame-dark"
                          : c.pendingCars >= 5 ? "text-gold-dark"
                          : "text-ink-700",
                      )}
                    >
                      {c.pendingCars}
                      <span className="text-[0.65rem] text-ink-400 ml-0.5 font-normal">
                        / {c.pendingBatches}b
                      </span>
                    </span>}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 py-2 text-[0.65rem] text-ink-500 bg-ink-50/40 border-t border-ink-200">
        <strong>Pending</strong> = cars committed to this city on still-open batches, with the count of distinct open batches after the slash. Drives the "which city has the most stuck inventory" lens.
      </p>
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

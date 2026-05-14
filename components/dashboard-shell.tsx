"use client";

/**
 * Dashboard shell — owns filter state and fetches the selected timeline.
 *
 * The page server-renders `rows` (from `getDashboardRows()`) and passes
 * them in. Filtering, sorting, and selection are pure client work — no
 * round-trips. Timeline data for the drawer is fetched once per selection
 * via /api/timeline?code=...
 */
import { useEffect, useMemo, useState } from "react";
import type {
  DashboardRow, StatusBucket, TimelineData, TimelineActivity,
} from "@/lib/dashboard-data";
import BatchTable from "./batch-table";
import PageHeader from "./page-header";
import TimelineSvg from "./timeline-svg";
import { cn } from "@/lib/utils";

interface Props {
  rows: DashboardRow[];
  totals: { total: number; active: number; delivered: number; delayed: number; onTrack: number; highRisk: number };
}

const STATUS_OPTIONS: { value: StatusBucket; label: string }[] = [
  { value: "on_track",  label: "🟢 On track" },
  { value: "ahead",     label: "🔵 Ahead" },
  { value: "delayed",   label: "🔴 Delayed" },
  { value: "delivered", label: "🎉 Delivered" },
];

const RISK_OPTIONS = [
  { value: "all",    label: "All" },
  { value: "high",   label: "High (≥75)" },
  { value: "medium", label: "Medium (40–74)" },
  { value: "low",    label: "Low (<40)" },
] as const;
type RiskOption = (typeof RISK_OPTIONS)[number]["value"];

const VIN_PHASE_OPTIONS = [
  { value: "all",      label: "All phases" },
  { value: "pre_vin",  label: "⚠️ Pre-VIN (high risk)" },
  { value: "post_vin", label: "✅ Post-VIN (execution)" },
] as const;
type VinPhaseOption = (typeof VIN_PHASE_OPTIONS)[number]["value"];

export default function DashboardShell({ rows, totals }: Props) {
  // ── Filter state ────────────────────────────────────────────
  const [search,        setSearch]       = useState<string>("");
  const [dealerFilter, setDealerFilter] = useState<string>("all");
  const [activeOnly,    setActiveOnly]   = useState<boolean>(true);
  const [stageFilter,   setStageFilter]  = useState<string>("all");
  const [modelFilter,   setModelFilter]  = useState<string>("all");
  const [statusFilter,  setStatusFilter] = useState<StatusBucket | "all">("all");
  const [riskFilter,    setRiskFilter]   = useState<RiskOption>("all");
  const [vinPhaseFilter, setVinPhaseFilter] = useState<VinPhaseOption>("all");

  const [selected,  setSelected]  = useState<string | null>(null);
  const [timeline,  setTimeline]  = useState<TimelineData | null>(null);
  const [tlBusy,    setTlBusy]    = useState<boolean>(false);
  const [tlError,   setTlError]   = useState<string | null>(null);

  // ── Filter option pools (derived from full data) ────────────
  const dealerOptions = useMemo(
    () => unique(rows.map((r) => r.dealerName)).sort(),
    [rows],
  );
  const stageOptions = useMemo(
    () => unique(rows.map((r) => r.stageDisplay)).sort(),
    [rows],
  );
  const modelOptions = useMemo(
    () => unique(rows.map((r) => r.modelYear)).sort(),
    [rows],
  );

  // ── Filtered rows ──────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q) {
        const hay = `${r.batchCode} ${r.poNumber ?? ""} ${r.dealerName} ${r.modelYear}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (dealerFilter !== "all" && r.dealerName !== dealerFilter) return false;
      if (activeOnly && r.status === "delivered") return false;
      if (stageFilter !== "all" && r.stageDisplay !== stageFilter) return false;
      if (modelFilter !== "all" && r.modelYear !== modelFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (riskFilter === "high"   && r.risk < 75) return false;
      if (riskFilter === "medium" && (r.risk < 40 || r.risk >= 75)) return false;
      if (riskFilter === "low"    && r.risk >= 40) return false;
      if (vinPhaseFilter !== "all" && r.vinPhase !== vinPhaseFilter) return false;
      return true;
    });
  }, [rows, search, dealerFilter, activeOnly, stageFilter, modelFilter, statusFilter, riskFilter, vinPhaseFilter]);

  // ── Hydrate timeline whenever selection changes ─────────────
  useEffect(() => {
    if (!selected) {
      setTimeline(null);
      setTlError(null);
      return;
    }
    let cancelled = false;
    setTlBusy(true);
    setTlError(null);
    fetch(`/api/timeline?code=${encodeURIComponent(selected)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.json() as Promise<TimelineData>;
      })
      .then((data) => { if (!cancelled) setTimeline(data); })
      .catch((e) => { if (!cancelled) setTlError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setTlBusy(false); });
    return () => { cancelled = true; };
  }, [selected]);

  // ── Render ──────────────────────────────────────────────────
  return (
    <div>
      <PageHeader
        view="Dashboard"
        subtitle="Filter the requests below, then click a row to view its Plan vs Reality timeline. Plan is locked at submission; Reality fills in as actuals come — gaps show where delays sit."
      />

      {/* Metric strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <Metric label="Active batches"     value={totals.active} />
        <Metric label="On track"           value={totals.onTrack} valueColor="text-green-dark" />
        <Metric label="Delayed"            value={totals.delayed} valueColor="text-flame-dark" />
        <Metric label="Delivered"          value={totals.delivered} valueColor="text-ink-600" />
        <Metric
          label="⚠️ Pre-VIN critical"
          value={totals.highRisk}
          valueColor={totals.highRisk > 0 ? "text-flame-dark" : "text-ink-400"}
          title="Active batches that are pre-VIN with ≤ 14 days to availability — need immediate action"
        />
      </div>

      {/* Top-level filters */}
      <div className="card mb-4 space-y-3">
        <label className="block">
          <span className="block text-xs font-medium text-ink-600 mb-1">🔎 Search</span>
          <div className="relative">
            <input
              className="input pr-9"
              placeholder="PO number, dealer, model — partial matches OK"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-midnight
                           text-sm rounded px-1.5 py-0.5"
              >
                ×
              </button>
            )}
          </div>
        </label>
        <div className="grid grid-cols-1 md:grid-cols-[1fr,auto] gap-3 items-end">
          <Select
            label="🏢 Dealer"
            value={dealerFilter}
            onChange={setDealerFilter}
            options={[{ value: "all", label: "All dealers" }, ...dealerOptions.map((d) => ({ value: d, label: d }))]}
          />
          <label className="flex items-center gap-2 text-sm text-midnight cursor-pointer select-none mb-0.5">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
              className="h-4 w-4 accent-brand"
            />
            Active only
          </label>
        </div>
      </div>

      {/* Table-level filters */}
      <div className="card mb-4">
        <p className="text-xs font-medium text-ink-500 mb-2 uppercase tracking-wide">Table filters</p>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Select
            label="Stage"
            value={stageFilter}
            onChange={setStageFilter}
            options={[{ value: "all", label: "All" }, ...stageOptions.map((s) => ({ value: s, label: s }))]}
          />
          <Select
            label="Model"
            value={modelFilter}
            onChange={setModelFilter}
            options={[{ value: "all", label: "All" }, ...modelOptions.map((m) => ({ value: m, label: m }))]}
          />
          <Select
            label="Status"
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as StatusBucket | "all")}
            options={[{ value: "all", label: "All" }, ...STATUS_OPTIONS]}
          />
          <Select
            label="Risk level"
            value={riskFilter}
            onChange={(v) => setRiskFilter(v as RiskOption)}
            options={[...RISK_OPTIONS]}
          />
          <Select
            label="VIN phase"
            value={vinPhaseFilter}
            onChange={(v) => setVinPhaseFilter(v as VinPhaseOption)}
            options={[...VIN_PHASE_OPTIONS]}
          />
        </div>
      </div>

      {/* Table */}
      <BatchTable
        rows={filtered}
        selectedCode={selected}
        onSelect={(code) => setSelected((cur) => (cur === code ? null : code))}
        totalCount={rows.length}
      />

      {/* Timeline drawer — appears below the table */}
      <div className="mt-6">
        {!selected ? (
          <p className="text-sm text-ink-500 px-1">
            👆 Click a row in the table above to view its Plan vs Reality timeline.
          </p>
        ) : tlBusy ? (
          <p className="text-sm text-ink-500 px-1">Loading timeline…</p>
        ) : tlError ? (
          <p
            role="alert"
            className="text-sm text-flame-dark bg-flame-pale border border-flame px-3 py-2 rounded-md"
          >
            Could not load timeline: {tlError}
          </p>
        ) : timeline ? (
          <TimelineCard data={timeline} />
        ) : null}
      </div>
    </div>
  );
}

// ── Metric tile ─────────────────────────────────────────────────

function Metric({
  label, value, valueColor, title,
}: {
  label: string;
  value: number;
  valueColor?: string;
  title?: string;
}) {
  return (
    <div className="metric" title={title}>
      <span className="metric-label">{label}</span>
      <span className={cn("metric-value", valueColor)}>{value}</span>
    </div>
  );
}

// ── Select (lightweight, label-above) ───────────────────────────

function Select({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-ink-600 mb-1">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

// ── Timeline card (header chips + SVG) ──────────────────────────

function TimelineCard({ data }: { data: TimelineData }) {
  return (
    <div className="card">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 className="text-lg font-bold text-midnight">
          📍 Plan vs Reality
          <code className="ml-2 text-sm font-mono font-medium text-ink-600">{data.batchCode}</code>
        </h2>
      </div>
      <p className="text-sm text-ink-500 mb-4">
        <span className="tabular-nums">{data.quantity}×</span> {data.modelYear}
        <Sep />
        dealer: <span className="font-medium text-midnight">{data.dealerName}</span>
        <Sep />
        stage: <span className="font-medium text-midnight">{data.stageDisplay}</span>
      </p>

      <div className="grid grid-cols-3 md:grid-cols-5 gap-3 mb-5">
        <ChipMetric label="📨 Submitted" value={data.realityRequested} />
        <ChipMetric label="📝 PO" value={data.poStatusLabel} />
        <ChipMetric label="🚗 Promised Avail." value={data.planPromised} />
        <ChipMetric label="📦 Actual Avail." value={data.deliveryStatusLabel} />
        <ChipMetric label="Status" value={data.overallStatusLabel} emphasis />
      </div>

      <TimelineSvg data={data} />

      <ActivityTable activity={data.activity} />
    </div>
  );
}

// ── Activity table (every batch_action with planned vs actual) ─────

function ActivityTable({ activity }: { activity: TimelineActivity[] }) {
  if (activity.length === 0) {
    return (
      <p className="mt-6 text-xs text-ink-500 px-1">
        No actions on this batch yet.
      </p>
    );
  }
  return (
    <div className="mt-6 border border-ink-200 rounded-md overflow-hidden">
      <header className="px-3 py-2 border-b border-ink-200 bg-ink-50">
        <h3 className="text-sm font-bold text-midnight">Activity</h3>
        <p className="text-[0.7rem] text-ink-500 mt-0.5 leading-snug">
          Every action on this batch — planned date, actual completion, owner, and signed delay.
          Skipped actions sink to the bottom.
        </p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50">
            <tr className="text-left text-[0.7rem] font-medium text-ink-600 border-b border-ink-200 uppercase tracking-wide">
              <th scope="col" className="px-3 py-2 whitespace-nowrap">Action</th>
              <th scope="col" className="px-3 py-2 whitespace-nowrap">Owner</th>
              <th scope="col" className="px-3 py-2 whitespace-nowrap">Status</th>
              <th scope="col" className="px-3 py-2 whitespace-nowrap text-right">Planned</th>
              <th scope="col" className="px-3 py-2 whitespace-nowrap text-right">Actual</th>
              <th scope="col" className="px-3 py-2 whitespace-nowrap text-right">Delay</th>
            </tr>
          </thead>
          <tbody>
            {activity.map((a, i) => (
              <tr key={i} className="border-b border-ink-200/60 last:border-b-0 align-top">
                <td className="px-3 py-2 text-midnight">
                  <div className="font-medium">{a.actionLabel}</div>
                  {a.notes && (
                    <div className="text-[0.7rem] text-ink-500 mt-0.5 leading-snug">{a.notes}</div>
                  )}
                </td>
                <td className="px-3 py-2 text-midnight whitespace-nowrap">
                  {a.departmentName ? (
                    <>
                      <div>{a.departmentName}</div>
                      {a.stakeholderName && (
                        <div className="text-[0.7rem] text-ink-500 mt-0.5">@{a.stakeholderName}</div>
                      )}
                    </>
                  ) : (
                    <span className="text-ink-400">— unassigned —</span>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <ActivityStatusChip status={a.status} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                  {a.expectedDate
                    ? <span className="text-midnight">{a.expectedDate}</span>
                    : <span className="text-ink-400">—</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                  {a.completedAt
                    ? <span
                        className="text-midnight"
                        title={`Completed ${a.completedAt} (server time, ISO)`}
                      >
                        {fmtLocalDateTime(a.completedAt)}
                      </span>
                    : <span className="text-ink-400">—</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                  <ActivityDelay days={a.delayDays} status={a.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActivityStatusChip({ status }: { status: TimelineActivity["status"] }) {
  // Tone matches conventions used elsewhere: green = done, midnight = open
  // (waiting), flame = blocked, ink-500 = skipped.
  const map: Record<TimelineActivity["status"], { label: string; cls: string }> = {
    done:    { label: "✅ Done",    cls: "bg-green-pale text-green-dark border border-green" },
    waiting: { label: "⏳ Waiting", cls: "bg-ink-100 text-midnight border border-ink-200" },
    blocked: { label: "🚫 Blocked", cls: "bg-flame-pale text-flame-dark border border-flame" },
    skipped: { label: "⏭ Skipped", cls: "bg-ink-100 text-ink-500 border border-ink-200" },
  };
  const m = map[status];
  return (
    <span className={cn("inline-block px-2 py-0.5 rounded-md text-[0.7rem] font-medium", m.cls)}>
      {m.label}
    </span>
  );
}

function ActivityDelay({
  days, status,
}: {
  days: number | null;
  status: TimelineActivity["status"];
}) {
  if (days == null) return <span className="text-ink-400">—</span>;
  if (days === 0)   return <span className="text-ink-500">0d</span>;
  // Past-due open actions surface in flame even though they're not done yet.
  const isLate = days > 0;
  const cls = isLate ? "text-flame-dark font-semibold" : "text-green-dark font-medium";
  const text = isLate ? `+${days}d` : `${days}d`;
  // Open actions get a subtle "late" qualifier so the reader knows the
  // delay is "already past expected" rather than "completed late".
  const suffix = isLate && (status === "waiting" || status === "blocked") ? " late" : "";
  return <span className={cls}>{text}{suffix}</span>;
}

function ChipMetric({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div>
      <p className="text-[0.7rem] font-medium text-ink-500 uppercase tracking-wide">{label}</p>
      <p className={cn(
        "text-sm font-medium tabular-nums",
        emphasis ? "text-midnight" : "text-midnight",
      )}>
        {value}
      </p>
    </div>
  );
}

function Sep() {
  return <span aria-hidden="true" className="text-ink-300 mx-1.5">·</span>;
}

// ── tiny helpers ────────────────────────────────────────────────

function unique<T>(xs: T[]): T[] {
  return Array.from(new Set(xs.filter((v) => v != null && v !== "")));
}

/**
 * Render an ISO datetime as `YYYY-MM-DD HH:MM` in the viewer's local
 * timezone. The DB stores ISO UTC; the team reading the dashboard
 * thinks in wall-clock time.
 */
function fmtLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

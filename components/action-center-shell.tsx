"use client";

/**
 * Action Center shell — owns filter state + selection + cross-component refresh.
 *
 * Server-rendered rows come in fresh on every page load and on mutation
 * (we router.refresh() after every successful drawer action).
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActionCenterRow } from "@/lib/action-center-data";
import { isFullySettled } from "@/lib/action-center-predicates";
import ActionCenterBatchList from "./action-center-batch-list";
import ActionCenterDrawer from "./action-center-drawer";
import ActionCenterDelayedStrip, { type AggregateFilter } from "./action-center-delayed-strip";
import PageHeader from "./page-header";
import { cn } from "@/lib/utils";

// Left-panel (batches list) width in the side-by-side view. Persisted in
// localStorage so each user keeps their preferred ratio between visits.
const LEFT_WIDTH_KEY = "action-center-left-width";
const DEFAULT_LEFT_WIDTH = 280;
const MIN_LEFT_WIDTH = 200;
const MAX_LEFT_WIDTH = 640;

// Completion view — segmented control above the batch list. Determines
// which slice of the dataset is in scope:
//   active    — batches with work still pending (default daily-use view)
//   all       — everything, regardless of completion state
//   completed — fully settled OR closed (delivered / cancelled)
type CompletionView = "active" | "all" | "completed";
const COMPLETION_VIEW_KEY = "action-center-completion-view";

interface Props {
  rows: ActionCenterRow[];
  totals: {
    total: number;
    active: number;
    withWaiting: number;
    fullyDone: number;
    delayed: number;
    delivered: number;
    cancelled: number;
    partlyDelivered: number;
    listed: number;
    totalQuantity: number;
    carsListed: number;
    carsDelivered: number;
    carsReady: number;
    carsPartlyDelivered: number;
    carsPartlyRequested: number;
    carsCancelled: number;
  };
}

type LifecycleFilter = "all" | "pre_po" | "post_po";
type StatusFilter    = "all" | "delayed" | "ahead" | "on_track" | "delivered";

export default function ActionCenterShell({ rows, totals }: Props) {
  const router = useRouter();

  const [departmentFilter, setDepartmentFilter] = useState<string>("all");
  const [lifecycleFilter,  setLifecycleFilter]  = useState<LifecycleFilter>("all");
  const [statusFilter,     setStatusFilter]     = useState<StatusFilter>("all");
  const [completionView,   setCompletionView]   = useState<CompletionView>("active");
  const [selected,         setSelected]         = useState<string | null>(null);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(COMPLETION_VIEW_KEY);
      if (stored === "active" || stored === "all" || stored === "completed") {
        setCompletionView(stored);
      }
    } catch { /* SSR / private mode */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(COMPLETION_VIEW_KEY, completionView); } catch { /* ignore */ }
  }, [completionView]);
  /**
   * Free-text search — matches the Dashboard's pattern (PO number,
   * dealer, model, batch code; case-insensitive substring). Applied
   * inside the same `topLevelFiltered` pipeline so the aggregate
   * strip + the batch list stay in sync.
   */
  const [search, setSearch] = useState<string>("");
  /**
   * Aggregate filter — single chip selected across the three rows of the
   * filter strip. Applied AFTER the high-level filters so the chip counts
   * reflect the same data the user is filtering inside.
   */
  const [aggregateFilter, setAggregateFilter] = useState<AggregateFilter>(null);

  // ── Left-panel width (drag-to-resize), persisted in localStorage ──
  const [leftWidth, setLeftWidth] = useState<number>(DEFAULT_LEFT_WIDTH);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(LEFT_WIDTH_KEY);
      if (stored) {
        const n = parseInt(stored, 10);
        if (!isNaN(n) && n >= MIN_LEFT_WIDTH && n <= MAX_LEFT_WIDTH) setLeftWidth(n);
      }
    } catch { /* SSR / private mode */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(LEFT_WIDTH_KEY, String(leftWidth)); } catch { /* ignore */ }
  }, [leftWidth]);

  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftWidth;
    function onMove(ev: MouseEvent) {
      const next = Math.min(
        MAX_LEFT_WIDTH,
        Math.max(MIN_LEFT_WIDTH, startWidth + (ev.clientX - startX)),
      );
      setLeftWidth(next);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Department options from rows
  const departmentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) for (const d of r.pendingDepartments) set.add(d);
    return Array.from(set).sort();
  }, [rows]);

  /**
   * Two-stage filter pipeline:
   *   topLevelFiltered — high-level filters applied (dept / lifecycle /
   *                      status / show-completed). The aggregate STRIP
   *                      aggregates from THIS so its chip counts reflect
   *                      the current view, not the raw dataset.
   *   filtered         — aggregate strip filter applied on top. This is
   *                      what the batch list renders. Clear the chip →
   *                      identical to topLevelFiltered.
   */
  const topLevelFiltered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (lifecycleFilter !== "all" && r.lifecycleState !== lifecycleFilter) return false;

      if (statusFilter === "delayed"   && r.delayDays <= 0) return false;
      if (statusFilter === "ahead"     && r.delayDays >= 0) return false;
      if (statusFilter === "on_track"  && (r.delayDays !== 0 || r.statusLabel.startsWith("🎉"))) return false;
      if (statusFilter === "delivered" && !r.statusLabel.startsWith("🎉")) return false;

      if (departmentFilter !== "all" && !r.pendingDepartments.includes(departmentFilter)) return false;

      // Completion view — Active hides anything fully wrapped up
      // (operationally settled or already closed). Completed inverts
      // that. All bypasses the cut entirely. `isFullySettled` is the
      // same predicate that drives the "Ready to deliver" tile, so
      // the surfaces stay in sync.
      const done = isFullySettled(r) || r.closedAt != null;
      if (completionView === "active"    && done)  return false;
      if (completionView === "completed" && !done) return false;

      // Free-text search — case-insensitive substring against the
      // batch identity fields ops searches by in practice.
      if (needle) {
        const hay = [
          r.batchCode,
          r.dealerName,
          r.modelYear,
        ].join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    }).sort((a, b) => {
      // Default sort: most-waiting first, then most-blocked, then delay desc.
      if (b.actionsWaiting !== a.actionsWaiting) return b.actionsWaiting - a.actionsWaiting;
      if (b.actionsBlocked !== a.actionsBlocked) return b.actionsBlocked - a.actionsBlocked;
      return b.delayDays - a.delayDays;
    });
  }, [rows, departmentFilter, lifecycleFilter, statusFilter, completionView, search]);

  const filtered = useMemo(() => {
    if (aggregateFilter == null) return topLevelFiltered;
    return topLevelFiltered.filter((r) => {
      // Compound predicate: the batch must have an open action that
      // matches BOTH the identity (action / department / stakeholder)
      // AND the exact delay-day value of the active chip.
      return r.openActions.some((oa) => {
        if (oa.delayDays !== aggregateFilter.delayDays) return false;
        switch (aggregateFilter.kind) {
          case "action":      return oa.actionTypeId === aggregateFilter.id;
          case "department":  return oa.departmentId === aggregateFilter.id;
          case "stakeholder": return oa.stakeholderId === aggregateFilter.id;
        }
      });
    });
  }, [topLevelFiltered, aggregateFilter]);

  function onMutation() {
    // Re-render the server component (refreshes rows from DB).
    router.refresh();
  }

  // Whole-percent against the total fleet, with a divide-by-zero
  // guard for the empty-Action-Center case.
  const pctOfTotal = (n: number) =>
    totals.totalQuantity === 0 ? 0 : Math.round((n / totals.totalQuantity) * 100);

  return (
    <div>
      <PageHeader
        view="Action Center"
        subtitle={<>Every batch in flight, sorted by action required. Pick a batch to update its action statuses and capture Ops&apos; current confidence.</>}
      />

      {/* Delayed-work strip — promoted to the top per the design
          audit. This is the genuine hero of the Action Center: ops
          opens this page to find what's slipping, and the chip
          filter (by Action / Department / Stakeholder, bucketed by
          days late) is the killer triage surface. Surfacing it above
          the KPI tiles + the regular filters puts triage first. */}
      <div className="mb-4">
        <ActionCenterDelayedStrip
          rows={topLevelFiltered}
          active={aggregateFilter}
          onChange={setAggregateFilter}
        />
      </div>

      {/* Metric hierarchy — Delayed is the only number that drives
          action; everything else is context. Use the same hero +
          compact pattern as the Dashboard for consistency. */}
      <div className="grid grid-cols-1 md:grid-cols-[2fr,1fr,1fr] gap-4 mb-3">
        <HeroMetric
          label="Delayed"
          value={totals.delayed}
          tone={totals.delayed > 0 ? "alert" : "ok"}
          title={totals.delayed > 0
            ? `${totals.delayed} batches are past their dealer-promised availability date`
            : "No batches are past their promised date"}
        />
        <Metric
          label="Active"
          value={totals.active}
          valueColor="text-midnight"
          title="Batches not yet closed (Delivered or Cancelled)."
        />
        <Metric
          label="Action needed"
          value={totals.withWaiting}
          title="Batches with at least one waiting action — somebody's owed work."
        />
      </div>
      {/* Closure + volume strip — compact tiles for the operational
          breakdown the team wants visible at a glance. Each tile has
          a colored left-edge accent matching its semantic role, and a
          subtitle giving the car-level context (since "3 batches"
          alone doesn't say how big the move is). Wraps to 2 or 3
          columns on narrow screens; all six fit one row on lg+. */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 mb-6">
        <CompactMetric
          label="Total cars"
          value={totals.totalQuantity}
          accent="ink"
          valueColor="text-midnight"
          subtitle={`across ${totals.total} ${totals.total === 1 ? "batch" : "batches"}`}
          title="Total cars across every batch in this Action Center (gross — includes cancelled units)."
        />
        <CompactMetric
          label="Listed on app"
          value={totals.listed}
          accent="brand"
          valueColor="text-brand-dark"
          subtitle={`${totals.carsListed} / ${totals.totalQuantity} cars · ${pctOfTotal(totals.carsListed)}%`}
          title="Batches marked live in the customer app. Subtitle: cars in those batches as a share of total PO quantity."
        />
        <CompactMetric
          label="Ready to deliver"
          value={totals.fullyDone}
          accent="green"
          valueColor="text-green-dark"
          subtitle={totals.fullyDone > 0
            ? `${totals.carsReady} ${totals.carsReady === 1 ? "car" : "cars"} in pipeline`
            : "—"}
          title="Batches where every internal action AND every VIN chase stage is done or skipped. Just waiting for Mark as Delivered."
        />
        <CompactMetric
          label="Delivered"
          value={totals.delivered}
          accent="green"
          valueColor="text-green-dark"
          subtitle={`${totals.carsDelivered} / ${totals.totalQuantity} cars · ${pctOfTotal(totals.carsDelivered)}%`}
          title="Batches formally closed as delivered. Subtitle: cars actually shipped (cumulative delivered_quantity) as a share of total PO quantity."
        />
        <CompactMetric
          label="Partly delivered"
          value={totals.partlyDelivered}
          accent="gold"
          valueColor="text-gold-dark"
          subtitle={totals.partlyDelivered > 0
            ? `${totals.carsPartlyDelivered} / ${totals.carsPartlyRequested} cars shipped`
            : "—"}
          title="Batches where some units shipped but not all — includes in-flight partials and cancelled-after-partial."
        />
        <CompactMetric
          label="Cancelled"
          value={totals.cancelled}
          accent="flame"
          valueColor="text-flame-dark"
          subtitle={totals.cancelled > 0
            ? `${totals.carsCancelled} ${totals.carsCancelled === 1 ? "car" : "cars"} affected`
            : "—"}
          title="Batches closed with a cancellation reason. Subtitle: gross car count across cancelled batches."
        />
      </div>

      {/* Filters */}
      <div className="card mb-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Select
            label="Department (waiting in)"
            value={departmentFilter}
            onChange={setDepartmentFilter}
            options={[
              { value: "all", label: "All departments" },
              ...departmentOptions.map((d) => ({ value: d, label: d })),
            ]}
          />
          <Select
            label="Phase"
            value={lifecycleFilter}
            onChange={(v) => setLifecycleFilter(v as LifecycleFilter)}
            options={[
              { value: "all",     label: "All" },
              { value: "pre_po",  label: "Pre-PO only" },
              { value: "post_po", label: "Post-PO only" },
            ]}
          />
          <Select
            label="Status"
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as StatusFilter)}
            options={[
              { value: "all",       label: "All" },
              { value: "delayed",   label: "🔴 Delayed" },
              { value: "on_track",  label: "🟢 On track" },
              { value: "ahead",     label: "🔵 Ahead" },
              { value: "delivered", label: "🎉 Delivered" },
            ]}
          />
        </div>
      </div>

      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-ink-500">
          {filtered.length} batch{filtered.length === 1 ? "" : "es"} match the current filters.
        </p>
      </div>

      {/* Side-by-side: compact list on the left, action card on the right.
          Both panes scroll independently inside a fixed-height container.
          Column widths are user-controlled: drag the divider between the
          two panes (lg+ only). The width is clamped to [MIN, MAX] and
          persisted in localStorage. Double-click the divider to reset. */}
      <div
        className="grid grid-cols-1 gap-4 lg:gap-0 h-[min(76vh,820px)] min-h-[480px] lg:[grid-template-columns:var(--ac-cols)]"
        style={{ "--ac-cols": `${leftWidth}px 14px 1fr` } as React.CSSProperties}
      >
          {/* Left column — search above the batch list. The completion-view
              toggle that used to live next to the search moved into the
              right column header so the narrow left column has more room
              for the search input. Header row is a fixed 40px so it
              aligns with the toggle on the right side. */}
          <div className="flex flex-col gap-2 min-h-0">
            <label className="block shrink-0 h-10">
              <span className="sr-only">Search batches</span>
              <div className="relative h-full">
                <input
                  type="search"
                  className="input pr-9 text-sm h-full"
                  placeholder="🔎 Search PO, dealer, model…"
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
            <div className="flex-1 min-h-0">
              <ActionCenterBatchList
                rows={filtered}
                selectedCode={selected}
                onSelect={(code) => setSelected((cur) => (cur === code ? null : code))}
                totalCount={rows.length}
              />
            </div>
          </div>

          {/* Drag-to-resize handle — hidden on mobile (grid collapses
              to a single column). The hit area is the full 14px column;
              the inner pill is a visual affordance that brightens on
              hover. Double-click resets to the default width. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize batches panel"
            aria-valuemin={MIN_LEFT_WIDTH}
            aria-valuemax={MAX_LEFT_WIDTH}
            aria-valuenow={leftWidth}
            title={`Drag to resize · Double-click to reset (${leftWidth}px)`}
            onMouseDown={startResize}
            onDoubleClick={() => setLeftWidth(DEFAULT_LEFT_WIDTH)}
            className="hidden lg:flex items-center justify-center cursor-col-resize
                       group select-none"
          >
            <div className="w-1 h-10 rounded-full bg-ink-200 group-hover:bg-brand
                            group-active:bg-brand-dark transition-colors" />
          </div>

          {/* Right column — completion-view toggle sits above the drawer
              box. Even though it filters the batch LIST on the left,
              hosting it here gives both elements more horizontal room
              and matches the visual rhythm of the drawer header below.
              Header row matches the search input's 40px height so the
              two columns' content boxes start at the same Y. */}
          <div className="flex flex-col gap-2 min-h-0 lg:ml-2">
            <div className="flex items-center shrink-0 h-10">
              <CompletionViewToggle value={completionView} onChange={setCompletionView} />
            </div>
            <div className="flex-1 min-h-0 overflow-auto rounded-lg">
              {selected ? (
                <ActionCenterDrawer
                  key={selected}
                  batchCode={selected}
                  onMutation={onMutation}
                  layout="kanban"
                />
              ) : (
                <div className="card h-full flex flex-col items-center justify-center text-center text-sm text-ink-500">
                  <p className="text-base font-medium text-midnight mb-1">
                    Pick a batch
                  </p>
                  <p>
                    Select a batch from the list to update its actions and capture Ops&apos; confidence.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
    </div>
  );
}

// ── Completion-view segmented control ─────────────────────────

function CompletionViewToggle({
  value, onChange,
}: {
  value: CompletionView;
  onChange: (v: CompletionView) => void;
}) {
  const options: { value: CompletionView; label: string; title: string }[] = [
    { value: "active",    label: "Active",    title: "Batches with work still pending" },
    { value: "all",       label: "All",       title: "All batches, regardless of state" },
    { value: "completed", label: "Completed", title: "Fully settled or closed batches" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Completion view"
      className="inline-flex items-center bg-ink-100 rounded-md p-0.5 shrink-0"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap",
            value === o.value
              ? "bg-white text-midnight shadow-sm"
              : "text-ink-500 hover:text-midnight",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Metric tiles — hero / standard / compact ──────────────────
//
// Same hierarchy primitives as the Dashboard. Hero = 2× weight,
// standard = baseline, compact = quiet pill.

function Metric({ label, value, valueColor, title }: {
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

function HeroMetric({ label, value, tone, title }: {
  label: string;
  value: number;
  tone: "alert" | "ok";
  title?: string;
}) {
  const ok = tone === "ok" || value === 0;
  return (
    <div
      title={title}
      className={cn(
        "card border-l-4 px-5 py-4 flex flex-col gap-1",
        ok ? "border-l-green bg-green-pale/30" : "border-l-gold bg-gold-pale/30",
      )}
    >
      <span className="text-xs font-semibold uppercase tracking-wide text-ink-600">
        {label}
      </span>
      <span className={cn(
        "text-4xl font-bold tabular-nums leading-none",
        ok ? "text-green-dark" : "text-gold-dark",
      )}>
        {value}
      </span>
    </div>
  );
}

type CompactAccent = "green" | "brand" | "gold" | "flame" | "ink";

const COMPACT_ACCENT_CLASSES: Record<CompactAccent, string> = {
  green: "border-l-2 border-l-green",
  brand: "border-l-2 border-l-brand",
  gold:  "border-l-2 border-l-gold",
  flame: "border-l-2 border-l-flame",
  ink:   "border-l-2 border-l-ink-300",
};

function CompactMetric({ label, value, valueColor, title, subtitle, accent }: {
  label: string;
  value: number;
  valueColor?: string;
  title?: string;
  /** Optional second line — used to show the car-level breakdown
   *  (e.g. "200 / 340 cars · 59%") under tiles that have one. */
  subtitle?: string;
  /** Colored left-edge stripe matching the tile's semantic role. */
  accent?: CompactAccent;
}) {
  return (
    <div
      title={title}
      className={cn(
        "px-3 py-2 rounded-md bg-ink-50 border border-ink-100",
        COMPACT_ACCENT_CLASSES[accent ?? "ink"],
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-ink-600">{label}</span>
        <span className={cn("text-lg font-semibold tabular-nums", valueColor ?? "text-midnight")}>
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

// ── Select ─────────────────────────────────────────────────────

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

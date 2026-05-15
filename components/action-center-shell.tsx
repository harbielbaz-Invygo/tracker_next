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
import ActionCenterTable from "./action-center-table";
import ActionCenterBatchList from "./action-center-batch-list";
import ActionCenterDrawer from "./action-center-drawer";
import ActionCenterDelayedStrip, { type AggregateFilter } from "./action-center-delayed-strip";
import PageHeader from "./page-header";
import { cn } from "@/lib/utils";

type ViewMode = "stacked" | "side-by-side";
const VIEW_MODE_KEY = "action-center-view-mode";

// Left-panel (batches list) width in the side-by-side view. Persisted in
// localStorage so each user keeps their preferred ratio between visits.
const LEFT_WIDTH_KEY = "action-center-left-width";
const DEFAULT_LEFT_WIDTH = 280;
const MIN_LEFT_WIDTH = 200;
const MAX_LEFT_WIDTH = 640;

interface Props {
  rows: ActionCenterRow[];
  totals: { total: number; withWaiting: number; fullyDone: number; delayed: number };
}

type LifecycleFilter = "all" | "pre_po" | "post_po";
type StatusFilter    = "all" | "delayed" | "ahead" | "on_track" | "delivered";

export default function ActionCenterShell({ rows, totals }: Props) {
  const router = useRouter();

  const [departmentFilter, setDepartmentFilter] = useState<string>("all");
  const [lifecycleFilter,  setLifecycleFilter]  = useState<LifecycleFilter>("all");
  const [statusFilter,     setStatusFilter]     = useState<StatusFilter>("all");
  const [showCompleted,    setShowCompleted]    = useState<boolean>(false);
  const [selected,         setSelected]         = useState<string | null>(null);
  /**
   * Free-text search — matches the Dashboard's pattern (PO number,
   * dealer, model, batch code; case-insensitive substring). Applied
   * inside the same `topLevelFiltered` pipeline so the aggregate
   * strip + the table stay in sync.
   */
  const [search, setSearch] = useState<string>("");
  /**
   * Aggregate filter — single chip selected across the three rows of the
   * filter strip. Applied AFTER the high-level filters so the chip counts
   * reflect the same data the user is filtering inside.
   */
  const [aggregateFilter, setAggregateFilter] = useState<AggregateFilter>(null);

  // ── View mode (stacked / side-by-side), persisted in localStorage ──
  // Default = side-by-side: master/detail layout fits the daily-use shape
  // of the Action Center better than the stacked variant. Users who prefer stacked
  // still get their preference back via localStorage on subsequent visits.
  const [viewMode, setViewMode] = useState<ViewMode>("side-by-side");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(VIEW_MODE_KEY);
      if (stored === "stacked" || stored === "side-by-side") setViewMode(stored);
    } catch { /* private mode / SSR — fall back to default */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(VIEW_MODE_KEY, viewMode); } catch { /* ignore */ }
  }, [viewMode]);

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
   *                      what the table renders. Clear the chip → identical
   *                      to topLevelFiltered.
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

      // "Hide completed" — batches where every internal action AND
      // every VIN chase stage is in a terminal state. Shared predicate
      // with the top "Fully done" metric so both surfaces agree.
      if (!showCompleted && isFullySettled(r)) return false;

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
  }, [rows, departmentFilter, lifecycleFilter, statusFilter, showCompleted, search]);

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
          label="Delayed batches"
          value={totals.delayed}
          tone={totals.delayed > 0 ? "alert" : "ok"}
          title={totals.delayed > 0
            ? `${totals.delayed} batches are past their dealer-promised availability date`
            : "No batches are past their promised date"}
        />
        <Metric label="Active batches"  value={totals.total} valueColor="text-midnight" />
        <Metric label="Waiting actions" value={totals.withWaiting} />
      </div>
      <div className="grid grid-cols-1 mb-6">
        <CompactMetric
          label="Ready to deliver"
          value={totals.fullyDone}
          valueColor="text-green-dark"
          title="Batches where every internal action AND every VIN chase stage is done or skipped. Just waiting for Mark as Delivered."
        />
      </div>

      {/* Filters */}
      <div className="card mb-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
          <label className="flex items-end gap-2 text-sm text-midnight pb-2 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) => setShowCompleted(e.target.checked)}
              className="h-4 w-4 accent-brand"
            />
            Show completed
          </label>
        </div>
      </div>

      {/* View toggle (segmented control) */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-ink-500">
          {filtered.length} batch{filtered.length === 1 ? "" : "es"} match the current filters.
        </p>
        <ViewToggle value={viewMode} onChange={setViewMode} />
      </div>

      {/* Conditional layout */}
      {viewMode === "stacked" ? (
        <>
          {/* Stacked: full-width table, drawer below when selected */}
          <ActionCenterTable
            rows={filtered}
            selectedCode={selected}
            onSelect={(code) => setSelected((cur) => (cur === code ? null : code))}
            totalCount={rows.length}
          />
          {selected && (
            <div className="mt-6">
              <ActionCenterDrawer
                key={selected}
                batchCode={selected}
                onMutation={onMutation}
              />
            </div>
          )}
          {!selected && rows.length > 0 && (
            <p className="text-sm text-ink-500 px-1 mt-6">
              👆 Click a batch row to update its actions and capture Ops&apos; confidence.
            </p>
          )}
        </>
      ) : (
        /* Side-by-side: compact list on the left, action card on the right.
           Both panes scroll independently inside a fixed-height container.
           Column widths are user-controlled: drag the divider between the
           two panes (lg+ only). The width is clamped to [MIN, MAX] and
           persisted in localStorage. Double-click the divider to reset. */
        <div
          className="grid grid-cols-1 gap-4 lg:gap-0 h-[min(76vh,820px)] min-h-[480px] lg:[grid-template-columns:var(--ac-cols)]"
          style={{ "--ac-cols": `${leftWidth}px 14px 1fr` } as React.CSSProperties}
        >
          {/* Left column — search input + batch list, stacked. The
              search is constrained to the same column width as the
              list below it (no media break, both are inside the
              same grid cell). Matches the Dashboard search UX
              (PO / dealer / model substring + ✕ clear button). */}
          <div className="flex flex-col gap-2 min-h-0">
            <label className="block shrink-0">
              <span className="sr-only">Search batches</span>
              <div className="relative">
                <input
                  type="search"
                  className="input pr-9 text-sm"
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

          <div className="overflow-auto rounded-lg lg:ml-2">
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
      )}
    </div>
  );
}

// ── View toggle ────────────────────────────────────────────────

function ViewToggle({
  value, onChange,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Action Center view mode"
      className="inline-flex items-center bg-ink-100 rounded-md p-0.5"
    >
      <ToggleButton
        active={value === "stacked"}
        onClick={() => onChange("stacked")}
        label="Stacked"
        title="Table on top, action card below the selected row"
      />
      <ToggleButton
        active={value === "side-by-side"}
        onClick={() => onChange("side-by-side")}
        label="Side by side"
        title="Compact batch list on the left, action card on the right"
      />
    </div>
  );
}

function ToggleButton({
  active, onClick, label, title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      title={title}
      className={cn(
        "px-3 py-1 text-xs font-medium rounded transition-colors",
        active
          ? "bg-white text-midnight shadow-sm"
          : "text-ink-500 hover:text-midnight",
      )}
    >
      {label}
    </button>
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

function CompactMetric({ label, value, valueColor, title }: {
  label: string;
  value: number;
  valueColor?: string;
  title?: string;
}) {
  return (
    <div
      title={title}
      className="flex items-baseline justify-between gap-3 px-3 py-2 rounded-md
                 bg-ink-50 border border-ink-100"
    >
      <span className="text-xs font-medium text-ink-600">{label}</span>
      <span className={cn("text-lg font-semibold tabular-nums", valueColor ?? "text-midnight")}>
        {value}
      </span>
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

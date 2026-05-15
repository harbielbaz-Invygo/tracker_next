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
      return true;
    }).sort((a, b) => {
      // Default sort: most-waiting first, then most-blocked, then delay desc.
      if (b.actionsWaiting !== a.actionsWaiting) return b.actionsWaiting - a.actionsWaiting;
      if (b.actionsBlocked !== a.actionsBlocked) return b.actionsBlocked - a.actionsBlocked;
      return b.delayDays - a.delayDays;
    });
  }, [rows, departmentFilter, lifecycleFilter, statusFilter, showCompleted]);

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

      {/* Metric strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Metric label="Active batches"   value={totals.total} />
        <Metric label="Waiting actions"  value={totals.withWaiting} />
        <Metric label="Delayed"          value={totals.delayed} valueColor="text-flame-dark" />
        <Metric label="Ready to deliver" value={totals.fullyDone} valueColor="text-green-dark" />
      </div>

      {/* Delayed-work strip — single triage surface. Chips bucketed by HOW
          MANY DAYS late an open action is, with Action / Department /
          Stakeholder sub-aggregations inside each delay-day group.
          Compound filter: chip click narrows the table to batches whose
          matching action is exactly that many days late. */}
      <div className="mb-4">
        <ActionCenterDelayedStrip
          rows={topLevelFiltered}
          active={aggregateFilter}
          onChange={setAggregateFilter}
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
           Both panes scroll independently inside a fixed-height container. */
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(300px,400px)_1fr] gap-4 h-[min(76vh,820px)] min-h-[480px]">
          <ActionCenterBatchList
            rows={filtered}
            selectedCode={selected}
            onSelect={(code) => setSelected((cur) => (cur === code ? null : code))}
            totalCount={rows.length}
          />
          <div className="overflow-auto rounded-lg">
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

// ── Metric tile ─────────────────────────────────────────────────

function Metric({ label, value, valueColor }: { label: string; value: number; valueColor?: string }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className={cn("metric-value", valueColor)}>{value}</span>
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

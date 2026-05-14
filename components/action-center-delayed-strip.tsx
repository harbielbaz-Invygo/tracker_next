"use client";

/**
 * Action Center → "Delayed work" strip.
 *
 * The single triage surface above the batches table. Subdivides delayed
 * open actions by HOW MANY DAYS late they are. Inside each delay-day
 * bucket we render three chip rows — By Action / By Department / By
 * Stakeholder — scoped to that delay-day cohort.
 *
 *   1 day late
 *     By Action       [ 2 Specs ] [ 1 VIN ]
 *     By Department   [ 2 Specs ] [ 1 Operations ]
 *     By Stakeholder  [ 2 Ahmed ] [ 1 Mohammed ]
 *
 *   2 days late
 *     ...
 *
 * Clicking a chip applies a COMPOUND filter: the chip's identity AND its
 * delay-day bucket. A click on "1 day late → Specs" narrows to batches
 * with an open Specs action delayed exactly 1 day.
 *
 * The whole strip is collapsible via the header — useful on days when
 * the dataset is small or to reclaim vertical space after triage.
 */
import { useState } from "react";
import type { ActionCenterRow } from "@/lib/action-center-data";
import { cn } from "@/lib/utils";

/**
 * Discriminated union — single active aggregate filter for the Action
 * Center. `delayDays` carries the chip's delay-day bucket; the shell
 * uses it as a compound predicate against open actions.
 */
export type AggregateFilter =
  | { kind: "action";      id: number; label: string; delayDays: number }
  | { kind: "department";  id: number; label: string; delayDays: number }
  | { kind: "stakeholder"; id: number; label: string; delayDays: number }
  | null;

interface Props {
  rows: ActionCenterRow[];
  active: AggregateFilter;
  onChange: (next: AggregateFilter) => void;
}

interface Bucket {
  id: number;
  label: string;
  secondary?: string;
  batchCount: number;
}

interface DelayGroup {
  delayDays: number;
  byAction:      Bucket[];
  byDepartment:  Bucket[];
  byStakeholder: Bucket[];
  /** Distinct batches with any open action at this delay — for the section heading. */
  totalBatches: number;
}

export default function ActionCenterDelayedStrip({ rows, active, onChange }: Props) {
  const groups = aggregateByDelay(rows);
  // Default collapsed — Action Center top is busy with the batches table
  // already; expand on click when ops wants to drill into delays.
  const [expanded, setExpanded] = useState(false);

  if (groups.length === 0) return null;

  /**
   * Total distinct batches across all delay groups — shown in the
   * collapsed header so the at-a-glance signal survives a collapse.
   * A batch with multiple delayed actions across different delay-day
   * buckets still counts ONCE here.
   */
  const totalBatches = new Set(
    rows.flatMap((r) => r.openActions.filter((oa) => oa.delayDays >= 1).map(() => r.batchId)),
  ).size;

  function toggle(
    kind: "action" | "department" | "stakeholder",
    id: number,
    label: string,
    delayDays: number,
  ) {
    if (
      active != null &&
      active.kind === kind &&
      active.id === id &&
      active.delayDays === delayDays
    ) {
      onChange(null);
    } else {
      onChange({ kind, id, label, delayDays });
    }
  }

  return (
    <section
      aria-label="Delayed work filters"
      className={cn("card border-flame/40", expanded ? "space-y-4" : "")}
    >
      <header className="flex items-baseline justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls="delayed-work-body"
          className="flex items-baseline gap-2 text-flame-dark hover:text-flame
                     focus-visible:outline-2 focus-visible:outline-brand
                     focus-visible:outline-offset-2 rounded -m-1 p-1"
          title={expanded ? "Collapse Delayed work" : "Expand Delayed work"}
        >
          <span aria-hidden="true" className="text-xs leading-none">
            {expanded ? "▾" : "▸"}
          </span>
          <span className="text-xs font-medium uppercase tracking-wide">
            🔴 Delayed work — click to filter
          </span>
          <span className="text-[0.7rem] font-normal text-ink-500 normal-case tabular-nums">
            {totalBatches} batch{totalBatches === 1 ? "" : "es"} · {groups.length} bucket{groups.length === 1 ? "" : "s"}
            {active && active.delayDays !== undefined && (
              <>
                {" · "}
                <span className="font-medium text-flame-dark">
                  filter: {active.label} ({active.delayDays}d late)
                </span>
              </>
            )}
          </span>
        </button>
        {active && active.delayDays !== undefined && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-[0.7rem] font-medium text-brand-dark hover:text-midnight underline-offset-2 hover:underline"
            title="Clear the active delay filter"
          >
            ✕ Clear filter
          </button>
        )}
      </header>

      {expanded && (
        <div id="delayed-work-body" className="space-y-4">
          {groups.map((g) => (
            <DelayGroupRow
              key={g.delayDays}
              group={g}
              active={active}
              onToggle={toggle}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// Delay group — heading + three chip rows
// ──────────────────────────────────────────────────────────────────

function DelayGroupRow({
  group, active, onToggle,
}: {
  group: DelayGroup;
  active: AggregateFilter;
  onToggle: (kind: "action" | "department" | "stakeholder", id: number, label: string, delayDays: number) => void;
}) {
  return (
    <div className="space-y-2 pl-2 border-l-2 border-flame/30">
      <p className="text-xs font-bold text-flame-dark tabular-nums">
        {group.delayDays}d late
        <span className="ml-2 text-[0.7rem] font-normal text-ink-500">
          {group.totalBatches} batch{group.totalBatches === 1 ? "" : "es"}
        </span>
      </p>

      <ChipRow
        label="By Action"
        buckets={group.byAction}
        kind="action"
        delayDays={group.delayDays}
        active={active}
        onToggle={onToggle}
      />
      <ChipRow
        label="By Department"
        buckets={group.byDepartment}
        kind="department"
        delayDays={group.delayDays}
        active={active}
        onToggle={onToggle}
      />
      <ChipRow
        label="By Stakeholder"
        buckets={group.byStakeholder}
        kind="stakeholder"
        delayDays={group.delayDays}
        active={active}
        onToggle={onToggle}
      />
    </div>
  );
}

function ChipRow({
  label, buckets, kind, delayDays, active, onToggle,
}: {
  label: string;
  buckets: Bucket[];
  kind: "action" | "department" | "stakeholder";
  delayDays: number;
  active: AggregateFilter;
  onToggle: (kind: "action" | "department" | "stakeholder", id: number, label: string, delayDays: number) => void;
}) {
  if (buckets.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="text-[0.7rem] font-medium text-ink-600 w-28 shrink-0">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {buckets.map((b) => {
          const isActive =
            active != null &&
            active.kind === kind &&
            active.id === b.id &&
            active.delayDays === delayDays;
          return (
            <button
              key={`${kind}-${b.id}-${delayDays}`}
              type="button"
              onClick={() => onToggle(kind, b.id, b.label, delayDays)}
              aria-pressed={isActive}
              className={cn(
                "inline-flex items-baseline gap-1.5 px-2 py-1 rounded-md border text-xs whitespace-nowrap",
                "transition-colors focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2",
                isActive
                  ? "bg-flame text-white border-flame-dark shadow-sm"
                  : "bg-white text-midnight border-ink-200 hover:bg-flame-pale/40 hover:border-flame",
              )}
              title={
                isActive
                  ? `Clear: ${b.label} (${delayDays}d late)`
                  : `Filter to batches with ${b.label} at ${delayDays}d late`
              }
            >
              <span className={cn(
                "tabular-nums font-bold",
                isActive ? "text-white" : "text-flame-dark",
              )}>
                {b.batchCount}
              </span>
              <span className="font-medium">{b.label}</span>
              {b.secondary && (
                <span className={cn(
                  "text-[0.65rem] font-normal",
                  isActive ? "text-white/80" : "text-ink-500",
                )}>
                  · {b.secondary}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Aggregation
// ──────────────────────────────────────────────────────────────────

/**
 * Group every DELAYED open action (delayDays >= 1) by its delay-day
 * value, and inside each group, build the three sub-aggregations by
 * action / department / stakeholder (distinct-batch counts each).
 */
function aggregateByDelay(rows: ActionCenterRow[]): DelayGroup[] {
  // delayDays → { actionMap, departmentMap, stakeholderMap, batchSet }
  const byDelay = new Map<number, {
    action:      Map<number, { label: string; batches: Set<number> }>;
    department:  Map<number, { label: string; batches: Set<number> }>;
    stakeholder: Map<number, { label: string; department: string | null; batches: Set<number> }>;
    batches:     Set<number>;
  }>();

  for (const r of rows) {
    for (const oa of r.openActions) {
      if (oa.delayDays < 1) continue;
      const slot = byDelay.get(oa.delayDays) ?? {
        action:      new Map(),
        department:  new Map(),
        stakeholder: new Map(),
        batches:     new Set<number>(),
      };
      slot.batches.add(r.batchId);

      // By action
      {
        const entry = slot.action.get(oa.actionTypeId) ?? {
          label: oa.waitingLabel || oa.actionTypeName,
          batches: new Set<number>(),
        };
        entry.batches.add(r.batchId);
        slot.action.set(oa.actionTypeId, entry);
      }
      // By department
      if (oa.departmentId != null) {
        const entry = slot.department.get(oa.departmentId) ?? {
          label: oa.departmentName ?? "—",
          batches: new Set<number>(),
        };
        entry.batches.add(r.batchId);
        slot.department.set(oa.departmentId, entry);
      }
      // By stakeholder
      if (oa.stakeholderId != null) {
        const entry = slot.stakeholder.get(oa.stakeholderId) ?? {
          label: oa.stakeholderName ?? "—",
          department: oa.departmentName ?? null,
          batches: new Set<number>(),
        };
        entry.batches.add(r.batchId);
        slot.stakeholder.set(oa.stakeholderId, entry);
      }
      byDelay.set(oa.delayDays, slot);
    }
  }

  const out: DelayGroup[] = [];
  for (const [delayDays, slot] of byDelay) {
    out.push({
      delayDays,
      totalBatches: slot.batches.size,
      byAction: Array.from(slot.action.entries()).map(([id, v]) => ({
        id, label: v.label, batchCount: v.batches.size,
      })).sort(byBatchCountDesc),
      byDepartment: Array.from(slot.department.entries()).map(([id, v]) => ({
        id, label: v.label, batchCount: v.batches.size,
      })).sort(byBatchCountDesc),
      byStakeholder: Array.from(slot.stakeholder.entries()).map(([id, v]) => ({
        id, label: v.label, secondary: v.department ?? undefined, batchCount: v.batches.size,
      })).sort(byBatchCountDesc),
    });
  }

  // Sort delay groups by delayDays ASC — 1d first, then 2d, then 3d. Surfaces
  // the freshest delays at the top so ops can recover them before they
  // compound.
  out.sort((a, b) => a.delayDays - b.delayDays);
  return out;
}

function byBatchCountDesc(a: Bucket, b: Bucket): number {
  if (b.batchCount !== a.batchCount) return b.batchCount - a.batchCount;
  return a.label.localeCompare(b.label);
}

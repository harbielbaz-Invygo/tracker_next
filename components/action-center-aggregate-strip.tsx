"use client";

/**
 * Action Center → aggregate filter strip.
 *
 * Sits above the Batches table. Three independent groupings of *open*
 * (waiting/blocked) work across all visible batches:
 *
 *   By Action         — "3 Waiting Car Specs"   (action_type)
 *   By Department     — "5 Specs"               (department)
 *   By Stakeholder    — "4 Ahmed"               (assigned stakeholder)
 *
 * Each chip is a distinct-batch count: a batch with two waiting actions
 * owned by Specs counts ONCE in the Specs department chip.
 *
 * Clicking any chip applies it as a single-select filter. The shell
 * narrows the visible batch rows accordingly. Clicking the same chip
 * again clears it. Only one chip is active at a time across all three
 * rows — keeps the model simple.
 */
import type { ActionCenterRow } from "@/lib/action-center-data";
import { cn } from "@/lib/utils";

/** Discriminated union — one active filter at a time across all 3 rows. */
export type AggregateFilter =
  | { kind: "action";      id: number; label: string }
  | { kind: "department";  id: number; label: string }
  | { kind: "stakeholder"; id: number; label: string }
  | null;

interface Props {
  /**
   * Rows AFTER the high-level filters (dealer / lifecycle / status / show
   * completed) but BEFORE the aggregate filter — so the chip counts reflect
   * what the user would see if they cleared this filter, not a stale total.
   */
  rows: ActionCenterRow[];
  active: AggregateFilter;
  onChange: (next: AggregateFilter) => void;
}

interface Bucket {
  id: number;
  label: string;
  secondary?: string; // e.g. department under a stakeholder
  batchCount: number;
}

export default function ActionCenterAggregateStrip({ rows, active, onChange }: Props) {
  const { byAction, byDepartment, byStakeholder } = aggregate(rows);

  // Bail out: no open actions at all → no strip. Avoids an empty section
  // taking visual weight on a fully-delivered or fresh setup.
  const total = byAction.length + byDepartment.length + byStakeholder.length;
  if (total === 0) return null;

  function isActive(kind: AggregateFilter extends infer T ? T extends { kind: infer K } ? K : never : never, id: number): boolean {
    return active != null && active.kind === kind && active.id === id;
  }

  function toggle(kind: "action" | "department" | "stakeholder", id: number, label: string) {
    if (active != null && active.kind === kind && active.id === id) {
      onChange(null);
    } else {
      onChange({ kind, id, label });
    }
  }

  return (
    <section
      aria-label="Aggregate filters"
      className="card space-y-2.5"
    >
      <header className="flex items-baseline justify-between gap-3 mb-1">
        <p className="text-xs font-medium text-ink-500 uppercase tracking-wide">
          Outstanding work — click to filter
        </p>
        {active && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-[0.7rem] font-medium text-brand-dark hover:text-midnight underline-offset-2 hover:underline"
            title="Clear the active aggregate filter"
          >
            ✕ Clear filter
          </button>
        )}
      </header>

      <ChipRow
        label="By Action"
        buckets={byAction}
        kind="action"
        active={active}
        onToggle={toggle}
      />
      <ChipRow
        label="By Department"
        buckets={byDepartment}
        kind="department"
        active={active}
        onToggle={toggle}
      />
      <ChipRow
        label="By Stakeholder"
        buckets={byStakeholder}
        kind="stakeholder"
        active={active}
        onToggle={toggle}
      />
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// Chip row
// ──────────────────────────────────────────────────────────────────

function ChipRow({
  label, buckets, kind, active, onToggle,
}: {
  label: string;
  buckets: Bucket[];
  kind: "action" | "department" | "stakeholder";
  active: AggregateFilter;
  onToggle: (kind: "action" | "department" | "stakeholder", id: number, label: string) => void;
}) {
  if (buckets.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="text-[0.7rem] font-medium text-ink-600 w-28 shrink-0">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {buckets.map((b) => {
          const isActive = active != null && active.kind === kind && active.id === b.id;
          return (
            <button
              key={`${kind}-${b.id}`}
              type="button"
              onClick={() => onToggle(kind, b.id, b.label)}
              aria-pressed={isActive}
              className={cn(
                "inline-flex items-baseline gap-1.5 px-2 py-1 rounded-md border text-xs whitespace-nowrap",
                "transition-colors focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2",
                isActive
                  ? "bg-brand text-white border-brand shadow-sm"
                  : "bg-white text-midnight border-ink-200 hover:bg-ink-50 hover:border-ink-300",
              )}
              title={
                isActive
                  ? `Clear filter: ${b.label}`
                  : `Filter to batches with ${b.label}`
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
 * Walk every row's open actions and bucket them three ways. Each bucket
 * counts DISTINCT batches — a batch with two waiting Specs actions
 * contributes once to the Specs department chip, not twice. Buckets are
 * sorted by batchCount desc so the busiest work surfaces left-most.
 */
function aggregate(rows: ActionCenterRow[]): {
  byAction:      Bucket[];
  byDepartment:  Bucket[];
  byStakeholder: Bucket[];
} {
  // batchSets[kind][id] → Set<batchId>
  const actionMap      = new Map<number, { label: string; batches: Set<number> }>();
  const departmentMap  = new Map<number, { label: string; batches: Set<number> }>();
  const stakeholderMap = new Map<number, { label: string; department: string | null; batches: Set<number> }>();

  for (const r of rows) {
    for (const oa of r.openActions) {
      // By action
      {
        const entry = actionMap.get(oa.actionTypeId) ?? {
          label: oa.waitingLabel || oa.actionTypeName,
          batches: new Set<number>(),
        };
        entry.batches.add(r.batchId);
        actionMap.set(oa.actionTypeId, entry);
      }
      // By department
      if (oa.departmentId != null) {
        const entry = departmentMap.get(oa.departmentId) ?? {
          label: oa.departmentName ?? "—",
          batches: new Set<number>(),
        };
        entry.batches.add(r.batchId);
        departmentMap.set(oa.departmentId, entry);
      }
      // By stakeholder
      if (oa.stakeholderId != null) {
        const entry = stakeholderMap.get(oa.stakeholderId) ?? {
          label: oa.stakeholderName ?? "—",
          department: oa.departmentName ?? null,
          batches: new Set<number>(),
        };
        entry.batches.add(r.batchId);
        stakeholderMap.set(oa.stakeholderId, entry);
      }
    }
  }

  const byAction: Bucket[] = Array.from(actionMap.entries()).map(([id, v]) => ({
    id, label: v.label, batchCount: v.batches.size,
  })).sort(byBatchCountDesc);

  const byDepartment: Bucket[] = Array.from(departmentMap.entries()).map(([id, v]) => ({
    id, label: v.label, batchCount: v.batches.size,
  })).sort(byBatchCountDesc);

  const byStakeholder: Bucket[] = Array.from(stakeholderMap.entries()).map(([id, v]) => ({
    id, label: v.label, secondary: v.department ?? undefined, batchCount: v.batches.size,
  })).sort(byBatchCountDesc);

  return { byAction, byDepartment, byStakeholder };
}

function byBatchCountDesc(a: Bucket, b: Bucket): number {
  if (b.batchCount !== a.batchCount) return b.batchCount - a.batchCount;
  return a.label.localeCompare(b.label);
}

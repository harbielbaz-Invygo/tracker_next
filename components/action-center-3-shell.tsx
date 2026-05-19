"use client";

/**
 * Action Center 3 — client shell for the redesigned External-Phase
 * view. Picks one PO at a time via a top-of-page select; renders its
 * delivery windows as a vertical list of cards. Everything (the
 * data shape, the action endpoints, the cascade behaviour) is shared
 * with the original /action-center page — only the visual design and
 * interaction model differ.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  ActionCenterTree, PoNode, WaveNode, BatchNode, ScopedActionDetail,
} from "@/lib/action-center-tree-data";
import { cn } from "@/lib/utils";

type Status = ScopedActionDetail["status"];

interface Props {
  tree: ActionCenterTree;
}

export default function ActionCenter3Shell({ tree }: Props) {
  const router = useRouter();

  // Flatten POs across dealers for the dropdown. Sorted by dealer name,
  // then by PO number for predictable ordering.
  const allPos = useMemo(() => {
    const flat: { po: PoNode; dealerName: string }[] = [];
    for (const d of tree.dealers) {
      for (const p of d.pos) {
        flat.push({ po: p, dealerName: d.name });
      }
    }
    return flat.sort((a, b) =>
      a.dealerName.localeCompare(b.dealerName)
      || a.po.poNumber.localeCompare(b.po.poNumber),
    );
  }, [tree]);

  const [selectedPoId, setSelectedPoId] = useState<number | null>(
    () => allPos[0]?.po.id ?? null,
  );
  const selected = useMemo(
    () => allPos.find((x) => x.po.id === selectedPoId) ?? null,
    [allPos, selectedPoId],
  );

  // Mutation helpers — identical to the main shell. Kept inline for
  // self-containment; the test page has no shared context.
  const [busyActionId, setBusyActionId] = useState<number | null>(null);
  const [busyBatchId,  setBusyBatchId]  = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setActionStatus(actionId: number, status: Status) {
    setBusyActionId(actionId);
    setError(null);
    try {
      const res = await fetch("/api/scope-action", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ actionId, status }),
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyActionId(null);
    }
  }
  async function runBatchOp(batchId: number, url: string, body: unknown) {
    setBusyBatchId(batchId);
    setError(null);
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyBatchId(null);
    }
  }

  // Selection set for the floating bulk action bar. Selecting via the
  // checkbox on each batch card. Cleared when the active PO changes
  // so stale selections from a previous PO can't accidentally fire.
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<number>>(new Set());
  function toggleBatch(batchId: number) {
    setSelectedBatchIds((curr) => {
      const next = new Set(curr);
      if (next.has(batchId)) next.delete(batchId); else next.add(batchId);
      return next;
    });
  }
  function clearBatchSelection() { setSelectedBatchIds(new Set()); }

  return (
    <div className="min-h-[60vh] bg-ink-50/60 -mx-4 px-4 py-4 sm:rounded-lg">
      {/* Top bar — PO picker + light meta */}
      <div className="flex flex-wrap items-center gap-3 mb-4 bg-white rounded-lg border border-ink-200 px-4 py-3 shadow-sm">
        <label className="text-xs text-ink-500 font-medium">PO</label>
        <select
          value={selectedPoId ?? ""}
          onChange={(e) => {
            const id = e.target.value ? parseInt(e.target.value, 10) : null;
            setSelectedPoId(id);
            clearBatchSelection();
          }}
          className="text-sm px-2.5 py-1.5 border border-ink-300 rounded-md bg-white min-w-[260px]"
        >
          {allPos.length === 0 && <option value="">No POs yet</option>}
          {allPos.map(({ po, dealerName }) => (
            <option key={po.id} value={po.id}>
              {po.poNumber} — {dealerName}
              {po.closedAt ? " (closed)" : ""}
            </option>
          ))}
        </select>
        {selected && (
          <p className="text-xs text-ink-600 ml-auto tabular-nums">
            {selected.po.totalCars} cars · {selected.po.waves.length} window
            {selected.po.waves.length === 1 ? "" : "s"}
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="text-xs text-flame-dark bg-flame-pale border border-flame px-3 py-2 rounded-md mb-3">
          Could not update: {error}
        </p>
      )}

      {!selected ? (
        <p className="text-sm text-ink-500 italic px-2 py-8 text-center">
          Pick a PO from the dropdown above.
        </p>
      ) : selected.po.waves.length === 0 ? (
        <p className="text-sm text-ink-500 italic px-2 py-8 text-center">
          No delivery windows yet on this PO.
        </p>
      ) : (
        <div className="space-y-4 pb-24">
          {selected.po.waves.map((w) => (
            <WindowCard
              key={w.id}
              wave={w}
              po={selected.po}
              selectedBatchIds={selectedBatchIds}
              onToggleBatch={toggleBatch}
              busyActionId={busyActionId}
              busyBatchId={busyBatchId}
              onChangeStatus={setActionStatus}
              onBatchOp={runBatchOp}
            />
          ))}
        </div>
      )}

      {selectedBatchIds.size > 0 && selected && (
        <FloatingBulkBar
          selectedCount={selectedBatchIds.size}
          onClear={clearBatchSelection}
          onShift={() => runWindowBulk(
            "shift",
            selected.po,
            selectedBatchIds,
            runBatchOp,
            setActionStatus,
          )}
          onCancel={() => runWindowBulk(
            "cancel",
            selected.po,
            selectedBatchIds,
            runBatchOp,
            setActionStatus,
          )}
          onDeliver={() => runWindowBulk(
            "deliver",
            selected.po,
            selectedBatchIds,
            runBatchOp,
            setActionStatus,
          )}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Window card
// ─────────────────────────────────────────────────────────────

function WindowCard({
  wave, po, selectedBatchIds, onToggleBatch,
  busyActionId, busyBatchId, onChangeStatus, onBatchOp,
}: {
  wave: WaveNode;
  po: PoNode;
  selectedBatchIds: Set<number>;
  onToggleBatch: (id: number) => void;
  busyActionId: number | null;
  busyBatchId:  number | null;
  onChangeStatus: (actionId: number, status: Status) => void;
  onBatchOp: (batchId: number, url: string, body: unknown) => Promise<void>;
}) {
  const [historyOpen, setHistoryOpen] = useState<boolean>(false);
  const total = wave.actions.length;
  const done  = wave.actions.filter((a) => a.status === "done" || a.status === "skipped").length;
  const pct   = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <section className="bg-white rounded-xl border border-ink-200 shadow-sm overflow-hidden">
      {/* Header — prominent. Progress bar gives ops a visual read of
          how far through the External Phase this window is. */}
      <header className="px-5 py-4 border-b border-ink-100">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <CalendarIcon className="text-brand-dark" />
          <h2 className="text-lg font-bold text-midnight">
            Delivery Window · {wave.availabilityDate}
          </h2>
          <span className="text-xs text-ink-500 tabular-nums">
            {wave.batches.reduce((s, b) => s + b.requestedQuantity, 0)} cars
            <span className="mx-1.5 text-ink-300">·</span>
            {wave.batches.length} batch{wave.batches.length === 1 ? "" : "es"}
          </span>
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            className="ml-auto text-xs text-brand-dark font-medium hover:underline"
          >
            {historyOpen ? "Hide" : "View"} shift history
          </button>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <div className="flex-1 h-2 rounded-full bg-ink-100 overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                pct === 100 ? "bg-green" : "bg-brand",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-xs text-ink-600 tabular-nums font-medium">
            {done}/{total} · {pct}%
          </span>
        </div>
      </header>

      {/* Collapsible shift-history drawer. Static once shifts happen,
          so hidden by default — pulls into view on demand. */}
      {historyOpen && <ShiftHistoryDrawer wave={wave} />}

      {/* Batch cards */}
      <div className="px-5 py-4 space-y-3">
        {wave.batches.map((b) => (
          <BatchCard
            key={b.id}
            batch={b}
            wave={wave}
            internalPhaseDone={po.internalPhaseDone}
            selected={selectedBatchIds.has(b.id)}
            onToggle={() => onToggleBatch(b.id)}
            busyActionId={busyActionId}
            busyBatchId={busyBatchId}
            onChangeStatus={onChangeStatus}
            onBatchOp={onBatchOp}
          />
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Batch card with progress stepper + status pill
// ─────────────────────────────────────────────────────────────

function BatchCard({
  batch: b, wave, internalPhaseDone, selected, onToggle,
  busyActionId, busyBatchId, onChangeStatus, onBatchOp,
}: {
  batch: BatchNode;
  wave: WaveNode;
  internalPhaseDone: boolean;
  selected: boolean;
  onToggle: () => void;
  busyActionId: number | null;
  busyBatchId:  number | null;
  onChangeStatus: (actionId: number, status: Status) => void;
  onBatchOp: (batchId: number, url: string, body: unknown) => Promise<void>;
}) {
  const delivery = b.actions.find((a) => a.actionTypeName === "Delivery");
  const closed = b.closedAt != null;
  const isListed = b.appListedAt != null;
  const batchBusy = busyBatchId === b.id;

  // External-Phase actions for THIS batch — prefer batch-scope copies,
  // fall back to the wave-scope row for legacy batches that pre-date
  // the per-batch rollout.
  const waveTypeIds = new Set(wave.actions.map((a) => a.actionTypeId));
  const batchScopeExternal = b.actions
    .filter((a) => waveTypeIds.has(a.actionTypeId))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const externalActions = batchScopeExternal.length > 0
    ? batchScopeExternal
    : wave.actions.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const externalPending = externalActions.filter(
    (a) => a.status !== "done" && a.status !== "skipped",
  );
  const externalReady = externalActions.length > 0 && externalPending.length === 0;

  // Status pill — derived from where in the workflow this batch sits.
  // Pill replaces the locked Mark-as-delivered button when the gates
  // aren't met; once deliverable, the pill becomes the actionable CTA.
  const pill: { label: string; tone: "neutral" | "amber" | "blue" | "green" | "flame" } =
    closed && b.closureReason === "delivered" ? { label: `✓ Delivered ${b.closedAt}`, tone: "green" } :
    closed                                    ? { label: `🚫 Cancelled`, tone: "flame" } :
    !internalPhaseDone                        ? { label: "Awaiting Internal Phase", tone: "amber" } :
    !isListed                                 ? { label: "Awaiting App Listing", tone: "amber" } :
    externalPending.length > 0                ? { label: `Awaiting ${externalPending[0].doneLabel || externalPending[0].actionTypeName}`, tone: "blue" } :
    externalReady                             ? { label: "Ready to deliver", tone: "green" } :
                                                { label: "In progress", tone: "blue" };

  return (
    <article
      className={cn(
        "rounded-lg border bg-white transition-all",
        "hover:shadow-md hover:border-ink-300",
        selected ? "border-brand ring-2 ring-brand/30" : "border-ink-200",
        closed && "opacity-70",
      )}
    >
      {/* Header row — checkbox · code · model · qty · pill */}
      <div className="px-4 pt-3 pb-2 flex flex-wrap items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${b.batchCode}`}
          className="mt-1 h-4 w-4 accent-brand cursor-pointer"
        />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 className="text-base font-semibold text-midnight tracking-tight">
              {b.modelYear}
            </h3>
            <code className="text-[0.7rem] font-mono text-ink-400">{b.batchCode}</code>
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-ink-600">
            <span className="tabular-nums">
              <CarIcon className="inline -mt-0.5 text-ink-400" /> {b.requestedQuantity}
            </span>
            {b.legs.length > 0 ? (
              <span className="text-ink-500">
                <PinIcon className="inline -mt-0.5 text-ink-400" />
                {" "}
                {b.legs.map((l) => `${l.city} ${l.quantity}`).join(", ")}
              </span>
            ) : (
              <span className="text-ink-500">
                <PinIcon className="inline -mt-0.5 text-ink-400" /> {b.city}
              </span>
            )}
            <span className="tabular-nums text-ink-500">
              📅 Promised {b.promisedDate}
            </span>
            {b.currentProjectedDeliveryDate
              && b.currentProjectedDeliveryDate !== b.promisedDate && (
              <span className="tabular-nums text-ink-500">
                ⏰ Ops {b.currentProjectedDeliveryDate}
              </span>
            )}
            {isListed && (
              <span className="tabular-nums text-green-dark">
                📱 listed {b.appListedAt!.slice(0, 10)}
              </span>
            )}
          </div>
        </div>
        <StatusPill
          label={pill.label}
          tone={pill.tone}
          interactive={pill.label === "Ready to deliver" && !!delivery}
          busy={!!delivery && busyActionId === delivery.id}
          onClick={() => delivery && onChangeStatus(delivery.id, "done")}
        />
      </div>

      {/* Progress stepper */}
      <div className="px-4 py-3 border-t border-ink-100 bg-ink-50/40">
        <ProgressStepper actions={externalActions}
          busyActionId={busyActionId}
          onChangeStatus={onChangeStatus}
        />
      </div>

      {/* Closure controls */}
      {!closed && (
        <div className="px-4 py-2.5 border-t border-ink-100 flex flex-wrap gap-2 items-center">
          <PrimaryBtn
            label="📅 Shift date"
            busy={batchBusy}
            onClick={() => {
              const next = window.prompt(`New projected availability date for ${b.batchCode} (yyyy-mm-dd):`);
              if (!next || !/^\d{4}-\d{2}-\d{2}$/.test(next.trim())) return;
              onBatchOp(b.id, "/api/batch-shift", {
                batchId: b.id,
                newProjectedDate: next.trim(),
                bookingsAtShift: 0,
                reason: null,
              });
            }}
          />
          <GhostBtn
            label="Cancel"
            busy={batchBusy}
            onClick={() => {
              if (!window.confirm(`Cancel ${b.batchCode}? This closes the batch as cancelled.`)) return;
              onBatchOp(b.id, "/api/batch-close", {
                batchId: b.id,
                reason: "cancelled",
                note: null,
              });
            }}
          />
        </div>
      )}
    </article>
  );
}

// ─────────────────────────────────────────────────────────────
// Horizontal progress stepper
// ─────────────────────────────────────────────────────────────

function ProgressStepper({
  actions, busyActionId, onChangeStatus,
}: {
  actions: ScopedActionDetail[];
  busyActionId: number | null;
  onChangeStatus: (actionId: number, status: Status) => void;
}) {
  if (actions.length === 0) {
    return <p className="text-xs text-ink-500 italic">No external-phase actions on this batch.</p>;
  }

  // Pick the next pending action as "in progress" — visually
  // distinguishes "where are we right now" from the rest.
  const nextPendingIdx = actions.findIndex((a) => a.status !== "done" && a.status !== "skipped");

  return (
    <ol className="relative grid gap-y-3" style={{
      gridTemplateColumns: `repeat(${actions.length}, minmax(0, 1fr))`,
    }}>
      {/* Connector line behind the dots */}
      <span
        aria-hidden
        className="absolute top-3 left-0 right-0 h-0.5 bg-ink-200"
        style={{ marginLeft: `calc(100% / ${actions.length * 2})`, marginRight: `calc(100% / ${actions.length * 2})` }}
      />
      {actions.map((a, idx) => {
        const isDone     = a.status === "done";
        const isSkipped  = a.status === "skipped";
        const isInProg   = idx === nextPendingIdx;
        const isBlocked  = a.status === "blocked";
        const isPending  = !isDone && !isSkipped && !isInProg;
        const busy = busyActionId === a.id;

        const dotCls =
          isDone   ? "bg-green text-white border-green" :
          isSkipped? "bg-ink-300 text-white border-ink-300" :
          isBlocked? "bg-flame text-white border-flame" :
          isInProg ? "bg-brand text-white border-brand ring-4 ring-brand-pastel" :
                     "bg-white text-ink-400 border-ink-300";

        const labelCls =
          isDone    ? "text-green-dark" :
          isSkipped ? "text-ink-400 line-through" :
          isBlocked ? "text-flame-dark" :
          isInProg  ? "text-brand-dark font-medium" :
                      "text-ink-500";

        const tooltipBits = [
          a.doneLabel || a.actionTypeName,
          a.expectedDate ? `due ${a.expectedDate}` : null,
          a.stakeholderName ? `@${a.stakeholderName}` : null,
          isBlocked && a.blockedByNames.length > 0
            ? `waiting on ${a.blockedByNames.join(", ")}`
            : null,
        ].filter(Boolean) as string[];

        // Click handler: progress waiting → done; blocked → waiting;
        // done/skipped → revert to waiting (re-open).
        const nextStatus: Status =
          a.status === "waiting" || a.status === "blocked" ? "done" :
          "waiting";

        return (
          <li key={a.id} className="relative z-10 flex flex-col items-center text-center">
            <button
              type="button"
              onClick={() => a.id >= 0 && onChangeStatus(a.id, nextStatus)}
              disabled={busy || a.id < 0}
              title={tooltipBits.join(" · ")}
              aria-label={a.doneLabel || a.actionTypeName}
              className={cn(
                "h-6 w-6 rounded-full border-2 flex items-center justify-center text-[0.6rem] font-bold transition-all",
                dotCls,
                !busy && a.id >= 0 && "hover:scale-110 cursor-pointer",
                busy && "opacity-50 cursor-wait",
              )}
            >
              {isDone ? "✓"
                : isSkipped ? "⏭"
                : isBlocked ? "!"
                : isInProg  ? "●"
                :              ""}
            </button>
            <span className={cn("mt-1.5 text-[0.65rem] leading-tight px-0.5", labelCls)}>
              {truncate(a.doneLabel || a.actionTypeName, 14)}
            </span>
            {isPending && (
              <span className="text-[0.6rem] text-ink-400">Pending</span>
            )}
            {isInProg && (
              <span className="text-[0.6rem] text-brand-dark font-medium">In progress</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ─────────────────────────────────────────────────────────────
// Status pill, primary/ghost buttons, icons, drawer
// ─────────────────────────────────────────────────────────────

function StatusPill({
  label, tone, interactive, busy, onClick,
}: {
  label: string;
  tone: "neutral" | "amber" | "blue" | "green" | "flame";
  interactive: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  const toneCls = {
    neutral: "bg-ink-100 text-ink-700",
    amber:   "bg-gold-pale text-gold-dark",
    blue:    "bg-brand-pastel text-brand-dark",
    green:   "bg-green-pale text-green-dark",
    flame:   "bg-flame-pale text-flame-dark",
  }[tone];

  if (!interactive) {
    return (
      <span className={cn("text-xs font-medium rounded-full px-3 py-1 inline-flex items-center gap-1 whitespace-nowrap", toneCls)}>
        {label}
      </span>
    );
  }
  // Interactive variant — fires the Delivery flip.
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        "text-xs font-medium rounded-full px-3 py-1 inline-flex items-center gap-1 whitespace-nowrap transition-colors",
        "bg-green text-white hover:bg-green-dark",
        busy && "opacity-50 cursor-wait",
      )}
    >
      {busy ? "…" : `✓ ${label}`}
    </button>
  );
}

function PrimaryBtn({
  label, busy, onClick,
}: { label: string; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        "text-xs font-medium px-3 py-1.5 rounded-md bg-brand text-white hover:bg-brand-dark transition-colors",
        busy && "opacity-50 cursor-wait",
      )}
    >
      {busy ? "…" : label}
    </button>
  );
}

function GhostBtn({
  label, busy, onClick,
}: { label: string; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        "text-xs font-medium px-3 py-1.5 rounded-md border border-ink-300 text-ink-600 hover:bg-ink-50 transition-colors",
        busy && "opacity-50 cursor-wait",
      )}
    >
      {busy ? "…" : label}
    </button>
  );
}

// ─── line icons ──────────────────────────────────────────────

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={cn("h-5 w-5", className)} aria-hidden>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}
function PinIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={cn("h-3.5 w-3.5 mr-0.5", className)} aria-hidden>
      <path d="M12 21s-7-7.6-7-12a7 7 0 0114 0c0 4.4-7 12-7 12z" />
      <circle cx="12" cy="9" r="2.5" />
    </svg>
  );
}
function CarIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={cn("h-3.5 w-3.5 mr-0.5", className)} aria-hidden>
      <path d="M5 17h14M5 17a2 2 0 01-2-2v-2l2-5h14l2 5v2a2 2 0 01-2 2M5 17v2M19 17v2" />
      <circle cx="8" cy="17" r="1.5" />
      <circle cx="16" cy="17" r="1.5" />
    </svg>
  );
}

// ─── Shift history drawer ───────────────────────────────────

function ShiftHistoryDrawer({ wave }: { wave: WaveNode }) {
  function ordinal(n: number): string {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  if (wave.batches.length === 0) return null;
  return (
    <div className="px-5 py-3 border-b border-ink-100 bg-gold-pale/20 text-[0.75rem]">
      <p className="text-[0.65rem] font-bold uppercase tracking-wide text-gold-dark mb-1.5">
        Shift history
      </p>
      <div className="space-y-1.5">
        {wave.batches.map((b) => {
          const original = b.shiftHistory.length > 0
            ? b.shiftHistory[0].previousDate
            : b.promisedDate;
          return (
            <div key={b.id}>
              <p className="flex flex-wrap items-baseline gap-x-1.5">
                <code className="text-[0.7rem] text-midnight font-mono">{b.batchCode}</code>
                <span className="text-ink-400">·</span>
                <span className="text-ink-700">
                  Promised <span className="text-midnight tabular-nums">{original}</span>
                </span>
                {b.shiftHistory.length === 0 && (
                  <span className="text-ink-400 italic">(no shifts yet)</span>
                )}
              </p>
              {b.shiftHistory.length > 0 && (
                <ul className="ml-4 mt-0.5 space-y-0.5">
                  {b.shiftHistory.map((s, idx) => (
                    <li key={`${b.id}:${idx}`} className="text-ink-700">
                      <span className="text-gold-dark font-medium">{ordinal(idx + 1)} shift</span>
                      {" on "}
                      <span className="tabular-nums">{(s.revisedAt || "").slice(0, 10) || "—"}</span>
                      {" → "}
                      <span className="tabular-nums">{s.newDate}</span>
                      {s.reason && (
                        <span className="text-ink-500 italic ml-1">· {s.reason}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Floating bulk action bar ───────────────────────────────

function FloatingBulkBar({
  selectedCount, onClear, onShift, onCancel, onDeliver,
}: {
  selectedCount: number;
  onClear: () => void;
  onShift: () => void;
  onCancel: () => void;
  onDeliver: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 bg-white border border-ink-300 rounded-full shadow-lg px-4 py-2 flex items-center gap-2"
    >
      <span className="text-xs font-medium text-midnight px-2">
        {selectedCount} selected
      </span>
      <span className="h-4 w-px bg-ink-200" />
      <button
        type="button"
        onClick={onShift}
        className="text-xs px-3 py-1 rounded-full text-brand-dark hover:bg-brand-pastel/60"
      >
        📅 Shift
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="text-xs px-3 py-1 rounded-full text-flame-dark hover:bg-flame-pale/60"
      >
        🚫 Cancel
      </button>
      <button
        type="button"
        onClick={onDeliver}
        className="text-xs px-3 py-1 rounded-full bg-green text-white hover:bg-green-dark font-medium"
      >
        ✓ Mark delivered
      </button>
      <span className="h-4 w-px bg-ink-200" />
      <button
        type="button"
        onClick={onClear}
        className="text-xs px-2 py-1 text-ink-500 hover:text-midnight"
        aria-label="Clear selection"
      >
        ✕
      </button>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Loops a bulk operation over every selected batch. Kept inline to
 * the shell to avoid prop-drilling another callback through the card
 * components; the cards just open/close the floating bar.
 */
async function runWindowBulk(
  kind: "shift" | "cancel" | "deliver",
  po: PoNode,
  ids: Set<number>,
  onBatchOp: (batchId: number, url: string, body: unknown) => Promise<void>,
  onChangeStatus: (actionId: number, status: Status) => void,
) {
  const batches = po.waves.flatMap((w) =>
    w.batches.filter((b) => ids.has(b.id) && b.closedAt == null),
  );
  if (batches.length === 0) return;

  if (kind === "shift") {
    const next = window.prompt("New projected availability date (yyyy-mm-dd):");
    if (!next || !/^\d{4}-\d{2}-\d{2}$/.test(next.trim())) return;
    const reason = window.prompt("Reason (optional):") || null;
    for (const b of batches) {
      await onBatchOp(b.id, "/api/batch-shift", {
        batchId: b.id,
        newProjectedDate: next.trim(),
        bookingsAtShift: 0,
        reason,
      });
    }
    return;
  }
  if (kind === "cancel") {
    if (!window.confirm(`Cancel ${batches.length} batch(es)? This is destructive.`)) return;
    const note = window.prompt("Cancellation note (optional):") || null;
    for (const b of batches) {
      await onBatchOp(b.id, "/api/batch-close", {
        batchId: b.id,
        reason: "cancelled",
        note,
      });
    }
    return;
  }
  // deliver
  if (!window.confirm(`Mark ${batches.length} batch(es) as delivered?`)) return;
  for (const b of batches) {
    const delivery = b.actions.find((a) => a.actionTypeName === "Delivery");
    if (delivery) onChangeStatus(delivery.id, "done");
  }
}

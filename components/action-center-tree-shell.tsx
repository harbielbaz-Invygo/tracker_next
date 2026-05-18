"use client";

/**
 * Action Center v2 — Dealer ▸ PO tree on the left, PO detail drawer
 * on the right. The drawer's content swaps between Internal Phase and
 * VIN Chase via a top toggle, per the spec discussion.
 *
 *   Internal Phase view → PO-scope actions (one set, applies to every
 *                          batch under this PO)
 *   VIN Chase view     → Wave-scope actions, grouped per availability
 *                         date. Each wave's batches listed beneath.
 *
 * Read-only in phase 3a; mutations (mark done / skip) land in phase 3b.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  ActionCenterTree, PoNode, WaveNode, BatchNode, ScopedActionDetail,
} from "@/lib/action-center-tree-data";
import { cn } from "@/lib/utils";

type Status = ScopedActionDetail["status"];

type DrawerView = "internal" | "vin";
const DRAWER_VIEW_KEY = "action-center-v2-drawer-view";

interface Props {
  tree: ActionCenterTree;
}

export default function ActionCenterTreeShell({ tree }: Props) {
  const router = useRouter();

  // Selection: the PO id. Null until the first PO is clicked.
  const [selectedPoId, setSelectedPoId] = useState<number | null>(null);
  const [view, setView] = useState<DrawerView>("internal");

  // Track which row is busy / errored so the buttons can show pending
  // state. Single-shot is fine for a list of dozens.
  const [busyActionId,  setBusyActionId]  = useState<number | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  async function setActionStatus(actionId: number, status: Status) {
    setBusyActionId(actionId);
    setMutationError(null);
    try {
      const res = await fetch("/api/scope-action", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId, status }),
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyActionId(null);
    }
  }
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(DRAWER_VIEW_KEY);
      if (stored === "internal" || stored === "vin") setView(stored);
    } catch { /* private mode */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(DRAWER_VIEW_KEY, view); } catch { /* ignore */ }
  }, [view]);

  // Flatten to find the selected PO node — small dataset, cheap.
  const selectedPo = useMemo<PoNode | null>(() => {
    if (selectedPoId == null) return null;
    for (const d of tree.dealers) {
      const hit = d.pos.find((p) => p.id === selectedPoId);
      if (hit) return hit;
    }
    return null;
  }, [tree, selectedPoId]);

  const dealerOfSelected = useMemo(() => {
    if (selectedPoId == null) return null;
    return tree.dealers.find((d) => d.pos.some((p) => p.id === selectedPoId)) ?? null;
  }, [tree, selectedPoId]);

  // Default to the first PO once data loads.
  useEffect(() => {
    if (selectedPoId == null && tree.dealers[0]?.pos[0]) {
      setSelectedPoId(tree.dealers[0].pos[0].id);
    }
  }, [tree, selectedPoId]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 h-[min(80vh,860px)] min-h-[520px]">
      {/* ─────────── Left: Dealer → PO tree ─────────── */}
      <DealerTree
        tree={tree}
        selectedPoId={selectedPoId}
        onSelect={setSelectedPoId}
      />

      {/* ─────────── Right: PO detail drawer ─────────── */}
      <div className="border border-ink-200 rounded-lg bg-white overflow-hidden flex flex-col">
        {selectedPo && dealerOfSelected ? (
          <PoDrawer
            po={selectedPo}
            dealerName={dealerOfSelected.name}
            view={view}
            onChangeView={setView}
            busyActionId={busyActionId}
            onChangeStatus={setActionStatus}
            mutationError={mutationError}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-ink-500 text-center px-8">
            {tree.dealers.length === 0
              ? "No POs yet. Submit one via Intake to populate this view."
              : "Pick a PO from the tree on the left."}
          </div>
        )}
      </div>
    </div>
  );
}

interface MutationProps {
  busyActionId:   number | null;
  onChangeStatus: (actionId: number, status: Status) => void;
  mutationError:  string | null;
}

// ─────────────────────────────────────────────────────────────
// Left panel — Dealer → PO tree
// ─────────────────────────────────────────────────────────────

function DealerTree({
  tree, selectedPoId, onSelect,
}: {
  tree: ActionCenterTree;
  selectedPoId: number | null;
  onSelect: (id: number) => void;
}) {
  const [expandedDealers, setExpandedDealers] = useState<Set<number>>(
    () => new Set(tree.dealers.map((d) => d.id)),
  );

  function toggleDealer(id: number) {
    setExpandedDealers((curr) => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <aside className="border border-ink-200 rounded-lg bg-white overflow-hidden flex flex-col">
      <header className="px-3 py-2.5 border-b border-ink-200 shrink-0 flex items-baseline justify-between">
        <h3 className="text-sm font-bold text-midnight">Dealers ▸ POs</h3>
        <span className="text-xs text-ink-500 tabular-nums">
          {tree.dealers.length} {tree.dealers.length === 1 ? "dealer" : "dealers"}
        </span>
      </header>
      <ul className="flex-1 overflow-auto">
        {tree.dealers.map((d) => {
          const expanded = expandedDealers.has(d.id);
          return (
            <li key={d.id} className="border-b border-ink-200/60 last:border-b-0">
              <button
                type="button"
                onClick={() => toggleDealer(d.id)}
                className="w-full text-left px-3 py-2 hover:bg-ink-50 flex items-center gap-2"
              >
                <span aria-hidden className="text-ink-400 text-xs">
                  {expanded ? "▾" : "▸"}
                </span>
                <span className="font-medium text-sm text-midnight truncate">{d.name}</span>
                <span className="text-[0.65rem] text-ink-500 tabular-nums ml-auto">
                  {d.pos.length} PO{d.pos.length === 1 ? "" : "s"}
                </span>
              </button>
              {expanded && (
                <ul>
                  {d.pos.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => onSelect(p.id)}
                        className={cn(
                          "w-full text-left px-3 py-2 pl-8 text-xs",
                          "border-l-2",
                          p.id === selectedPoId
                            ? "bg-brand-pastel border-l-brand text-brand-dark"
                            : "border-l-transparent hover:bg-ink-50 text-ink-700",
                        )}
                      >
                        <div className="font-mono font-medium">{p.poNumber}</div>
                        <div className="text-[0.65rem] text-ink-500 mt-0.5 tabular-nums">
                          {p.totalCars} cars · {p.waves.length} wave{p.waves.length === 1 ? "" : "s"}
                          {p.closedAt && <span className="ml-1 text-green-dark">· closed</span>}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
        {tree.dealers.length === 0 && (
          <li className="px-3 py-8 text-sm text-ink-500 text-center">No POs yet.</li>
        )}
      </ul>
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────
// Right drawer — PO header + view toggle + scope sections
// ─────────────────────────────────────────────────────────────

function PoDrawer({
  po, dealerName, view, onChangeView,
  busyActionId, onChangeStatus, mutationError,
}: {
  po: PoNode;
  dealerName: string;
  view: DrawerView;
  onChangeView: (v: DrawerView) => void;
} & MutationProps) {
  return (
    <>
      {/* Header */}
      <header className="px-4 py-3 border-b border-ink-200 shrink-0 bg-ink-50/50">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-xl font-mono font-bold text-midnight">{po.poNumber}</h2>
          {po.poDate && (
            <span className="text-xs text-ink-500 tabular-nums">{po.poDate}</span>
          )}
        </div>
        <p className="text-xs text-ink-600 mt-1">
          <span className="font-medium text-midnight">🏢 {dealerName}</span>
          <span className="text-ink-300 mx-1.5">·</span>
          <span className="tabular-nums">{po.totalCars} cars</span>
          <span className="text-ink-300 mx-1.5">·</span>
          <span className="tabular-nums">{po.waves.length} wave{po.waves.length === 1 ? "" : "s"}</span>
          {po.contractLengthMonths && (
            <>
              <span className="text-ink-300 mx-1.5">·</span>
              <span className="tabular-nums">{po.contractLengthMonths}-month contract</span>
            </>
          )}
        </p>
      </header>

      {/* View toggle */}
      <div className="px-4 py-2 border-b border-ink-200 shrink-0 bg-white">
        <div role="tablist" className="inline-flex items-center bg-ink-100 rounded-md p-0.5">
          <ToggleBtn active={view === "internal"} onClick={() => onChangeView("internal")} label="Internal Phase" />
          <ToggleBtn active={view === "vin"}      onClick={() => onChangeView("vin")}      label="VIN Chase" />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {mutationError && (
          <p role="alert" className="text-xs text-flame-dark bg-flame-pale border border-flame px-3 py-2 rounded-md">
            Could not update: {mutationError}
          </p>
        )}
        {view === "internal" ? (
          <InternalPhaseView po={po} busyActionId={busyActionId} onChangeStatus={onChangeStatus} />
        ) : (
          <VinChaseView po={po} busyActionId={busyActionId} onChangeStatus={onChangeStatus} />
        )}
      </div>
    </>
  );
}

function ToggleBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap",
        active
          ? "bg-white text-midnight shadow-sm"
          : "text-ink-500 hover:text-midnight",
      )}
    >
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────
// Internal Phase — PO-scope actions
// ─────────────────────────────────────────────────────────────

function InternalPhaseView({
  po, busyActionId, onChangeStatus,
}: { po: PoNode } & Pick<MutationProps, "busyActionId" | "onChangeStatus">) {
  if (po.actions.length === 0) {
    return (
      <p className="text-sm text-ink-500 italic px-2">
        No PO-scope actions configured for this PO. Add some at Intake or in Settings → Action Types.
      </p>
    );
  }
  return (
    <section>
      <p className="text-[0.7rem] text-ink-500 mb-2">
        These actions apply to the entire PO — marking one done propagates across every batch beneath.
      </p>
      <ul className="space-y-2">
        {po.actions
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((a) => (
            <ActionRow
              key={a.id}
              action={a}
              busy={busyActionId === a.id}
              onChangeStatus={onChangeStatus}
            />
          ))}
      </ul>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// VIN Chase — per-wave sections with wave-scope actions + batches
// ─────────────────────────────────────────────────────────────

function VinChaseView({
  po, busyActionId, onChangeStatus,
}: { po: PoNode } & Pick<MutationProps, "busyActionId" | "onChangeStatus">) {
  if (po.waves.length === 0) {
    return (
      <p className="text-sm text-ink-500 italic px-2">
        No waves yet. Submit an Intake on this PO to create waves.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {po.waves.map((w) => (
        <WaveSection key={w.id} wave={w} busyActionId={busyActionId} onChangeStatus={onChangeStatus} />
      ))}
    </div>
  );
}

function WaveSection({
  wave, busyActionId, onChangeStatus,
}: { wave: WaveNode } & Pick<MutationProps, "busyActionId" | "onChangeStatus">) {
  // Waves are collapsed by default — a PO can have many waves and the
  // VIN Chase view gets long fast. Click the header to open one.
  const [expanded, setExpanded] = useState(false);
  const totalCars = wave.batches.reduce((s, b) => s + b.requestedQuantity, 0);
  // Tiny status summary in the collapsed header so ops can scan
  // progress without expanding every wave.
  const doneCount    = wave.actions.filter((a) => a.status === "done").length;
  const blockedCount = wave.actions.filter((a) => a.status === "blocked").length;
  return (
    <section className="border border-ink-200 rounded-md bg-ink-50/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full text-left px-3 py-2 border-b border-ink-200 bg-white hover:bg-ink-50 transition-colors"
      >
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span aria-hidden className="text-ink-400 text-xs">
            {expanded ? "▾" : "▸"}
          </span>
          <span className="text-sm font-semibold text-midnight">📅 Wave · {wave.availabilityDate}</span>
          <span className="text-xs text-ink-500 tabular-nums">
            {totalCars} cars · {wave.batches.length} batch{wave.batches.length === 1 ? "" : "es"}
          </span>
          {wave.opsExpectedDate && wave.opsExpectedDate !== wave.availabilityDate && (
            <span className="text-xs text-gold-dark tabular-nums">
              · ops projecting {wave.opsExpectedDate}
            </span>
          )}
          {wave.actions.length > 0 && (
            <span className="text-[0.65rem] text-ink-500 tabular-nums ml-auto">
              {doneCount}/{wave.actions.length} done
              {blockedCount > 0 && (
                <span className="text-flame-dark ml-1">· {blockedCount} blocked</span>
              )}
            </span>
          )}
        </p>
      </button>

      {expanded && (
        <>
          {/* Wave-scope actions */}
          <div className="px-3 py-2">
            {wave.actions.length === 0 ? (
              <p className="text-xs text-ink-500 italic">No VIN-chase actions on this wave.</p>
            ) : (
              <ul className="space-y-1.5">
                {wave.actions
                  .slice()
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                  .map((a) => (
                    <ActionRow
                      key={a.id}
                      action={a}
                      busy={busyActionId === a.id}
                      onChangeStatus={onChangeStatus}
                    />
                  ))}
              </ul>
            )}
          </div>

          {/* Batches in this wave */}
          <div className="px-3 py-2 border-t border-ink-200/60 bg-white">
            <p className="text-[0.65rem] font-medium uppercase tracking-wide text-ink-500 mb-1.5">
              Batches in this wave
            </p>
            <ul className="space-y-1">
              {wave.batches.map((b) => (
                <li key={b.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                  <code className="text-[0.7rem] text-midnight font-mono">{b.batchCode}</code>
                  <span className="text-ink-600">{b.modelYear}</span>
                  <span className="text-ink-300">·</span>
                  <span className="tabular-nums">{b.requestedQuantity}× {b.city}</span>
                  {b.closedAt && (
                    <span className={cn(
                      "ml-auto text-[0.65rem] tabular-nums",
                      b.closureReason === "delivered" ? "text-green-dark" : "text-flame-dark",
                    )}>
                      {b.closureReason === "delivered" ? "✓ delivered" : "🚫 cancelled"} {b.closedAt}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Shared row — used by both Internal Phase and Wave actions
// ─────────────────────────────────────────────────────────────

function ActionRow({
  action, busy, onChangeStatus,
}: {
  action: ScopedActionDetail;
  busy: boolean;
  onChangeStatus: (actionId: number, status: Status) => void;
}) {
  const icon = action.status === "done"    ? "✅"
             : action.status === "skipped" ? "⏭"
             : action.status === "blocked" ? "⛔"
             :                                "⏳";
  const label = action.status === "done" ? action.doneLabel : action.waitingLabel;

  return (
    <li className="rounded-md border border-ink-200 bg-white px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="shrink-0" aria-hidden>{icon}</span>
        <span className="text-sm font-medium text-midnight">{label}</span>
        {action.stakeholderName && (
          <span className="text-[0.7rem] text-ink-500">@{action.stakeholderName}</span>
        )}
        {action.departmentName && (
          <span className="text-[0.65rem] text-ink-500 uppercase tracking-wide">
            ({action.departmentName})
          </span>
        )}
        {action.status === "done" && action.completedAt && (
          <span className="text-[0.65rem] text-green-dark tabular-nums ml-auto">
            ✓ {action.completedAt.slice(0, 10)}
          </span>
        )}
        {action.status !== "done" && action.expectedDate && (
          <span className="text-[0.65rem] text-ink-500 tabular-nums ml-auto">
            due {action.expectedDate}
          </span>
        )}
      </div>

      {/* Status controls — change based on current status. */}
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {action.status !== "done" && (
          <StatusBtn
            label="✓ Mark done"
            tone="green"
            busy={busy}
            onClick={() => onChangeStatus(action.id, "done")}
          />
        )}
        {action.status !== "skipped" && action.status !== "done" && (
          <StatusBtn
            label="⏭ Skip"
            tone="ink"
            busy={busy}
            onClick={() => onChangeStatus(action.id, "skipped")}
          />
        )}
        {action.status === "blocked" && (
          <StatusBtn
            label="↶ Unblock"
            tone="brand"
            busy={busy}
            onClick={() => onChangeStatus(action.id, "waiting")}
          />
        )}
        {(action.status === "done" || action.status === "skipped") && (
          <StatusBtn
            label="↶ Re-open"
            tone="ink"
            busy={busy}
            onClick={() => onChangeStatus(action.id, "waiting")}
          />
        )}
      </div>
    </li>
  );
}

function StatusBtn({
  label, tone, busy, onClick,
}: {
  label: string;
  tone: "green" | "brand" | "ink";
  busy: boolean;
  onClick: () => void;
}) {
  const toneCls = tone === "green"
    ? "border-green text-green-dark hover:bg-green-pale"
    : tone === "brand"
    ? "border-brand text-brand-dark hover:bg-brand-pastel"
    : "border-ink-300 text-ink-600 hover:bg-ink-50";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        "text-[0.7rem] px-2 py-0.5 rounded border transition-colors",
        toneCls,
        busy && "opacity-50 cursor-wait",
      )}
    >
      {busy ? "…" : label}
    </button>
  );
}

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

/** Today's date in ISO yyyy-mm-dd — used for the overdue check. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
/**
 * "Overdue" = expectedDate in the past AND the action isn't settled.
 * Skipped/done rows aren't overdue regardless of date. Used to flag
 * action rows in the drawer + roll up an at-risk count per PO.
 */
function isOverdue(a: ScopedActionDetail, today: string): boolean {
  if (a.status === "done" || a.status === "skipped") return false;
  if (!a.expectedDate) return false;
  return a.expectedDate < today;
}
/**
 * Walk every action under a PO (PO + waves + batches) and return
 * total/done/overdue counts. Drives the progress chip in the left tree.
 */
function rollupPoCounts(po: PoNode, today: string): { total: number; done: number; overdue: number } {
  let total = 0, done = 0, overdue = 0;
  const tally = (a: ScopedActionDetail) => {
    total++;
    if (a.status === "done") done++;
    if (isOverdue(a, today)) overdue++;
  };
  for (const a of po.actions) tally(a);
  for (const w of po.waves) {
    for (const a of w.actions) tally(a);
    for (const b of w.batches) for (const a of b.actions) tally(a);
  }
  return { total, done, overdue };
}

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
  /** Transient toast — shows cascade results ("2 actions unblocked"). */
  const [cascadeFlash,  setCascadeFlash]  = useState<string | null>(null);

  async function setActionStatus(actionId: number, status: Status) {
    setBusyActionId(actionId);
    setMutationError(null);
    setCascadeFlash(null);
    try {
      const res = await fetch("/api/scope-action", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId, status }),
      });
      if (!res.ok) throw new Error(await res.text());
      // Surface cascade activity so ops sees what changed beyond the
      // row they clicked. The route returns these arrays from phase 3c.
      const data = await res.json().catch(() => null) as
        | { autoUnblockedIds?: number[]; cascadeRevertedIds?: number[] }
        | null;
      const unblocked = data?.autoUnblockedIds?.length ?? 0;
      const reverted  = data?.cascadeRevertedIds?.length ?? 0;
      if (unblocked > 0 || reverted > 0) {
        const parts: string[] = [];
        if (unblocked > 0) parts.push(`${unblocked} action${unblocked === 1 ? "" : "s"} unblocked`);
        if (reverted  > 0) parts.push(`${reverted} re-blocked`);
        setCascadeFlash(parts.join(" · "));
      }
      router.refresh();
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyActionId(null);
    }
  }
  // Auto-clear the cascade flash after a few seconds so it doesn't
  // linger on screen forever.
  useEffect(() => {
    if (cascadeFlash == null) return;
    const t = window.setTimeout(() => setCascadeFlash(null), 4000);
    return () => window.clearTimeout(t);
  }, [cascadeFlash]);
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
            cascadeFlash={cascadeFlash}
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
  // Memoised so we don't recompute on every render — same value for
  // the whole session view (overdue is a date-only comparison).
  const today = useMemo(() => todayIso(), []);

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
                  {d.pos.map((p) => {
                    const counts = rollupPoCounts(p, today);
                    return (
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
                            // Closed POs are dimmed but still selectable —
                            // ops occasionally needs to see post-delivery
                            // detail.
                            p.closedAt && p.id !== selectedPoId && "opacity-60",
                          )}
                        >
                          <div className="font-mono font-medium flex items-baseline gap-1.5">
                            <span className="truncate">{p.poNumber}</span>
                            {counts.overdue > 0 && (
                              <span
                                title={`${counts.overdue} overdue`}
                                className="ml-auto text-[0.6rem] font-sans font-bold tabular-nums text-flame-dark"
                              >
                                ⚠ {counts.overdue}
                              </span>
                            )}
                          </div>
                          <div className="text-[0.65rem] text-ink-500 mt-0.5 tabular-nums">
                            {p.totalCars} cars · {p.waves.length} wave{p.waves.length === 1 ? "" : "s"}
                            {counts.total > 0 && (
                              <> · {counts.done}/{counts.total} done</>
                            )}
                            {p.closedAt && <span className="ml-1 text-green-dark">· closed</span>}
                          </div>
                        </button>
                      </li>
                    );
                  })}
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
  busyActionId, onChangeStatus, mutationError, cascadeFlash,
}: {
  po: PoNode;
  dealerName: string;
  view: DrawerView;
  onChangeView: (v: DrawerView) => void;
  cascadeFlash: string | null;
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
        {cascadeFlash && (
          <p role="status" className="text-xs text-green-dark bg-green-pale border border-green px-3 py-2 rounded-md">
            ✓ {cascadeFlash}
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

/**
 * Synthesise the "App listed" row from the PO's batch app-listing
 * roll-up. Reads as a final step in the Internal Phase column — done
 * once every batch under the PO has its `appListedAt` stamped, pending
 * otherwise. Read-only: actual listing happens through the app-listing
 * flow on each batch.
 */
function appListedSyntheticAction(po: PoNode): ScopedActionDetail | null {
  if (po.appListingSummary.total === 0) return null;
  const isDone = po.appListingSummary.completedAt != null;
  const partial = po.appListingSummary.listed > 0
                 && po.appListingSummary.listed < po.appListingSummary.total;
  const label = isDone
    ? "App listed"
    : partial
      ? `App listing in progress (${po.appListingSummary.listed}/${po.appListingSummary.total})`
      : "Waiting App listing";
  return {
    // negative id flags it as synthetic — the ActionRow's status buttons
    // are suppressed for these rows so ops can't try to flip them.
    id:               -1,
    actionTypeId:     -1,
    actionTypeName:   "App listed",
    waitingLabel:     label,
    doneLabel:        label,
    status:           isDone ? "done" : "waiting",
    departmentName:   null,
    stakeholderName:  null,
    expectedDate:     null,
    completedAt:      po.appListingSummary.completedAt,
    notes:            null,
    // Sort after every real action by giving it a very large sortOrder.
    sortOrder:        999_999,
    blockedByNames:   [],
  };
}

function InternalPhaseView({
  po, busyActionId, onChangeStatus,
}: { po: PoNode } & Pick<MutationProps, "busyActionId" | "onChangeStatus">) {
  const appListed = appListedSyntheticAction(po);
  const allActions = [
    ...po.actions,
    ...(appListed ? [appListed] : []),
  ].sort((a, b) => a.sortOrder - b.sortOrder);

  if (allActions.length === 0) {
    return (
      <div className="text-sm text-ink-500 px-2 space-y-2">
        <p className="italic">
          No internal-phase actions on this PO yet.
        </p>
        <p className="text-xs">
          PO-scope actions are picked at Intake (Step 4) — choose Specs, Pricing,
          SKU, etc. and they appear here. If this PO was created before
          scope-aware actions landed, mark them done in the legacy /action-center.
        </p>
      </div>
    );
  }

  return (
    <ThreeColumnActionBoard
      title="Internal phase"
      subtitle="Specs · Pricing · SKU — runs in parallel"
      actions={allActions}
      busyActionId={busyActionId}
      onChangeStatus={onChangeStatus}
    />
  );
}

// ─────────────────────────────────────────────────────────────
// Shared 3-column Waiting / Blocked / Done board
// ─────────────────────────────────────────────────────────────

function ThreeColumnActionBoard({
  title, subtitle, actions, busyActionId, onChangeStatus,
}: {
  title: string;
  subtitle?: string;
  actions: ScopedActionDetail[];
} & Pick<MutationProps, "busyActionId" | "onChangeStatus">) {
  const waiting = actions.filter((a) => a.status === "waiting");
  const blocked = actions.filter((a) => a.status === "blocked");
  const done    = actions.filter((a) => a.status === "done" || a.status === "skipped");
  const total   = actions.length;
  const pending = waiting.length + blocked.length;
  const doneCount = done.length;

  return (
    <section className="border border-ink-200 rounded-md overflow-hidden bg-white">
      <header className="px-3 py-2 border-b border-ink-200 bg-brand-pastel/30 flex flex-wrap items-baseline justify-between gap-x-3">
        <div className="flex items-baseline gap-2">
          <span aria-hidden className="text-brand">▸</span>
          <h3 className="text-sm font-semibold text-brand-dark">{title}</h3>
          {subtitle && (
            <span className="text-[0.7rem] text-ink-500">{subtitle}</span>
          )}
        </div>
        <p className="text-[0.7rem] text-ink-600 tabular-nums">
          <span className={cn(doneCount === total ? "text-green-dark font-medium" : "")}>
            {doneCount}/{total} done
          </span>
          <span className="text-ink-300 mx-1.5">·</span>
          <span className="text-brand-dark">{pending} pending</span>
        </p>
      </header>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 p-3 bg-ink-50/40">
        <Column
          title="Waiting"
          count={waiting.length}
          tone="brand"
          rows={waiting}
          busyActionId={busyActionId}
          onChangeStatus={onChangeStatus}
        />
        <Column
          title="Blocked"
          count={blocked.length}
          tone="flame"
          rows={blocked}
          busyActionId={busyActionId}
          onChangeStatus={onChangeStatus}
        />
        <Column
          title="Done"
          count={done.length}
          tone="green"
          rows={done}
          busyActionId={busyActionId}
          onChangeStatus={onChangeStatus}
        />
      </div>
    </section>
  );
}

function Column({
  title, count, tone, rows, busyActionId, onChangeStatus,
}: {
  title: string;
  count: number;
  tone: "brand" | "flame" | "green";
  rows: ScopedActionDetail[];
} & Pick<MutationProps, "busyActionId" | "onChangeStatus">) {
  const headTone =
    tone === "brand" ? "text-brand-dark" :
    tone === "flame" ? "text-flame-dark" :
    "text-green-dark";
  return (
    <div className="flex flex-col">
      <h4 className={cn("text-[0.7rem] font-bold uppercase tracking-wide mb-2", headTone)}>
        {title} <span className="font-normal text-ink-500 tabular-nums">({count})</span>
      </h4>
      {rows.length === 0 ? (
        <p className="text-xs text-ink-400 italic px-2">none</p>
      ) : (
        <ul className="space-y-2">
          {rows
            .slice()
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((a) => (
              <ActionCard
                key={a.id}
                action={a}
                busy={busyActionId === a.id}
                onChangeStatus={onChangeStatus}
              />
            ))}
        </ul>
      )}
    </div>
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
        <div className="p-2 space-y-2">
          {/* Wave-scope actions in the same 3-column board */}
          {wave.actions.length === 0 ? (
            <p className="text-xs text-ink-500 italic px-2 py-1">
              No VIN-chase actions on this wave.
            </p>
          ) : (
            <ThreeColumnActionBoard
              title="VIN chase"
              subtitle="Tracks every step from dealer-confirmation to ready-for-delivery"
              actions={wave.actions}
              busyActionId={busyActionId}
              onChangeStatus={onChangeStatus}
            />
          )}

          {/* Batches in this wave — compact summary list. */}
          <div className="px-2 py-1.5 border border-ink-200 rounded-md bg-white">
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
                  {b.appListedAt && (
                    <span className="text-[0.6rem] text-green-dark tabular-nums">
                      📱 listed {b.appListedAt.slice(0, 10)}
                    </span>
                  )}
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
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Action card — rich tile used inside Waiting / Blocked / Done columns
// ─────────────────────────────────────────────────────────────

function ActionCard({
  action, busy, onChangeStatus,
}: {
  action: ScopedActionDetail;
  busy: boolean;
  onChangeStatus: (actionId: number, status: Status) => void;
}) {
  // Synthetic rows (id < 0) like the derived "App listed" row are
  // read-only; clicking buttons on them would attempt to update a
  // non-existent actions table row.
  const isSynthetic = action.id < 0;
  const label = action.status === "done" ? action.doneLabel : action.waitingLabel;
  const today = todayIso();
  const overdue = isOverdue(action, today);

  // Tone for the card border + accent.
  const tone =
    action.status === "blocked" ? "blocked" :
    action.status === "done"    ? "done"    :
    action.status === "skipped" ? "skipped" :
    overdue                     ? "overdue" :
    "waiting";
  const toneCls = {
    waiting: "border-ink-200",
    blocked: "border-flame-pale bg-flame-pale/20",
    overdue: "border-flame bg-flame-pale/30",
    done:    "border-green-pale bg-green-pale/30",
    skipped: "border-ink-200 bg-ink-50/40 opacity-80",
  }[tone];

  return (
    <li className={cn("rounded-md border bg-white px-3 py-2", toneCls)}>
      <div className="space-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-sm font-semibold text-midnight">{label}</span>
          {overdue && action.status !== "done" && action.status !== "skipped" && (
            <span className="text-[0.6rem] font-bold tabular-nums text-flame-dark uppercase tracking-wide">
              ⚠ Overdue
            </span>
          )}
        </div>

        {/* Stakeholder · Department */}
        {(action.stakeholderName || action.departmentName) && !isSynthetic && (
          <p className="text-[0.7rem] text-ink-600">
            {action.stakeholderName && (
              <span className="text-brand-dark">@{action.stakeholderName}</span>
            )}
            {action.stakeholderName && action.departmentName && (
              <span className="text-ink-400"> · </span>
            )}
            {action.departmentName && (
              <span className="text-ink-500">{action.departmentName}</span>
            )}
          </p>
        )}

        {/* Date — completed or due */}
        {action.status === "done" && action.completedAt && (
          <p className="text-[0.7rem] text-green-dark tabular-nums">
            📅 {action.completedAt.slice(0, 10)}
          </p>
        )}
        {action.status !== "done" && action.status !== "skipped" && action.expectedDate && (
          <p className={cn(
            "text-[0.7rem] tabular-nums",
            overdue ? "text-flame-dark font-medium" : "text-ink-500",
          )}>
            📅 {action.expectedDate}
          </p>
        )}

        {/* Blocked reason */}
        {action.status === "blocked" && action.blockedByNames.length > 0 && (
          <p className="text-[0.7rem] text-flame-dark mt-0.5">
            waiting on {action.blockedByNames.join(", ")}
          </p>
        )}
      </div>

      {/* Status controls — suppressed entirely for synthetic rows. */}
      {!isSynthetic && (
      <div className="flex flex-wrap gap-1.5 mt-2">
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
      )}
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

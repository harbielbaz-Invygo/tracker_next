"use client";

/**
 * Action Center — Dealer ▸ PO tree on the left, PO detail drawer
 * on the right. The drawer's content swaps between Internal Phase and
 * External Phase via a top toggle.
 *
 *   Internal Phase view → PO-scope actions (one set, applies to every
 *                          batch under this PO). Specs, pricing, SKU.
 *   External Phase view → Wave-scope actions, grouped per Delivery
 *                          Window (availability date). Each delivery
 *                          window's batches listed beneath. Dealer-
 *                          side execution: VIN, plate, customs, etc.
 *
 * Internal code keeps the schema-aligned `wave` / `WaveNode` names;
 * user-facing strings say "Delivery Window".
 */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  ActionCenterTree, PoNode, WaveNode, BatchNode, ScopedActionDetail,
  DepartmentCatalog,
} from "@/lib/action-center-tree-data";

/**
 * Shell context — gives every nested card access to the reassign
 * mutation + dept/stakeholder catalog + bulk app-listing toggle
 * without drilling props through 5 levels of components.
 */
interface ShellCtx {
  onReassign: (actionId: number, stakeholderId: number | null) => Promise<void>;
  onBulkSetAppListed: (batchIds: number[], setListed: boolean) => Promise<void>;
  busyBatchId: number | null;
  departments: DepartmentCatalog[];
}
const ShellContext = createContext<ShellCtx | null>(null);
function useShell(): ShellCtx {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside ShellContext.Provider");
  return ctx;
}
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

/** Drawer selection mode — a single PO, or the "Mine" cross-PO view. */
type Selection =
  | { kind: "po"; poId: number }
  | { kind: "mine" };

export default function ActionCenterTreeShell({ tree }: Props) {
  const router = useRouter();

  // Selection: a PO, or the "Mine" cross-PO inbox. Defaults to Mine
  // so ops lands on their own pending work first instead of an
  // arbitrary first PO.
  const [selection, setSelection] = useState<Selection>({ kind: "mine" });
  const [view, setView] = useState<DrawerView>("internal");

  /**
   * Help overlay visibility — toggled by `?` or the small ⌨ button
   * in the header. Persists across renders so ops can open + close
   * without losing place.
   */
  const [helpOpen, setHelpOpen] = useState<boolean>(false);

  // Track which row is busy / errored so the buttons can show pending
  // state. Single-shot is fine for a list of dozens.
  const [busyActionId,  setBusyActionId]  = useState<number | null>(null);
  const [busyBatchId,   setBusyBatchId]   = useState<number | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  /** Cascade flash sticks until the next action fires (no 4 s timer). */
  const [cascadeFlash,  setCascadeFlash]  = useState<string | null>(null);
  /**
   * Set of expanded wave ids — lifted from WaveSection so a router.refresh
   * doesn't collapse waves the operator was working in. Persists for the
   * life of this component instance. Could be moved to URL state if
   * deep-linking is ever needed.
   */
  const [expandedWaveIds, setExpandedWaveIds] = useState<Set<number>>(new Set());
  function toggleWave(id: number) {
    setExpandedWaveIds((curr) => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  /**
   * Batch row that's showing an inline form (Shift date or Cancel) +
   * which form is open. Only one inline form per drawer at a time —
   * keeps focus, prevents accidental edits to other batches.
   */
  const [inlineForm, setInlineForm] = useState<
    | { batchId: number; kind: "shift" | "cancel" }
    | null
  >(null);
  function openInlineForm(batchId: number, kind: "shift" | "cancel") {
    setInlineForm({ batchId, kind });
  }
  function closeInlineForm() { setInlineForm(null); }

  /**
   * Generic batch-level mutation runner. Used by the per-batch buttons
   * (Mark as listed / Shift availability date / Cancel batch) that hit
   * REST endpoints other than /api/scope-action. Handles loading state,
   * surface-level error messaging, and router refresh on success.
   */
  async function runBatchOp(batchId: number, url: string, body: unknown): Promise<void> {
    setBusyBatchId(batchId);
    setMutationError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyBatchId(null);
    }
  }

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

  /**
   * Bulk-set the app-listing state across a list of batches. Used by
   * the synthetic "App listed" step in Internal Phase — app-listing is
   * a PO-wide commitment, not per-batch, so the operator flips the
   * whole set in one click (or un-lists all the same way).
   */
  async function bulkSetAppListed(batchIds: number[], setListed: boolean): Promise<void> {
    if (batchIds.length === 0) return;
    setMutationError(null);
    setCascadeFlash(null);
    const stamp = setListed ? new Date().toISOString() : null;
    try {
      for (const bid of batchIds) {
        setBusyBatchId(bid);
        const res = await fetch("/api/batch-app-listing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchId: bid, appListedAt: stamp }),
        });
        if (!res.ok) throw new Error(await res.text());
      }
      setCascadeFlash(
        setListed
          ? `${batchIds.length} batch${batchIds.length === 1 ? "" : "es"} marked as listed`
          : `${batchIds.length} batch${batchIds.length === 1 ? "" : "es"} un-listed`,
      );
      router.refresh();
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyBatchId(null);
    }
  }

  /**
   * Reassign an action's stakeholder. Hits /api/scope-action/assign
   * (sibling of the status flip route). Surfaces the same busy /
   * error state so the picker can show a spinner inline.
   */
  async function reassignStakeholder(actionId: number, stakeholderId: number | null): Promise<void> {
    setBusyActionId(actionId);
    setMutationError(null);
    try {
      const res = await fetch("/api/scope-action/assign", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId, assignedStakeholderId: stakeholderId }),
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyActionId(null);
    }
  }

  /**
   * Bulk apply a status to a list of action ids. Hits /api/scope-action
   * sequentially (small N, transactional cost per call) and refreshes
   * once at the end. Used by the wave-header "Mark all done" / "Skip
   * remaining" buttons and the per-wave "Deliver all ready batches"
   * bulk action.
   */
  async function bulkSetStatus(actionIds: number[], status: Status): Promise<void> {
    if (actionIds.length === 0) return;
    setMutationError(null);
    setCascadeFlash(null);
    let touched = 0;
    try {
      for (const id of actionIds) {
        setBusyActionId(id);
        const res = await fetch("/api/scope-action", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actionId: id, status }),
        });
        if (!res.ok) throw new Error(await res.text());
        touched++;
      }
      setCascadeFlash(`${touched} action${touched === 1 ? "" : "s"} → ${status}`);
      router.refresh();
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyActionId(null);
    }
  }
  // Cascade flash intentionally sticks — it clears on the next action
  // mutation (see setActionStatus / runBatchOp) or on dismiss-click in
  // the banner. The earlier 4 s timer cleared the message before slow
  // readers could scan it.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(DRAWER_VIEW_KEY);
      if (stored === "internal" || stored === "vin") setView(stored);
    } catch { /* private mode */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(DRAWER_VIEW_KEY, view); } catch { /* ignore */ }
  }, [view]);

  // Global keyboard shortcuts. Listens once on the document; ignores
  // events that originate inside a text input / textarea / contentEditable
  // so the operator can still type freely in forms and the tree search.
  // - i / e: switch drawer view (Internal Phase / External Phase)
  // - m:     jump to Mine inbox
  // - /:     focus the tree search box
  // - Esc:   close inline form / dismiss flash / close help
  // - ?:     toggle help overlay
  useEffect(() => {
    function isTypingTarget(el: EventTarget | null): boolean {
      if (!(el instanceof HTMLElement)) return false;
      if (el.isContentEditable) return true;
      const t = el.tagName;
      return t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
    }
    function onKey(e: KeyboardEvent) {
      // Don't hijack keys while ops is typing in a form field.
      if (isTypingTarget(e.target)) {
        if (e.key === "Escape") {
          (e.target as HTMLElement).blur();
        }
        return;
      }
      // Cmd/Ctrl modifiers belong to the browser.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "?") { e.preventDefault(); setHelpOpen((v) => !v); return; }
      if (e.key === "Escape") {
        if (helpOpen)         { setHelpOpen(false); return; }
        if (inlineForm)       { closeInlineForm(); return; }
        if (cascadeFlash)     { setCascadeFlash(null); return; }
        return;
      }
      if (e.key === "m" || e.key === "M") {
        setSelection({ kind: "mine" });
        return;
      }
      if (e.key === "i" || e.key === "I") {
        if (selection.kind === "po") setView("internal");
        return;
      }
      if (e.key === "e" || e.key === "E") {
        if (selection.kind === "po") setView("vin");
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>(
          "aside input[type='search']",
        );
        input?.focus();
        return;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [helpOpen, inlineForm, cascadeFlash, selection]);

  // Flatten to find the selected PO node — small dataset, cheap.
  const selectedPo = useMemo<PoNode | null>(() => {
    if (selection.kind !== "po") return null;
    for (const d of tree.dealers) {
      const hit = d.pos.find((p) => p.id === selection.poId);
      if (hit) return hit;
    }
    return null;
  }, [tree, selection]);

  const dealerOfSelected = useMemo(() => {
    if (selection.kind !== "po") return null;
    const poId = selection.poId;
    return tree.dealers.find((d) => d.pos.some((p) => p.id === poId)) ?? null;
  }, [tree, selection]);

  return (
    <ShellContext.Provider value={{
      onReassign: reassignStakeholder,
      onBulkSetAppListed: bulkSetAppListed,
      busyBatchId,
      departments: tree.departments,
    }}>
    <div className="relative grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 h-[min(80vh,860px)] min-h-[520px]">
      {/* Floating help button — bottom-right of the grid container. */}
      <button
        type="button"
        onClick={() => setHelpOpen((v) => !v)}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        className="absolute bottom-2 right-2 z-10 text-xs px-2 py-1 rounded-full border border-ink-300 bg-white/90 hover:bg-ink-50 text-ink-600 shadow-sm"
      >
        ⌨ ?
      </button>

      {helpOpen && (
        <div
          role="dialog"
          aria-modal
          className="absolute inset-0 z-20 bg-midnight/40 flex items-center justify-center p-4"
          onClick={() => setHelpOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-lg border border-ink-200 shadow-lg max-w-md w-full p-4 space-y-3"
          >
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-bold text-midnight">Keyboard shortcuts</h3>
              <button
                type="button"
                onClick={() => setHelpOpen(false)}
                aria-label="Close"
                className="text-ink-500 hover:text-midnight"
              >
                ✕
              </button>
            </div>
            <table className="w-full text-xs">
              <tbody>
                {[
                  ["m",        "Jump to Inbox (all pending actions)"],
                  ["i",        "Switch drawer to Internal Phase"],
                  ["e",        "Switch drawer to External Phase"],
                  ["/",        "Focus the tree search box"],
                  ["Esc",      "Close inline form / dismiss flash / close this overlay"],
                  ["?",        "Toggle this overlay"],
                ].map(([k, desc]) => (
                  <tr key={k} className="border-b border-ink-100 last:border-b-0">
                    <td className="py-1.5 pr-3">
                      <kbd className="font-mono px-1.5 py-0.5 rounded border border-ink-300 bg-ink-50 text-ink-700">
                        {k}
                      </kbd>
                    </td>
                    <td className="py-1.5 text-ink-600">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[0.65rem] text-ink-500">
              Shortcuts pause automatically while you&apos;re typing in any input.
            </p>
          </div>
        </div>
      )}

      {/* ─────────── Left: Mine entry + Dealer → PO tree ─────────── */}
      <DealerTree
        tree={tree}
        selection={selection}
        onSelectPo={(poId) => setSelection({ kind: "po", poId })}
        onSelectMine={() => setSelection({ kind: "mine" })}
      />

      {/* ─────────── Right: drawer (PO detail OR Mine inbox) ─────────── */}
      <div className="border border-ink-200 rounded-lg bg-white overflow-hidden flex flex-col">
        {selection.kind === "mine" ? (
          <MineView
            tree={tree}
            busyActionId={busyActionId}
            onChangeStatus={setActionStatus}
            onBulkSetStatus={bulkSetStatus}
            mutationError={mutationError}
            cascadeFlash={cascadeFlash}
            onDismissFlash={() => setCascadeFlash(null)}
            onJumpToPo={(poId) => setSelection({ kind: "po", poId })}
          />
        ) : selectedPo && dealerOfSelected ? (
          <PoDrawer
            po={selectedPo}
            dealerName={dealerOfSelected.name}
            view={view}
            onChangeView={setView}
            busyActionId={busyActionId}
            busyBatchId={busyBatchId}
            onChangeStatus={setActionStatus}
            onBulkSetStatus={bulkSetStatus}
            onBatchOp={runBatchOp}
            mutationError={mutationError}
            cascadeFlash={cascadeFlash}
            onDismissFlash={() => setCascadeFlash(null)}
            expandedWaveIds={expandedWaveIds}
            onToggleWave={toggleWave}
            inlineForm={inlineForm}
            onOpenInlineForm={openInlineForm}
            onCloseInlineForm={closeInlineForm}
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
    </ShellContext.Provider>
  );
}

interface MutationProps {
  busyActionId:    number | null;
  onChangeStatus:  (actionId: number, status: Status) => void;
  onBulkSetStatus: (actionIds: number[], status: Status) => Promise<void>;
  mutationError:   string | null;
}

interface BatchOpProps {
  busyBatchId: number | null;
  onBatchOp:   (batchId: number, url: string, body: unknown) => Promise<void>;
}

/** State for the persisted wave-expansion + inline forms, threaded
 *  from the top-level component down to BatchRow. */
interface UiStateProps {
  expandedWaveIds: Set<number>;
  onToggleWave: (id: number) => void;
  inlineForm: { batchId: number; kind: "shift" | "cancel" } | null;
  onOpenInlineForm:  (batchId: number, kind: "shift" | "cancel") => void;
  onCloseInlineForm: () => void;
}

// ─────────────────────────────────────────────────────────────
// Left panel — Dealer → PO tree
// ─────────────────────────────────────────────────────────────

function DealerTree({
  tree, selection, onSelectPo, onSelectMine,
}: {
  tree: ActionCenterTree;
  selection: Selection;
  onSelectPo: (id: number) => void;
  onSelectMine: () => void;
}) {
  const [expandedDealers, setExpandedDealers] = useState<Set<number>>(
    () => new Set(tree.dealers.map((d) => d.id)),
  );
  // Free-text filter (PO #, dealer, batch code substring) + sort
  // toggle. Both are local UI state — no need to persist for now.
  const [query, setQuery] = useState<string>("");
  const [sortMode, setSortMode] = useState<"alpha" | "overdue">("alpha");

  // Memoised so we don't recompute on every render — same value for
  // the whole session view (overdue is a date-only comparison).
  const today = useMemo(() => todayIso(), []);
  const selectedPoId = selection.kind === "po" ? selection.poId : null;
  // Count of pending (non-settled) actions across the entire tree —
  // shown next to the Mine entry as the operator's inbox badge.
  const minePending = useMemo(() => {
    let n = 0;
    for (const d of tree.dealers) for (const p of d.pos) {
      for (const a of p.actions) if (a.status === "waiting" || a.status === "blocked") n++;
      for (const w of p.waves) {
        for (const a of w.actions) if (a.status === "waiting" || a.status === "blocked") n++;
        for (const b of w.batches) for (const a of b.actions) {
          if (a.status === "waiting" || a.status === "blocked") n++;
        }
      }
    }
    return n;
  }, [tree]);

  function toggleDealer(id: number) {
    setExpandedDealers((curr) => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Filter + sort applied to the dealer/PO list. The query matches
  // against PO number, dealer name, or any batch code under the PO.
  // sortMode='overdue' surfaces the dealers/POs with the most stale
  // work first — useful when the tree gets long.
  const q = query.trim().toLowerCase();
  const filteredDealers = useMemo(() => {
    const matchPo = (p: PoNode, dealerName: string) => {
      if (!q) return true;
      if (p.poNumber.toLowerCase().includes(q)) return true;
      if (dealerName.toLowerCase().includes(q)) return true;
      for (const w of p.waves) for (const b of w.batches) {
        if (b.batchCode.toLowerCase().includes(q)) return true;
      }
      return false;
    };
    return tree.dealers
      .map((d) => ({ ...d, pos: d.pos.filter((p) => matchPo(p, d.name)) }))
      .filter((d) => d.pos.length > 0)
      .map((d) => {
        if (sortMode === "overdue") {
          const sorted = d.pos.slice().sort((a, b) => {
            const ao = rollupPoCounts(a, today).overdue;
            const bo = rollupPoCounts(b, today).overdue;
            return bo - ao;
          });
          return { ...d, pos: sorted };
        }
        return d;
      });
  }, [tree.dealers, q, sortMode, today]);

  return (
    <aside className="border border-ink-200 rounded-lg bg-white overflow-hidden flex flex-col">
      <header className="px-3 py-2.5 border-b border-ink-200 shrink-0 space-y-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-bold text-midnight">Dealers ▸ POs</h3>
          <span className="text-xs text-ink-500 tabular-nums">
            {filteredDealers.length} {filteredDealers.length === 1 ? "dealer" : "dealers"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search PO / dealer / batch…"
            className="flex-1 text-xs px-2 py-1 border border-ink-300 rounded"
          />
          <button
            type="button"
            onClick={() => setSortMode((m) => m === "alpha" ? "overdue" : "alpha")}
            title={sortMode === "alpha"
              ? "Sorting alphabetically — click to surface overdue first"
              : "Sorting most-overdue first — click to revert to alphabetical"}
            className={cn(
              "text-[0.7rem] px-2 py-1 rounded border whitespace-nowrap",
              sortMode === "overdue"
                ? "border-flame text-flame-dark bg-flame-pale/30"
                : "border-ink-300 text-ink-600 hover:bg-ink-50",
            )}
          >
            {sortMode === "alpha" ? "A→Z" : "⚠ Overdue"}
          </button>
        </div>
      </header>

      {/* "Mine" cross-PO inbox — lives at the top of the tree as a
          single sticky entry so ops's first scroll position is their
          own pending work, not an arbitrary dealer. */}
      <button
        type="button"
        onClick={onSelectMine}
        className={cn(
          "px-3 py-2 text-left border-b border-ink-200 flex items-center gap-2",
          selection.kind === "mine"
            ? "bg-brand-pastel border-l-2 border-l-brand"
            : "hover:bg-ink-50",
        )}
      >
        <span aria-hidden>📋</span>
        <span className={cn(
          "text-sm font-medium",
          selection.kind === "mine" ? "text-brand-dark" : "text-midnight",
        )}>
          Inbox · All pending
        </span>
        <span className="ml-auto text-[0.65rem] tabular-nums text-ink-500">
          {minePending}
        </span>
      </button>

      <ul className="flex-1 overflow-auto">
        {filteredDealers.map((d) => {
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
                          onClick={() => onSelectPo(p.id)}
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
                            {p.totalCars} cars · {p.waves.length} window{p.waves.length === 1 ? "" : "s"}
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
        {filteredDealers.length === 0 && (
          <li className="px-3 py-8 text-sm text-ink-500 text-center">
            {q ? `No POs match "${query}".` : "No POs yet."}
          </li>
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
  busyActionId, busyBatchId, onChangeStatus, onBulkSetStatus, onBatchOp,
  mutationError, cascadeFlash, onDismissFlash,
  expandedWaveIds, onToggleWave,
  inlineForm, onOpenInlineForm, onCloseInlineForm,
}: {
  po: PoNode;
  dealerName: string;
  view: DrawerView;
  onChangeView: (v: DrawerView) => void;
  cascadeFlash: string | null;
  onDismissFlash: () => void;
} & MutationProps & BatchOpProps & UiStateProps) {
  return (
    <>
      {/* Header — denser meta line so ops glances value, urgency, and
          at-risk count without scrolling. Inbox-grade summary. */}
      <header className="px-4 py-3 border-b border-ink-200 shrink-0 bg-ink-50/50">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-xl font-mono font-bold text-midnight">{po.poNumber}</h2>
          {po.poDate && (
            <span className="text-xs text-ink-500 tabular-nums">{po.poDate}</span>
          )}
          {po.closedAt && (
            <span className="text-[0.65rem] font-medium tabular-nums text-green-dark uppercase tracking-wide">
              ✓ Closed {po.closedAt}
            </span>
          )}
        </div>
        <p className="text-xs text-ink-600 mt-1">
          <span className="font-medium text-midnight">🏢 {dealerName}</span>
          <span className="text-ink-300 mx-1.5">·</span>
          <span className="tabular-nums">{po.totalCars} cars</span>
          {po.totalValueSar != null && (
            <>
              <span className="text-ink-300 mx-1.5">·</span>
              <span className="tabular-nums" title="Estimated PO value (cars × unit price, SAR)">
                💰 {po.totalValueSar.toLocaleString()} SAR
              </span>
            </>
          )}
          <span className="text-ink-300 mx-1.5">·</span>
          <span className="tabular-nums">{po.waves.length} delivery window{po.waves.length === 1 ? "" : "s"}</span>
          {po.nextAvailability && (() => {
            const today = todayIso();
            const days = Math.round(
              (new Date(po.nextAvailability).getTime() - new Date(today).getTime())
              / (24 * 60 * 60 * 1000),
            );
            const txt = days < 0
              ? `${-days}d past first window`
              : days === 0
                ? "first window today"
                : `in ${days}d`;
            return (
              <>
                <span className="text-ink-300 mx-1.5">·</span>
                <span className={cn(
                  "tabular-nums",
                  days < 0 ? "text-flame-dark font-medium" : "text-ink-600",
                )}>
                  📅 {txt}
                </span>
              </>
            );
          })()}
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
          <ToggleBtn active={view === "vin"}      onClick={() => onChangeView("vin")}      label="External Phase" />
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
          <div
            role="status"
            className="flex items-center justify-between text-xs text-green-dark bg-green-pale border border-green px-3 py-2 rounded-md"
          >
            <span>✓ {cascadeFlash}</span>
            <button
              type="button"
              onClick={onDismissFlash}
              aria-label="Dismiss"
              className="text-green-dark/70 hover:text-green-dark text-[0.85rem] leading-none px-1"
            >
              ✕
            </button>
          </div>
        )}
        {/* Closed-PO summary — replaces the per-section content when
            every batch under the PO has been delivered. Celebrates the
            finish + surfaces a single "days end-to-end" metric ops can
            use as retrospective input. */}
        {po.closedAt && (() => {
          const delivered = po.waves.flatMap((w) => w.batches)
            .filter((b) => b.closureReason === "delivered");
          const cancelled = po.waves.flatMap((w) => w.batches)
            .filter((b) => b.closureReason === "cancelled");
          if (delivered.length === 0 && cancelled.length === 0) return null;
          // End-to-end days = closedAt − poDate (when both known).
          const daysE2E = po.poDate && po.closedAt
            ? Math.round(
                (new Date(po.closedAt).getTime() - new Date(po.poDate).getTime())
                / (24 * 60 * 60 * 1000),
              )
            : null;
          return (
            <div className="border border-green-pale rounded-md bg-green-pale/40 p-4 text-center space-y-1">
              <p className="text-sm font-semibold text-green-dark">
                ✅ PO closed
              </p>
              <p className="text-xs text-ink-700">
                {delivered.length > 0 && (
                  <>
                    {delivered.length} batch{delivered.length === 1 ? "" : "es"} delivered
                  </>
                )}
                {delivered.length > 0 && cancelled.length > 0 && " · "}
                {cancelled.length > 0 && (
                  <span className="text-flame-dark">
                    {cancelled.length} cancelled
                  </span>
                )}
                {daysE2E != null && (
                  <>
                    <span className="text-ink-300 mx-1.5">·</span>
                    <span className="tabular-nums">
                      {daysE2E} day{daysE2E === 1 ? "" : "s"} end-to-end
                    </span>
                  </>
                )}
              </p>
            </div>
          );
        })()}
        {view === "internal" ? (
          <InternalPhaseView po={po} busyActionId={busyActionId} onChangeStatus={onChangeStatus} />
        ) : (
          <VinChaseView
            po={po}
            busyActionId={busyActionId}
            busyBatchId={busyBatchId}
            onChangeStatus={onChangeStatus}
            onBulkSetStatus={onBulkSetStatus}
            onBatchOp={onBatchOp}
            expandedWaveIds={expandedWaveIds}
            onToggleWave={onToggleWave}
            inlineForm={inlineForm}
            onOpenInlineForm={onOpenInlineForm}
            onCloseInlineForm={onCloseInlineForm}
          />
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// "Mine" / Inbox — flat list of every pending action across the
// tree. Operators land here first and triage by due-date order,
// crossing PO boundaries without needing to drill in.
// ─────────────────────────────────────────────────────────────

interface MineRow {
  action:        ScopedActionDetail;
  poId:          number;
  poNumber:      string;
  dealerName:    string;
  /** "PO-wide" / "Wave 2026-06-15" / "PO-0117-Wallan-3" */
  contextLabel:  string;
}

function MineView({
  tree, busyActionId, onChangeStatus, onBulkSetStatus,
  mutationError, cascadeFlash, onDismissFlash,
  onJumpToPo,
}: {
  tree: ActionCenterTree;
  cascadeFlash: string | null;
  onDismissFlash: () => void;
  onJumpToPo: (poId: number) => void;
} & Pick<MutationProps, "busyActionId" | "onChangeStatus" | "onBulkSetStatus" | "mutationError">) {
  const today = todayIso();

  // Department filter — operators in Pricing should see Pricing first.
  const [deptFilter, setDeptFilter] = useState<string>("");
  const [stakeholderFilter, setStakeholderFilter] = useState<string>("");

  // Flatten every pending action across the tree into a MineRow.
  const rows = useMemo<MineRow[]>(() => {
    const acc: MineRow[] = [];
    for (const d of tree.dealers) {
      for (const p of d.pos) {
        const dealerName = d.name;
        const poNumber = p.poNumber;
        const poId = p.id;
        // PO-scope
        for (const a of p.actions) {
          if (a.status !== "waiting" && a.status !== "blocked") continue;
          acc.push({ action: a, poId, poNumber, dealerName, contextLabel: "PO-wide" });
        }
        // Wave-scope
        for (const w of p.waves) {
          for (const a of w.actions) {
            if (a.status !== "waiting" && a.status !== "blocked") continue;
            acc.push({ action: a, poId, poNumber, dealerName,
              contextLabel: `Delivery Window · ${w.availabilityDate}` });
          }
          // Batch-scope (skip Delivery; surfaced via Mark-as-delivered UI)
          for (const b of w.batches) {
            for (const a of b.actions) {
              if (a.status !== "waiting" && a.status !== "blocked") continue;
              if (a.actionTypeName === "Delivery") continue;
              acc.push({ action: a, poId, poNumber, dealerName, contextLabel: b.batchCode });
            }
          }
        }
      }
    }
    return acc;
  }, [tree]);

  // Distinct dept + stakeholder lists for the filter chips.
  const departments = useMemo(() =>
    Array.from(new Set(rows.map((r) => r.action.departmentName).filter(Boolean))) as string[]
  , [rows]);
  const stakeholders = useMemo(() =>
    Array.from(new Set(rows.map((r) => r.action.stakeholderName).filter(Boolean))) as string[]
  , [rows]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (deptFilter && r.action.departmentName !== deptFilter) return false;
    if (stakeholderFilter && r.action.stakeholderName !== stakeholderFilter) return false;
    return true;
  }), [rows, deptFilter, stakeholderFilter]);

  // Sort: overdue first (oldest expectedDate ASC), then non-overdue
  // by expectedDate ASC (nulls last), with blocked rows after waiting
  // within the same date so ops sees what they can actually act on.
  const sorted = useMemo(() => filtered.slice().sort((a, b) => {
    const ao = isOverdue(a.action, today) ? 0 : 1;
    const bo = isOverdue(b.action, today) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const ad = a.action.expectedDate ?? "9999-12-31";
    const bd = b.action.expectedDate ?? "9999-12-31";
    if (ad !== bd) return ad.localeCompare(bd);
    const as = a.action.status === "blocked" ? 1 : 0;
    const bs = b.action.status === "blocked" ? 1 : 0;
    return as - bs;
  }), [filtered, today]);

  const overdueCount = sorted.filter((r) => isOverdue(r.action, today)).length;
  const blockedCount = sorted.filter((r) => r.action.status === "blocked").length;

  return (
    <>
      <header className="px-4 py-3 border-b border-ink-200 shrink-0 bg-ink-50/50">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-xl font-bold text-midnight">📋 Inbox</h2>
          <span className="text-xs text-ink-500">
            All pending actions across every PO, sorted by due date.
          </span>
        </div>
        <p className="text-xs text-ink-600 mt-1">
          <span className="font-medium">{sorted.length} pending</span>
          {overdueCount > 0 && (
            <>
              <span className="text-ink-300 mx-1.5">·</span>
              <span className="text-flame-dark font-medium">{overdueCount} overdue</span>
            </>
          )}
          {blockedCount > 0 && (
            <>
              <span className="text-ink-300 mx-1.5">·</span>
              <span className="text-flame-dark">{blockedCount} blocked</span>
            </>
          )}
        </p>
      </header>

      {/* Filters + bulk-apply */}
      <div className="px-4 py-2 border-b border-ink-200 shrink-0 bg-white flex flex-wrap gap-2 items-center text-xs">
        <span className="text-ink-500">Filter:</span>
        <select
          value={deptFilter}
          onChange={(e) => setDeptFilter(e.target.value)}
          className="text-xs px-2 py-1 border border-ink-300 rounded"
        >
          <option value="">All departments</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select
          value={stakeholderFilter}
          onChange={(e) => setStakeholderFilter(e.target.value)}
          className="text-xs px-2 py-1 border border-ink-300 rounded"
        >
          <option value="">All stakeholders</option>
          {stakeholders.map((s) => <option key={s} value={s}>@{s}</option>)}
        </select>
        {(deptFilter || stakeholderFilter) && (
          <button
            type="button"
            onClick={() => { setDeptFilter(""); setStakeholderFilter(""); }}
            className="text-[0.7rem] text-brand-dark underline ml-1"
          >
            clear
          </button>
        )}
        {/* Bulk "Mark all visible done" — only active when a filter is
            applied; closing the safety guard against accidentally
            settling every action across the system in one click. */}
        {(deptFilter || stakeholderFilter) && sorted.length > 0 && (
          <button
            type="button"
            onClick={() => {
              const waitingIds = sorted
                .filter((r) => r.action.status === "waiting")
                .map((r) => r.action.id);
              if (waitingIds.length === 0) {
                window.alert("No waiting actions in the current filter (blocked rows are excluded from bulk apply).");
                return;
              }
              const ok = window.confirm(
                `Mark ${waitingIds.length} filtered action${waitingIds.length === 1 ? "" : "s"} as done?\n\nThis cascades through any dependent actions.`,
              );
              if (ok) onBulkSetStatus(waitingIds, "done");
            }}
            className="ml-auto text-[0.7rem] px-2 py-0.5 rounded border border-green text-green-dark hover:bg-green-pale"
          >
            ✓ Mark filtered done
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-3">
        {mutationError && (
          <p role="alert" className="text-xs text-flame-dark bg-flame-pale border border-flame px-3 py-2 rounded-md">
            Could not update: {mutationError}
          </p>
        )}
        {cascadeFlash && (
          <div role="status" className="flex items-center justify-between text-xs text-green-dark bg-green-pale border border-green px-3 py-2 rounded-md">
            <span>✓ {cascadeFlash}</span>
            <button type="button" onClick={onDismissFlash} className="px-1">✕</button>
          </div>
        )}
        {sorted.length === 0 ? (
          <p className="text-sm text-ink-500 italic px-2">
            {rows.length === 0
              ? "🎉 Inbox zero — no pending actions anywhere in the system."
              : "No pending actions match these filters."}
          </p>
        ) : (
          <ul className="space-y-2">
            {sorted.map((r) => (
              <MineRowCard
                key={`${r.poId}:${r.action.id}`}
                row={r}
                today={today}
                busy={busyActionId === r.action.id}
                onChangeStatus={onChangeStatus}
                onJumpToPo={onJumpToPo}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function MineRowCard({
  row, today, busy, onChangeStatus, onJumpToPo,
}: {
  row: MineRow;
  today: string;
  busy: boolean;
  onChangeStatus: (actionId: number, status: Status) => void;
  onJumpToPo: (poId: number) => void;
}) {
  const a = row.action;
  const overdue = isOverdue(a, today);
  const label = a.doneLabel || a.waitingLabel;

  const toneCls = a.status === "blocked"
    ? "border-flame-pale bg-flame-pale/20"
    : overdue
      ? "border-flame bg-flame-pale/30"
      : "border-ink-200";

  return (
    <li className={cn("rounded-md border bg-white px-3 py-2", toneCls)}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-semibold text-midnight">{label}</span>
        {overdue && (
          <span className="text-[0.6rem] font-bold tabular-nums text-flame-dark uppercase tracking-wide">
            ⚠ Overdue
          </span>
        )}
        {a.status === "blocked" && (
          <span className="text-[0.6rem] font-bold tabular-nums text-flame-dark uppercase tracking-wide">
            ⛔ Blocked
          </span>
        )}
        {a.expectedDate && (
          <span className={cn(
            "text-[0.7rem] tabular-nums ml-auto",
            overdue ? "text-flame-dark font-medium" : "text-ink-500",
          )}>
            ⏰ {a.expectedDate}
          </span>
        )}
      </div>

      <p className="text-[0.7rem] text-ink-600 mt-0.5">
        {a.stakeholderName && (
          <span className="text-brand-dark">@{a.stakeholderName}</span>
        )}
        {a.stakeholderName && a.departmentName && <span className="text-ink-400"> · </span>}
        {a.departmentName && (
          <span className="text-ink-500">{a.departmentName}</span>
        )}
      </p>

      <p className="text-[0.65rem] text-ink-500 mt-0.5">
        <button
          type="button"
          onClick={() => onJumpToPo(row.poId)}
          className="font-mono text-midnight underline-offset-2 hover:underline"
        >
          {row.poNumber}
        </button>
        <span className="text-ink-300 mx-1">·</span>
        <span>{row.dealerName}</span>
        <span className="text-ink-300 mx-1">·</span>
        <span>{row.contextLabel}</span>
      </p>

      {a.status === "blocked" && a.blockedByNames.length > 0 && (
        <p className="text-[0.65rem] text-flame-dark mt-1">
          waiting on {a.blockedByNames.join(", ")}
        </p>
      )}

      <div className="flex flex-wrap gap-1.5 mt-1.5">
        <StatusBtn
          label="✓ Mark done"
          tone="green"
          busy={busy}
          onClick={() => onChangeStatus(a.id, "done")}
        />
        <StatusBtn
          label="⏭ Skip"
          tone="ink"
          busy={busy}
          onClick={() => {
            if (a.pendingDependentNames.length > 0) {
              const ok = window.confirm(
                `Skipping "${label}" will unblock:\n\n` +
                a.pendingDependentNames.map((n) => `  • ${n}`).join("\n") +
                `\n\nProceed?`,
              );
              if (!ok) return;
            }
            onChangeStatus(a.id, "skipped");
          }}
        />
        {a.status === "blocked" && (
          <StatusBtn
            label="↶ Unblock"
            tone="brand"
            busy={busy}
            onClick={() => onChangeStatus(a.id, "waiting")}
          />
        )}
      </div>
    </li>
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
    pendingDependentNames: [],
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
      poForAppListing={po}
    />
  );
}

// ─────────────────────────────────────────────────────────────
// Shared 3-column Waiting / Blocked / Done board
// ─────────────────────────────────────────────────────────────

function ThreeColumnActionBoard({
  title, subtitle, actions, busyActionId, onChangeStatus, poForAppListing,
}: {
  title: string;
  subtitle?: string;
  actions: ScopedActionDetail[];
  /** When passed (Internal Phase view), enables the bulk app-listing
   *  control on the synthetic "App listed" row. */
  poForAppListing?: PoNode;
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
          poForAppListing={poForAppListing}
        />
        <Column
          title="Blocked"
          count={blocked.length}
          tone="flame"
          rows={blocked}
          busyActionId={busyActionId}
          onChangeStatus={onChangeStatus}
          poForAppListing={poForAppListing}
        />
        <Column
          title="Done"
          count={done.length}
          tone="green"
          rows={done}
          busyActionId={busyActionId}
          onChangeStatus={onChangeStatus}
          poForAppListing={poForAppListing}
        />
      </div>
    </section>
  );
}

function Column({
  title, count, tone, rows, busyActionId, onChangeStatus, poForAppListing,
}: {
  title: string;
  count: number;
  tone: "brand" | "flame" | "green";
  rows: ScopedActionDetail[];
  poForAppListing?: PoNode;
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
                poForAppListing={a.actionTypeName === "App listed" ? poForAppListing : undefined}
              />
            ))}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// External Phase — per-window sections with window-scope actions
// + the batches landing in that window
// ─────────────────────────────────────────────────────────────

function VinChaseView({
  po, busyActionId, busyBatchId, onChangeStatus, onBulkSetStatus, onBatchOp,
  expandedWaveIds, onToggleWave, inlineForm, onOpenInlineForm, onCloseInlineForm,
}: { po: PoNode }
  & Pick<MutationProps, "busyActionId" | "onChangeStatus" | "onBulkSetStatus">
  & BatchOpProps
  & UiStateProps
) {
  if (po.waves.length === 0) {
    return (
      <p className="text-sm text-ink-500 italic px-2">
        No delivery windows yet. Submit an Intake on this PO to create them.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {po.waves.map((w) => (
        <WaveSection
          key={w.id}
          wave={w}
          internalPhaseDone={po.internalPhaseDone}
          busyActionId={busyActionId}
          busyBatchId={busyBatchId}
          onChangeStatus={onChangeStatus}
          onBulkSetStatus={onBulkSetStatus}
          onBatchOp={onBatchOp}
          expandedWaveIds={expandedWaveIds}
          onToggleWave={onToggleWave}
          inlineForm={inlineForm}
          onOpenInlineForm={onOpenInlineForm}
          onCloseInlineForm={onCloseInlineForm}
        />
      ))}
    </div>
  );
}

function WaveSection({
  wave, internalPhaseDone, busyActionId, busyBatchId, onChangeStatus, onBulkSetStatus, onBatchOp,
  expandedWaveIds, onToggleWave, inlineForm, onOpenInlineForm, onCloseInlineForm,
}: { wave: WaveNode; internalPhaseDone: boolean }
  & Pick<MutationProps, "busyActionId" | "onChangeStatus" | "onBulkSetStatus">
  & BatchOpProps
  & UiStateProps
) {
  // Expansion state is lifted to the top-level shell so router.refresh()
  // after a mutation doesn't collapse the wave the operator is working in.
  const expanded = expandedWaveIds.has(wave.id);
  const setExpanded = () => onToggleWave(wave.id);
  const totalCars = wave.batches.reduce((s, b) => s + b.requestedQuantity, 0);
  // Tiny status summary in the collapsed header so ops can scan
  // progress without expanding every wave.
  const doneCount    = wave.actions.filter((a) => a.status === "done").length;
  const blockedCount = wave.actions.filter((a) => a.status === "blocked").length;
  const waitingCount = wave.actions.filter((a) => a.status === "waiting").length;

  function handleMarkAllDone(e: React.MouseEvent) {
    // Stop the click from also toggling the wave's expanded state —
    // the button is logically nested inside the toggle row.
    e.stopPropagation();
    const ids = wave.actions
      .filter((a) => a.status === "waiting")
      .map((a) => a.id);
    if (ids.length === 0) return;
    const ok = window.confirm(
      `Mark ${ids.length} waiting External-Phase action${ids.length === 1 ? "" : "s"} done in this window?\n\n` +
      `Blocked rows are excluded — unblock them first if they should also flip.`,
    );
    if (ok) onBulkSetStatus(ids, "done");
  }

  return (
    <section className="border border-ink-200 rounded-md bg-ink-50/30 overflow-hidden">
      {/* Header row uses a wrapper <div> + nested <button> roles so we
          can place an inline "Mark all done" affordance next to the
          toggle without nesting <button>s (invalid HTML). */}
      <div
        role="button"
        tabIndex={0}
        onClick={setExpanded}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(); } }}
        aria-expanded={expanded}
        className="w-full px-3 py-2 border-b border-ink-200 bg-white hover:bg-ink-50 transition-colors cursor-pointer flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
      >
        <span aria-hidden className="text-ink-400 text-xs">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="text-sm font-semibold text-midnight">📅 Delivery Window · {wave.availabilityDate}</span>
        <span className="text-xs text-ink-500 tabular-nums">
          {totalCars} cars · {wave.batches.length} batch{wave.batches.length === 1 ? "" : "es"}
        </span>
        {wave.opsExpectedDate && wave.opsExpectedDate !== wave.availabilityDate && (
          <span className="text-xs text-gold-dark tabular-nums">
            · ops projecting {wave.opsExpectedDate}
          </span>
        )}
        {wave.actions.length > 0 && (
          <span className="text-[0.65rem] text-ink-500 tabular-nums">
            · {doneCount}/{wave.actions.length} done
            {blockedCount > 0 && (
              <span className="text-flame-dark ml-1">· {blockedCount} blocked</span>
            )}
          </span>
        )}
        {/* Wave-level bulk-apply: when expanded AND ≥ 1 waiting action,
            give ops a one-click "all waiting → done" affordance. Hidden
            on closed-status waves to avoid clutter. */}
        {expanded && waitingCount > 0 && (
          <button
            type="button"
            onClick={handleMarkAllDone}
            onKeyDown={(e) => e.stopPropagation()}
            className="ml-auto text-[0.7rem] px-2 py-0.5 rounded border border-green text-green-dark hover:bg-green-pale"
          >
            ✓ Mark all External-Phase actions done ({waitingCount})
          </button>
        )}
      </div>

      {expanded && (
        <div className="p-2 space-y-2">
          {/* Batches in this wave — placed first so ops sees WHAT this
              wave covers (cars, cities, codes) before drilling into the
              actions that get those batches delivered. Each batch row
              carries its own Mark-as-delivered button, gated on the
              wave's actions being all done/skipped so ops can't skip
              ahead. */}
          <BatchListInWave
            wave={wave}
            internalPhaseDone={internalPhaseDone}
            busyActionId={busyActionId}
            busyBatchId={busyBatchId}
            onChangeStatus={onChangeStatus}
            onBatchOp={onBatchOp}
            inlineForm={inlineForm}
            onOpenInlineForm={onOpenInlineForm}
            onCloseInlineForm={onCloseInlineForm}
          />

          {/* Wave-scope actions — flat list (no Blocked/Done columns
              since VIN-chase deps are strictly linear: each step is
              "waiting" or "done", never "blocked on a sibling"). The
              ActionCard is reused for the rich label + status buttons. */}
          {wave.actions.length === 0 ? (
            <p className="text-xs text-ink-500 italic px-2 py-1">
              No External-Phase actions on this delivery window.
            </p>
          ) : (
            <ul className="space-y-2">
              {wave.actions
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
      )}
    </section>
  );
}

/**
 * Compact list of batches in a wave, with a per-batch "Mark as
 * delivered" button. The button finds the batch's Delivery action
 * (auto-attached at Intake) and flips it to done — the existing
 * /api/scope-action handler then auto-closes the batch.
 *
 * Gating:
 *   - The Delivery action must exist on the batch (always true for
 *     new-shape batches; defensive null-check otherwise).
 *   - The batch must not already be closed (delivered or cancelled).
 *   - Every wave-scope action must be done or skipped, otherwise the
 *     button shows pending count and is disabled.
 */
function BatchListInWave({
  wave, internalPhaseDone, busyActionId, busyBatchId, onChangeStatus, onBatchOp,
  inlineForm, onOpenInlineForm, onCloseInlineForm,
}: { wave: WaveNode; internalPhaseDone: boolean }
  & Pick<MutationProps, "busyActionId" | "onChangeStatus">
  & BatchOpProps
  & Pick<UiStateProps, "inlineForm" | "onOpenInlineForm" | "onCloseInlineForm">
) {
  // "Wave ready" = every wave-scope action is settled.
  const wavePending = wave.actions.filter(
    (a) => a.status !== "done" && a.status !== "skipped",
  ).length;
  const waveReady = wave.actions.length > 0 && wavePending === 0;

  return (
    <div className="px-2 py-1.5 border border-ink-200 rounded-md bg-white">
      <p className="text-[0.65rem] font-medium uppercase tracking-wide text-ink-500 mb-1.5">
        Batches in this delivery window
      </p>
      <ul className="space-y-2">
        {wave.batches.map((b) => (
          <BatchRow
            key={b.id}
            batch={b}
            wavePending={wavePending}
            waveReady={waveReady}
            internalPhaseDone={internalPhaseDone}
            busyActionId={busyActionId}
            busyBatchId={busyBatchId}
            onChangeStatus={onChangeStatus}
            onBatchOp={onBatchOp}
            inlineForm={inlineForm}
            onOpenInlineForm={onOpenInlineForm}
            onCloseInlineForm={onCloseInlineForm}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * One batch row inside a wave's batch list. Header line carries the
 * usual identity fields; the right-hand action cluster mirrors the
 * legacy per-batch drawer:
 *   📱 Mark as listed (toggles batches.app_listed_at)
 *   📅 Shift availability date (updates currentProjectedDeliveryDate)
 *   🚫 Cancel batch (closes with closureReason='cancelled')
 *   ✓ Mark as delivered (flips the Delivery action → auto-close)
 *
 * Each button is disabled / lock-styled when its preconditions aren't
 * met: e.g. Mark as delivered shows "🔒 N pending" until every wave
 * action is done/skipped; Cancel/Shift hide once the batch is closed.
 */
function BatchRow({
  batch: b, wavePending, waveReady, internalPhaseDone,
  busyActionId, busyBatchId, onChangeStatus, onBatchOp,
  inlineForm, onOpenInlineForm, onCloseInlineForm,
}: {
  batch: BatchNode;
  wavePending: number;
  waveReady: boolean;
  internalPhaseDone: boolean;
} & Pick<MutationProps, "busyActionId" | "onChangeStatus">
  & BatchOpProps
  & Pick<UiStateProps, "inlineForm" | "onOpenInlineForm" | "onCloseInlineForm">
) {
  const delivery = b.actions.find((a) => a.actionTypeName === "Delivery");
  const alreadyDelivered = b.closedAt != null && b.closureReason === "delivered";
  const cancelled        = b.closedAt != null && b.closureReason === "cancelled";
  const closed = alreadyDelivered || cancelled;
  const isListed = b.appListedAt != null;

  // Multi-gate Mark-as-delivered:
  //   1. Delivery action must exist on the batch
  //   2. Batch isn't already closed
  //   3. Wave-scope actions are all done/skipped (waveReady)
  //   4. Internal Phase complete on the parent PO
  //   5. Batch has been app-listed
  // Each gate gives a distinct tooltip so ops sees WHY a button is
  // locked without trial-and-error.
  const deliveryGate: { ok: boolean; reason: string } = (() => {
    if (!delivery)             return { ok: false, reason: "No Delivery action on this batch." };
    if (closed)                return { ok: false, reason: "Batch already closed." };
    if (!internalPhaseDone)    return { ok: false, reason: "Internal-phase actions still pending on the PO." };
    if (!waveReady)            return { ok: false, reason: `${wavePending} External-Phase action${wavePending === 1 ? "" : "s"} still pending in this window.` };
    if (!isListed)             return { ok: false, reason: "Batch not yet app-listed (do it via Internal Phase → App listed)." };
    return { ok: true, reason: "Marks the Delivery action done and auto-closes the batch." };
  })();
  const canDeliver = deliveryGate.ok;
  const deliveryBusy = !!delivery && busyActionId === delivery.id;
  const batchBusy    = busyBatchId === b.id;

  const showShiftForm  = inlineForm?.batchId === b.id && inlineForm.kind === "shift";
  const showCancelForm = inlineForm?.batchId === b.id && inlineForm.kind === "cancel";

  return (
    <li className="border border-ink-200 rounded-md bg-white px-2 py-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
        <code className="text-[0.7rem] text-midnight font-mono">{b.batchCode}</code>
        <span className="text-ink-600">{b.modelYear}</span>
        <span className="text-ink-300">·</span>
        <span className="tabular-nums">{b.requestedQuantity}× {b.city}</span>
        {isListed && (
          <span className="text-[0.6rem] text-green-dark tabular-nums">
            📱 listed {b.appListedAt!.slice(0, 10)}
          </span>
        )}
        {b.closedAt && (
          <span className={cn(
            "text-[0.65rem] tabular-nums",
            b.closureReason === "delivered" ? "text-green-dark" : "text-flame-dark",
          )}>
            {b.closureReason === "delivered" ? "✓ delivered" : "🚫 cancelled"} {b.closedAt}
          </span>
        )}
      </div>

      {/* Action buttons — hide once the batch is closed.
          Note: Mark-as-listed lives in Internal Phase now as a single
          PO-wide step (it's a commercial commitment that crosses
          every batch under the PO, not a per-batch toggle). */}
      {!closed && !showShiftForm && !showCancelForm && (
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          <BatchOpBtn
            label="📅 Shift date"
            tone="gold"
            busy={batchBusy}
            onClick={() => onOpenInlineForm(b.id, "shift")}
          />
          <BatchOpBtn
            label="🚫 Cancel"
            tone="flame"
            busy={batchBusy}
            onClick={() => onOpenInlineForm(b.id, "cancel")}
          />
          {delivery && (
            <button
              type="button"
              disabled={!canDeliver || deliveryBusy}
              onClick={() => onChangeStatus(delivery.id, "done")}
              className={cn(
                "text-[0.7rem] px-2 py-0.5 rounded border transition-colors ml-auto",
                canDeliver
                  ? "border-green text-green-dark hover:bg-green-pale"
                  : "border-ink-200 text-ink-400 cursor-not-allowed",
                deliveryBusy && "opacity-50 cursor-wait",
              )}
              title={deliveryGate.reason}
            >
              {deliveryBusy
                ? "…"
                : canDeliver
                  ? "✓ Mark as delivered"
                  : "🔒 Mark as delivered"}
            </button>
          )}
        </div>
      )}

      {showShiftForm && (
        <ShiftDateForm
          batch={b}
          busy={batchBusy}
          onSubmit={(payload) => {
            onBatchOp(b.id, "/api/batch-shift", payload);
            onCloseInlineForm();
          }}
          onCancel={onCloseInlineForm}
        />
      )}
      {showCancelForm && (
        <CancelBatchForm
          batch={b}
          busy={batchBusy}
          onSubmit={(note) => {
            onBatchOp(b.id, "/api/batch-close", {
              batchId: b.id,
              reason: "cancelled",
              note: note || null,
            });
            onCloseInlineForm();
          }}
          onCancel={onCloseInlineForm}
        />
      )}
    </li>
  );
}

/**
 * Inline form for batches → Shift availability date. Date input
 * uses the native date picker; reason + bookings are optional. The
 * form replaces the legacy three-step window.prompt chain, which
 * was unusable on a daily basis.
 */
function ShiftDateForm({
  batch: b, busy, onSubmit, onCancel,
}: {
  batch: BatchNode;
  busy: boolean;
  onSubmit: (payload: { batchId: number; newProjectedDate: string; reason: string | null; bookingsAtShift: number }) => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [bookings, setBookings] = useState<string>("0");
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("Pick a valid date.");
      return;
    }
    const n = parseInt(bookings, 10);
    onSubmit({
      batchId:          b.id,
      newProjectedDate: date,
      reason:           reason.trim() || null,
      bookingsAtShift:  Number.isFinite(n) && n >= 0 ? n : 0,
    });
  }

  return (
    <form onSubmit={submit} className="mt-2 p-2 border border-gold rounded-md bg-gold-pale/30 space-y-2">
      <p className="text-[0.7rem] font-medium text-gold-dark">📅 Shift availability date — {b.batchCode}</p>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2">
        <label className="text-[0.65rem] text-ink-600 flex flex-col">
          New date (yyyy-mm-dd)
          <input
            type="date"
            value={date}
            onChange={(e) => { setDate(e.target.value); setError(null); }}
            className="text-xs px-2 py-1 border border-ink-300 rounded mt-0.5"
            required
          />
        </label>
        <label className="text-[0.65rem] text-ink-600 flex flex-col">
          Bookings at shift
          <input
            type="number"
            min="0"
            value={bookings}
            onChange={(e) => setBookings(e.target.value)}
            className="text-xs px-2 py-1 border border-ink-300 rounded mt-0.5 tabular-nums"
          />
        </label>
        <label className="text-[0.65rem] text-ink-600 flex flex-col sm:col-span-3">
          Reason (optional)
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Dealer VIN delayed by 5 days"
            className="text-xs px-2 py-1 border border-ink-300 rounded mt-0.5"
          />
        </label>
      </div>
      {error && <p className="text-[0.65rem] text-flame-dark">{error}</p>}
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-[0.7rem] px-2 py-0.5 rounded border border-ink-300 text-ink-600 hover:bg-ink-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="text-[0.7rem] px-2 py-0.5 rounded border border-gold text-gold-dark hover:bg-gold-pale"
        >
          {busy ? "…" : "✓ Save shift"}
        </button>
      </div>
    </form>
  );
}

/**
 * Inline confirm-to-cancel form. Requires ops to type the batch code
 * to confirm — destructive actions deserve friction proportional to
 * consequence. Free-text note carries through to /api/batch-close.
 */
function CancelBatchForm({
  batch: b, busy, onSubmit, onCancel,
}: {
  batch: BatchNode;
  busy: boolean;
  onSubmit: (note: string) => void;
  onCancel: () => void;
}) {
  const [confirmText, setConfirmText] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const canConfirm = confirmText.trim() === b.batchCode;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canConfirm) return;
    onSubmit(note.trim());
  }

  return (
    <form onSubmit={submit} className="mt-2 p-2 border border-flame rounded-md bg-flame-pale/30 space-y-2">
      <p className="text-[0.7rem] font-bold text-flame-dark">
        🚫 Cancel batch — irreversible
      </p>
      <p className="text-[0.65rem] text-ink-700 leading-snug">
        Closing as cancelled removes the batch from active work. Type the batch
        code <code className="font-mono text-midnight">{b.batchCode}</code> to confirm.
      </p>
      <input
        type="text"
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        placeholder={b.batchCode}
        autoFocus
        className="text-xs px-2 py-1 border border-ink-300 rounded w-full font-mono"
      />
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Cancellation reason (optional)"
        className="text-xs px-2 py-1 border border-ink-300 rounded w-full"
      />
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-[0.7rem] px-2 py-0.5 rounded border border-ink-300 text-ink-600 hover:bg-ink-50"
        >
          Back
        </button>
        <button
          type="submit"
          disabled={!canConfirm || busy}
          className={cn(
            "text-[0.7rem] px-2 py-0.5 rounded border transition-colors",
            canConfirm
              ? "border-flame text-flame-dark hover:bg-flame-pale"
              : "border-ink-200 text-ink-400 cursor-not-allowed",
          )}
        >
          {busy ? "…" : "🚫 Confirm cancel"}
        </button>
      </div>
    </form>
  );
}

function BatchOpBtn({
  label, tone, busy, onClick,
}: {
  label: string;
  tone: "brand" | "ink" | "gold" | "flame";
  busy: boolean;
  onClick: () => void;
}) {
  const toneCls =
    tone === "brand" ? "border-brand text-brand-dark hover:bg-brand-pastel" :
    tone === "gold"  ? "border-gold text-gold-dark hover:bg-gold-pale"      :
    tone === "flame" ? "border-flame text-flame-dark hover:bg-flame-pale"   :
    "border-ink-300 text-ink-600 hover:bg-ink-50";
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

// ─────────────────────────────────────────────────────────────
// Action card — rich tile used inside Waiting / Blocked / Done columns
// ─────────────────────────────────────────────────────────────

function ActionCard({
  action, busy, onChangeStatus, poForAppListing,
}: {
  action: ScopedActionDetail;
  busy: boolean;
  onChangeStatus: (actionId: number, status: Status) => void;
  /** When this card is the synthetic "App listed" row in Internal
   *  Phase, the parent passes the PO so the row can offer a real
   *  bulk-listing CTA instead of being read-only. */
  poForAppListing?: PoNode;
}) {
  // Synthetic rows (id < 0) like the derived "App listed" row are
  // read-only by default. The exception: when the parent passes
  // `poForAppListing`, the App-listed row gets a bulk-listing CTA
  // that flips every batch's appListedAt in one transaction.
  const isSynthetic = action.id < 0;
  const isAppListedRow = action.actionTypeName === "App listed";
  // Always show the doneLabel base form. The card's column placement
  // (Waiting / Blocked / Done) carries the status — repeating the
  // word "Waiting" in front of every label was redundant.
  const label = action.doneLabel || action.waitingLabel;
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

        {/* Stakeholder · Department — synthetic rows skip this whole line.
            Real action rows surface the same inline-edit picker used in
            the legacy drawer: click the @name to reassign within the
            same department. */}
        {!isSynthetic && (action.stakeholderName || action.departmentName) && (
          <ReassignInline action={action} busy={busy} />
        )}

        {/* Date — completed (✓) or due (⏰). Differentiating prefixes
            keep scan speed up: ✓ instantly reads as past tense, ⏰ as
            future obligation, no need to also parse the colour. */}
        {action.status === "done" && action.completedAt && (
          <p className="text-[0.7rem] text-green-dark tabular-nums">
            ✓ {action.completedAt.slice(0, 10)}
          </p>
        )}
        {action.status !== "done" && action.status !== "skipped" && action.expectedDate && (
          <p className={cn(
            "text-[0.7rem] tabular-nums",
            overdue ? "text-flame-dark font-medium" : "text-ink-500",
          )}>
            ⏰ {action.expectedDate}
          </p>
        )}

        {/* Blocked reason */}
        {action.status === "blocked" && action.blockedByNames.length > 0 && (
          <p className="text-[0.7rem] text-flame-dark mt-0.5">
            waiting on {action.blockedByNames.join(", ")}
          </p>
        )}
      </div>

      {/* App-listing CTA — only fires on the synthetic App-listed row
          when the parent (Internal Phase view) opted in by passing
          poForAppListing. The control toggles every batch's
          appListedAt at once. Gated on the PO's internalPhaseDone so
          ops can't list before pricing/specs/SKU are settled. */}
      {isAppListedRow && poForAppListing && (
        <AppListedBulkCta po={poForAppListing} />
      )}

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
            onClick={() => {
              // Skip silently satisfies the cascade (children promote
              // from blocked → waiting), which can mask "we never
              // actually did this work" mistakes. When there are
              // pending dependents on the same scope, confirm with
              // ops first so they see the downstream impact.
              if (action.pendingDependentNames.length > 0) {
                const confirmed = window.confirm(
                  `Skipping "${action.doneLabel || action.actionTypeName}" will unblock these dependent actions:\n\n` +
                  action.pendingDependentNames.map((n) => `  • ${n}`).join("\n") +
                  `\n\nProceed?`,
                );
                if (!confirmed) return;
              }
              onChangeStatus(action.id, "skipped");
            }}
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

/**
 * Bulk app-listing control rendered on the synthetic "App listed" row
 * inside Internal Phase. Three button states based on the PO's roll-up:
 *   • 0/N listed   → "📱 Mark all as listed" (primary)
 *   • k/N listed   → "📱 Mark remaining (N−k) as listed" (primary)
 *   • N/N listed   → "📱 Un-list all" (secondary)
 * Disabled with a 🔒 prefix when Internal Phase isn't done yet.
 */
function AppListedBulkCta({ po }: { po: PoNode }) {
  const { onBulkSetAppListed, busyBatchId } = useShell();
  const allBatches = po.waves.flatMap((w) => w.batches);
  const unlistedIds = allBatches.filter((b) => b.appListedAt == null).map((b) => b.id);
  const listedIds   = allBatches.filter((b) => b.appListedAt != null).map((b) => b.id);
  const total    = allBatches.length;
  const listed   = listedIds.length;
  const fullyListed = total > 0 && listed === total;
  const gateOk = po.internalPhaseDone || fullyListed; // un-listing always allowed
  const busy = busyBatchId != null && allBatches.some((b) => b.id === busyBatchId);

  function handleClick() {
    if (!gateOk) return;
    if (fullyListed) {
      const ok = window.confirm(`Un-list all ${total} batch${total === 1 ? "" : "es"}? Clears every appListedAt timestamp.`);
      if (!ok) return;
      onBulkSetAppListed(listedIds, false);
    } else {
      onBulkSetAppListed(unlistedIds, true);
    }
  }

  const remaining = total - listed;
  const label =
    fullyListed   ? "📱 Un-list all"
    : !gateOk     ? `🔒 Mark all listed (${remaining} pending)`
    : listed === 0
                  ? `📱 Mark all batches as listed (${total})`
                  : `📱 Mark remaining as listed (${remaining})`;

  const tone = fullyListed
    ? "border-ink-300 text-ink-600 hover:bg-ink-50"
    : gateOk
      ? "border-brand text-brand-dark hover:bg-brand-pastel"
      : "border-ink-200 text-ink-400 cursor-not-allowed";

  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      <button
        type="button"
        disabled={!gateOk || busy || total === 0}
        onClick={handleClick}
        title={
          !gateOk
            ? "Complete Internal-phase actions before listing batches."
            : fullyListed
              ? "Clears every batch's app-listing timestamp."
              : "Marks every batch as live in the app right now."
        }
        className={cn(
          "text-[0.7rem] px-2 py-0.5 rounded border transition-colors",
          tone,
          busy && "opacity-50 cursor-wait",
        )}
      >
        {busy ? "…" : label}
      </button>
    </div>
  );
}

/**
 * Inline stakeholder reassign for an action card. Renders the
 * "@Name · Dept" line normally; clicking the chip swaps in a small
 * <select> bound to the action's current department's stakeholders.
 * Picking a new option fires onReassign immediately; Esc / blur
 * cancels without saving.
 */
function ReassignInline({
  action, busy,
}: { action: ScopedActionDetail; busy: boolean }) {
  const { onReassign, departments } = useShell();
  const [editing, setEditing] = useState<boolean>(false);

  // Resolve the action's department → its stakeholder list. If the
  // action has no department, fall back to ALL stakeholders so ops
  // can still pick someone. Departments with zero stakeholders show
  // a "no options" hint instead of an empty dropdown.
  const dept = action.departmentName
    ? departments.find((d) => d.name === action.departmentName)
    : null;
  const choices = dept?.stakeholders ?? departments.flatMap((d) => d.stakeholders);

  if (!editing) {
    return (
      <p className="text-[0.7rem] text-ink-600 flex items-baseline gap-1">
        {action.stakeholderName ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-brand-dark underline underline-offset-2 decoration-dotted hover:decoration-solid"
            title="Click to reassign"
          >
            @{action.stakeholderName}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-ink-500 italic underline underline-offset-2 decoration-dotted hover:decoration-solid"
            title="Click to assign a stakeholder"
          >
            unassigned
          </button>
        )}
        {action.departmentName && (
          <>
            <span className="text-ink-400">·</span>
            <span className="text-ink-500">{action.departmentName}</span>
          </>
        )}
      </p>
    );
  }

  return (
    <div className="flex items-center gap-1.5 mt-0.5">
      <select
        autoFocus
        disabled={busy}
        defaultValue={action.stakeholderName
          ? (choices.find((s) => s.name === action.stakeholderName)?.id ?? "")
          : ""}
        onChange={async (e) => {
          const v = e.target.value;
          const newId = v === "" ? null : parseInt(v, 10);
          // No-op when the operator picked the same stakeholder.
          const current = action.stakeholderName
            ? choices.find((s) => s.name === action.stakeholderName)?.id ?? null
            : null;
          setEditing(false);
          if (newId === current) return;
          await onReassign(action.id, newId);
        }}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        className="text-[0.7rem] px-1.5 py-0.5 border border-ink-300 rounded"
      >
        <option value="">— unassigned —</option>
        {choices.length === 0 && (
          <option value="" disabled>(no stakeholders in this dept)</option>
        )}
        {choices.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
      {action.departmentName && (
        <span className="text-[0.7rem] text-ink-500">· {action.departmentName}</span>
      )}
    </div>
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

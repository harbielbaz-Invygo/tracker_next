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
import Link from "next/link";
import type {
  ActionCenterTree, PoNode, WaveNode, BatchNode, ScopedActionDetail,
  DepartmentCatalog, ActionTouchpoint,
} from "@/lib/action-center-tree-data";
import { augmentActions, type Touchpoint } from "@/lib/action-flow-shared";
import ConfirmDialog from "./confirm-dialog";
import InputDialog from "./input-dialog";
import { useConfirmDialog } from "./use-confirm-dialog";

/**
 * Shell context — gives every nested card access to the reassign
 * mutation + dept/stakeholder catalog + bulk app-listing toggle
 * without drilling props through 5 levels of components.
 */
interface ShellCtx {
  onReassign: (actionId: number, stakeholderId: number | null) => Promise<void>;
  onBulkSetAppListed: (batchIds: number[], setListed: boolean, customStampIso?: string) => Promise<void>;
  busyBatchId: number | null;
  departments: DepartmentCatalog[];
  // Touchpoint flow — used only by the External-Phase chips on each
  // batch row to surface metrics (📞 N · ↗ N · ⏱ Nd) and to fire
  // Log-contact / Escalate from a satellite row beneath the chip.
  //
  // The optional `actionLabel` arg is purely cosmetic: it ends up in
  // the undo-toast headline so ops can see *which* chip they just
  // poked ("📞 VIN — contact logged") before the 10s window closes.
  touchpointsByAction: Record<string, ActionTouchpoint[]>;
  onLogContact:       (actionId: number, actionLabel?: string) => Promise<void>;
  onEscalate:         (actionId: number, actionLabel?: string) => Promise<void>;
  busyTouchpointActionId: number | null;
  /**
   * Audit 6 #1+#10 — branded replacements for window.confirm / window.alert.
   * Promise-based so async mutation handlers stay flat. Always prefer
   * these over the native dialogs (unbranded + a11y-poor + can't show
   * preview lists of affected items).
   */
  confirm: ReturnType<typeof useConfirmDialog>["confirm"];
  alert:   ReturnType<typeof useConfirmDialog>["alert"];
  prompt:  ReturnType<typeof useConfirmDialog>["prompt"];
  /** True when the signed-in user is an admin — gates the Redistribute UI. */
  isAdmin: boolean;
}
const ShellContext = createContext<ShellCtx | null>(null);
function useShell(): ShellCtx {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside ShellContext.Provider");
  return ctx;
}
import { cn } from "@/lib/utils";
import { computeBaselineReliability } from "@/lib/baseline-reliability";

type Status = ScopedActionDetail["status"];

/** Today's date in ISO yyyy-mm-dd — used for the overdue check. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Format a Date as a `datetime-local` input value (`YYYY-MM-DDTHH:mm`)
 *  in the browser's local timezone. */
function toLocalDatetimeValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Whole days from `todayIso` to `targetIso` (positive = future, negative
 *  = past). Both are yyyy-mm-dd. */
function daysUntil(targetIso: string, todayIso: string): number {
  const a = Date.parse(`${todayIso}T00:00:00Z`);
  const b = Date.parse(`${targetIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Prominent "days remaining" pill for a delivery window — big + coloured
 *  so it stands out at the front of the window line. */
function WindowDaysLeftBadge({ targetIso, today }: { targetIso: string; today: string }) {
  const d = daysUntil(targetIso, today);
  const label = d < 0 ? `${Math.abs(d)}d overdue` : d === 0 ? "Today" : `${d}d left`;
  const tone =
    d < 0   ? "bg-flame-dark text-white border-flame-dark"
    : d <= 2 ? "bg-gold-pale text-gold-dark border-gold"
    :          "bg-brand-pastel text-brand-dark border-brand/40";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-sm font-bold tabular-nums leading-none",
        tone,
      )}
      title={`${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} ${d < 0 ? "past" : "until"} this delivery window`}
    >
      {label}
    </span>
  );
}

/** Today + N days, ISO yyyy-mm-dd. Used as the default next-follow-up
 *  date for Log-contact / Escalate touchpoints. */
function addDaysIso(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
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
 * Walk every action under a PO and split the counts by phase so the
 * left tree can show "Internal x/y · External x/y" instead of a
 * single combined total. Returns:
 *   internal — PO-scope actions + the synthetic App-listed row
 *              (counted as 1 done when every batch is listed)
 *   external — wave-scope actions across every wave
 *   overdue  — combined; ops cares about at-risk count regardless of phase
 */
function rollupPoCounts(po: PoNode, today: string): {
  internal: { done: number; total: number };
  external: { done: number; total: number };
  overdue:  number;
} {
  let intDone = 0, intTotal = 0;
  let extDone = 0, extTotal = 0;
  let overdue = 0;
  for (const a of po.actions) {
    intTotal++;
    if (a.status === "done" || a.status === "skipped") intDone++;
    if (isOverdue(a, today)) overdue++;
  }
  // Synthetic App-listed row: counted as ONE internal-phase row that
  // is done when every batch under the PO has appListedAt set.
  if (po.appListingSummary.total > 0) {
    intTotal++;
    if (po.appListingSummary.completedAt != null) intDone++;
  }
  for (const w of po.waves) {
    for (const a of w.actions) {
      extTotal++;
      if (a.status === "done" || a.status === "skipped") extDone++;
      if (isOverdue(a, today)) overdue++;
    }
    // Batch-scope rows (Delivery + per-batch external copies) drive
    // the per-batch chips, but for the tree summary we surface them
    // through the wave totals to avoid double-counting.
  }
  return {
    internal: { done: intDone, total: intTotal },
    external: { done: extDone, total: extTotal },
    overdue,
  };
}

type DrawerView = "internal" | "vin" | "prepo";
const DRAWER_VIEW_KEY = "action-center-v2-drawer-view";

interface Props {
  tree: ActionCenterTree;
  /** Signed-in user is an admin — gates the Redistribute controls. */
  isAdmin?: boolean;
}

/** Drawer selection mode — a single PO, or the "Mine" cross-PO view. */
type Selection =
  | { kind: "po"; poId: number }
  | { kind: "mine" };

// Drag-to-resize bounds for the left PO-tree pane. Persisted width is
// clamped to this range so neither pane can collapse past usefulness.
const TREE_W_KEY = "ac-tree-width";
const TREE_W_DEFAULT = 320;
const TREE_W_MIN = 240;
const TREE_W_MAX = 560;

export default function ActionCenterTreeShell({ tree, isAdmin = false }: Props) {
  const router = useRouter();

  // ── Drag-to-resize the split between the PO tree and the detail
  // pane. Width persists in localStorage so ops keeps their preferred
  // split across sessions; double-clicking the handle resets it.
  const [treeWidth, setTreeWidth] = useState<number>(TREE_W_DEFAULT);
  const [resizingTree, setResizingTree] = useState<boolean>(false);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(TREE_W_KEY);
      if (stored) {
        const n = parseInt(stored, 10);
        if (!Number.isNaN(n) && n >= TREE_W_MIN && n <= TREE_W_MAX) setTreeWidth(n);
      }
    } catch { /* private mode / SSR */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(TREE_W_KEY, String(treeWidth)); } catch { /* ignore */ }
  }, [treeWidth]);

  function startTreeResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = treeWidth;
    setResizingTree(true);
    function onMove(ev: MouseEvent) {
      const next = Math.min(
        TREE_W_MAX,
        Math.max(TREE_W_MIN, startWidth + (ev.clientX - startX)),
      );
      setTreeWidth(next);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setResizingTree(false);
    }
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

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
  /**
   * Cascade flash auto-dismisses after 5 s (Audit 6 #3) so a lingering
   * green banner doesn't stay after the operator has visually confirmed
   * the outcome. Still dismissable via Escape or the ✕ button before
   * the timer fires. Errors do NOT auto-dismiss — those need explicit
   * acknowledgement.
   */
  const [cascadeFlash,  setCascadeFlash]  = useState<string | null>(null);
  useEffect(() => {
    if (!cascadeFlash) return;
    const t = setTimeout(() => setCascadeFlash(null), 5000);
    return () => clearTimeout(t);
  }, [cascadeFlash]);

  // Audit 6 #1+#10 — promise-based branded confirm/alert. Exposed
  // through ShellContext so nested components can call them without
  // each instantiating their own dialog state.
  const { confirm, alert, prompt, dialogProps, inputProps } = useConfirmDialog();
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
    | { batchId: number; kind: "shift" | "cancel" | "vins" | "confirmation" | "deliver" | "date"; actionId?: number }
    | null
  >(null);
  function openInlineForm(
    batchId: number,
    kind: "shift" | "cancel" | "vins" | "confirmation" | "deliver" | "date",
    actionId?: number,
  ) {
    setInlineForm({ batchId, kind, actionId });
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

  async function setActionStatus(actionId: number, status: Status, completedAt?: string) {
    setBusyActionId(actionId);
    setMutationError(null);
    setCascadeFlash(null);
    try {
      const res = await fetch("/api/scope-action", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId,
          status,
          ...(completedAt ? { completedAt } : {}),
        }),
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
   * the synthetic "App listed" step in Internal Phase — app-listing
   * is per-delivery-window, so the picker batches up unlisted batches
   * within the checked windows and fires this once. Optional
   * `customStampIso` lets ops backdate the listing event (e.g.
   * "actually went live last Friday at 3pm") — defaults to "now".
   */
  async function bulkSetAppListed(
    batchIds: number[],
    setListed: boolean,
    customStampIso?: string,
  ): Promise<void> {
    if (batchIds.length === 0) return;
    setMutationError(null);
    setCascadeFlash(null);
    const stamp = setListed
      ? (customStampIso ?? new Date().toISOString())
      : null;
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
      if (stored === "internal" || stored === "vin" || stored === "prepo") setView(stored);
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

  // Auto-snap the drawer view when the selected node is a Pre-PO —
  // Internal/External tabs don't exist for those, and the view state
  // would otherwise stay on whatever the previous selection was on.
  useEffect(() => {
    if (selectedPo?.isPrePo && view !== "prepo") setView("prepo");
    if (selectedPo && !selectedPo.isPrePo && view === "prepo") setView("internal");
  }, [selectedPo, view]);

  // Touchpoint mutations — wired into ShellContext so the per-chip
  // satellite row in BatchRow can fire them without prop-drilling.
  const [busyTouchpointActionId, setBusyTouchpointActionId] = useState<number | null>(null);

  // Undo banner — captures the id of the last-inserted touchpoint so
  // a single click on ↶ Undo can DELETE it within the 10s window. The
  // tick interval drives the per-second countdown in the pill.
  interface LastTouchpoint { id: number; label: string; expiresAt: number }
  const [lastTouchpoint, setLastTouchpoint] = useState<LastTouchpoint | null>(null);
  const [touchpointNow, setTouchpointNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!lastTouchpoint) return;
    const t = setInterval(() => setTouchpointNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [lastTouchpoint]);
  useEffect(() => {
    if (lastTouchpoint && touchpointNow >= lastTouchpoint.expiresAt) {
      setLastTouchpoint(null);
    }
  }, [lastTouchpoint, touchpointNow]);

  async function logContactMutation(actionId: number, actionLabel?: string): Promise<void> {
    setBusyTouchpointActionId(actionId);
    setMutationError(null);
    try {
      const res = await fetch("/api/action-touchpoint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId,
          channel:        "other",
          direction:      "outbound",
          outcome:        "no_response",
          nextFollowupAt: addDaysIso(1),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as { touchpoint?: { id: number } };
      if (data.touchpoint?.id) {
        setLastTouchpoint({
          id:        data.touchpoint.id,
          label:     `📞 ${actionLabel ?? "contact"} — logged`,
          expiresAt: Date.now() + 10_000,
        });
        setTouchpointNow(Date.now());
      }
      router.refresh();
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyTouchpointActionId(null);
    }
  }

  async function escalateMutation(actionId: number, actionLabel?: string): Promise<void> {
    setBusyTouchpointActionId(actionId);
    setMutationError(null);
    try {
      const res = await fetch("/api/action-touchpoint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId,
          channel:        "other",
          direction:      "internal",
          outcome:        "other",
          escalated:      true,
          note:           "Escalated",
          nextFollowupAt: addDaysIso(2),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as { touchpoint?: { id: number } };
      if (data.touchpoint?.id) {
        setLastTouchpoint({
          id:        data.touchpoint.id,
          label:     `↗ ${actionLabel ?? "action"} — escalated`,
          expiresAt: Date.now() + 10_000,
        });
        setTouchpointNow(Date.now());
      }
      router.refresh();
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyTouchpointActionId(null);
    }
  }

  async function undoLastTouchpoint(): Promise<void> {
    if (!lastTouchpoint) return;
    const id = lastTouchpoint.id;
    setLastTouchpoint(null);
    setMutationError(null);
    try {
      const res = await fetch("/api/action-touchpoint", {
        method:  "DELETE",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <ShellContext.Provider value={{
      onReassign: reassignStakeholder,
      onBulkSetAppListed: bulkSetAppListed,
      busyBatchId,
      departments: tree.departments,
      touchpointsByAction:    tree.touchpointsByAction,
      onLogContact:           logContactMutation,
      onEscalate:             escalateMutation,
      busyTouchpointActionId,
      confirm,
      alert,
      prompt,
      isAdmin,
    }}>
    <ConfirmDialog {...dialogProps} />
    <InputDialog   {...inputProps} />
    <div
      className="relative grid grid-cols-1 lg:grid-cols-[var(--ac-tree-w,320px)_1fr] gap-4 h-[min(80vh,860px)] min-h-[520px]"
      style={{ "--ac-tree-w": `${treeWidth}px` } as React.CSSProperties}
    >
      {/* Drag-to-resize the PO-tree ↔ detail split. lg+ only (the panes
          stack on small screens). Sits centred in the 1rem gap between
          the two columns; double-click resets to the default width. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panels"
        aria-valuemin={TREE_W_MIN}
        aria-valuemax={TREE_W_MAX}
        aria-valuenow={treeWidth}
        title={`Drag to resize · double-click to reset (${treeWidth}px)`}
        onMouseDown={startTreeResize}
        onDoubleClick={() => setTreeWidth(TREE_W_DEFAULT)}
        style={{ left: "calc(var(--ac-tree-w,320px) + 8px)" }}
        className={cn(
          "hidden lg:block absolute top-0 z-10 h-full w-2 -ml-1 rounded cursor-col-resize select-none",
          "hover:bg-brand/40 active:bg-brand/60 transition-colors",
          resizingTree && "bg-brand/60",
        )}
      />

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

      {/* Undo toast for touchpoints — floats over the drawer at the
          bottom-left so it doesn't fight with the help button (right)
          or any inline form. Auto-dismisses after 10s; clicking the
          ↶ button hits DELETE /api/action-touchpoint. */}
      {lastTouchpoint && touchpointNow < lastTouchpoint.expiresAt && (
        <div
          role="status"
          className="absolute bottom-2 left-2 z-10 flex items-center gap-2 text-xs bg-green-pale border border-green px-3 py-1.5 rounded-md shadow-sm"
        >
          <span>✓ {lastTouchpoint.label}</span>
          <span className="text-ink-500 tabular-nums">
            · {Math.max(0, Math.ceil((lastTouchpoint.expiresAt - touchpointNow) / 1000))}s
          </span>
          <button
            type="button"
            onClick={undoLastTouchpoint}
            className="ml-1 text-[0.7rem] px-2 py-0.5 rounded border border-flame text-flame-dark hover:bg-flame-pale font-medium bg-white"
          >
            ↶ Undo
          </button>
        </div>
      )}

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
  onChangeStatus:  (actionId: number, status: Status, completedAt?: string) => void;
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
  inlineForm: { batchId: number; kind: "shift" | "cancel" | "vins" | "confirmation" | "deliver" | "date"; actionId?: number } | null;
  onOpenInlineForm:  (batchId: number, kind: "shift" | "cancel" | "vins" | "confirmation" | "deliver" | "date", actionId?: number) => void;
  onCloseInlineForm: () => void;
}

// ─────────────────────────────────────────────────────────────
// Left panel — Dealer → PO tree
// ─────────────────────────────────────────────────────────────

type PoStatusFilter = "all" | "active" | "completed" | "cancelled" | "partly";

/**
 * Bucket a PO for the status quick-filter:
 *   active     — not yet closed (open, or a Pre-PO bet)
 *   cancelled  — closed with every batch cancelled
 *   completed  — closed with every batch delivered in full
 *   partly     — closed but mixed (some cancelled, or partial deliveries)
 */
function poStatusBucket(po: PoNode): Exclude<PoStatusFilter, "all"> {
  if (!po.closedAt) return "active";
  const batches = po.waves.flatMap((w) => w.batches);
  if (batches.length === 0) return "active";
  const delivered = batches.filter((b) => b.closureReason === "delivered");
  const cancelled = batches.filter((b) => b.closureReason === "cancelled");
  if (cancelled.length === batches.length) return "cancelled";
  const fullyDelivered = cancelled.length === 0
    && delivered.length === batches.length
    && delivered.every((b) => (b.deliveredQuantity ?? 0) >= b.requestedQuantity);
  if (fullyDelivered) return "completed";
  return "partly";
}

const PO_STATUS_FILTERS: { value: PoStatusFilter; label: string; title: string }[] = [
  { value: "active",    label: "Active",    title: "Open POs still in progress (incl. Pre-PO bets)" },
  { value: "all",       label: "All",       title: "Every PO" },
  { value: "completed", label: "Completed", title: "Closed & delivered — full or partial (everything except cancelled)" },
  { value: "partly",    label: "Partly",    title: "Closed — partly delivered (mixed / partial) only" },
  { value: "cancelled", label: "Cancelled", title: "Closed — every batch cancelled" },
];

function DealerTree({
  tree, selection, onSelectPo, onSelectMine,
}: {
  tree: ActionCenterTree;
  selection: Selection;
  onSelectPo: (id: number) => void;
  onSelectMine: () => void;
}) {
  // Dealers start collapsed — fewer rows on first paint, ops opens
  // the dealer they're working on. Persisted in-memory for the
  // session; refresh resets to fully-collapsed.
  const [expandedDealers, setExpandedDealers] = useState<Set<number>>(
    () => new Set(),
  );
  // Free-text filter (PO #, dealer, batch code substring) + sort
  // toggle. Both are local UI state — no need to persist for now.
  const [query, setQuery] = useState<string>("");
  const [sortMode, setSortMode] = useState<"alpha" | "overdue">("alpha");
  // Status quick-filter. Defaults to "active" so ops lands on in-progress
  // POs; closed/cancelled ones are a click away.
  const [statusFilter, setStatusFilter] = useState<PoStatusFilter>("active");

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
    const matchStatus = (p: PoNode) => {
      if (statusFilter === "all") return true;
      const bucket = poStatusBucket(p);
      // "Completed" = every closed PO that delivered at least some cars
      // (full OR partial) — i.e. all closed minus the fully-cancelled.
      // "Partly" remains the narrower view of just the partial ones.
      if (statusFilter === "completed") return bucket === "completed" || bucket === "partly";
      return bucket === statusFilter;
    };
    return tree.dealers
      .map((d) => ({ ...d, pos: d.pos.filter((p) => matchPo(p, d.name) && matchStatus(p)) }))
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
  }, [tree.dealers, q, sortMode, today, statusFilter]);

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
        {/* Status quick-filter — show/hide POs by lifecycle outcome. */}
        <div className="flex flex-wrap items-center gap-1">
          {PO_STATUS_FILTERS.map(({ value, label, title }) => (
            <button
              key={value}
              type="button"
              onClick={() => setStatusFilter(value)}
              aria-pressed={statusFilter === value}
              title={title}
              className={cn(
                "text-[0.65rem] px-2 py-0.5 rounded-full border whitespace-nowrap transition-colors",
                statusFilter === value
                  ? "border-brand text-brand-dark bg-brand-pastel/60 font-semibold"
                  : "border-ink-300 text-ink-600 hover:bg-ink-50",
              )}
            >
              {label}
            </button>
          ))}
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
        {filteredDealers.length === 0 && (
          <li className="px-3 py-4 text-xs text-ink-500 italic">
            No POs match {query ? "the search" : `the "${PO_STATUS_FILTERS.find((f) => f.value === statusFilter)?.label}" filter`}.
          </li>
        )}
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
                              ? (p.isPrePo
                                  ? "bg-gold-pale border-l-gold text-gold-dark"
                                  : "bg-brand-pastel border-l-brand text-brand-dark")
                              : p.isPrePo
                                ? "border-l-gold/40 hover:bg-gold-pale/40 text-midnight"
                                : "border-l-transparent hover:bg-ink-50 text-ink-700",
                            // Closed POs are dimmed but still selectable —
                            // ops occasionally needs to see post-delivery
                            // detail.
                            p.closedAt && p.id !== selectedPoId && "opacity-60",
                          )}
                        >
                          <div className="font-mono font-medium flex items-baseline gap-1.5">
                            {p.isPrePo && (
                              <span
                                aria-hidden
                                className="font-sans text-[0.6rem] font-bold uppercase tracking-wide bg-gold text-white rounded-full px-1.5 py-0.5"
                              >
                                Pre-PO
                              </span>
                            )}
                            <span className="truncate">
                              {p.isPrePo ? p.poNumber.replace(/^Pre-PO · /, "") : p.poNumber}
                            </span>
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
                            {p.totalCars} cars
                            {!p.isPrePo && (
                              <>
                                {" · "}
                                {p.waves.length} window{p.waves.length === 1 ? "" : "s"}
                              </>
                            )}
                            {p.isPrePo && p.prePoSummary && (
                              <>
                                {" · "}
                                <span className="text-gold-dark">awaiting PO</span>
                              </>
                            )}
                            {p.closedAt && (() => {
                              const bs = p.waves.flatMap((w) => w.batches);
                              const cancelledOnly = bs.length > 0
                                && bs.every((b) => b.closureReason === "cancelled");
                              return (
                                <span className={cn("ml-1", cancelledOnly ? "text-flame-dark" : "text-green-dark")}>
                                  · {cancelledOnly ? "cancelled" : "delivered"}
                                </span>
                              );
                            })()}
                          </div>
                          {/* Phase-broken progress lines: Internal +
                              External shown separately so ops can
                              tell at a glance which side is dragging.
                              Each phase that has at least one row
                              shows its own line; we omit when total=0
                              to keep the tree compact for newly-
                              created POs. Pre-PO nodes skip this
                              entirely — they have no Internal /
                              External phases, only Pre-PO follow-up. */}
                          {!p.isPrePo && (counts.internal.total > 0 || counts.external.total > 0) && (
                            <div className="mt-0.5 space-y-0.5 leading-tight">
                              {counts.internal.total > 0 && (
                                <div className="text-[0.65rem] tabular-nums">
                                  <span className="text-ink-500">Internal phase </span>
                                  <span className={cn(
                                    "font-medium",
                                    counts.internal.done === counts.internal.total
                                      ? "text-green-dark"
                                      : "text-midnight",
                                  )}>
                                    {counts.internal.done}/{counts.internal.total}
                                  </span>
                                </div>
                              )}
                              {counts.external.total > 0 && (
                                <div className="text-[0.65rem] tabular-nums">
                                  <span className="text-ink-500">External phase </span>
                                  <span className={cn(
                                    "font-medium",
                                    counts.external.done === counts.external.total
                                      ? "text-green-dark"
                                      : "text-midnight",
                                  )}>
                                    {counts.external.done}/{counts.external.total}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                          {/* PO Reliability badge (Review #4 R5).
                              Only lights up on fully-closed POs —
                              reliability is null until every batch
                              has a realised outcome. Tone band:
                              80+ green, 60-79 gold, < 60 flame. */}
                          {!p.isPrePo && p.reliabilityScore != null && (
                            <div className={cn(
                              "mt-0.5 text-[0.65rem] tabular-nums font-medium",
                              p.reliabilityScore >= 80 ? "text-green-dark" :
                              p.reliabilityScore >= 60 ? "text-gold-dark" :
                              "text-flame-dark",
                            )}>
                              🎯 {p.reliabilityScore}% reliable
                            </div>
                          )}
                          {/* Listing-speed KPI badge (Review #2 R9).
                              Lights up on every live PO so the primary
                              "PO → App Listed" metric is visible on the
                              operator surface. Three states:
                                - listed + fully delivered: "📱 Listed in Nd"
                                - listed but not all batches: same chip
                                - open + unlisted: "📱 Day N unlisted"
                                  (gold past 7d, flame past 14d)
                             Pre-PO and POs without a submission date
                             are intentionally omitted (no clock yet). */}
                          {!p.isPrePo && p.daysSinceSubmission != null && (
                            p.daysToListed != null ? (
                              <div className="mt-0.5 text-[0.65rem] tabular-nums text-green-dark">
                                📱 Listed in {p.daysToListed}d
                              </div>
                            ) : (
                              <div className={cn(
                                "mt-0.5 text-[0.65rem] tabular-nums",
                                p.daysSinceSubmission >= 14
                                  ? "text-flame-dark font-medium"
                                  : p.daysSinceSubmission >= 7
                                    ? "text-gold-dark"
                                    : "text-ink-500",
                              )}>
                                📱 Day {p.daysSinceSubmission} unlisted
                              </div>
                            )
                          )}
                          {/* Pre-PO follow-up progress — surfaces the
                              Pre-PO App Listing chip's status (and
                              anything else ops added under pre_po) so
                              the tree row carries the same signal
                              live POs do for Internal/External. */}
                          {p.isPrePo && p.actions.length > 0 && (() => {
                            const done = p.actions.filter(
                              (a) => a.status === "done" || a.status === "skipped",
                            ).length;
                            return (
                              <div className="mt-0.5 text-[0.65rem] tabular-nums">
                                <span className="text-ink-500">Pre-PO follow-up </span>
                                <span className={cn(
                                  "font-medium",
                                  done === p.actions.length
                                    ? "text-green-dark"
                                    : "text-midnight",
                                )}>
                                  {done}/{p.actions.length}
                                </span>
                              </div>
                            );
                          })()}
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
          at-risk count without scrolling. Inbox-grade summary, plus
          a phase-status strip and a milestone timeline so ops sees
          the operational picture for this PO in one block. */}
      <header className="px-4 py-3 border-b border-ink-200 shrink-0 bg-ink-50/50 space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-xl font-mono font-bold text-midnight">{po.poNumber}</h2>
          {po.poDate && (
            <span className="text-xs text-ink-500 tabular-nums">{po.poDate}</span>
          )}
          {po.closedAt && (() => {
            // "Delivered" unless every batch was cancelled (then "Cancelled").
            const batches = po.waves.flatMap((w) => w.batches);
            const cancelledOnly = batches.length > 0
              && batches.every((b) => b.closureReason === "cancelled");
            return (
              <span className={cn(
                "text-[0.65rem] font-medium tabular-nums uppercase tracking-wide",
                cancelledOnly ? "text-flame-dark" : "text-green-dark",
              )}>
                {cancelledOnly ? "🚫 Cancelled" : "✓ Delivered"} {po.closedAt}
              </span>
            );
          })()}
        </div>
        <p className="text-xs text-ink-600">
          <span className="font-medium text-midnight">🏢 {dealerName}</span>
          <span className="text-ink-300 mx-1.5">·</span>
          <span className="tabular-nums">{po.totalCars} cars</span>
          {(() => {
            // Per-model breakdown derived client-side from the
            // batches under this PO. Renders inline as
            // "🚗 Accent 50 · Elantra 30 · Sonata 30" when there are
            // multiple distinct models, or just the model + count
            // when the PO is single-model.
            const byModel = new Map<string, number>();
            for (const w of po.waves) {
              for (const b of w.batches) {
                if (!b.modelYear || b.modelYear === "—") continue;
                byModel.set(
                  b.modelYear,
                  (byModel.get(b.modelYear) ?? 0) + b.requestedQuantity,
                );
              }
            }
            const entries = Array.from(byModel.entries())
              .sort((a, b) => b[1] - a[1]); // largest qty first
            if (entries.length === 0) return null;
            return (
              <>
                <span className="text-ink-300 mx-1.5">·</span>
                <span className="tabular-nums" title="Per-model car counts under this PO">
                  🚗 {entries.map(([m, n]) => `${m} ${n}`).join(" · ")}
                </span>
              </>
            );
          })()}
          <span className="text-ink-300 mx-1.5">·</span>
          <span className="tabular-nums">{po.waves.length} delivery window{po.waves.length === 1 ? "" : "s"}</span>
          {/* The "in Nd / Nd past window" countdown moved to each delivery
              window header (it's inherently per-window) — removed from the
              PO header to keep it PO-level. */}
          {po.contractLengthMonths && (
            <>
              <span className="text-ink-300 mx-1.5">·</span>
              <span className="tabular-nums">{po.contractLengthMonths}-month contract</span>
            </>
          )}
        </p>

        {/* PO "story" — segmented phase bar + a compact next-milestone
            pointer. PO-level only: per-window dates (app-listed, VIN,
            ops vs PO) now live on each Delivery Window below, so the
            header stays a one-glance PO summary without duplicating the
            same counts three times. */}
        <PoStoryBar po={po} />
        <PoNextPointer po={po} />
      </header>

      {/* View toggle. Pre-PO nodes only surface the "Pre-PO follow-up"
          tab — Internal/External Phase don't exist until a real PO
          arrives. Live POs keep the two-tab toggle and never expose
          the Pre-PO follow-up control. */}
      <div className="px-4 py-2 border-b border-ink-200 shrink-0 bg-white">
        <div role="tablist" className="inline-flex items-center bg-ink-100 rounded-md p-0.5">
          {po.isPrePo ? (
            <ToggleBtn active={view === "prepo"}    onClick={() => onChangeView("prepo")}    label="Pre-PO follow-up" />
          ) : (
            <>
              <ToggleBtn active={view === "internal"} onClick={() => onChangeView("internal")} label="Internal Phase" />
              <ToggleBtn active={view === "vin"}      onClick={() => onChangeView("vin")}      label="External Phase" />
            </>
          )}
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
              <p className={cn(
                "text-sm font-semibold",
                cancelled.length > 0 && delivered.length === 0 ? "text-flame-dark" : "text-green-dark",
              )}>
                {cancelled.length > 0 && delivered.length === 0 ? "🚫 PO cancelled" : "✅ PO delivered"}
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
        {po.isPrePo ? (
          <PrePoFollowUpView
            po={po}
            busyActionId={busyActionId}
            onChangeStatus={onChangeStatus}
          />
        ) : view === "internal" ? (
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
// "Mine" / Inbox — info box grouped by delivery window. Each row
// is one (PO × Delivery Window): Dealer + pending internal-phase
// actions + pending external-phase actions + BOTH dates (PO
// promised and Ops projected). Sorted by the nearest delivery
// date — ops date overrides PO date when set.
// ─────────────────────────────────────────────────────────────

interface InboxWindow {
  poId:           number;
  poNumber:       string;
  dealerName:     string;
  windowDate:     string;          // wave.availabilityDate (PO promised)
  /** Earliest currentProjectedDeliveryDate across the wave's batches.
   *  Null when no batch has been re-projected; falls back to windowDate. */
  opsDate:        string | null;
  /** The date used for sorting: opsDate ?? windowDate. */
  sortDate:       string;
  internalPending: ScopedActionDetail[];   // PO-scope, not settled
  externalPending: ScopedActionDetail[];   // wave + batch scope, not settled
  /**
   * The latest step the workflow has reached on this window — the
   * highest-sortOrder action across (PO + wave + batch) whose
   * status === "done". Drives the condensed row rendered when no
   * pending work remains (we still show the window so ops can see
   * where deliveries are sitting, just without the empty chip rows).
   */
  lastStep:       { label: string; completedAt: string | null } | null;
}

/** True when an action is still in flight (waiting or blocked). */
function isPending(a: ScopedActionDetail): boolean {
  return a.status === "waiting" || a.status === "blocked";
}

function MineView({
  tree,
  mutationError, cascadeFlash, onDismissFlash,
  onJumpToPo,
}: {
  tree: ActionCenterTree;
  cascadeFlash: string | null;
  onDismissFlash: () => void;
  onJumpToPo: (poId: number) => void;
} & Pick<MutationProps, "mutationError">) {
  const today = todayIso();

  // Roll up every (PO × delivery window) cohort. Each cohort gathers
  // its internal-phase (PO-scope) + external-phase (wave + batch-scope)
  // pending actions. Internal-phase work is PO-wide, so the same
  // actions repeat across every wave under the PO — that's accurate:
  // a stalled PO-wide action blocks every wave's delivery.
  const rows = useMemo<InboxWindow[]>(() => {
    const acc: InboxWindow[] = [];
    for (const d of tree.dealers) {
      for (const p of d.pos) {
        const internalPending = p.actions.filter(isPending);
        for (const w of p.waves) {
          const externalPending: ScopedActionDetail[] = [];
          // External-Phase pending comes from the BATCH-scope action rows
          // only — the same authoritative source the drawer's External
          // Phase uses ("NOT the single wave-scope set"; see WaveSection).
          // The wave-scope set is a bulk roll-up that ISN'T marked done as
          // ops completes the per-batch work, so including it surfaced a
          // stale head (e.g. "Sending Dealer Confirmation" / "Awaiting
          // VIN") on windows whose batch-scope external phase is already
          // done, and made those windows falsely count as breaching SLA.
          for (const b of w.batches) {
            for (const a of b.actions) {
              if (!isPending(a)) continue;
              // Skip the Delivery batch action — surfaced via the
              // Mark-as-delivered button, not as an inbox chore.
              if (a.actionTypeName === "Delivery") continue;
              externalPending.push(a);
            }
          }
          // Earliest ops-projected date across batches in this wave.
          const opsDates = w.batches
            .map((b) => b.currentProjectedDeliveryDate)
            .filter((s): s is string => !!s)
            .sort();
          const opsDate = opsDates.length > 0 ? opsDates[0] : null;
          const sortDate = opsDate ?? w.availabilityDate;

          // Latest step = highest-sortOrder done action across PO +
          // wave + batch scopes. Sort-order reflects workflow order,
          // so the highest done step IS the "furthest along we've
          // gotten" — what ops cares about when no work is pending.
          const allActionsOnWindow: ScopedActionDetail[] = [];
          for (const a of p.actions) allActionsOnWindow.push(a);
          for (const a of w.actions) allActionsOnWindow.push(a);
          for (const b of w.batches) for (const a of b.actions) allActionsOnWindow.push(a);
          const doneActions = allActionsOnWindow.filter((a) => a.status === "done");
          let lastStep: InboxWindow["lastStep"] = null;
          if (doneActions.length > 0) {
            // Pick the highest-sortOrder row; break ties on completedAt
            // so the visible label matches the freshest progress.
            const winner = doneActions.reduce((best, cur) => {
              if (cur.sortOrder > best.sortOrder) return cur;
              if (cur.sortOrder < best.sortOrder) return best;
              const ca = cur.completedAt ?? "";
              const cb = best.completedAt ?? "";
              return ca.localeCompare(cb) > 0 ? cur : best;
            });
            lastStep = {
              label:       winner.doneLabel || winner.waitingLabel,
              completedAt: winner.completedAt
                ? localIsoDate(winner.completedAt)
                : null,
            };
          }

          // Drop settled windows from the inbox. A window is settled when
          // it's fully closed — PO closed, wave closed, or every batch
          // delivered/cancelled. We drop it regardless of any remaining
          // "pending" actions, because the wave-scope External-Phase rows
          // are a bulk layer that ISN'T marked done when a batch delivers,
          // so a delivered window would otherwise linger in "All pending"
          // showing a stale "Awaiting VIN" head. Idle-but-OPEN windows are
          // still kept so ops sees where deliveries are sitting.
          const windowClosed =
            p.closedAt != null ||
            w.closedAt != null ||
            (w.batches.length > 0 && w.batches.every((b) => b.closedAt != null));
          if (windowClosed) continue;

          acc.push({
            poId:        p.id,
            poNumber:    p.poNumber,
            dealerName:  d.name,
            windowDate:  w.availabilityDate,
            opsDate,
            sortDate,
            internalPending,
            externalPending,
            lastStep,
          });
        }
      }
    }
    return acc;
  }, [tree]);

  // Sort by nearest delivery first (ops date wins over PO date).
  const sorted = useMemo(() => rows.slice().sort(
    (a, b) => a.sortDate.localeCompare(b.sortDate),
  ), [rows]);

  // Group windows under their PO so PO-scope Internal-Phase work shows
  // ONCE per PO (it's shared across that PO's windows) instead of
  // repeating on every window card, and each window lists only its own
  // External-Phase work. `sorted` is ascending by date, so the first
  // window seen for a PO is its earliest — the Map's insertion order
  // therefore keeps POs ordered by nearest window.
  const poGroups = useMemo(() => {
    const byPo = new Map<number, {
      poId: number; poNumber: string; dealerName: string;
      internalPending: ScopedActionDetail[]; windows: InboxWindow[];
    }>();
    for (const r of sorted) {
      let g = byPo.get(r.poId);
      if (!g) {
        g = {
          poId: r.poId, poNumber: r.poNumber, dealerName: r.dealerName,
          internalPending: r.internalPending, windows: [],
        };
        byPo.set(r.poId, g);
      }
      g.windows.push(r);
    }
    return Array.from(byPo.values());
  }, [sorted]);

  // Pending actions: internal counted once per PO, external per window.
  const totalPending = poGroups.reduce(
    (n, g) => n + g.internalPending.length
      + g.windows.reduce((m, w) => m + w.externalPending.length, 0),
    0,
  );
  const overdueWindows = sorted.filter((r) => r.sortDate < today).length;

  // ── SLA triage ────────────────────────────────────────────────────
  // A slow (30s) clock drives the SLA-based ranking, counts and filter —
  // per-second precision lives in the chips, the inbox only needs to
  // re-bucket every so often. Each PO group is tagged with the worst SLA
  // state across its pending actions, then breached POs sort to the top.
  const slaNow = useNow(30_000);
  const [slaFilter, setSlaFilter] = useState<"all" | "soon" | "overdue" | "critical">("all");

  const groupsWithSla = useMemo(
    () => poGroups.map((g) => {
      const acts = [...g.internalPending, ...g.windows.flatMap((w) => w.externalPending)];
      return { group: g, worst: worstSlaState(acts, slaNow) };
    }),
    [poGroups, slaNow],
  );

  // Counts of POs whose worst pending action is in each state.
  const slaCounts = useMemo(() => {
    let warning = 0, overdue = 0, critical = 0;
    for (const { worst } of groupsWithSla) {
      if (worst === "warning") warning++;
      else if (worst === "overdue") overdue++;
      else if (worst === "critical") critical++;
    }
    return { warning, overdue, critical };
  }, [groupsWithSla]);

  // Breached POs to the top; stable sort preserves nearest-window order
  // within the same priority bucket.
  const prioritized = useMemo(
    () => groupsWithSla.slice().sort((a, b) => slaPriority(b.worst) - slaPriority(a.worst)),
    [groupsWithSla],
  );

  const visibleGroups = useMemo(
    () => prioritized.filter(({ worst }) => {
      switch (slaFilter) {
        case "soon":     return worst === "warning";
        case "overdue":  return worst === "overdue" || worst === "critical";
        case "critical": return worst === "critical";
        default:         return true;
      }
    }),
    [prioritized, slaFilter],
  );

  return (
    <>
      <header className="px-4 py-3 border-b border-ink-200 shrink-0 bg-ink-50/50">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-xl font-bold text-midnight">📋 Inbox</h2>
          <span className="text-xs text-ink-500">
            Grouped by PO — Internal-Phase work shows once per PO; each delivery window lists its own External-Phase work. Sorted by nearest window; settled windows drop off.
          </span>
        </div>
        <p className="text-xs text-ink-600 mt-1">
          <span className="font-medium">{poGroups.length} PO{poGroups.length === 1 ? "" : "s"}</span>
          <span className="text-ink-300 mx-1.5">·</span>
          <span>{sorted.length} window{sorted.length === 1 ? "" : "s"}</span>
          <span className="text-ink-300 mx-1.5">·</span>
          <span>{totalPending} pending action{totalPending === 1 ? "" : "s"}</span>
          {overdueWindows > 0 && (
            <>
              <span className="text-ink-300 mx-1.5">·</span>
              <span className="text-flame-dark font-medium">{overdueWindows} past due</span>
            </>
          )}
          {(slaCounts.overdue + slaCounts.critical) > 0 && (
            <>
              <span className="text-ink-300 mx-1.5">·</span>
              <span className="text-flame-dark font-semibold">
                ⚠ {slaCounts.overdue + slaCounts.critical} PO{(slaCounts.overdue + slaCounts.critical) === 1 ? "" : "s"} breaching SLA
              </span>
            </>
          )}
        </p>
        {/* SLA quick-filters — narrow the inbox to POs by SLA severity.
            Each button disables itself when nothing matches; clicking the
            active filter clears back to All. */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <SlaFilterButton label="All" active={slaFilter === "all"}
            onClick={() => setSlaFilter("all")} />
          <SlaFilterButton label="Remaining soon" count={slaCounts.warning}
            tone="warning" active={slaFilter === "soon"}
            onClick={() => setSlaFilter((f) => f === "soon" ? "all" : "soon")} />
          <SlaFilterButton label="Overdue" count={slaCounts.overdue + slaCounts.critical}
            tone="overdue" active={slaFilter === "overdue"}
            onClick={() => setSlaFilter((f) => f === "overdue" ? "all" : "overdue")} />
          <SlaFilterButton label="Critical delay" count={slaCounts.critical}
            tone="critical" active={slaFilter === "critical"}
            onClick={() => setSlaFilter((f) => f === "critical" ? "all" : "critical")} />
        </div>
      </header>

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
        {poGroups.length === 0 ? (
          <p className="text-sm text-ink-500 italic px-2">
            No delivery windows yet — submit an Intake to create one.
          </p>
        ) : visibleGroups.length === 0 ? (
          <p className="text-sm text-ink-500 italic px-2">
            No POs match this filter.{" "}
            <button type="button" className="underline hover:text-ink-700"
              onClick={() => setSlaFilter("all")}>Clear filter</button>
          </p>
        ) : (
          <ul className="space-y-2">
            {visibleGroups.map(({ group: g }) => (
              <PoInboxCard
                key={g.poId}
                group={g}
                today={today}
                onJumpToPo={onJumpToPo}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}


/**
 * SLA severity quick-filter pill for the Inbox header. Disables itself
 * when its bucket is empty; the active pill takes its bucket's colour.
 */
function SlaFilterButton({
  label, count, tone, active, onClick,
}: {
  label: string;
  count?: number;
  tone?: "warning" | "overdue" | "critical";
  active: boolean;
  onClick: () => void;
}) {
  const disabled = count !== undefined && count === 0;
  const toneActive =
    tone === "critical" ? "bg-flame-dark text-white border-flame-dark" :
    tone === "overdue"  ? "bg-flame-pale text-flame-dark border-flame" :
    tone === "warning"  ? "bg-gold-pale text-gold-dark border-gold" :
    "bg-midnight text-white border-midnight";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[0.7rem] font-medium transition-colors",
        active ? toneActive : "bg-white text-ink-600 border-ink-300 hover:bg-ink-50",
        disabled && "opacity-40 cursor-not-allowed",
      )}
    >
      {label}
      {count !== undefined && (
        <span className={cn("tabular-nums", active ? "" : "text-ink-400")}>{count}</span>
      )}
    </button>
  );
}

/**
 * One PO card in the Inbox. PO-scope Internal-Phase work renders ONCE
 * at the top (it's shared across the PO's windows), then each delivery
 * window lists only its own External-Phase work below. The card flames
 * if any of its windows is overdue.
 */
function PoInboxCard({
  group, today, onJumpToPo,
}: {
  group: {
    poId: number; poNumber: string; dealerName: string;
    internalPending: ScopedActionDetail[]; windows: InboxWindow[];
  };
  today: string;
  onJumpToPo: (poId: number) => void;
}) {
  const anyOverdue = group.windows.some((w) => w.sortDate < today);
  return (
    <li className={cn(
      "rounded-md border bg-white px-3 py-2 space-y-2",
      anyOverdue ? "border-flame bg-flame-pale/20" : "border-ink-200",
    )}>
      {/* PO header — dealer + PO (click to open the drawer) + window count. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-bold text-midnight">{group.dealerName}</span>
        <span className="text-ink-300">·</span>
        <button
          type="button"
          onClick={() => onJumpToPo(group.poId)}
          className="font-mono text-[0.75rem] text-midnight underline-offset-2 hover:underline"
        >
          {group.poNumber}
        </button>
        <span className="text-[0.65rem] text-ink-500 tabular-nums">
          · {group.windows.length} window{group.windows.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Internal phase — PO-scope, shown ONCE for the whole PO (not
          repeated per window). */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[0.65rem] font-medium uppercase tracking-wide text-ink-500 w-28 shrink-0">
          Internal phase
        </span>
        {group.internalPending.length === 0 ? (
          <span className="text-[0.7rem] text-green-dark">✓ all done</span>
        ) : (
          <ReadOnlyChipList actions={group.internalPending} today={today} />
        )}
      </div>

      {/* Per-window External-Phase work. */}
      <div className="space-y-1 border-t border-ink-100 pt-1.5">
        {group.windows.map((w) => (
          <WindowExternalRow key={w.windowDate} row={w} today={today} />
        ))}
      </div>
    </li>
  );
}

/**
 * One delivery-window sub-row inside a PO card — its date stack plus
 * the head of its External-Phase queue (or, when idle, the last step
 * reached). Internal-Phase work lives once at the PO level above.
 */
function WindowExternalRow({
  row, today,
}: {
  row: InboxWindow;
  today: string;
}) {
  const isOverdueWindow = row.sortDate < today;
  const slipped = row.opsDate != null && row.opsDate !== row.windowDate;
  const hasExternal = row.externalPending.length > 0;
  return (
    <div className={cn(
      "rounded px-2 py-1.5",
      isOverdueWindow ? "bg-flame-pale/40" : "bg-ink-50/60",
    )}>
      {/* Window date line — prominent days-remaining badge, then PO
          Expected (the window date) + Ops Expected. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <WindowDaysLeftBadge targetIso={row.sortDate} today={today} />
        <span className="text-[0.72rem] font-semibold text-midnight tabular-nums" title="PO Expected Date for this delivery window">
          📅 {row.windowDate}
        </span>
        {row.opsDate ? (
          <span
            className={cn("text-[0.68rem] tabular-nums", slipped ? "text-flame-dark font-medium" : "text-green-dark")}
            title="Current Ops Expected Date — ops projection based on real signals"
          >
            ⏰ Ops {row.opsDate}
          </span>
        ) : (
          <span className="text-[0.68rem] tabular-nums text-ink-400 italic">⏰ Ops —</span>
        )}
      </div>

      {/* External head-of-queue, or the last step reached when idle. */}
      {hasExternal ? (() => {
        const sortedByOrder = row.externalPending.slice().sort(
          (a, b) => a.sortOrder - b.sortOrder,
        );
        const head = sortedByOrder[0];
        const remaining = new Set(
          sortedByOrder
            .filter((a) => a.actionTypeId !== head.actionTypeId)
            .map((a) => a.actionTypeId),
        ).size;
        return (
          <div className="mt-1 flex flex-wrap items-baseline gap-2">
            <ReadOnlyChipList actions={[head]} today={today} />
            {remaining > 0 && (
              <span className="text-[0.65rem] text-ink-500 tabular-nums">
                +{remaining} more downstream
              </span>
            )}
          </div>
        );
      })() : (
        <p className="mt-0.5 text-[0.68rem] text-ink-600">
          {row.lastStep ? (
            <>
              <span className="text-ink-500 mr-1">Current step:</span>
              <span className="text-green-dark font-medium">✓ {row.lastStep.label}</span>
              {row.lastStep.completedAt && (
                <span className="text-ink-400 ml-1 tabular-nums">({row.lastStep.completedAt})</span>
              )}
            </>
          ) : (
            <span className="text-ink-400 italic">No external work started yet.</span>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * Read-only chip list for the Inbox. Each chip is plain text — no
 * click, no buttons. Tone follows the action's status (overdue =
 * flame, blocked = flame, waiting = neutral) so ops can still scan
 * which rows need attention without giving them an actionable
 * surface from this view.
 */
function ReadOnlyChipList({
  actions, today,
}: {
  actions: ScopedActionDetail[];
  today: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 flex-1 min-w-0">
      {actions
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((a) => {
          const overdue = isOverdue(a, today);
          const tone =
            a.status === "blocked" ? "border-flame text-flame-dark bg-flame-pale/40" :
            overdue                ? "border-flame text-flame-dark bg-flame-pale/40" :
            "border-ink-300 text-ink-700 bg-white";
          const icon =
            a.status === "blocked" ? "⛔" :
            overdue                ? "⚠️" :
            "⏳";
          const label = a.waitingLabel || a.doneLabel;
          return (
            <span
              key={a.id}
              className={cn(
                "text-[0.7rem] px-2 py-0.5 rounded border inline-flex items-center gap-1",
                tone,
              )}
              title={[
                label,
                a.expectedDate ? `due ${a.expectedDate}` : null,
                a.stakeholderName ? `@${a.stakeholderName}` : null,
                a.departmentName,
              ].filter(Boolean).join(" · ")}
            >
              <span aria-hidden>{icon}</span>
              <span className="font-medium truncate max-w-[10rem]">{label}</span>
            </span>
          );
        })}
    </div>
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
/**
 * PO header strip: phase status chips + a milestone timeline.
 * Renders ONLY when there is at least one milestone date to show
 * (po date exists, or a wave gives us availability) — keeps the
 * header tidy on brand-new POs with no waves yet.
 *
 * Milestones (left → right in chronological order):
 *   📅 PO Date            from po.poDate
 *   📱 App Listing        po.appListingSummary.completedAt (when all batches listed)
 *   🔑 VIN Received       earliest "done" wave-scope action whose
 *                          action_type name matches /vin/i
 *   🚗 Op Availability    earliest wave opsExpectedDate (falls back
 *                          to availabilityDate when ops hasn't
 *                          re-projected). Operations' best estimate
 *                          of when the cohort actually lands.
 *
 * A "today" marker shows where we sit relative to those milestones.
 * Past milestones render green ✓; future ones grey ⏰.
 */
/**
 * Compose every PO state signal we already have into a small derived
 * model both story components consume. Phase order matches the
 * operational lifecycle. Each phase carries its own state machine
 * (not_started / in_progress / done / overdue / blocked) so the
 * downstream UI can colour + label uniformly.
 */
type PoPhaseState = "not_started" | "in_progress" | "done" | "overdue";

interface PoPhase {
  key:      "po_signed" | "internal" | "app_listed" | "vin_chase" | "delivery";
  label:    string;
  state:    PoPhaseState;
  /** Done / total when applicable, null when binary. */
  progress: { done: number; total: number } | null;
  /** ISO date that anchors this phase's "when" (poDate, completedAt,
   *  promisedDate, etc.) — null when the phase hasn't started. */
  date:     string | null;
}

function derivePoPhases(po: PoNode, todayStr: string): PoPhase[] {
  const counts = rollupPoCounts(po, todayStr);

  // 1. PO signed — done the moment poDate exists. We treat the
  //    absence as "in progress" only for pre_po POs that haven't
  //    converted yet; real POs always have a date.
  const poSigned: PoPhase = {
    key:   "po_signed",
    label: "PO received",
    state: po.poDate ? "done" : "in_progress",
    progress: null,
    date:  po.poDate ?? null,
  };

  // 2. Internal phase — done when every PO-scope action is settled.
  const internal: PoPhase = {
    key:   "internal",
    label: "Internal phase",
    state: counts.internal.total === 0
      ? "not_started"
      : counts.internal.done === counts.internal.total
        ? "done"
        : "in_progress",
    progress: counts.internal.total === 0
      ? null
      : { done: counts.internal.done, total: counts.internal.total },
    date:  null,
  };

  // 3. App listed — done when every batch under the PO has
  //    appListedAt; partial = "in progress"; none = "not started".
  const listing = po.appListingSummary;
  const appListed: PoPhase = {
    key:   "app_listed",
    label: "App listed",
    state: listing.total === 0
      ? "not_started"
      : listing.completedAt != null
        ? "done"
        : listing.listed > 0
          ? "in_progress"
          : "not_started",
    progress: listing.total === 0
      ? null
      : { done: listing.listed, total: listing.total },
    date:  listing.completedAt ? listing.completedAt.slice(0, 10) : null,
  };

  // 4. External phase — aggregate every wave-scope action's status.
  //    (Internally still keyed "vin_chase" because the data model
  //    keys VIN-chase actions at wave scope.) Done when all wave
  //    actions are settled, in progress if any are done OR any are
  //    blocked + the PO is post-internal-phase.
  const waveActions = po.waves.flatMap((w) => w.actions);
  const waveDone   = waveActions.filter((a) => a.status === "done" || a.status === "skipped").length;
  const waveTotal  = waveActions.length;
  const vinChase: PoPhase = {
    key:   "vin_chase",
    label: "External phase",
    state: waveTotal === 0
      ? "not_started"
      : waveDone === waveTotal
        ? "done"
        : waveDone > 0
          ? "in_progress"
          : "not_started",
    progress: waveTotal === 0
      ? null
      : { done: waveDone, total: waveTotal },
    date:  null,
  };

  // 5. Delivery — done when every batch is closed-as-delivered.
  //    Overdue when any wave's promised date is in the past and the
  //    PO isn't fully delivered yet.
  const allBatches    = po.waves.flatMap((w) => w.batches);
  const delivered     = allBatches.filter((b) => b.closedAt != null && b.closureReason === "delivered").length;
  const totalBatches  = allBatches.length;
  const isFullyDelivered = totalBatches > 0 && delivered === totalBatches;
  const overdueWindow = !isFullyDelivered && po.waves.some(
    (w) => (w.opsExpectedDate ?? w.availabilityDate) < todayStr && (w.closedAt == null),
  );
  const delivery: PoPhase = {
    key:   "delivery",
    label: "Delivery",
    state: totalBatches === 0
      ? "not_started"
      : isFullyDelivered
        ? "done"
        : overdueWindow
          ? "overdue"
          : delivered > 0
            ? "in_progress"
            : "not_started",
    progress: totalBatches === 0
      ? null
      : { done: delivered, total: totalBatches },
    date:  po.nextAvailability ?? null,
  };

  return [poSigned, internal, appListed, vinChase, delivery];
}

/**
 * Story bar — horizontal segmented phase progression. One pill per
 * phase, coloured by state. The pill currently in flight pulses; done
 * pills get a check, future pills stay neutral, overdue pills go flame.
 * Sits above the existing chip strip so ops sees the macro picture
 * before drilling into the detail.
 */
function PoStoryBar({ po }: { po: PoNode }) {
  const today  = todayIso();
  const phases = derivePoPhases(po, today);
  if (phases.length === 0) return null;

  // First in-progress phase (left-to-right) is "current" — the one we
  // pulse. Falls back to the last phase when everything is done.
  const currentIdx = (() => {
    const inProg = phases.findIndex((p) => p.state === "in_progress" || p.state === "overdue");
    if (inProg !== -1) return inProg;
    return phases.length - 1;
  })();

  return (
    <ol className="flex flex-wrap items-stretch gap-1 text-[0.65rem]">
      {phases.map((p, i) => {
        const isCurrent = i === currentIdx;
        const cls =
          p.state === "done"        ? "border-green text-green-dark bg-green-pale/60" :
          p.state === "overdue"     ? "border-flame text-flame-dark bg-flame-pale/60" :
          p.state === "in_progress" ? "border-brand text-brand-dark bg-brand-pastel/60" :
                                       "border-ink-200 text-ink-500 bg-white";
        return (
          <li key={p.key} className="flex items-center gap-1">
            <span
              className={cn(
                "inline-flex items-center gap-1 border rounded-md px-2 py-1 font-medium",
                cls,
                isCurrent && p.state !== "done" && "ring-2 ring-brand/30",
              )}
              title={p.date ? `${p.label} · ${p.date}` : p.label}
            >
              <span aria-hidden>
                {p.state === "done"
                  ? "✓"
                  : p.state === "overdue"
                    ? "⚠"
                    : p.state === "in_progress"
                      ? "●"
                      : "○"}
              </span>
              <span>{p.label}</span>
              {p.progress && (
                <span className="tabular-nums opacity-80">
                  {p.progress.done}/{p.progress.total}
                </span>
              )}
              {/* Milestone date inline on the pill (e.g. PO signed,
                  App listed, Delivery). Replaces the separate date-chip
                  strip removed in the header dedupe. */}
              {p.date && (
                <span className="tabular-nums font-normal opacity-70">{p.date}</span>
              )}
            </span>
            {i < phases.length - 1 && (
              <span aria-hidden className="text-ink-300">→</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Compact "next milestone" pointer rendered beneath the phase bar —
 * the leftmost phase that isn't done yet. Replaces the old story
 * sentence + milestone-chip strip, both of which duplicated the
 * counts the phase bar already shows. PO-level only; per-window dates
 * now live on each Delivery Window.
 */
function PoNextPointer({ po }: { po: PoNode }) {
  const today = todayIso();
  const phases = derivePoPhases(po, today);
  const next = phases.find((p) => p.state !== "done");
  if (!next) {
    return (
      <p className="text-[0.7rem] font-medium text-green-dark">✓ All phases complete</p>
    );
  }
  const overdue = next.state === "overdue";
  return (
    <p className="text-[0.7rem] text-ink-500">
      <span aria-hidden>→</span>{" "}
      <span className={cn("font-medium", overdue ? "text-flame-dark" : "text-brand-dark")}>
        Next: {next.label}
      </span>
    </p>
  );
}

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
    // Synthetic rows never have an SLA clock — always exempt.
    slaStartedAt:     null,
    slaHours:         null,
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

  // App-listing target signal — the earliest wave-level Ops expected
  // date across this PO's delivery windows. Once any wave has had
  // its Ops Expected Date set, Internal Phase reads that date as
  // the "list cars in the app by" target. Falls back to the PO
  // availability date when no wave has been ops-projected yet, so
  // the team always sees a target.
  const appListingTarget = (() => {
    const opsDates = po.waves
      .map((w) => w.opsExpectedDate)
      .filter((d): d is string => !!d && d !== "");
    if (opsDates.length > 0) {
      return { date: opsDates.sort()[0], source: "ops" as const };
    }
    const promised = po.waves
      .map((w) => w.availabilityDate)
      .sort()
      .at(0) ?? null;
    return promised ? { date: promised, source: "po" as const } : null;
  })();

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
    <div className="space-y-3">
      {/* App-listing target banner. The signal from the wave-level
          Ops Expected Date: Internal Phase knows when ops needs the
          cars listed in the app by. */}
      {appListingTarget && (
        <div className={cn(
          "border rounded-md px-3 py-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[0.7rem]",
          appListingTarget.source === "ops"
            ? "border-brand/40 bg-brand-pastel/30"
            : "border-ink-200 bg-ink-50",
        )}>
          <span className={cn(
            "font-medium",
            appListingTarget.source === "ops" ? "text-brand-dark" : "text-ink-600",
          )}>
            📱 App listing target
          </span>
          <span className="tabular-nums text-midnight font-medium">
            {appListingTarget.date}
          </span>
          <span className="text-[0.65rem] text-ink-500 italic">
            {appListingTarget.source === "ops"
              ? "from the earliest Ops-expected delivery date across this PO's windows"
              : "from PO availability — set an Ops expected date on any window to override"}
          </span>
        </div>
      )}
      <ThreeColumnActionBoard
        title="Internal phase"
        subtitle="Specs · Pricing · SKU — runs in parallel"
        actions={allActions}
        busyActionId={busyActionId}
        onChangeStatus={onChangeStatus}
        poForAppListing={po}
      />
    </div>
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

/**
 * Pre-PO follow-up view — drawer body shown when the selected node is
 * a virtual Pre-PO entry (Forecast commitment with no real PO yet).
 *
 * Layout:
 *   - Identity card: dealer + city + qty + dates + submitter
 *   - Pre-PO action chips (typically just "Pre-PO App Listing", but
 *     ops can add more action_types whose scope='batch' apply here)
 *   - Big "Link this Pre-PO to a new PO" CTA that deep-links to
 *     /intake?linkForecast={prePoBatchId}. When the real PO PDF
 *     arrives ops drops it on Intake and the same batch flips to
 *     post_po — accuracy metrics survive.
 */
function PrePoFollowUpView({
  po, busyActionId, onChangeStatus,
}: { po: PoNode }
  & Pick<MutationProps, "busyActionId" | "onChangeStatus">
) {
  const summary = po.prePoSummary;
  const actions = po.actions;
  return (
    <div className="space-y-4">
      {/* Identity card — replaces the standard PO meta strip because
          a Pre-PO has no PO number / signing date / contract terms. */}
      <section className="border border-gold/40 rounded-md bg-gold-pale/20 p-3 space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="inline-block text-[0.6rem] font-bold uppercase tracking-wide bg-gold text-white rounded-full px-2 py-0.5">
            🔮 Pre-PO
          </span>
          <span className="text-sm font-semibold text-midnight">
            Partnership commitment · {po.totalCars} car{po.totalCars === 1 ? "" : "s"}
          </span>
        </div>
        {summary && (
          <div className="text-[0.7rem] text-ink-600 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span>📍 <span className="text-midnight">{summary.city}</span></span>
            <span className="tabular-nums">
              🚚 Expected delivery <span className="text-midnight">{summary.expectedDeliveryDate}</span>
            </span>
            {summary.expectedPoSigningDate && (
              <span className="tabular-nums">
                📝 Expected PO signing <span className="text-midnight">{summary.expectedPoSigningDate}</span>
              </span>
            )}
            <span className="tabular-nums">
              📅 Submitted <span className="text-midnight">{summary.submittedAt}</span>
            </span>
            {summary.submittedByName && (
              <span>by <span className="text-brand-dark">@{summary.submittedByName}</span></span>
            )}
          </div>
        )}
      </section>

      {/* Pre-PO action chips. Same chip styling as External Phase so
          the interaction model carries over (click flips status, 📅
          opens the backdate form on done chips). */}
      <section className="space-y-2">
        <p className="text-[0.7rem] font-medium uppercase tracking-wide text-ink-500">
          Pre-PO actions
        </p>
        {actions.length === 0 ? (
          <p className="text-[0.75rem] text-ink-500 italic">
            No actions configured for this Pre-PO yet.
          </p>
        ) : (
          <div className="grid gap-1.5 grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
            {actions
              .slice()
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((a) => (
                <ActionChip
                  key={a.id}
                  action={a}
                  busy={busyActionId === a.id}
                  onChangeStatus={onChangeStatus}
                />
              ))}
          </div>
        )}
      </section>

      {/* Per-row listing + bookings — the Forecast exception flow.
          Each row shows city × model × qty × listing date and a +/-
          control for the running booking counter. Hidden when the
          batch has no legs (legacy pre-migration forecasts). */}
      {summary && summary.legs.length > 0 && (
        <PrePoLegsSection legs={summary.legs} />
      )}

      {/* Link-to-Intake CTA. When the real PO arrives, ops drops the
          PDF here — the Intake page reads the query string and
          pre-binds the new PO to this Pre-PO so all the partnership
          metadata + actions carry forward. */}
      {po.prePoBatchId != null && (
        <section className="border-2 border-dashed border-brand rounded-md bg-brand-pastel/20 p-4 text-center space-y-2">
          <p className="text-sm font-semibold text-brand-dark">
            ↪ Link to a real PO
          </p>
          <p className="text-[0.7rem] text-ink-600 max-w-md mx-auto">
            Drop the real PO PDF on Intake to convert this Pre-PO into a
            full PO. The same record flips from <code>pre_po</code> to{" "}
            <code>post_po</code> and Internal / External Phase actions
            become available.
          </p>
          <Link
            href={`/intake?linkForecast=${po.prePoBatchId}`}
            className="btn btn-primary inline-flex"
          >
            🧾 Open Intake with this Pre-PO linked
          </Link>
        </section>
      )}
    </div>
  );
}

/**
 * Per-row pre-PO listing section — only renders inside PrePoFollowUpView
 * when the parent batch has `batch_delivery_legs` rows populated with
 * the Forecast pre-PO extension columns (carModel, listedAt,
 * promisedAvailabilityDate, bookingsCount).
 *
 * The booking counter is the single editable surface — +/- bumps the
 * count by 1, "Set…" prompts for an absolute value when ops gets a
 * batched import from the customer-facing app. Busy state is local
 * per-row so quick consecutive +1s don't all spin together.
 */
function PrePoLegsSection({
  legs,
}: {
  legs: NonNullable<PoNode["prePoSummary"]>["legs"];
}) {
  const router = useRouter();
  const shell = useShell();
  const [busyLegId, setBusyLegId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function bumpBookings(legId: number, delta: number) {
    setBusyLegId(legId);
    setError(null);
    try {
      const res = await fetch("/api/forecast/update-bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ legId, delta }),
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyLegId(null);
    }
  }

  async function setBookings(legId: number, qty: number) {
    const input = await shell.prompt({
      title: "Set booking count",
      description: `Enter the new total customer-booking count for this row. Capped at the row's quantity.`,
      inputLabel: `Booking count (0 – ${qty})`,
      inputType: "number",
      required: true,
      validate: (val) => {
        const v = Number(val);
        if (!Number.isFinite(v) || !Number.isInteger(v))
          return "Enter a whole number.";
        if (v < 0 || v > qty) return `Must be between 0 and ${qty}.`;
        return null;
      },
      confirmLabel: "Save",
    });
    if (input == null) return;
    const v = Number(input);
    setBusyLegId(legId);
    setError(null);
    try {
      const res = await fetch("/api/forecast/update-bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ legId, value: Math.round(v) }),
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyLegId(null);
    }
  }

  const totalBookings = legs.reduce((s, l) => s + l.bookingsCount, 0);
  const totalQty      = legs.reduce((s, l) => s + l.quantity, 0);

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <p className="text-[0.7rem] font-medium uppercase tracking-wide text-ink-500">
          Pre-PO listed rows · {legs.length}
        </p>
        <p className="text-[0.7rem] text-ink-600 tabular-nums">
          Bookings <span className="text-midnight font-semibold">{totalBookings}</span>
          <span className="text-ink-400 mx-0.5">/</span>
          {totalQty} cars
        </p>
      </div>
      <div className="border border-ink-200 rounded-md overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-ink-50 text-[0.65rem] text-ink-500 uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-1.5">City</th>
              <th className="text-left px-3 py-1.5">Model</th>
              <th className="text-right px-3 py-1.5">Qty</th>
              <th className="text-left px-3 py-1.5">Listed</th>
              <th className="text-left px-3 py-1.5">Avail.</th>
              <th className="text-right px-3 py-1.5">Bookings</th>
              <th className="text-right px-3 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {legs.map((leg) => {
              const busy = busyLegId === leg.legId;
              const atCap = leg.bookingsCount >= leg.quantity;
              return (
                <tr key={leg.legId} className="border-t border-ink-200/60">
                  <td className="px-3 py-1.5 text-midnight">{leg.city}</td>
                  <td className="px-3 py-1.5 text-midnight">
                    {leg.carModel ?? <span className="text-ink-400">—</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{leg.quantity}</td>
                  <td className="px-3 py-1.5 tabular-nums text-ink-600">
                    {leg.listedAt ?? <span className="text-ink-400">—</span>}
                  </td>
                  <td className="px-3 py-1.5 tabular-nums text-ink-600">
                    {leg.promisedAvailabilityDate ?? <span className="text-ink-400">—</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    <span className={cn(
                      "font-semibold",
                      leg.bookingsCount === 0 ? "text-ink-400"
                        : atCap ? "text-flame-dark"
                        : "text-gold-dark",
                    )}>
                      {leg.bookingsCount}
                    </span>
                    <span className="text-ink-300 ml-0.5">/ {leg.quantity}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => bumpBookings(leg.legId, -1)}
                      disabled={busy || leg.bookingsCount === 0}
                      title="Decrement bookings"
                      className="text-[0.7rem] px-1.5 py-0.5 rounded border border-ink-300 text-ink-700 hover:bg-ink-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      −
                    </button>
                    <button
                      type="button"
                      onClick={() => bumpBookings(leg.legId, +1)}
                      disabled={busy || atCap}
                      title={atCap ? "At capacity — can't book more than listed qty" : "Add one booking"}
                      className="text-[0.7rem] px-1.5 py-0.5 rounded border border-brand text-brand-dark hover:bg-brand-pastel/40 disabled:opacity-40 disabled:cursor-not-allowed ml-1"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      onClick={() => setBookings(leg.legId, leg.quantity)}
                      disabled={busy}
                      title="Set the booking count to a specific value"
                      className="text-[0.7rem] px-1.5 py-0.5 rounded border border-ink-300 text-ink-700 hover:bg-ink-50 disabled:opacity-40 disabled:cursor-not-allowed ml-1"
                    >
                      Set…
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {error && (
        <p role="alert" className="text-[0.7rem] text-flame-dark">
          {error}
        </p>
      )}
      <p className="text-[0.65rem] text-ink-500 leading-snug">
        Bookings are pre-PO only. Once the Forecast is linked to a signed PO,
        these counts become read-only and the post-PO booking flow takes over.
      </p>
    </section>
  );
}

/**
 * "Promised vs working" delivery-plan panel (frozen baseline). Read-only
 * for everyone; admins also get a Redistribute mode to move cars between
 * windows (and add new ones). The baseline is never edited — reliability
 * is always scored against it. Self-hides until the baseline is frozen.
 */
type DraftWindow = { windowDate: string; quantity: number; isNew: boolean };

/** Model key = the same join the data layer uses for BatchNode.modelYear. */
const modelKey = (model: string, year: number) => [model, year].filter(Boolean).join(" ");

/**
 * Read-only per-window delivery plan + baseline reliability, shown when the
 * per-model baseline hasn't been migrated yet. No redistribution — that
 * needs the per-model baseline (run the migration to enable it).
 */
function DeliveryPlanReadonlyFallback({ po }: { po: PoNode }) {
  const workingByDate = new Map<string, number>();
  for (const w of po.waves) {
    const qty = w.batches.reduce((s, b) => s + b.requestedQuantity, 0);
    workingByDate.set(w.availabilityDate, (workingByDate.get(w.availabilityDate) ?? 0) + qty);
  }
  const baselineByDate = new Map<string, number>();
  for (const b of po.baseline) baselineByDate.set(b.windowDate, b.quantity);
  const dates = Array.from(new Set([...baselineByDate.keys(), ...workingByDate.keys()])).sort();
  const baseTotal = po.baseline.reduce((s, b) => s + b.quantity, 0);
  const workTotal = Array.from(workingByDate.values()).reduce((s, n) => s + n, 0);
  const deliveries = po.waves.flatMap((w) =>
    w.batches.filter((b) => b.closureReason === "delivered" && b.closedAt)
      .map((b) => ({ date: b.closedAt!.slice(0, 10), quantity: b.deliveredQuantity ?? 0 })));
  const rel = computeBaselineReliability(po.baseline, deliveries, todayIso());
  const relTone = rel.onTimeRate == null ? "text-ink-400"
    : rel.onTimeRate >= 90 ? "text-green-dark" : rel.onTimeRate >= 70 ? "text-gold-dark" : "text-flame-dark";
  return (
    <section className="border border-ink-200 rounded-md bg-ink-50/40 p-3 space-y-2">
      <h4 className="text-[0.7rem] font-semibold uppercase tracking-wide text-ink-600">🚚 Delivery plan — promised vs working</h4>
      <div className="flex flex-wrap items-baseline gap-x-2 pb-1.5 border-b border-ink-200">
        <span className="text-[0.6rem] font-medium uppercase tracking-wide text-ink-500">📊 Baseline reliability</span>
        <span className={cn("text-sm font-bold tabular-nums", relTone)}>{rel.onTimeRate == null ? "—" : `${rel.onTimeRate}%`}</span>
        <span className="text-[0.65rem] text-ink-500 tabular-nums">{rel.onTime}/{rel.promisedTotal} cars on time</span>
      </div>
      <table className="w-full text-[0.7rem] tabular-nums">
        <thead><tr className="text-ink-500 text-left">
          <th className="font-medium py-0.5">Window</th>
          <th className="font-medium py-0.5 text-right">Promised</th>
          <th className="font-medium py-0.5 text-right">Working</th>
        </tr></thead>
        <tbody>
          {dates.map((d) => (
            <tr key={d} className="border-t border-ink-100">
              <td className="py-0.5 text-midnight">{d}</td>
              <td className="py-0.5 text-right text-ink-600">{baselineByDate.get(d) || "—"}</td>
              <td className="py-0.5 text-right font-medium text-midnight">{workingByDate.get(d) || "—"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr className="border-t border-ink-200 font-semibold text-midnight">
          <td className="py-0.5">Total</td>
          <td className="py-0.5 text-right">{baseTotal}</td>
          <td className="py-0.5 text-right">{workTotal}</td>
        </tr></tfoot>
      </table>
      <p className="text-[0.6rem] text-ink-400 leading-snug">
        Run <strong>Settings → Maintenance → &quot;PO baseline (per-model)&quot;</strong> to enable per-model redistribution.
      </p>
    </section>
  );
}

function DeliveryPlanPanel({ po }: { po: PoNode }) {
  const { isAdmin } = useShell();
  const router = useRouter();
  const [selModel, setSelModel] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftWindow[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Distinct models from the per-model baseline.
  const models = useMemo(() => {
    const m = new Map<string, { key: string; model: string; year: number; total: number }>();
    for (const b of po.baselineModel) {
      const key = modelKey(b.model, b.year);
      const e = m.get(key) ?? { key, model: b.model, year: b.year, total: 0 };
      e.total += b.quantity;
      m.set(key, e);
    }
    return Array.from(m.values()).sort((a, b) => a.key.localeCompare(b.key));
  }, [po.baselineModel]);

  // No per-model baseline yet → graceful read-only per-window fallback.
  if (po.baselineModel.length === 0) {
    if (po.baseline.length === 0) return null;
    return <DeliveryPlanReadonlyFallback po={po} />;
  }

  const activeKey = (selModel && models.some((m) => m.key === selModel)) ? selModel : (models[0]?.key ?? "");
  const active = models.find((m) => m.key === activeKey);
  if (!active) return null;

  // Per-active-model: baseline (frozen) / working (current) / delivered.
  const baselineByDate = new Map<string, number>();
  for (const b of po.baselineModel) {
    if (modelKey(b.model, b.year) !== activeKey) continue;
    baselineByDate.set(b.windowDate, (baselineByDate.get(b.windowDate) ?? 0) + b.quantity);
  }
  const workingByDate = new Map<string, number>();
  const deliveredByWindow = new Map<string, number>();
  const deliveries: { date: string; quantity: number }[] = [];
  for (const w of po.waves) {
    let work = 0, del = 0;
    for (const b of w.batches) {
      if (b.modelYear !== activeKey) continue;
      work += b.requestedQuantity;
      if (b.closureReason === "delivered") {
        del += b.deliveredQuantity ?? 0;
        if (b.closedAt) deliveries.push({ date: b.closedAt.slice(0, 10), quantity: b.deliveredQuantity ?? 0 });
      }
    }
    if (work > 0) workingByDate.set(w.availabilityDate, work);
    if (del > 0) deliveredByWindow.set(w.availabilityDate, del);
  }

  const dates = Array.from(new Set([...baselineByDate.keys(), ...workingByDate.keys()])).sort();
  const baseTotal = active.total;
  const workTotal = Array.from(workingByDate.values()).reduce((s, n) => s + n, 0);
  const deliveredTotal = Array.from(deliveredByWindow.values()).reduce((s, n) => s + n, 0);
  const changed = dates.some((d) => (baselineByDate.get(d) ?? 0) !== (workingByDate.get(d) ?? 0));

  const rel = computeBaselineReliability(
    Array.from(baselineByDate, ([windowDate, quantity]) => ({ windowDate, quantity })),
    deliveries, todayIso());
  const relTone =
    rel.onTimeRate == null ? "text-ink-400"
    : rel.onTimeRate >= 90 ? "text-green-dark"
    : rel.onTimeRate >= 70 ? "text-gold-dark"
    : "text-flame-dark";

  function selectModel(key: string) {
    setSelModel(key);
    setEditing(false);
    setError(null);
  }
  function startEdit() {
    setDraft(dates
      .filter((d) => (workingByDate.get(d) ?? 0) > 0 || baselineByDate.has(d))
      .map((d) => ({ windowDate: d, quantity: workingByDate.get(d) ?? 0, isNew: false })));
    setReason("");
    setError(null);
    setEditing(true);
  }
  function patch(i: number, p: Partial<DraftWindow>) {
    setDraft((cur) => cur.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
    setError(null);
  }
  const draftTotal = draft.reduce((s, r) => s + (Number.isFinite(r.quantity) ? r.quantity : 0), 0);
  const balanced = draftTotal === baseTotal;

  async function save() {
    if (!active) return;
    if (!reason.trim()) { setError("Add a reason for the redistribution."); return; }
    if (!balanced) { setError(`${active.key} must total ${baseTotal} (currently ${draftTotal}).`); return; }
    for (const r of draft) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.windowDate)) { setError("Every window needs a date."); return; }
      if (!Number.isInteger(r.quantity) || r.quantity < 1) { setError(`"${r.windowDate}" needs a whole number ≥ 1.`); return; }
    }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/po-redistribute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          poId: po.id,
          model: active.model,
          year: active.year,
          reason: reason.trim(),
          allocation: draft.map((r) => ({ windowDate: r.windowDate, quantity: r.quantity })),
        }),
      });
      if (!res.ok) {
        const t = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(t.error || `Redistribute failed (${res.status})`);
      }
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border border-ink-200 rounded-md bg-ink-50/40 p-3 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-[0.7rem] font-semibold uppercase tracking-wide text-ink-600">
          🚚 Delivery plan — promised vs working
        </h4>
        <div className="flex items-center gap-2">
          <span className={cn("text-[0.65rem] font-medium", changed ? "text-gold-dark" : "text-green-dark")}>
            {changed ? "↪ redistributed" : "✓ matches the promise"}
          </span>
          {isAdmin && !editing && (
            <button type="button" onClick={startEdit} className="text-[0.65rem] px-2 py-0.5 rounded border border-brand text-brand-dark hover:bg-brand-pastel">
              ↪ Redistribute
            </button>
          )}
        </div>
      </div>

      {/* Model selector — one model redistributed at a time. */}
      {models.length > 1 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[0.6rem] text-ink-500">Model:</span>
          {models.map((m) => (
            <button key={m.key} type="button" onClick={() => selectModel(m.key)}
              className={cn(
                "text-[0.65rem] px-2 py-0.5 rounded-full border tabular-nums",
                m.key === activeKey ? "bg-midnight text-white border-midnight" : "bg-white text-ink-600 border-ink-300 hover:bg-ink-50",
              )}>
              {m.key} <span className="opacity-70">({m.total})</span>
            </button>
          ))}
        </div>
      )}

      {!editing ? (
        <>
          {/* Baseline reliability headline — actual vs the frozen promise. */}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 pb-1.5 border-b border-ink-200">
            <span className="text-[0.6rem] font-medium uppercase tracking-wide text-ink-500">📊 Baseline reliability</span>
            <span className={cn("text-sm font-bold tabular-nums", relTone)}>
              {rel.onTimeRate == null ? "—" : `${rel.onTimeRate}%`}
            </span>
            <span className="text-[0.65rem] text-ink-500 tabular-nums">
              {rel.onTime}/{rel.promisedTotal} cars on time
              {rel.deliveredTotal < rel.promisedTotal && ` · ${rel.deliveredTotal}/${rel.promisedTotal} delivered`}
              {rel.shortfallToDate > 0 && (
                <span className="text-flame-dark font-medium"> · {rel.shortfallToDate} short of promise</span>
              )}
            </span>
          </div>
          <table className="w-full text-[0.7rem] tabular-nums">
            <thead>
              <tr className="text-ink-500 text-left">
                <th className="font-medium py-0.5">Window</th>
                <th className="font-medium py-0.5 text-right">Promised</th>
                <th className="font-medium py-0.5 text-right">Working</th>
                <th className="font-medium py-0.5 text-right">Del.</th>
                <th className="font-medium py-0.5 text-right">Δ</th>
              </tr>
            </thead>
            <tbody>
              {dates.map((d) => {
                const promised = baselineByDate.get(d) ?? 0;
                const working = workingByDate.get(d) ?? 0;
                const delta = working - promised;
                const isNew = !baselineByDate.has(d);
                return (
                  <tr key={d} className="border-t border-ink-100">
                    <td className="py-0.5 text-midnight">{d}{isNew && <span className="ml-1 text-[0.6rem] text-brand-dark">new</span>}</td>
                    <td className="py-0.5 text-right text-ink-600">{promised || "—"}</td>
                    <td className="py-0.5 text-right font-medium text-midnight">{working || "—"}</td>
                    <td className="py-0.5 text-right text-green-dark">{deliveredByWindow.get(d) || "—"}</td>
                    <td className={cn("py-0.5 text-right font-medium", delta > 0 ? "text-green-dark" : delta < 0 ? "text-flame-dark" : "text-ink-400")}>
                      {delta === 0 ? "0" : delta > 0 ? `+${delta}` : `${delta}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-ink-200 font-semibold text-midnight">
                <td className="py-0.5">Total</td>
                <td className="py-0.5 text-right">{baseTotal}</td>
                <td className="py-0.5 text-right">{workTotal}</td>
                <td className="py-0.5 text-right text-green-dark">{deliveredTotal || "—"}</td>
                <td className={cn("py-0.5 text-right", workTotal === baseTotal ? "text-ink-400" : "text-flame-dark")}>
                  {workTotal === baseTotal ? "0" : workTotal - baseTotal}
                </td>
              </tr>
            </tfoot>
          </table>
          <p className="text-[0.6rem] text-ink-400 leading-snug">
            <strong>Promised</strong> = the frozen plan from PO upload (the reliability baseline).{" "}
            <strong>Working</strong> = current windows. Reliability is always scored against Promised,
            so moving cars never hides a missed commitment.
          </p>
        </>
      ) : (
        <div className="space-y-2">
          <p className="text-[0.6rem] text-ink-500">
            Move cars between windows (or add a window). The total must stay {baseTotal} — the baseline never changes.
          </p>
          <div className="space-y-1">
            {draft.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_5rem_auto] items-center gap-2">
                {r.isNew ? (
                  <input type="date" value={r.windowDate} aria-label="New window date"
                    onChange={(e) => patch(i, { windowDate: e.target.value })}
                    className="text-[0.7rem] px-2 py-1 border border-ink-300 rounded tabular-nums" />
                ) : (
                  <span className="text-[0.7rem] text-midnight tabular-nums">{r.windowDate}</span>
                )}
                <input type="number" min={1} value={Number.isFinite(r.quantity) ? r.quantity : ""}
                  aria-label={`Cars for ${r.windowDate}`}
                  onChange={(e) => patch(i, { quantity: parseInt(e.target.value, 10) })}
                  className="text-[0.7rem] px-2 py-1 border border-ink-300 rounded tabular-nums text-right" />
                {r.isNew ? (
                  <button type="button" onClick={() => setDraft((c) => c.filter((_, idx) => idx !== i))}
                    className="text-[0.65rem] text-flame-dark px-1">✕</button>
                ) : <span />}
              </div>
            ))}
          </div>
          <button type="button"
            onClick={() => setDraft((c) => [...c, { windowDate: "", quantity: 0, isNew: true }])}
            className="text-[0.65rem] px-2 py-0.5 rounded border border-ink-300 text-ink-600 hover:bg-ink-50">
            + Add window
          </button>
          <div className="flex items-center justify-between gap-2 pt-1 border-t border-ink-200">
            <span className={cn("text-[0.7rem] font-semibold tabular-nums", balanced ? "text-green-dark" : "text-flame-dark")}>
              Total {draftTotal} / {baseTotal} {balanced ? "✓" : "✗"}
            </span>
          </div>
          <input type="text" value={reason} placeholder="Reason (e.g. dealer can't supply 5 cars on the 1st)"
            onChange={(e) => { setReason(e.target.value); setError(null); }}
            className="w-full text-[0.7rem] px-2 py-1 border border-ink-300 rounded" />
          {error && <p className="text-[0.65rem] text-flame-dark">{error}</p>}
          <div className="flex justify-end gap-1.5">
            <button type="button" onClick={() => setEditing(false)} disabled={busy}
              className="text-[0.7rem] px-2 py-0.5 rounded border border-ink-300 text-ink-600 hover:bg-ink-50">Cancel</button>
            <button type="button" onClick={save} disabled={busy || !balanced || !reason.trim()}
              className="text-[0.7rem] px-2 py-0.5 rounded border border-brand bg-brand text-white disabled:opacity-50 hover:bg-brand-dark">
              {busy ? "…" : "Save redistribution"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

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
      <DeliveryPlanPanel po={po} />
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
      {/* End-to-end retrospective — only renders once the PO is closed. */}
      <ClosedPoRetrospective po={po} />
      {/* Who moved this PO + how on-time — closed POs only. */}
      <PoPhasePerformance po={po} />
    </div>
  );
}

/**
 * Closed-PO end-to-end retrospective — a compact, Insights-style recap
 * rendered under the delivery windows once the PO is closed. Pulls from
 * the batch data already on the node (no extra fetch): the reliability
 * composite, end-to-end span, on-time vs the locked PO Expected baseline,
 * the PO→App-listed lag, delivered cars, and the date-slip / customer-
 * days impact rolled up from each batch's shift history.
 */
function ClosedPoRetrospective({ po }: { po: PoNode }) {
  if (!po.closedAt) return null;
  const allBatches = po.waves.flatMap((w) => w.batches);
  if (allBatches.length === 0) return null;

  const dayDiff = (a: string, b: string) =>
    Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);

  const delivered = allBatches.filter((b) => b.closureReason === "delivered");
  const cancelled = allBatches.filter((b) => b.closureReason === "cancelled");
  const requestedCars = allBatches.reduce((s, b) => s + b.requestedQuantity, 0);
  const deliveredCars = allBatches.reduce((s, b) => s + (b.deliveredQuantity ?? 0), 0);

  const e2eDays = po.poDate ? dayDiff(po.closedAt, po.poDate) : null;

  // Worst lateness across delivered batches vs the locked baseline
  // (PO Expected @ lock, falling back to the dealer-promised date).
  let worstLate: number | null = null;
  for (const b of delivered) {
    if (!b.closedAt) continue;
    const baseline = b.poExpectedDateAtLock ?? b.promisedDate;
    if (!baseline) continue;
    const late = dayDiff(b.closedAt, baseline);
    worstLate = worstLate == null ? late : Math.max(worstLate, late);
  }

  const listedLag = po.appListingSummary.completedAt && po.poDate
    ? dayDiff(localIsoDate(po.appListingSummary.completedAt), po.poDate)
    : null;

  let shiftCount = 0;
  let custDaysLost = 0;
  for (const b of allBatches) {
    for (const s of b.shiftHistory) {
      shiftCount++;
      if (s.delayDays > 0) custDaysLost += (s.bookingsAtShift ?? 0) * s.delayDays;
    }
  }

  const reliability = po.reliabilityScore;

  return (
    <section className="border-2 border-ink-700 rounded-md bg-white overflow-hidden">
      <div className="px-3 py-2 border-b border-ink-200 bg-ink-50/50 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-bold text-midnight">📊 End-to-end retrospective</span>
        <span className="text-[0.7rem] text-ink-500">how this PO actually played out</span>
        {reliability != null && (
          <span
            className={cn(
              "ml-auto text-[0.7rem] font-bold tabular-nums px-2 py-0.5 rounded-full border",
              reliability >= 80 ? "border-green text-green-dark bg-green-pale"
                : reliability >= 50 ? "border-gold text-gold-dark bg-gold-pale"
                : "border-flame text-flame-dark bg-flame-pale",
            )}
            title="PO reliability composite (same metric as the Insights → PO Reliability tab)"
          >
            🎯 {Math.round(reliability)}% reliable
          </span>
        )}
      </div>

      <div className="p-3 grid gap-2 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        <RetroStat label="End-to-end" value={e2eDays != null ? `${e2eDays}d` : "—"}
                   hint="PO received → delivered" />
        <RetroStat
          label="On-time"
          value={worstLate == null ? "—" : worstLate <= 0 ? "On time" : `${worstLate}d late`}
          tone={worstLate == null ? "neutral" : worstLate <= 0 ? "good" : "bad"}
          hint="actual vs PO Expected @ lock"
        />
        <RetroStat label="Delivered" value={`${deliveredCars}/${requestedCars}`}
                   tone={deliveredCars >= requestedCars ? "good" : "neutral"}
                   hint={cancelled.length > 0 ? `${cancelled.length} batch${cancelled.length === 1 ? "" : "es"} cancelled` : "cars"} />
        <RetroStat label="PO → Listed" value={listedLag != null ? `${listedLag}d` : "—"}
                   hint="signing → in-app" />
        <RetroStat label="Date slips" value={`${shiftCount}`}
                   tone={shiftCount === 0 ? "good" : "neutral"}
                   hint={shiftCount === 1 ? "revision" : "revisions"} />
        <RetroStat label="Cust-days lost" value={`${custDaysLost}`}
                   tone={custDaysLost === 0 ? "good" : "bad"}
                   hint="Σ bookings × slip days" />
      </div>

      {/* Plan-vs-reality milestone line. */}
      <div className="px-3 pb-3 -mt-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.7rem] text-ink-600">
          {po.poDate && (<span className="tabular-nums">🖊 Received {po.poDate}</span>)}
          {po.appListingSummary.completedAt && (
            <>
              <span className="text-ink-300">→</span>
              <span className="tabular-nums">📱 Listed {localIsoDate(po.appListingSummary.completedAt)}</span>
            </>
          )}
          <span className="text-ink-300">→</span>
          {cancelled.length > 0 && delivered.length === 0 ? (
            <span className="tabular-nums text-flame-dark font-medium">🚫 Cancelled {po.closedAt}</span>
          ) : (
            <span className="tabular-nums text-green-dark font-medium">✓ Delivered {po.closedAt}</span>
          )}
        </div>
      </div>
    </section>
  );
}

function RetroStat({
  label, value, hint, tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "good" | "bad";
}) {
  const valueCls =
    tone === "good" ? "text-green-dark" :
    tone === "bad"  ? "text-flame-dark" :
    "text-midnight";
  return (
    <div className="rounded-md border border-ink-200 bg-ink-50/40 px-2.5 py-1.5">
      <p className="text-[0.6rem] font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p className={cn("text-base font-bold tabular-nums leading-tight", valueCls)}>{value}</p>
      {hint && <p className="text-[0.6rem] text-ink-400 leading-tight mt-0.5">{hint}</p>}
    </div>
  );
}

type PerfAgg = { name: string; done: number; onTime: number; late: number };

/**
 * Aggregate completed actions into PerfAgg rows keyed by department,
 * stakeholder, or action-type step. For each group: how many were done,
 * and of those with a planned date, how many landed on/before it vs
 * late. Most-active first.
 */
function aggregatePerf(
  actions: ScopedActionDetail[],
  keyOf: (a: ScopedActionDetail) => string | null,
): PerfAgg[] {
  const map = new Map<string, PerfAgg>();
  for (const a of actions) {
    const name = keyOf(a) ?? "— unassigned —";
    let g = map.get(name);
    if (!g) { g = { name, done: 0, onTime: 0, late: 0 }; map.set(name, g); }
    if (a.status === "done") {
      g.done++;
      if (a.expectedDate && a.completedAt) {
        // completedAt is an ISO datetime; compare its local date to the
        // planned (date-only) expectedDate.
        if (localIsoDate(a.completedAt) <= a.expectedDate) g.onTime++;
        else g.late++;
      }
    }
  }
  return Array.from(map.values()).sort(
    (x, y) => y.done - x.done || x.name.localeCompare(y.name),
  );
}

/**
 * Phase performance for a closed PO — two boxes:
 *   1. Internal phase — department & stakeholder on-time (the work our
 *      own teams own).
 *   2. External phase — dealer-side. Any delay here is on the dealer,
 *      so we deliberately do NOT attribute it to a department or
 *      stakeholder; it's broken down by step (action type) instead.
 *
 * Internal = PO-scope actions. External = each batch's own external
 * rows (wave-scope copies excluded to avoid double-count; Delivery
 * excluded). Closed POs only.
 */
function PoPhasePerformance({ po }: { po: PoNode }) {
  if (!po.closedAt) return null;

  const internalActions = po.actions.filter((a) => a.id >= 0);
  const externalActions = po.waves
    .flatMap((w) => w.batches.flatMap((b) => b.actions))
    .filter((a) => a.id >= 0 && a.actionTypeName !== "Delivery");

  if (internalActions.length === 0 && externalActions.length === 0) return null;

  const byDept        = aggregatePerf(internalActions, (a) => a.departmentName);
  const byStakeholder = aggregatePerf(internalActions, (a) => a.stakeholderName);
  const byStep        = aggregatePerf(externalActions, (a) => a.actionTypeName);

  return (
    <>
      {internalActions.length > 0 && (
        <section className="border-2 border-ink-700 rounded-md bg-white overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200 bg-ink-50/50 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-bold text-midnight">🛠 Internal-phase performance</span>
            <span className="text-[0.7rem] text-ink-500">department &amp; stakeholder on-time — the work our teams own</span>
          </div>
          <div className="p-3 grid gap-4 md:grid-cols-2">
            <PerfList title="Departments" rows={byDept} />
            <PerfList title="Stakeholders" rows={byStakeholder} />
          </div>
        </section>
      )}

      {externalActions.length > 0 && (
        <section className="border-2 border-ink-700 rounded-md bg-white overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200 bg-ink-50/50 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-bold text-midnight">🤝 External-phase performance</span>
            <span className="text-[0.7rem] text-ink-500">dealer-side — any delay here is on the dealer (broken down by step)</span>
          </div>
          <div className="p-3">
            <PerfList title="By step" rows={byStep} />
          </div>
        </section>
      )}
    </>
  );
}

function PerfList({ title, rows }: { title: string; rows: PerfAgg[] }) {
  return (
    <div>
      <p className="text-[0.6rem] font-medium uppercase tracking-wide text-ink-500 mb-1">{title}</p>
      {rows.length === 0 ? (
        <p className="text-[0.7rem] text-ink-400 italic">No actions assigned.</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => {
            const judged = r.onTime + r.late;
            const pct = judged > 0 ? Math.round((r.onTime / judged) * 100) : null;
            return (
              <li key={r.name} className="flex items-center gap-2 text-[0.72rem]">
                <span className="flex-1 min-w-0 truncate text-midnight" title={r.name}>{r.name}</span>
                <span className="tabular-nums text-ink-500 shrink-0">{r.done} done</span>
                {pct != null && (
                  <span
                    className={cn(
                      "tabular-nums font-medium px-1.5 py-0.5 rounded shrink-0",
                      pct >= 80 ? "text-green-dark bg-green-pale"
                        : pct >= 50 ? "text-gold-dark bg-gold-pale"
                        : "text-flame-dark bg-flame-pale",
                    )}
                    title={`${r.onTime} on-time · ${r.late} late (of ${judged} with a planned date)`}
                  >
                    {pct}% on-time
                  </span>
                )}
                {r.late > 0 && (
                  <span className="tabular-nums text-flame-dark shrink-0" title="late completions">
                    ⚠ {r.late}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
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
  // Blocked count for the collapsed-header indicator.
  const blockedCount = wave.actions.filter((a) => a.status === "blocked").length;

  // Per-window informational rollups surfaced in the collapsed header:
  //   • External-Phase progress — counts each BATCH's own external
  //     action rows summed across the window (batches × steps, e.g.
  //     6 batches × 7 steps = 42), NOT the single wave-scope set. The
  //     synthetic Delivery row is excluded (it's its own phase / the
  //     Mark-delivered button).
  //   • App-listed — how many of the window's batches are live in-app.
  //   • VIN — cars with a VIN received vs. the cars requested.
  const extBatchActions = wave.batches
    .flatMap((b) => b.actions)
    .filter((a) => a.actionTypeName !== "Delivery");
  const waveDone  = extBatchActions.filter((a) => a.status === "done").length;
  const waveTotal = extBatchActions.length;
  const listedCount = wave.batches.filter((b) => b.appListedAt != null).length;
  const batchCount  = wave.batches.length;
  const vinsReceived = wave.batches.reduce((s, b) => s + (b.vinsReceivedQuantity ?? 0), 0);

  // Days until / past this window's date (ops projection wins), shown
  // per-window in the header (visible collapsed AND expanded). Suppressed
  // once the window is fully delivered so an on-time window never reads
  // "overdue".
  const today = todayIso();
  const windowClosed = wave.closedAt != null
    || (wave.batches.length > 0 && wave.batches.every((b) => b.closedAt != null));
  const windowHeadlineDate = wave.opsExpectedDate ?? wave.availabilityDate;
  const windowDaysDelta = Math.round(
    (new Date(windowHeadlineDate).getTime() - new Date(today).getTime())
    / (24 * 60 * 60 * 1000),
  );

  // Audit 1 #3 — wave "Partially confirmed" badge. The Confirmation
  // chip stays green on N>0 (matches dealer reality: yes, partial),
  // but the wave header surfaces the qty gap so it stays visible at
  // the macro level. Only counts when at least one batch has captured
  // a confirmation > 0 AND the total falls short of the requested.
  const waveConfirmation = (() => {
    let confirmed = 0;
    let requested = 0;
    let anyCaptured = false;
    for (const b of wave.batches) {
      const c = b.confirmedQuantity ?? 0;
      if (c > 0) anyCaptured = true;
      confirmed += c;
      requested += b.requestedQuantity;
    }
    if (!anyCaptured || requested === 0) return null;
    if (confirmed >= requested) return { state: "full" as const, confirmed, requested };
    return { state: "partial" as const, confirmed, requested };
  })();

  // "Ops hasn't committed to a window date yet" = the wave's
  // ops_expected_date equals the PO availability date (the intake
  // default) OR is null. Once ops sets a real projection, the CTA
  // hides and per-batch Shift Date takes over for adjustments.
  const opsProjectionSet = wave.opsExpectedDate != null
    && wave.opsExpectedDate !== wave.availabilityDate;
  const [showOpsDateForm, setShowOpsDateForm] = useState<boolean>(false);
  // Ops Expected Date box starts collapsed — ops expands it on demand.
  const [opsExpanded, setOpsExpanded] = useState<boolean>(false);
  const [opsDateBusy, setOpsDateBusy] = useState<boolean>(false);
  const [opsDateError, setOpsDateError] = useState<string | null>(null);
  const router = useRouter();
  async function submitWaveOpsDate(date: string, reason: string | null) {
    setOpsDateBusy(true);
    setOpsDateError(null);
    try {
      const res = await fetch("/api/wave-set-ops-projected", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          waveId: wave.id,
          opsProjectedDate: date,
          reason,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
      setShowOpsDateForm(false);
    } catch (e) {
      setOpsDateError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpsDateBusy(false);
    }
  }

  return (
    <section className="border-2 border-ink-700 rounded-md bg-ink-50/30 overflow-hidden">
      {/* Header row uses a wrapper <div> + nested <button> roles so the
          collapsible toggle stays valid HTML. */}
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
        {/* Headline date = Ops Expected Date when set; PO Expected
            Date hangs off the side as the partnership-dealer
            commitment. Two distinct concepts — ops projection is
            ops's read based on real signals; PO expected is the
            original agreement (only changes if dealer renegotiates,
            captured via Shift). */}
        {(() => {
          const opsDate = wave.opsExpectedDate ?? null;
          const headline = opsDate ?? wave.availabilityDate;
          const slipped = opsDate != null && opsDate !== wave.availabilityDate;
          return (
            <>
              <span className="text-sm font-semibold text-midnight">
                📅 Delivery Window · {headline}
              </span>
              {slipped && (
                <span className="text-xs text-ink-500 tabular-nums">
                  · PO Expected Date {wave.availabilityDate}
                </span>
              )}
            </>
          );
        })()}
        <span className="text-xs text-ink-500 tabular-nums">
          {totalCars} cars · {wave.batches.length} batch{wave.batches.length === 1 ? "" : "es"}
        </span>
        {/* External-Phase progress — the collapsed-header priority.
            Counts every batch's external steps across the window
            (batches × steps), excluding Delivery. */}
        <span
          className={cn(
            "text-[0.65rem] font-semibold tabular-nums px-1.5 py-0.5 rounded border",
            waveTotal > 0 && waveDone === waveTotal
              ? "border-green text-green-dark bg-green-pale"
              : "border-ink-300 text-ink-600 bg-white",
          )}
          title="External-Phase actions done across this window — each batch's steps summed (excludes Delivery)"
        >
          {waveDone}/{waveTotal} done
        </span>
        {/* Per-window countdown — days until / past this window's date.
            Rendered as a prominent pill so the timing reads at a glance:
            flame when overdue, gold for today, brand for upcoming. */}
        {!windowClosed && (
          <span
            className={cn(
              "text-sm font-bold tabular-nums px-2.5 py-0.5 rounded-full border",
              windowDaysDelta < 0
                ? "border-flame text-flame-dark bg-flame-pale"
                : windowDaysDelta === 0
                  ? "border-gold text-gold-dark bg-gold-pale"
                  : "border-brand text-brand-dark bg-brand-pastel/60",
            )}
            title="Days until (or past) this window's expected date"
          >
            ⏳ {windowDaysDelta < 0
              ? `${-windowDaysDelta}d overdue`
              : windowDaysDelta === 0
                ? "today"
                : `in ${windowDaysDelta}d`}
          </span>
        )}
        {/* App-listed status for the window's batches. */}
        {batchCount > 0 && (
          <span
            className={cn(
              "text-[0.65rem] font-medium tabular-nums px-1.5 py-0.5 rounded border",
              listedCount === batchCount
                ? "border-green text-green-dark bg-green-pale"
                : "border-ink-300 text-ink-600 bg-white",
            )}
            title={`${listedCount} of ${batchCount} batch${batchCount === 1 ? "" : "es"} listed in-app`}
          >
            {listedCount === batchCount ? "✓ Listed" : `📱 Listed ${listedCount}/${batchCount}`}
          </span>
        )}
        {/* VIN status — cars with a VIN received vs. cars requested. */}
        <span
          className={cn(
            "text-[0.65rem] font-medium tabular-nums px-1.5 py-0.5 rounded border",
            totalCars > 0 && vinsReceived >= totalCars
              ? "border-green text-green-dark bg-green-pale"
              : "border-ink-300 text-ink-600 bg-white",
          )}
          title={`${vinsReceived} of ${totalCars} cars have a VIN received`}
        >
          {totalCars > 0 && vinsReceived >= totalCars
            ? "✓ VIN"
            : vinsReceived > 0
              ? `🔑 VIN ${vinsReceived}/${totalCars}`
              : "🔑 VIN pending"}
        </span>
        {/* Audit 1 #3 — wave confirmation state. Chips green when
            partially confirmed land but the window total falls short
            of the requested, surfacing the gap at the macro level
            without dropping the per-batch chip back to flame. */}
        {waveConfirmation?.state === "partial" && (
          <span
            className="text-[0.65rem] font-semibold tabular-nums px-1.5 py-0.5 rounded border border-gold text-gold-dark bg-gold-pale"
            title={`${waveConfirmation.confirmed} of ${waveConfirmation.requested} cars confirmed across the window's batches`}
          >
            ⚠ Partially confirmed {waveConfirmation.confirmed}/{waveConfirmation.requested}
          </span>
        )}
        {waveConfirmation?.state === "full" && (
          <span
            className="text-[0.65rem] font-semibold tabular-nums px-1.5 py-0.5 rounded border border-green text-green-dark bg-green-pale"
            title="Every batch in this window has full dealer confirmation"
          >
            ✓ Fully confirmed
          </span>
        )}
        {/* Blocked indicator only — the wave-scope "{doneCount}/N done"
            count was removed because it duplicated/contradicted the
            window-wide "{extDone}/{extTotal} done" chip above (that one
            counts wave + every batch's external actions; this counted
            wave-scope rows only). Blocked is a distinct, actionable
            signal so it stays. */}
        {blockedCount > 0 && (
          <span className="text-[0.65rem] text-flame-dark tabular-nums">
            · {blockedCount} blocked
          </span>
        )}
      </div>

      {expanded && (
        <div className="p-2 space-y-3">
          {/* Ops Expected Date banner + shift-history audit sit side by
              side so the two window-level boxes fill the row instead of
              stacking. Stacks back to one column on narrow screens. */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
          {/* Wave-level Ops Expected Date — the per-window commitment.
              When ops hasn't committed yet (opsExpectedDate equals the
              PO availability date), surface a prominent CTA. Once set,
              show the value as a chip; subsequent adjustments go per-
              batch via the Shift Date button on each row. Cascades to
              every open batch in the wave and locks each batch's
              `opsProjectedDeliveryDateAtLock` on the first set. */}
          {/* Collapsible — starts collapsed; the header line always shows
              the date status, the body (Set CTA / form / detail) reveals
              on expand. The form forces the body open while it's active. */}
          <div className={cn(
            "rounded-md",
            opsProjectionSet
              ? "border border-brand/40 bg-brand-pastel/30"
              : "border-2 border-dashed border-brand bg-brand-pastel/20",
          )}>
            <button
              type="button"
              onClick={() => setOpsExpanded((v) => !v)}
              aria-expanded={opsExpanded}
              className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-brand-pastel/40 rounded-md"
            >
              <span aria-hidden className="text-brand-dark text-xs">{opsExpanded ? "▾" : "▸"}</span>
              <span className="text-[0.7rem] font-medium text-brand-dark">📌 Ops Expected Date</span>
              <span className="text-[0.65rem] tabular-nums text-midnight">
                {opsProjectionSet ? wave.opsExpectedDate : "— not set yet"}
              </span>
              {!opsExpanded && !showOpsDateForm && (
                <span className="ml-auto text-[0.6rem] text-brand-dark/70 italic">
                  {opsProjectionSet ? "click to view" : "click to set"}
                </span>
              )}
            </button>
            {(opsExpanded || showOpsDateForm) && (
              <div className="px-3 pb-2">
                {!opsProjectionSet ? (
                  showOpsDateForm ? (
                    <WaveOpsDateForm
                      availabilityDate={wave.availabilityDate}
                      busy={opsDateBusy}
                      error={opsDateError}
                      onSubmit={submitWaveOpsDate}
                      onCancel={() => { setShowOpsDateForm(false); setOpsDateError(null); }}
                    />
                  ) : (
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-[0.65rem] text-ink-600">
                        PO Expected Date: <span className="text-midnight tabular-nums">{wave.availabilityDate}</span>
                      </span>
                      <span className="text-[0.65rem] text-ink-500 italic">
                        Signals Internal Phase — App listing targets this date.
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowOpsDateForm(true)}
                        className="ml-auto text-[0.7rem] px-2 py-0.5 rounded border border-brand text-brand-dark bg-white hover:bg-brand-pastel"
                      >
                        Set Ops Expected Date →
                      </button>
                    </div>
                  )
                ) : (
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[0.7rem]">
                    <span className="text-ink-500">
                      PO Expected Date <span className="tabular-nums text-midnight">{wave.availabilityDate}</span>
                    </span>
                    <span className="text-ink-500 italic">
                      Per-batch shifts adjust individual batches; the window-level commitment is the baseline.
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Shift-history audit trail for this delivery window. The
              window-level bulk-action box ("WINDOW") was removed —
              per-batch closure controls + External-Phase chips already
              live on each batch row below, so the window bulk bar (and
              its wave-scope chip grid) was redundant clutter. */}
          <ShiftHistoryBlock wave={wave} />
          </div>

          {/* PER-BATCH BLOCK
              Each batch gets its own box with identity meta on top and
              a single Action Bar at the bottom: closure controls on
              the left (single-batch), External-Phase chips on the
              right that reflect THIS batch's batch-scope copies. */}
          <ul className="space-y-2">
            {wave.batches.map((b) => (
              <BatchRow
                key={b.id}
                batch={b}
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
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * Compact horizontal chip representation of a single action — used
 * in the per-batch ActionBar (right cluster). One click flips the action's status in
 * the canonical waiting → done direction; shift-click reverts via
 * the cascade. Status drives the icon + colour:
 *   ⏳ waiting   → click marks done
 *   ⛔ blocked   → click marks waiting (unblock)
 *   ✅ done      → click re-opens
 *   ⏭ skipped   → click re-opens (waiting)
 * Tooltip carries the full label + due date + (when blocked) the
 * pending parents list.
 */
// ─────────────────────────────────────────────────────────────────
// SLA countdown — a live "Xh remaining" / "Overdue by Yd" pill shown
// under each actionable chip. Derived entirely client-side from the
// action's slaStartedAt + slaHours so it ticks without a refetch.
//   Normal   — plenty of budget left
//   Warning  — ≤25% of the budget remaining (75%+ elapsed)
//   Overdue  — past the deadline, by < one full budget
//   Critical — overdue by ≥ one full budget
// Only waiting rows show it; blocked rows have no running clock, and
// done/skipped are settled (compliance reporting lands in Phase 4).
// ─────────────────────────────────────────────────────────────────
type SlaState = "normal" | "warning" | "overdue" | "critical";

const SLA_PILL_STYLES: Record<SlaState, string> = {
  normal:   "bg-green-pale text-green-dark border-green/40",
  warning:  "bg-gold-pale text-gold-dark border-gold/50",
  overdue:  "bg-flame-pale text-flame-dark border-flame/60",
  critical: "bg-flame-dark text-white border-flame-dark",
};

/**
 * Live clock. Pass an interval in ms to tick, or `null` to disable the
 * timer entirely (returns a stable initial value). Settled chips pass
 * null so only chips with a running SLA actually schedule a timer.
 */
function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (intervalMs == null) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function formatSlaDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86_400);
  const h = Math.floor((totalSec % 86_400) / 3_600);
  const m = Math.floor((totalSec % 3_600) / 60);
  const s = totalSec % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

export function computeSlaState(
  slaStartedAt: string | null,
  slaHours: number | null,
  now: number,
): { state: SlaState; overdue: boolean; label: string } | null {
  if (!slaStartedAt || slaHours == null || slaHours <= 0) return null;
  const start = new Date(slaStartedAt).getTime();
  if (!Number.isFinite(start)) return null;
  const budgetMs = slaHours * 3_600_000;
  const remainingMs = start + budgetMs - now;
  if (remainingMs >= 0) {
    const state: SlaState = remainingMs / budgetMs <= 0.25 ? "warning" : "normal";
    return { state, overdue: false, label: `${formatSlaDuration(remainingMs)} remaining` };
  }
  const overdueMs = -remainingMs;
  const state: SlaState = overdueMs >= budgetMs ? "critical" : "overdue";
  return { state, overdue: true, label: `Overdue by ${formatSlaDuration(overdueMs)}` };
}

type SlaInfo = { state: SlaState; overdue: boolean; label: string };

const SLA_RANK: Record<SlaState, number> = { normal: 1, warning: 2, overdue: 3, critical: 4 };

/** Numeric priority for sorting; null (exempt / no clock) ranks lowest. */
function slaPriority(state: SlaState | null): number {
  return state ? SLA_RANK[state] : 0;
}

/**
 * The worst (highest-priority) SLA state across a set of actions at time
 * `now` — used to rank and filter PO groups in the Inbox. Only waiting
 * rows with a configured budget contribute; returns null when none do.
 */
function worstSlaState(actions: ScopedActionDetail[], now: number): SlaState | null {
  let worst: SlaState | null = null;
  for (const a of actions) {
    if (a.status !== "waiting") continue;
    const sla = computeSlaState(a.slaStartedAt, a.slaHours, now);
    if (!sla) continue;
    if (worst === null || SLA_RANK[sla.state] > SLA_RANK[worst]) worst = sla.state;
  }
  return worst;
}

/** True when this action has a running SLA clock (waiting + configured). */
function hasLiveSla(action: ScopedActionDetail): boolean {
  return action.status === "waiting"
    && !!action.slaStartedAt
    && action.slaHours != null
    && action.slaHours > 0;
}

/**
 * Escalation ring for the chip shell, by SLA state. Overdue chips get a
 * flame ring; critical ones a heavier solid-flame ring so a breached
 * action pops out of a dense list. Returns "" for non-overdue / exempt.
 */
function slaChipRing(sla: SlaInfo | null): string {
  if (!sla?.overdue) return "";
  return sla.state === "critical"
    ? "ring-2 ring-flame-dark ring-offset-1"
    : "ring-2 ring-flame/70";
}

/** Presentational countdown pill — state is computed by the caller. */
function SlaPill({ sla, title, className }: { sla: SlaInfo; title?: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold tabular-nums whitespace-nowrap",
        SLA_PILL_STYLES[sla.state],
        className,
      )}
      title={title}
    >
      {sla.overdue && <span aria-hidden>⚠</span>}
      {sla.label}
    </span>
  );
}

function ActionChip({
  action, busy, onChangeStatus, vinsBadge, onClickOverride, onEditDate, size = "sm",
}: {
  action: ScopedActionDetail;
  busy: boolean;
  onChangeStatus: (actionId: number, status: Status, completedAt?: string) => void;
  /** When provided (batch-scope VIN chip), appends a "n/N" count after
   *  the label so ops can see partial reception at a glance. */
  vinsBadge?: string | null;
  /** When provided, intercepts the click instead of flipping status.
   *  Used by the batch-scope VIN chip to open the qty form. */
  onClickOverride?: (() => void) | null;
  /** When provided, the 📅 button delegates to this handler (BatchRow
   *  opens its full-width inline date form this way). When omitted,
   *  the chip renders its own inline date popover below itself. */
  onEditDate?: (() => void) | null;
  /** Visual size. "sm" (default) is the historical compact chip used
   *  everywhere; "lg" roughly doubles the chip's text and padding for
   *  the External-Phase row, where ops asked for bigger tap targets
   *  and at-a-glance readability. */
  size?: "sm" | "lg";
}) {
  // Synthetic rows (negative id) shouldn't expose interactive chips —
  // they're read-only summaries.
  if (action.id < 0) return null;

  // Local popover state — only used when no external onEditDate
  // handler is supplied (i.e. the caller doesn't manage its own
  // inline form). Lets every chip in the tree get a date picker
  // without per-call plumbing.
  const [dateOpen, setDateOpen] = useState<boolean>(false);
  const usesLocalPopover = !onEditDate && action.status !== "skipped";

  // Live SLA clock — only schedule a timer when this chip actually has a
  // running SLA (waiting + configured), so settled chips cost nothing.
  const slaActive = hasLiveSla(action);
  const slaNow = useNow(slaActive ? 1000 : null);
  const sla = slaActive
    ? computeSlaState(action.slaStartedAt, action.slaHours, slaNow)
    : null;

  const today = todayIso();
  // SLA breach is the authoritative overdue signal when a budget is set;
  // otherwise fall back to the legacy expected-date check.
  const overdue = sla ? sla.overdue : isOverdue(action, today);
  const label = action.doneLabel || action.waitingLabel;

  const icon = action.status === "done"    ? "✅"
             : action.status === "skipped" ? "⏭"
             : action.status === "blocked" ? "⛔"
             : overdue                     ? "⚠️"
             :                                "⏳";

  // Tone derived from status. Done = green; blocked/overdue = flame;
  // waiting = neutral.
  const toneCls =
    action.status === "done"    ? "border-green text-green-dark hover:bg-green-pale" :
    action.status === "skipped" ? "border-ink-300 text-ink-500 hover:bg-ink-50" :
    action.status === "blocked" ? "border-flame text-flame-dark hover:bg-flame-pale" :
    overdue                     ? "border-flame text-flame-dark hover:bg-flame-pale" :
    "border-ink-300 text-ink-700 hover:bg-ink-50";

  // Next-state on click: progresses waiting → done, otherwise reverts
  // to waiting (re-open / unblock). Skip is intentionally NOT on the
  // chip — keep that to the deeper ActionCard view to avoid silent
  // dep-cascade satisfaction from a single quick click.
  const nextStatus: Status =
    action.status === "waiting" ? "done" :
    action.status === "blocked" ? "waiting" :
    "waiting";

  // Tooltip aggregates everything ops might want to see at a glance.
  const tooltipBits = [
    label,
    action.expectedDate ? `due ${action.expectedDate}` : null,
    action.status === "done" && action.completedAt
      ? `✓ done ${localIsoDate(action.completedAt)}`
      : null,
    action.stakeholderName ? `@${action.stakeholderName}` : null,
    action.departmentName,
    action.status === "blocked" && action.blockedByNames.length > 0
      ? `waiting on ${action.blockedByNames.join(", ")}`
      : null,
  ].filter(Boolean) as string[];

  // Size-aware classes — only "lg" differs. The lg variant roughly
  // doubles the chip's height by lifting text from text-[0.7rem] to
  // text-sm and padding from py-0.5 to py-1.5; everywhere else stays
  // pixel-identical to the historical chip.
  //
  // Lg also stretches the chip to fill its container (so every chip
  // in a column reaches the same right edge), while sm keeps its
  // historical inline-flex shrink-to-content behaviour so non-flow
  // call sites stay pixel-identical.
  const isLg = size === "lg";
  const outerFlexCls   = isLg ? "flex w-full" : "inline-flex";
  const shellFlexCls   = isLg ? "flex w-full" : "inline-flex";
  const shellTextCls   = isLg ? "text-sm"             : "text-[0.7rem]";
  const labelPadCls    = isLg ? "px-3 py-1.5 gap-1.5" : "px-2 py-0.5 gap-1";
  // Drop the small-variant label truncation cap on lg so it fills
  // its column even when the label is short.
  const labelMaxWCls   = isLg ? ""                    : "max-w-[10rem]";
  const vinsBadgeCls   = isLg ? "text-xs"             : "text-[0.65rem]";
  const dateBtnCls     = isLg ? "px-2.5 text-sm"      : "px-1.5 text-[0.7rem]";

  // Wrap the chip's main click target + the optional date-edit
  // trigger in a single bordered shell so they read as one chip
  // visually. Two separate <button>s under the shell (rather than a
  // nested button) keeps the HTML valid.
  return (
    <span className={cn(outerFlexCls, "flex-col items-stretch")}>
      <span
        className={cn(
          shellTextCls,
          shellFlexCls,
          "rounded border transition-colors items-stretch overflow-hidden",
          toneCls,
          // Overdue/critical SLA → escalation ring so breaches pop.
          slaChipRing(sla),
          busy && "opacity-50 cursor-wait",
        )}
      >
        <button
          type="button"
          onClick={() => onClickOverride
            ? onClickOverride()
            : onChangeStatus(action.id, nextStatus)}
          disabled={busy}
          title={vinsBadge
            ? `${tooltipBits.join(" · ")} · ${vinsBadge} VINs received`
            : tooltipBits.join(" · ")}
          className={cn(
            labelPadCls,
            "inline-flex items-center flex-1 min-w-0 text-left hover:bg-black/5",
          )}
        >
          <span aria-hidden>{icon}</span>
          <span className={cn("font-medium truncate", labelMaxWCls)}>{label}</span>
          {vinsBadge && (
            <span className={cn("tabular-nums ml-auto text-ink-500", vinsBadgeCls)}>
              {vinsBadge}
            </span>
          )}
        </button>
        {/* 📅 always visible (except on skipped). Delegates to the
            external handler when one's wired up (BatchRow row-wide
            form); otherwise opens a local popover below the chip. */}
        {(onEditDate || usesLocalPopover) && (
          <button
            type="button"
            onClick={() => onEditDate ? onEditDate() : setDateOpen((v) => !v)}
            disabled={busy}
            title={action.status === "done"
              ? "Edit completion date"
              : "Mark done with a custom date"}
            aria-label="Set completion date"
            className={cn(
              dateBtnCls,
              "border-l border-current/40 hover:bg-black/10",
            )}
          >
            📅
          </button>
        )}
      </span>
      {/* Live SLA countdown — sits under the chip; only present for a
          waiting row with an SLA budget configured. */}
      {sla && (
        <SlaPill
          sla={sla}
          className="mt-1 self-start"
          title={`SLA budget: ${action.slaHours}h${action.slaStartedAt ? ` · started ${localIsoDate(action.slaStartedAt)}` : ""}`}
        />
      )}
      {/* Local date popover for chips without an external handler.
          Renders below the chip and unhooks on submit/cancel. */}
      {usesLocalPopover && dateOpen && (
        <ActionChipDatePopover
          action={action}
          busy={busy}
          onSubmit={(iso) => {
            onChangeStatus(action.id, "done", iso);
            setDateOpen(false);
          }}
          onCancel={() => setDateOpen(false)}
        />
      )}
    </span>
  );
}

/**
 * Date button + inline popover for ActionCard (Internal Phase rows).
 * Sits next to "Mark done" / "Re-open" in the card's status bar.
 * Label flips based on the current status so the affordance reads
 * the same way as the chip's tooltip.
 */
function ActionCardDateButton({
  action, busy, onChangeStatus,
}: {
  action: ScopedActionDetail;
  busy: boolean;
  onChangeStatus: (actionId: number, status: Status, completedAt?: string) => void;
}) {
  const [open, setOpen] = useState<boolean>(false);
  const isDone = action.status === "done";
  return (
    <>
      <StatusBtn
        label={isDone ? "📅 Backdate" : "📅 Mark done on…"}
        tone="ink"
        busy={busy}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div className="w-full">
          <ActionChipDatePopover
            action={action}
            busy={busy}
            onSubmit={(iso) => {
              onChangeStatus(action.id, "done", iso);
              setOpen(false);
            }}
            onCancel={() => setOpen(false)}
          />
        </div>
      )}
    </>
  );
}

/**
 * datetime-local <-> ISO helpers. The input value is in local time
 * (no tz suffix); we keep it that way through state and convert to
 * UTC ISO only at submit time. Going the other way (existing
 * completedAt back into the input) we render in the operator's
 * local time so the value they see matches what they entered.
 */
function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function datetimeLocalNow(): string {
  return isoToDatetimeLocal(new Date().toISOString());
}

/**
 * Local-time yyyy-mm-dd extractor — replacement for naive
 * `iso.slice(0, 10)` at every UI display site. The naive slice reads
 * the UTC date from the stored ISO, which mis-aligns by a day for
 * picks near midnight in any non-UTC timezone (e.g. Riyadh = UTC+3
 * means a 2 AM local pick stores as 23:00 UTC the previous day, and
 * the slice would show yesterday's date in the tooltip). Reading via
 * Date accessors keeps the displayed value in the same day the
 * operator picked locally.
 */
function localIsoDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Compact date+time popover anchored under an ActionChip when no
 * parent handler is wired. Single datetime-local input + Cancel/✓.
 */
function ActionChipDatePopover({
  action, busy, onSubmit, onCancel,
}: {
  action: ScopedActionDetail;
  busy: boolean;
  onSubmit: (completedAtIso: string) => void;
  onCancel: () => void;
}) {
  const isDone = action.status === "done";
  const initial = action.completedAt
    ? isoToDatetimeLocal(action.completedAt)
    : datetimeLocalNow();
  const [local, setLocal] = useState<string>(initial);
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!local) {
      setError("Pick a date and time.");
      return;
    }
    const d = new Date(local);
    if (Number.isNaN(d.getTime())) {
      setError("Invalid date/time.");
      return;
    }
    onSubmit(d.toISOString());
  }

  return (
    <form
      onSubmit={submit}
      className="mt-1 p-1.5 border border-brand rounded-md bg-brand-pastel/30 inline-flex flex-col gap-1 text-[0.65rem]"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="text-brand-dark font-medium">
        {isDone ? "📅 Backdate" : "✓ Mark done at"}
      </span>
      <input
        type="datetime-local"
        value={local}
        onChange={(e) => { setLocal(e.target.value); setError(null); }}
        className="text-[0.65rem] px-1.5 py-0.5 border border-ink-300 rounded tabular-nums"
        autoFocus
      />
      {error && <span className="text-flame-dark">{error}</span>}
      <div className="flex gap-1 justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="px-1.5 py-0.5 rounded border border-ink-300 text-ink-600 hover:bg-ink-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className={cn(
            "px-1.5 py-0.5 rounded border",
            isDone
              ? "border-brand text-brand-dark hover:bg-brand-pastel"
              : "border-green text-green-dark hover:bg-green-pale",
          )}
        >
          {busy ? "…" : "✓"}
        </button>
      </div>
    </form>
  );
}

/**
 * Renders the shift history for every batch currently in a delivery
 * window. Each batch becomes one paragraph:
 *
 *   PO-0117-Wallan-1 — Promised 2026-05-10
 *      1st shift on 2026-05-15 → new date 2026-06-01  ·  reason …
 *      2nd shift on 2026-05-20 → new date 2026-06-15
 *
 * Batches with no shifts render a single "(no shifts yet)" line so
 * the section still acknowledges them. The whole block hides when
 * the window has no batches.
 */
function ShiftHistoryBlock({ wave }: { wave: WaveNode }) {
  // Collapsed by default — matches the WINDOW card's collapse pattern
  // so the two boxes start in identical state when ops first expands
  // a delivery window. Mounting either box doesn't surprise-fill the
  // screen with audit data.
  const [expanded, setExpanded] = useState<boolean>(false);

  // Pre-count shift events so the collapsed header carries a hint of
  // what's inside — ops can see "no shifts yet" without expanding.
  const totalShifts = wave.batches.reduce(
    (sum, b) => sum + b.shiftHistory.length,
    0,
  );
  if (wave.batches.length === 0) return null;

  function ordinal(n: number): string {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // Shift-history audit trail for the window — full-width, collapsed
  // by default. Click-to-toggle header so ops opens it on demand.
  return (
    <div className="border border-gold/40 rounded-md bg-gold-pale/20 text-[0.7rem] flex flex-col">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-baseline gap-2 px-3 py-2 text-left hover:bg-gold-pale/40 transition-colors"
      >
        <span aria-hidden className="text-gold-dark text-xs">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="inline-block text-[0.6rem] font-bold uppercase tracking-wide bg-gold text-white rounded-full px-2 py-0.5">
          History
        </span>
        <span className="text-[0.7rem] text-gold-dark font-medium">
          Shift audit trail for this delivery window
        </span>
        {!expanded && (
          <span className="text-[0.65rem] text-gold-dark/70 italic ml-auto tabular-nums">
            {totalShifts === 0
              ? "no shifts yet"
              : `${totalShifts} shift${totalShifts === 1 ? "" : "s"}`}
          </span>
        )}
      </button>

      {expanded && (
      <div className="px-3 pb-2 -mt-1 space-y-3">
        {/* Only render batches that actually have shifts. Batches
            with no revisions are operationally uninteresting in this
            audit view — listing them just adds visual noise. The
            collapsed header still surfaces "no shifts yet" when the
            entire window is shift-free. */}
        {(() => {
          const shifted = wave.batches.filter((b) => b.shiftHistory.length > 0);
          if (shifted.length === 0) {
            return (
              <p className="text-[0.7rem] text-ink-500 italic">
                No shifts have been applied to any batch in this window.
              </p>
            );
          }
          return shifted.map((b) => {
          // Original promise = first revision's previousDate.
          const original = b.shiftHistory[0].previousDate;
          return (
            <div key={b.id}>
              {/* Batch identity line. Code in mono, model in regular
                  so the eye locks onto the human label, not the slug. */}
              <p className="flex flex-wrap items-baseline gap-x-2 leading-tight mb-1">
                <code className="text-[0.65rem] text-midnight font-mono font-semibold">
                  {b.batchCode}
                </code>
                {b.modelYear && b.modelYear !== "—" && (
                  <span className="text-[0.65rem] text-ink-500">{b.modelYear}</span>
                )}
              </p>

              {/* Tabular roll-up — three tight columns that cluster
                  on the left of the box. No flex-1 spacer, so the
                  delta + shifted-on cell stays adjacent to the date
                  instead of floating to the far right. */}
              <div className="grid grid-cols-[5rem_6.25rem_auto] gap-x-3 gap-y-0.5 text-[0.7rem] leading-tight items-baseline">
                {/* Promised row — anchor everything else against the
                    original commitment. The meta column is empty here
                    so date columns still line up below. */}
                <span className="text-ink-500">Promised</span>
                <span className="tabular-nums text-midnight font-medium">{original}</span>
                <span />
                {b.shiftHistory.map((s, idx) => {
                  // Short "May 19" form for the day-of-shift so we
                  // can keep the whole column on one line at the
                  // narrow box width.
                  const shiftedOn = s.revisedAt ? fmtShortDay(s.revisedAt) : "—";
                  const fromDate = idx === 0 ? original : b.shiftHistory[idx - 1].newDate;
                  const delta = signedDayDiff(s.newDate, fromDate);
                  const deltaCls = delta > 0 ? "text-flame-dark" : delta < 0 ? "text-green-dark" : "text-ink-400";
                  return (
                    <ShiftHistoryRow
                      key={`${b.id}:${idx}`}
                      label={`${ordinal(idx + 1)} shift`}
                      newDate={s.newDate}
                      delta={delta}
                      deltaCls={deltaCls}
                      shiftedOn={shiftedOn}
                      reason={s.reason}
                    />
                  );
                })}
              </div>
            </div>
          );
        });
        })()}
      </div>
      )}
    </div>
  );
}

/** One row inside the shift-history tabular layout. Three columns:
 *  label · new date · "(+Δd · shifted-on)". Delta + day live in the
 *  same cell so they stay adjacent to each other and to the date,
 *  instead of floating off to the right of the box. */
function ShiftHistoryRow({
  label, newDate, delta, deltaCls, shiftedOn, reason,
}: {
  label: string;
  newDate: string;
  delta: number;
  deltaCls: string;
  shiftedOn: string;
  reason: string | null;
}) {
  return (
    <>
      <span className="text-gold-dark font-medium">{label}</span>
      <span className="tabular-nums text-midnight font-medium whitespace-nowrap">{newDate}</span>
      <span className="tabular-nums text-ink-500 whitespace-nowrap">
        <span className={deltaCls}>
          {delta > 0 ? `+${delta}d` : delta < 0 ? `${delta}d` : "0d"}
        </span>
        <span className="text-ink-300 mx-1">·</span>
        <span>{shiftedOn}</span>
      </span>
      {reason && (
        <span className="col-span-3 text-ink-500 italic text-[0.65rem] ml-[5.5rem] -mt-0.5">
          {reason}
        </span>
      )}
    </>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
function signedDayDiff(a: string, b: string): number {
  const t = (s: string) => new Date(s + "T12:00:00Z").getTime();
  return Math.round((t(a) - t(b)) / DAY_MS);
}

/** Short "May 19" / "Dec 3" form for the shifted-on column. Saves
 *  ~5 characters vs. the full yyyy-mm-dd so the column fits the
 *  Shift History box without wrapping. Falls back to the raw input
 *  when the ISO timestamp doesn't parse. */
function fmtShortDay(isoTs: string): string {
  const datePart = isoTs.slice(0, 10);
  const m = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return datePart || isoTs;
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const month = MONTHS[parseInt(m[2], 10) - 1] ?? m[2];
  const day = String(parseInt(m[3], 10));
  return `${month} ${day}`;
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
  batch: b, wave, internalPhaseDone,
  busyActionId, busyBatchId, onChangeStatus, onBatchOp,
  inlineForm, onOpenInlineForm, onCloseInlineForm,
}: {
  batch: BatchNode;
  wave: WaveNode;
  internalPhaseDone: boolean;
} & Pick<MutationProps, "busyActionId" | "onChangeStatus">
  & BatchOpProps
  & Pick<UiStateProps, "inlineForm" | "onOpenInlineForm" | "onCloseInlineForm">
) {
  const delivery = b.actions.find((a) => a.actionTypeName === "Delivery");
  const alreadyDelivered = b.closedAt != null && b.closureReason === "delivered";
  const cancelled        = b.closedAt != null && b.closureReason === "cancelled";
  const closed = alreadyDelivered || cancelled;
  // Partly delivered: closed as delivered but deliveredQuantity is
  // less than what was requested. Distinct from a full delivery
  // because the operator usually spun off a remainder batch and
  // wants to see at a glance "this row didn't fulfil completely".
  const partlyDelivered = alreadyDelivered
    && b.deliveredQuantity > 0
    && b.deliveredQuantity < b.requestedQuantity;
  const isListed = b.appListedAt != null;

  // Derive External-Phase gate status from THIS batch's batch-scope
  // copies of the wave's action_type set. We match by actionTypeId
  // rather than by name so a renamed action_type doesn't break the
  // gate. Batches created before the per-batch rollout don't have
  // these copies — fall back to the wave-level status so the gate
  // still behaves sensibly (until admin runs the backfill endpoint).
  const externalActionTypeIds = new Set(wave.actions.map((a) => a.actionTypeId));
  const batchScopeExternal = b.actions.filter((a) => externalActionTypeIds.has(a.actionTypeId));
  const externalActions = batchScopeExternal.length > 0 ? batchScopeExternal : wave.actions;
  const externalPending = externalActions.filter(
    (a) => a.status !== "done" && a.status !== "skipped",
  ).length;
  const externalReady = externalActions.length > 0 && externalPending === 0;

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
    if (!externalReady)        return { ok: false, reason: `${externalPending} External-Phase action${externalPending === 1 ? "" : "s"} still pending on this batch.` };
    if (!isListed)             return { ok: false, reason: "Batch not yet app-listed (do it via Internal Phase → App listed)." };
    // VIN gate — can't deliver more cars than VINs received. We block
    // delivery outright when zero VINs are recorded, and rely on the
    // delivery qty form's max cap for the partial case.
    if ((b.vinsReceivedQuantity ?? 0) <= 0) {
      return { ok: false, reason: "No VINs received yet — set the count via 🔑 Set VINs." };
    }
    return { ok: true, reason: `Up to ${b.vinsReceivedQuantity} car${b.vinsReceivedQuantity === 1 ? "" : "s"} deliverable (VINs received).` };
  })();
  const canDeliver = deliveryGate.ok;
  const deliveryBusy = !!delivery && busyActionId === delivery.id;
  const batchBusy    = busyBatchId === b.id;

  const showShiftForm   = inlineForm?.batchId === b.id && inlineForm.kind === "shift";
  const showCancelForm  = inlineForm?.batchId === b.id && inlineForm.kind === "cancel";
  const showVinsForm    = inlineForm?.batchId === b.id && inlineForm.kind === "vins";
  const showConfirmationForm = inlineForm?.batchId === b.id && inlineForm.kind === "confirmation";
  const showDeliverForm = inlineForm?.batchId === b.id && inlineForm.kind === "deliver";
  const showDateForm    = inlineForm?.batchId === b.id && inlineForm.kind === "date";
  const dateFormActionId = showDateForm ? inlineForm?.actionId ?? null : null;

  // Identify the batch-scope VIN action (if any). We pass it to the
  // VIN qty form so the inline submit can flip the chip in the same
  // round-trip — saves a second API call.
  const vinAction = batchScopeExternal.find((a) => /vin/i.test(a.actionTypeName)) ?? null;
  const vinsReceived = b.vinsReceivedQuantity ?? 0;
  const vinsPartial  = vinsReceived > 0 && vinsReceived < b.requestedQuantity;
  const vinsAllIn    = vinsReceived > 0 && vinsReceived >= b.requestedQuantity;

  // Delay vs. dealer promise — positive means we're projecting later
  // than promised; negative means we're tracking ahead. Used for the
  // colored chip in the meta line so ops sees the at-risk batches.
  const projectedDate = b.currentProjectedDeliveryDate ?? b.promisedDate;
  const delayDays = (() => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    return Math.round(
      (new Date(projectedDate).getTime() - new Date(b.promisedDate).getTime()) / DAY_MS,
    );
  })();

  const formActive = showShiftForm || showCancelForm || showVinsForm
    || showConfirmationForm || showDeliverForm || showDateForm;

  // Remainder batches carry a `-R{n}` suffix that the close endpoint
  // assigns when ops splits off the undelivered cars from a partial
  // delivery. Detect via regex so we don't need a schema change to
  // light up the visual treatment — the suffix is stable.
  const remainderMatch = /^(.+)-R(\d+)$/.exec(b.batchCode);
  const isRemainder = remainderMatch != null;
  const remainderOf = remainderMatch ? remainderMatch[1] : null;
  const remainderIndex = remainderMatch ? parseInt(remainderMatch[2], 10) : null;

  return (
    <li className={cn(
      "border-2 rounded-lg overflow-hidden shadow-sm",
      // Remainder batches get a distinct gold-tinted border + dotted
      // pattern so they read as "leftover from another batch" at a
      // glance — separate visual category from delivered / cancelled
      // / open batches. Partly-delivered (closed-as-delivered with
      // qty < requested) also tints gold so ops sees it's not a
      // clean ✓ — the rest is tracked in a sibling remainder.
      isRemainder
        ? "border-gold border-dashed bg-gold-pale/20"
        : closed
          ? (partlyDelivered
              ? "bg-gold-pale/25 border-ink-700"
              : b.closureReason === "delivered"
                ? "bg-green-pale/30 border-ink-700"
                : "bg-flame-pale/20 border-ink-700")
          : "bg-white border-ink-700",
    )}>
      {/* Remainder banner — only on remainder batches. Spans the
          full width above the two-column layout so ops sees the
          provenance before the action controls. */}
      {isRemainder && (
        <div className="px-3 py-1.5 bg-gold/15 border-b border-gold/40 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[0.7rem]">
          <span className="text-[0.6rem] font-bold uppercase tracking-wide bg-gold text-white rounded-full px-2 py-0.5">
            🔄 Remaining cars
          </span>
          <span className="text-gold-dark font-medium tabular-nums">
            {b.requestedQuantity} car{b.requestedQuantity === 1 ? "" : "s"} from{" "}
            <code className="font-mono">{remainderOf}</code>
            {remainderIndex != null && remainderIndex > 1 ? ` (split #${remainderIndex})` : ""}
          </span>
          <span className="text-ink-500 italic">
            — dealer to deliver these later. Only External-Phase work applies.
          </span>
        </div>
      )}
      {/* Two-column rectangular box: information on the left, actions
          stacked on the right. Stacks to a single column at narrow
          widths so the right rail doesn't squeeze the identity row
          unreadable. Inline forms (shift/cancel/vins/deliver/date)
          take over the full width below when active. */}
      {!formActive && (
        // Right column doubled from min(280px,42%) → min(560px,55%) so
        // the External-Phase chip + flow-controls row has room to
        // breathe — the satellite metrics (📞 N · ↗ N · ⏱ Nd) plus the
        // bigger lg chip were wrapping onto two lines in the old width.
        <div>
          {/* TOP — identity + meta (full width). No colors line
              (intentionally dropped from this view — the modal at intake
              captures it and the dashboard surfaces it; here it crowded
              the row). */}
          <div className="px-3 py-2 space-y-1 border-b border-ink-200">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
              <code className="text-[0.75rem] text-midnight font-mono font-semibold">{b.batchCode}</code>
              <span className="text-midnight font-medium">{b.modelYear}</span>
              <span className="text-ink-300">·</span>
              <span className="tabular-nums">{b.requestedQuantity} cars</span>
              {(vinsPartial || vinsAllIn) && (
                <span className={cn(
                  "text-[0.65rem] font-medium tabular-nums px-1.5 py-0.5 rounded",
                  vinsAllIn
                    ? "text-green-dark bg-green-pale"
                    : "text-gold-dark bg-gold-pale",
                )}>
                  🔑 {vinsReceived}/{b.requestedQuantity} VINs
                </span>
              )}
              {/* Audit 1 #2 — customer-impact chip. Peak bookings
                  exposed to a shift on this batch. Only renders when
                  > 0 so an unbooked batch row stays clean. */}
              {(() => {
                const peakBookings = b.shiftHistory.reduce(
                  (max, r) => Math.max(max, r.bookingsAtShift ?? 0), 0,
                );
                if (peakBookings === 0) return null;
                return (
                  <span
                    className="text-[0.65rem] font-medium tabular-nums px-1.5 py-0.5 rounded text-flame-dark bg-flame-pale"
                    title={`Peak ${peakBookings} customers exposed to a shift on this batch`}
                  >
                    🧑 {peakBookings}
                  </span>
                );
              })()}
              {b.closedAt && (
                <span className={cn(
                  "ml-auto text-[0.65rem] font-medium tabular-nums px-1.5 py-0.5 rounded",
                  partlyDelivered
                    ? "text-gold-dark bg-gold-pale"
                    : b.closureReason === "delivered"
                      ? "text-green-dark bg-green-pale"
                      : "text-flame-dark bg-flame-pale",
                )}>
                  {b.closureReason === "delivered"
                    ? (partlyDelivered
                        ? `⚠ partly delivered ${b.deliveredQuantity}/${b.requestedQuantity}`
                        : "✓ delivered")
                    : "🚫 cancelled"}
                  {" "}{b.closedAt}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[0.7rem] text-ink-600">
              <span className="tabular-nums" title="Current PO Expected Date — partnership-dealer commitment">
                📅 PO Expected <span className="text-midnight">{b.promisedDate}</span>
                {b.poExpectedDateAtLock && b.poExpectedDateAtLock !== b.promisedDate && (
                  <span
                    className="text-[0.65rem] text-ink-400 ml-1"
                    title={`Original PO Expected Date (locked at intake): ${b.poExpectedDateAtLock}`}
                  >
                    (was {b.poExpectedDateAtLock})
                  </span>
                )}
              </span>
              {b.currentProjectedDeliveryDate && b.currentProjectedDeliveryDate !== b.promisedDate && (
                <span className="tabular-nums" title="Current Ops Expected Date — ops projection based on real signals">
                  ⏰ Ops Expected <span className="text-midnight">{b.currentProjectedDeliveryDate}</span>
                </span>
              )}
              {delayDays !== 0 && !closed && (
                <span className={cn(
                  "text-[0.65rem] font-medium tabular-nums px-1.5 py-0.5 rounded",
                  delayDays > 0
                    ? "text-flame-dark bg-flame-pale"
                    : "text-brand-dark bg-brand-pastel",
                )}>
                  {delayDays > 0 ? `+${delayDays}d late` : `${-delayDays}d ahead`}
                </span>
              )}
              {isListed && (
                <span className="tabular-nums text-green-dark">
                  📱 listed {b.appListedAt!.slice(0, 10)}
                </span>
              )}
              {b.legs.length > 0 ? (
                <span className="text-ink-500">
                  📍 {b.legs.map((l) => `${l.city} ${l.quantity}`).join(", ")}
                </span>
              ) : (
                <span className="text-ink-500">📍 {b.city}</span>
              )}
            </div>
          </div>

          {/* BELOW — action cluster, full width. Closure controls
              (Shift / Cancel / Mark delivered) laid inline, then the
              External-Phase chips in a responsive multi-column grid so
              they fill the window's width instead of stranding empty
              space beside a narrow column. Hidden once the batch is
              closed. */}
          {!closed && (
            <div className="px-3 py-2 bg-ink-50/40 space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {/* "Set Ops expected date" now lives at the wave
                    (delivery window) level — see the WaveSection
                    header. Per-batch Shift Date stays here for
                    individual adjustments after the window-wide
                    commitment lands. Action-level backdate is
                    independent — never touches batch dates. */}
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
                    onClick={() => onOpenInlineForm(b.id, "deliver")}
                    className={cn(
                      "text-[0.7rem] px-2 py-0.5 rounded border transition-colors text-left",
                      canDeliver
                        ? "border-green text-green-dark hover:bg-green-pale bg-white"
                        : "border-ink-200 text-ink-400 cursor-not-allowed bg-white",
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

              {/* Single full-width column. ExtPhaseChipWithFlow is built
                  as a full-width row (chip stretches via 1fr, metric
                  badges + 📞/↗ buttons hug a shared right edge), so every
                  row's controls line up. A multi-column grid squeezes each
                  chip into a narrow cell — truncating the label and
                  zig-zagging the right-edge buttons — so keep it 1-col. */}
              {externalActions.length > 0 && (
                <div className="flex flex-col gap-1.5 pt-2 border-t border-ink-200">
                  {externalActions
                    .slice()
                    .sort((a, b) => a.sortOrder - b.sortOrder)
                    .map((a) => {
                      const isVin = /vin/i.test(a.actionTypeName);
                      const isBatchScopeVin = isVin && batchScopeExternal.some((x) => x.id === a.id);
                      const isConfirmation = /confirmation/i.test(a.actionTypeName);
                      const isBatchScopeConfirmation = isConfirmation
                        && batchScopeExternal.some((x) => x.id === a.id);
                      return (
                        <ExtPhaseChipWithFlow
                          key={a.id}
                          action={a}
                          batch={b}
                          busy={busyActionId === a.id}
                          onChangeStatus={onChangeStatus}
                          vinsBadge={isBatchScopeVin && vinsReceived > 0
                            ? `${vinsReceived}/${b.requestedQuantity}`
                            : isBatchScopeConfirmation && (b.confirmedQuantity ?? 0) > 0
                              ? `${b.confirmedQuantity}/${b.requestedQuantity}`
                              : null}
                          onClickOverride={
                            isBatchScopeVin
                              ? () => onOpenInlineForm(b.id, "vins", a.id)
                              : isBatchScopeConfirmation
                                ? () => onOpenInlineForm(b.id, "confirmation", a.id)
                                : null
                          }
                          onEditDate={a.status === "skipped"
                            ? null
                            : () => onOpenInlineForm(b.id, "date", a.id)}
                        />
                      );
                    })}
                </div>
              )}
            </div>
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
      {showVinsForm && (
        <VinsReceivedForm
          batch={b}
          actionId={inlineForm?.actionId ?? vinAction?.id ?? null}
          busy={batchBusy}
          onSubmit={(payload) => {
            onBatchOp(b.id, "/api/batch-vins-received", payload);
            onCloseInlineForm();
          }}
          onCancel={onCloseInlineForm}
        />
      )}
      {showConfirmationForm && (
        <ConfirmationQtyForm
          batch={b}
          actionId={inlineForm?.actionId ?? null}
          busy={batchBusy}
          onSubmit={(payload) => {
            onBatchOp(b.id, "/api/batch-confirmation", payload);
            onCloseInlineForm();
          }}
          onCancel={onCloseInlineForm}
        />
      )}
      {showDeliverForm && (
        <DeliverForm
          batch={b}
          busy={batchBusy}
          onSubmit={(payload) => {
            onBatchOp(b.id, "/api/batch-close", {
              batchId:           b.id,
              reason:            "delivered",
              deliveredQuantity: payload.deliveredQuantity,
              ...(payload.deliveredAt ? { deliveredAt: payload.deliveredAt } : {}),
              ...(payload.legConfirmations
                ? { legConfirmations: payload.legConfirmations }
                : {}),
              ...(payload.createRemainderBatch
                ? { createRemainderBatch: true }
                : {}),
            });
            onCloseInlineForm();
          }}
          onCancel={onCloseInlineForm}
        />
      )}
      {showDateForm && dateFormActionId != null && (() => {
        // Lookup the action across this batch's batch-scope rows AND
        // the wave's wave-scope rows — both render chips in this row
        // so the date trigger can target either layer.
        const action = batchScopeExternal.find((a) => a.id === dateFormActionId)
          ?? wave.actions.find((a) => a.id === dateFormActionId)
          ?? null;
        if (!action) {
          // Stale state (action no longer exists) — close defensively.
          onCloseInlineForm();
          return null;
        }
        return (
          <ActionDateForm
            action={action}
            busy={busyActionId === action.id}
            onSubmit={(payload) => {
              // payload.completedAt is already a full ISO timestamp
              // built from the datetime-local input (or null when
              // ops cleared it on a done chip).
              if (payload.markDone) {
                onChangeStatus(action.id, "done", payload.completedAt ?? undefined);
              } else {
                onBatchOp(b.id, "/api/scope-action/date", {
                  actionId:     action.id,
                  expectedDate: action.expectedDate,
                  completedAt:  payload.completedAt,
                });
              }
              onCloseInlineForm();
            }}
            onCancel={onCloseInlineForm}
          />
        );
      })()}
    </li>
  );
}

/**
 * Inline form for batches → Shift availability date. Date input
 * uses the native date picker; reason + bookings are optional. The
 * form replaces the legacy three-step window.prompt chain, which
 * was unusable on a daily basis.
 */
/**
 * Wave-level "Set Ops expected date" form. Fires once per delivery
 * window — the first ops commitment after intake. Cascades to every
 * open batch under the wave (setting currentProjectedDeliveryDate
 * and locking opsProjectedDeliveryDateAtLock per batch).
 *
 * After first submit the parent hides this form and shows the locked
 * value as a read-only chip. Per-batch Shift Date handles any
 * subsequent individual adjustments.
 */
function WaveOpsDateForm({
  availabilityDate, busy, error, onSubmit, onCancel,
}: {
  availabilityDate: string;
  busy: boolean;
  error: string | null;
  onSubmit: (date: string, reason: string | null) => void;
  onCancel: () => void;
}) {
  // Default = PO availability date (the window's current target).
  // Ops adjusts up or down depending on the signal that prompted the
  // commitment (VIN landed early, dealer delay confirmed, etc.).
  const [date, setDate]     = useState<string>(availabilityDate);
  const [reason, setReason] = useState<string>("");
  const [localError, setLocalError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setLocalError("Pick a date.");
      return;
    }
    onSubmit(date, reason.trim() || null);
  }

  return (
    <form
      onSubmit={submit}
      className="border-2 border-brand rounded-md bg-brand-pastel/20 px-3 py-2 space-y-2"
    >
      <p className="text-[0.7rem] font-medium text-brand-dark">
        📌 Set Ops expected delivery date for this window
      </p>
      <p className="text-[0.65rem] text-ink-600 leading-snug">
        Sets the wave's commitment AND locks every batch's
        initial-commitment snapshot. Internal Phase reads this as
        the App-listing target.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2">
        <label className="text-[0.65rem] text-ink-600 flex flex-col">
          Ops expected date
          <input
            type="date"
            value={date}
            onChange={(e) => { setDate(e.target.value); setLocalError(null); }}
            className="text-xs px-2 py-1 border border-ink-300 rounded mt-0.5"
            autoFocus
            required
          />
        </label>
        <label className="text-[0.65rem] text-ink-600 flex flex-col">
          Reason / context (optional)
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. VIN expected next week, customs cleared"
            className="text-xs px-2 py-1 border border-ink-300 rounded mt-0.5"
          />
        </label>
        <div className="flex flex-col gap-1 self-end">
          <button
            type="submit"
            disabled={busy}
            className="text-[0.7rem] px-2 py-1 rounded border border-brand text-brand-dark bg-white hover:bg-brand-pastel"
          >
            {busy ? "…" : "✓ Save & lock"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-[0.7rem] px-2 py-0.5 rounded border border-ink-300 text-ink-600 hover:bg-ink-50"
          >
            Cancel
          </button>
        </div>
      </div>
      {(localError || error) && (
        <p className="text-[0.65rem] text-flame-dark">{localError ?? error}</p>
      )}
    </form>
  );
}

// Audit 3 #4 — categorical reason taxonomy. Six buckets chosen so
// every realistic slip cause finds a home without forcing ops to
// pick "other" unless the cause is truly novel. The "avoidable"
// flag splits delays we could have prevented from systemic ones.
const REASON_CATEGORIES: { value: ShiftReasonCategory; label: string; avoidable: boolean }[] = [
  { value: "dealer_supply",   label: "🏭 Dealer supply (VIN / production / stock)", avoidable: false },
  { value: "internal_specs",  label: "📋 Internal specs / pricing / SKU",            avoidable: true  },
  { value: "customs",         label: "🛃 Customs / import / shipping",                avoidable: false },
  { value: "logistics",       label: "🚚 Logistics / showroom / inspection",         avoidable: true  },
  { value: "demand_change",   label: "🔁 Demand change / dealer renegotiation",      avoidable: false },
  { value: "other",           label: "· Other",                                      avoidable: false },
];
type ShiftReasonCategory =
  | "dealer_supply" | "internal_specs" | "customs"
  | "logistics" | "demand_change" | "other";

function ShiftDateForm({
  batch: b, busy, onSubmit, onCancel,
}: {
  batch: BatchNode;
  busy: boolean;
  onSubmit: (payload: { batchId: number; newProjectedDate: string; reason: string | null; bookingsAtShift: number; delayReasonCategory: ShiftReasonCategory | null }) => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [bookings, setBookings] = useState<string>("0");
  const [category, setCategory] = useState<ShiftReasonCategory | "">("");
  const [error, setError] = useState<string | null>(null);

  // Audit 3 #3 — customer-impact preview.
  // historicalImpact = customer-days lost on PRIOR shifts on this batch
  //   (sum of bookings × delayDays across past revisions).
  // pendingImpact    = customer-days this shift is about to add
  //   (live preview: typed bookings × computed delayDays).
  const historicalImpact = b.shiftHistory.reduce(
    (sum, r) => sum + (r.bookingsAtShift ?? 0) * (r.delayDays ?? 0),
    0,
  );
  const previousProjected = b.currentProjectedDeliveryDate ?? b.promisedDate;
  const previewDelayDays = (() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const ms = new Date(date).getTime() - new Date(previousProjected).getTime();
    return Math.round(ms / (24 * 60 * 60 * 1000));
  })();
  const previewBookings = Math.max(0, parseInt(bookings, 10) || 0);
  const pendingImpact = previewDelayDays != null && previewDelayDays > 0
    ? previewBookings * previewDelayDays
    : 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("Pick a valid date.");
      return;
    }
    const n = parseInt(bookings, 10);
    onSubmit({
      batchId:             b.id,
      newProjectedDate:    date,
      reason:              reason.trim() || null,
      bookingsAtShift:     Number.isFinite(n) && n >= 0 ? n : 0,
      delayReasonCategory: category === "" ? null : category,
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
          {/* Audit 3 #4 — categorical attribution. Drives the
              "Avoidable delays" breakdown on Insights. */}
          Reason category (optional)
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ShiftReasonCategory | "")}
            className="text-xs px-2 py-1 border border-ink-300 rounded mt-0.5 bg-white"
          >
            <option value="">— Pick a category —</option>
            {REASON_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="text-[0.65rem] text-ink-600 flex flex-col sm:col-span-3">
          Reason details (optional)
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Dealer VIN delayed by 5 days — supplier OEM allocation slipped"
            className="text-xs px-2 py-1 border border-ink-300 rounded mt-0.5"
          />
        </label>
      </div>
      {error && <p className="text-[0.65rem] text-flame-dark">{error}</p>}

      {/* Customer-impact preview (Audit 3 #3). Lives above the
          confirm button so ops sees who they're affecting BEFORE
          clicking save. Renders even when previewDelayDays is null
          (date not picked yet) so the historical context is visible
          the moment the form opens. */}
      <div className={cn(
        "text-[0.65rem] px-2 py-1 rounded border tabular-nums",
        pendingImpact > 0
          ? "border-flame bg-flame-pale/40 text-flame-dark"
          : "border-ink-200 bg-ink-50 text-ink-600",
      )}>
        {previewDelayDays == null ? (
          <>Pick a date to preview customer impact.</>
        ) : previewDelayDays > 0 ? (
          <>
            🧑 <span className="font-semibold">{previewBookings}</span> customer{previewBookings === 1 ? "" : "s"} will be affected
            {" · "}+<span className="font-semibold">{pendingImpact}</span> customer-day{pendingImpact === 1 ? "" : "s"} this shift
          </>
        ) : previewDelayDays === 0 ? (
          <>No date change — no new customer impact.</>
        ) : (
          <>↑ Pulling delivery in by {-previewDelayDays}d — no negative customer impact.</>
        )}
        {historicalImpact > 0 && (
          <span className="block text-[0.6rem] text-ink-500 mt-0.5">
            Prior shifts on this batch: <span className="font-medium">{historicalImpact}</span> customer-day{historicalImpact === 1 ? "" : "s"} already lost ({b.shiftHistory.length} shift{b.shiftHistory.length === 1 ? "" : "s"}).
          </span>
        )}
      </div>

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

/**
 * Inline form for backdating an action's completedAt. Triggered by
 * the 📅 button on each *done* ActionChip — non-done chips don't
 * show the trigger since there's no completion timestamp to edit.
 * Clearing the input + submit nulls the field (effectively reverts
 * to "auto-stamped at done click").
 */
function ActionDateForm({
  action, busy, onSubmit, onCancel,
}: {
  action: ScopedActionDetail;
  busy: boolean;
  /** Payload tells the parent how to route the submit:
   *   - `markDone: true`  → action is currently waiting/blocked; the
   *      parent should call onChangeStatus(id, "done", completedAt).
   *   - `markDone: false` → action is already done; the parent should
   *      PATCH /api/scope-action/date with the new completedAt. */
  onSubmit: (payload: { completedAt: string | null; markDone: boolean }) => void;
  onCancel: () => void;
}) {
  const label = action.doneLabel || action.waitingLabel;
  const isDone = action.status === "done";

  // Default the input to now (local time) when the chip isn't done
  // yet. When it's already done, pre-fill the existing completion
  // timestamp so ops can tweak rather than re-enter.
  const initial = action.completedAt
    ? isoToDatetimeLocal(action.completedAt)
    : datetimeLocalNow();
  const [completed, setCompleted] = useState<string>(initial);
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // Empty input is only meaningful when the chip is already done
    // (= "clear the backdate, fall back to auto-stamped value").
    // For waiting/blocked chips we require a date+time — "mark done"
    // without a moment to attach to doesn't make sense.
    if (!completed && !isDone) {
      setError("Pick a completion date and time.");
      return;
    }
    if (completed) {
      const d = new Date(completed);
      if (Number.isNaN(d.getTime())) {
        setError("Invalid date/time.");
        return;
      }
      onSubmit({
        completedAt: d.toISOString(),
        markDone:    !isDone,
      });
    } else {
      onSubmit({ completedAt: null, markDone: !isDone });
    }
  }

  return (
    <form onSubmit={submit} className="mt-2 p-2 border border-brand rounded-md bg-brand-pastel/20 space-y-2">
      <p className="text-[0.7rem] font-medium text-midnight">
        {isDone
          ? `📅 Completion date / time — ${label}`
          : `✓ Mark done — ${label}`}
      </p>
      <p className="text-[0.65rem] text-ink-600 leading-snug">
        {isDone
          ? "When did this action actually complete? Clear the field to revert to the auto-stamped value."
          : "Pick the date + time this action completed. Submitting flips the chip done and stamps the completion at the chosen moment."}
      </p>
      <div className="flex items-baseline gap-2">
        <label className="text-[0.65rem] text-ink-600 flex items-baseline gap-1.5">
          {isDone ? "Completed at" : "Completion time"}
          <input
            type="datetime-local"
            value={completed}
            onChange={(e) => { setCompleted(e.target.value); setError(null); }}
            className="text-xs px-2 py-1 border border-ink-300 rounded tabular-nums"
            autoFocus
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
          className={cn(
            "text-[0.7rem] px-2 py-0.5 rounded border transition-colors",
            isDone
              ? "border-brand text-brand-dark hover:bg-brand-pastel"
              : "border-green text-green-dark hover:bg-green-pale",
          )}
        >
          {busy
            ? "…"
            : isDone
              ? "✓ Save"
              : "✓ Mark done on this date"}
        </button>
      </div>
    </form>
  );
}

/**
 * Inline form for recording how many VINs the dealer has shared for
 * this batch. When the batch has multiple delivery legs (cities), one
 * input per leg lets ops record partial reception per destination
 * (e.g. all 15 Riyadh VINs in, but only 6 of 10 for Jeddah). The
 * batch total rolls up as the sum. Single-leg / legacy batches keep
 * a single input.
 *
 * Submitting hits /api/batch-vins-received which persists the
 * per-leg counts, updates the batch total atomically, and flips the
 * batch-scope VIN chip in the same round-trip.
 */
function VinsReceivedForm({
  batch: b, actionId, busy, onSubmit, onCancel,
}: {
  batch: BatchNode;
  actionId: number | null;
  busy: boolean;
  onSubmit: (payload:
    | { batchId: number; vinsReceivedQuantity: number; actionId?: number }
    | { batchId: number; legs: { id: number; vinsReceivedQuantity: number }[]; actionId?: number }
  ) => void;
  onCancel: () => void;
}) {
  // Multi-leg path activates when the batch has ≥ 2 legs in the data
  // (legs table populated). Single-leg + legacy fall through to the
  // single-input flow.
  const multiLeg = b.legs.length >= 2;

  // Per-leg state: keyed by leg.id, default to the current value or
  // the requested qty (the "all in" case) when nothing's been recorded.
  const [legQtys, setLegQtys] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {};
    for (const l of b.legs) {
      init[l.id] = String(l.vinsReceivedQuantity > 0 ? l.vinsReceivedQuantity : l.quantity);
    }
    return init;
  });

  // Single-input state (legacy path).
  const initialScalar = (b.vinsReceivedQuantity ?? 0) > 0
    ? (b.vinsReceivedQuantity ?? 0)
    : b.requestedQuantity;
  const [scalarQty, setScalarQty] = useState<string>(String(initialScalar));

  const [error, setError] = useState<string | null>(null);

  const total = multiLeg
    ? b.legs.reduce((sum, l) => {
        const n = parseInt(legQtys[l.id] ?? "0", 10);
        return sum + (Number.isFinite(n) && n >= 0 ? n : 0);
      }, 0)
    : Math.max(0, parseInt(scalarQty, 10) || 0);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (multiLeg) {
      const legsPayload: { id: number; vinsReceivedQuantity: number }[] = [];
      for (const l of b.legs) {
        const n = parseInt(legQtys[l.id] ?? "0", 10);
        if (!Number.isFinite(n) || n < 0) {
          setError(`${l.city}: enter a non-negative integer.`);
          return;
        }
        if (n > l.quantity) {
          setError(`${l.city}: can't exceed ${l.quantity} cars.`);
          return;
        }
        legsPayload.push({ id: l.id, vinsReceivedQuantity: n });
      }
      onSubmit({
        batchId: b.id,
        legs:    legsPayload,
        ...(actionId ? { actionId } : {}),
      });
      return;
    }
    const n = parseInt(scalarQty, 10);
    if (!Number.isFinite(n) || n < 0) {
      setError("Enter a non-negative integer.");
      return;
    }
    if (n > b.requestedQuantity) {
      setError(`Can't exceed the batch size (${b.requestedQuantity}).`);
      return;
    }
    onSubmit({
      batchId:              b.id,
      vinsReceivedQuantity: n,
      ...(actionId ? { actionId } : {}),
    });
  }

  return (
    <form onSubmit={submit} className="mt-2 p-2 border border-brand rounded-md bg-brand-pastel/30 space-y-2">
      <p className="text-[0.7rem] font-medium text-brand-dark">
        🔑 VINs received — {b.batchCode}
      </p>
      <p className="text-[0.65rem] text-ink-600 leading-snug">
        {multiLeg
          ? "Record per-city. Each city's Mark-as-delivered caps at its own VINs."
          : "How many VINs has the dealer shared so far? Partial is fine — Mark-as-delivered caps at this number."}
      </p>
      {multiLeg ? (
        <div className="space-y-1.5">
          <div className="grid grid-cols-[8rem_5rem_auto] items-baseline gap-x-2 gap-y-1">
            {b.legs.map((l) => (
              <div key={l.id} className="contents">
                <span className="text-[0.65rem] text-ink-600 truncate">📍 {l.city}</span>
                <input
                  type="number"
                  min={0}
                  max={l.quantity}
                  value={legQtys[l.id] ?? ""}
                  onChange={(e) => {
                    setLegQtys((prev) => ({ ...prev, [l.id]: e.target.value }));
                    setError(null);
                  }}
                  className="text-xs px-2 py-1 border border-ink-300 rounded tabular-nums"
                />
                <span className="text-[0.65rem] text-ink-500 tabular-nums">/ {l.quantity}</span>
              </div>
            ))}
          </div>
          <p className="text-[0.65rem] text-ink-500 tabular-nums pt-1 border-t border-ink-200">
            Batch total: <span className="text-midnight font-medium">{total}</span> / {b.requestedQuantity} cars
          </p>
        </div>
      ) : (
        <div className="flex items-baseline gap-2">
          <label className="text-[0.65rem] text-ink-600 flex items-baseline gap-1.5">
            Received
            <input
              type="number"
              min={0}
              max={b.requestedQuantity}
              value={scalarQty}
              onChange={(e) => { setScalarQty(e.target.value); setError(null); }}
              className="text-xs px-2 py-1 border border-ink-300 rounded w-20 tabular-nums"
              autoFocus
            />
          </label>
          <span className="text-[0.65rem] text-ink-500 tabular-nums">
            / {b.requestedQuantity} cars
          </span>
        </div>
      )}
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
          className="text-[0.7rem] px-2 py-0.5 rounded border border-brand text-brand-dark hover:bg-brand-pastel"
        >
          {busy ? "…" : "✓ Save VIN count"}
        </button>
      </div>
    </form>
  );
}

/**
 * Inline form for the Confirmation chip — captures "dealer confirmed N
 * of M cars". Scalar only (the data model doesn't track per-city
 * confirmation today). Mirrors VinsReceivedForm's visual style so the
 * two flows feel identical to ops.
 */
function ConfirmationQtyForm({
  batch: b, actionId, busy, onSubmit, onCancel,
}: {
  batch: BatchNode;
  actionId: number | null;
  busy: boolean;
  onSubmit: (payload: { batchId: number; confirmedQuantity: number; actionId?: number }) => void;
  onCancel: () => void;
}) {
  const initial = (b.confirmedQuantity ?? 0) > 0
    ? (b.confirmedQuantity ?? 0)
    : b.requestedQuantity;
  const [qty, setQty] = useState<string>(String(initial));
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = parseInt(qty, 10);
    if (!Number.isFinite(n) || n < 0) {
      setError("Enter a non-negative integer.");
      return;
    }
    if (n > b.requestedQuantity) {
      setError(`Can't exceed the batch size (${b.requestedQuantity}).`);
      return;
    }
    onSubmit({
      batchId:           b.id,
      confirmedQuantity: n,
      ...(actionId ? { actionId } : {}),
    });
  }

  return (
    <form onSubmit={submit} className="mt-2 p-2 border border-brand rounded-md bg-brand-pastel/30 space-y-2">
      <p className="text-[0.7rem] font-medium text-brand-dark">
        ✅ Dealer confirmation — {b.batchCode}
      </p>
      <p className="text-[0.65rem] text-ink-600 leading-snug">
        How many of the requested cars has the dealer confirmed they can
        supply? Partial (e.g. 7 of 10) is normal.
      </p>
      <div className="flex items-baseline gap-2">
        <label className="text-[0.65rem] text-ink-600 flex items-baseline gap-1.5">
          Confirmed
          <input
            type="number"
            min={0}
            max={b.requestedQuantity}
            value={qty}
            onChange={(e) => { setQty(e.target.value); setError(null); }}
            className="text-xs px-2 py-1 border border-ink-300 rounded w-20 tabular-nums"
            autoFocus
          />
        </label>
        <span className="text-[0.65rem] text-ink-500 tabular-nums">
          / {b.requestedQuantity} cars
        </span>
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
          className="text-[0.7rem] px-2 py-0.5 rounded border border-brand text-brand-dark hover:bg-brand-pastel"
        >
          {busy ? "…" : "✓ Save confirmation"}
        </button>
      </div>
    </form>
  );
}

/**
 * External-Phase chip + satellite row of touchpoint controls. The
 * chip itself is the unchanged ActionChip (status, qty pill, 📅).
 * Beneath it sits a compact row with the metrics ops asked for
 * (📞 N · ↗ N · ⏱ Nd) plus 📞 Contact / ↗ Escalate buttons that fire
 * touchpoint mutations via ShellContext.
 *
 * Scope: only used at the External-Phase chip render site in BatchRow.
 * Internal-Phase / PO-scope / Pre-PO chips render plain ActionChip so
 * their UX stays untouched (per the user's "don't change anything
 * outside the action box" instruction).
 */
function ExtPhaseChipWithFlow({
  action, batch, busy, onChangeStatus, vinsBadge, onClickOverride, onEditDate,
}: {
  action: ScopedActionDetail;
  batch: BatchNode;
  busy: boolean;
  onChangeStatus: (actionId: number, status: Status, completedAt?: string) => void;
  vinsBadge?: string | null;
  onClickOverride?: (() => void) | null;
  onEditDate?: (() => void) | null;
}) {
  const { touchpointsByAction, onLogContact, onEscalate, busyTouchpointActionId } = useShell();

  // Reuse the action-flow augmenter so the badges match what
  // /action-center-flow shows. ActionTouchpoint is structurally
  // compatible with Touchpoint (same fields) so the cast is safe.
  const augmented = useMemo(
    () => augmentActions(
      [action],
      touchpointsByAction as unknown as Record<string, Touchpoint[]>,
    )[0],
    [action, touchpointsByAction],
  );

  const tpBusy = busyTouchpointActionId === action.id;
  const anyBusy = busy || tpBusy;
  const isDone = action.status === "done" || action.status === "skipped";
  // Surface the chip's label in the undo toast so the user sees
  // "📞 VIN — logged" instead of a generic "contact logged".
  const actionLabel = action.doneLabel || action.waitingLabel;
  // Don't surface contact / escalate on synthetic rows.
  if (action.id < 0) return null;

  // Always render the buttons slot, even when the chip is done /
  // skipped, so every row's right-edge controls land at the same x
  // position. Done rows just get empty placeholders matching the
  // button footprint so the column stays aligned.
  const buttonW = "min-w-[2.25rem]"; // matches text-sm px-2 py-1 button width

  return (
    // Three-column grid: chip stretches (1fr), metric badges sit
    // right-aligned in the middle (fixed-min so the column line is
    // stable across rows), action buttons hug the right edge (auto).
    // Every row obeys the same grid so every visual column lines up
    // — no more zigzag from variable-width chips.
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
      <ActionChip
        action={action}
        busy={busy}
        onChangeStatus={onChangeStatus}
        vinsBadge={vinsBadge}
        onClickOverride={onClickOverride}
        onEditDate={onEditDate}
        size="lg"
      />

      {/* Metric badges — right-aligned within a fixed-min cell so the
          inner items line up regardless of which badges are present. */}
      <div className="flex items-center gap-1.5 justify-end min-w-[10rem]">
        {augmented.contactCount > 0 && (
          <span
            className="text-xs tabular-nums text-ink-600 bg-ink-50 border border-ink-200 rounded px-1.5 py-0.5 leading-tight"
            title={`${augmented.contactCount} touchpoint${augmented.contactCount === 1 ? "" : "s"} logged`}
          >
            📞 {augmented.contactCount}
          </span>
        )}
        {augmented.escalationCount > 0 && (
          <span
            className="text-xs tabular-nums text-flame-dark bg-flame-pale border border-flame rounded px-1.5 py-0.5 leading-tight"
            title={`${augmented.escalationCount} escalation${augmented.escalationCount === 1 ? "" : "s"}`}
          >
            ↗ {augmented.escalationCount}
          </span>
        )}
        {augmented.daysSinceLastContact != null && !isDone && (
          <span
            className="text-xs tabular-nums text-ink-500 leading-tight"
            title="Days since last contact"
          >
            {augmented.daysSinceLastContact}d ago
          </span>
        )}
        {augmented.daysToConfirm != null && (
          <span
            className="text-xs tabular-nums text-green-dark bg-green-pale border border-green rounded px-1.5 py-0.5 leading-tight"
            title="Days from first contact to confirmation"
          >
            ⏱ {augmented.daysToConfirm}d
          </span>
        )}
      </div>

      {/* Right-edge action buttons — always rendered so every row's
          right column aligns. Done/skipped rows get invisible spacers
          of the same dimensions to keep the column straight. */}
      <div className="flex items-center gap-1 justify-end">
        {!isDone ? (
          <>
            <button
              type="button"
              onClick={() => onLogContact(action.id, actionLabel)}
              disabled={anyBusy}
              title="Log a touchpoint (default: outbound, +1d follow-up)"
              className={cn(buttonW,
                "text-sm px-2 py-1 rounded border border-ink-300 text-ink-700 hover:bg-ink-50 bg-white leading-tight text-center",
              )}
            >
              📞
            </button>
            <button
              type="button"
              onClick={() => onEscalate(action.id, actionLabel)}
              disabled={anyBusy}
              title="Log an internal escalation (+2d follow-up)"
              className={cn(buttonW,
                "text-sm px-2 py-1 rounded border border-flame text-flame-dark hover:bg-flame-pale bg-white leading-tight text-center",
              )}
            >
              ↗
            </button>
          </>
        ) : (
          // Invisible spacers so done rows occupy the same right-edge
          // width as open rows. aria-hidden so screen readers skip them.
          <>
            <span className={cn(buttonW, "text-sm px-2 py-1 leading-tight invisible")} aria-hidden>📞</span>
            <span className={cn(buttonW, "text-sm px-2 py-1 leading-tight invisible")} aria-hidden>↗</span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Inline form for Mark-as-delivered. Caps the qty input at the
 * number of VINs received — you can't deliver more cars than VINs.
 *
 * Multi-leg batches get per-city inputs so ops can record partial
 * city deliveries (e.g. all 15 in Riyadh, but only 8 of 10 for
 * Jeddah). Each city caps at its own VINs-received count. Single-
 * leg / legacy batches keep a single delivered input.
 */
function DeliverForm({
  batch: b, busy, onSubmit, onCancel,
}: {
  batch: BatchNode;
  busy: boolean;
  onSubmit: (payload: {
    deliveredQuantity: number;
    legConfirmations?: { id: number; deliveredQuantity: number }[];
    createRemainderBatch?: boolean;
    /** Full ISO datetime the delivery actually happened (date + time). */
    deliveredAt?: string;
  }) => void;
  onCancel: () => void;
}) {
  const multiLeg = b.legs.length >= 2;
  const batchCap = b.vinsReceivedQuantity ?? 0;

  // Delivery window cap — the chosen delivery date/time can't be later
  // than this window's date (ops-projected date, falling back to the
  // dealer-promised date). A late delivery shifts the window first, so
  // the window always reflects the agreed landing date.
  const windowDate = (b.currentProjectedDeliveryDate ?? b.promisedDate)?.slice(0, 10) || todayIso();
  // datetime-local seed: now, clamped so it never opens past the window.
  const seedDeliveredAt = (() => {
    const now = new Date();
    const local = toLocalDatetimeValue(now);
    const windowEnd = `${windowDate}T23:59`;
    return local > windowEnd ? `${windowDate}T12:00` : local;
  })();
  const [deliveredAt, setDeliveredAt] = useState<string>(seedDeliveredAt);

  // Per-leg state: default each city to its own VINs received (the
  // "deliver everything we have VINs for" case).
  const [legQtys, setLegQtys] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {};
    for (const l of b.legs) {
      init[l.id] = String(l.vinsReceivedQuantity);
    }
    return init;
  });

  const [scalarQty, setScalarQty] = useState<string>(String(batchCap));
  // Defaults ON: partial delivery almost always implies the dealer
  // will ship the leftover later. Ops can untick when they're closing
  // out the batch entirely (e.g. the missing units were cancelled).
  const [createRemainder, setCreateRemainder] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const total = multiLeg
    ? b.legs.reduce((sum, l) => {
        const n = parseInt(legQtys[l.id] ?? "0", 10);
        return sum + (Number.isFinite(n) && n >= 0 ? n : 0);
      }, 0)
    : Math.max(0, parseInt(scalarQty, 10) || 0);
  const undelivered = Math.max(0, b.requestedQuantity - total);
  const isPartial = total > 0 && total < b.requestedQuantity;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // Validate the delivery date/time against the window cap.
    if (!deliveredAt) {
      setError("Choose a delivery date & time.");
      return;
    }
    if (deliveredAt.slice(0, 10) > windowDate) {
      setError(`Delivery date can't be after the delivery window (${windowDate}).`);
      return;
    }
    const parsedDeliveredAt = new Date(deliveredAt);
    if (Number.isNaN(parsedDeliveredAt.getTime())) {
      setError("Enter a valid delivery date & time.");
      return;
    }
    const deliveredAtIso = parsedDeliveredAt.toISOString();
    if (multiLeg) {
      const legConfirmations: { id: number; deliveredQuantity: number }[] = [];
      for (const l of b.legs) {
        const n = parseInt(legQtys[l.id] ?? "0", 10);
        if (!Number.isFinite(n) || n < 0) {
          setError(`${l.city}: enter a non-negative integer.`);
          return;
        }
        if (n > l.vinsReceivedQuantity) {
          setError(`${l.city}: capped at VINs received (${l.vinsReceivedQuantity}).`);
          return;
        }
        legConfirmations.push({ id: l.id, deliveredQuantity: n });
      }
      if (total <= 0) {
        setError("Record at least one delivered car across the cities.");
        return;
      }
      onSubmit({
        deliveredQuantity: total,
        legConfirmations,
        deliveredAt: deliveredAtIso,
        ...(isPartial && createRemainder ? { createRemainderBatch: true } : {}),
      });
      return;
    }
    const n = parseInt(scalarQty, 10);
    if (!Number.isFinite(n) || n <= 0) {
      setError("Enter a positive integer.");
      return;
    }
    if (n > batchCap) {
      setError(`Capped at VINs received (${batchCap}). Record more VINs first if needed.`);
      return;
    }
    onSubmit({
      deliveredQuantity: n,
      deliveredAt: deliveredAtIso,
      ...(isPartial && createRemainder ? { createRemainderBatch: true } : {}),
    });
  }

  return (
    <form onSubmit={submit} className="mt-2 p-2 border border-green rounded-md bg-green-pale/30 space-y-2">
      <p className="text-[0.7rem] font-medium text-green-dark">
        ✓ Mark as delivered — {b.batchCode}
      </p>
      <p className="text-[0.65rem] text-ink-600 leading-snug">
        {multiLeg
          ? "Cars delivered per city. Each city caps at its own VINs received. The batch closes once any delivery is recorded."
          : `Cars delivered to the customer. Capped at VINs received (${batchCap} / ${b.requestedQuantity}). The batch closes once any delivered qty is recorded.`}
      </p>
      {multiLeg ? (
        <div className="space-y-1.5">
          <div className="grid grid-cols-[8rem_5rem_auto] items-baseline gap-x-2 gap-y-1">
            {b.legs.map((l) => (
              <div key={l.id} className="contents">
                <span className="text-[0.65rem] text-ink-600 truncate">📍 {l.city}</span>
                <input
                  type="number"
                  min={0}
                  max={l.vinsReceivedQuantity}
                  value={legQtys[l.id] ?? ""}
                  onChange={(e) => {
                    setLegQtys((prev) => ({ ...prev, [l.id]: e.target.value }));
                    setError(null);
                  }}
                  className="text-xs px-2 py-1 border border-ink-300 rounded tabular-nums"
                  disabled={l.vinsReceivedQuantity === 0}
                  title={l.vinsReceivedQuantity === 0
                    ? "No VINs received for this city yet — record VINs first."
                    : undefined}
                />
                <span className="text-[0.65rem] text-ink-500 tabular-nums">
                  / {l.vinsReceivedQuantity} VINs · {l.quantity} cars
                </span>
              </div>
            ))}
          </div>
          <p className="text-[0.65rem] text-ink-500 tabular-nums pt-1 border-t border-ink-200">
            Batch delivered: <span className="text-midnight font-medium">{total}</span> / {batchCap} VINs
          </p>
        </div>
      ) : (
        <div className="flex items-baseline gap-2">
          <label className="text-[0.65rem] text-ink-600 flex items-baseline gap-1.5">
            Delivered
            <input
              type="number"
              min={1}
              max={batchCap}
              value={scalarQty}
              onChange={(e) => { setScalarQty(e.target.value); setError(null); }}
              className="text-xs px-2 py-1 border border-ink-300 rounded w-20 tabular-nums"
              autoFocus
            />
          </label>
          <span className="text-[0.65rem] text-ink-500 tabular-nums">
            / {batchCap} VINs · {b.requestedQuantity} cars
          </span>
        </div>
      )}
      {/* Delivery date & time — when the cars actually landed. Capped at
          the delivery window date so a recorded delivery can't post-date
          the agreed window. */}
      <label className="flex flex-wrap items-baseline gap-1.5 text-[0.65rem] text-ink-600 pt-1 border-t border-ink-200">
        Delivered at
        <input
          type="datetime-local"
          value={deliveredAt}
          max={`${windowDate}T23:59`}
          onChange={(e) => { setDeliveredAt(e.target.value); setError(null); }}
          className="text-xs px-2 py-1 border border-ink-300 rounded tabular-nums"
        />
        <span className="text-[0.6rem] text-ink-400">
          no later than the window ({windowDate})
        </span>
      </label>
      {/* Remainder toggle — only relevant when the input is partial.
          Defaults ON: most partial deliveries are "rest is coming
          later", and the remainder batch costs nothing to create. */}
      {isPartial && (
        <label className="flex items-baseline gap-1.5 text-[0.7rem] text-ink-700 pt-1 border-t border-ink-200">
          <input
            type="checkbox"
            checked={createRemainder}
            onChange={(e) => setCreateRemainder(e.target.checked)}
            className="accent-brand cursor-pointer"
          />
          <span>
            Create a remainder batch for the <span className="font-medium tabular-nums">{undelivered}</span> undelivered car{undelivered === 1 ? "" : "s"} (dealer may ship later)
          </span>
        </label>
      )}
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
          className="text-[0.7rem] px-2 py-0.5 rounded border border-green text-green-dark hover:bg-green-pale"
        >
          {busy ? "…" : "✓ Confirm delivery"}
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
  onChangeStatus: (actionId: number, status: Status, completedAt?: string) => void;
  /** When this card is the synthetic "App listed" row in Internal
   *  Phase, the parent passes the PO so the row can offer a real
   *  bulk-listing CTA instead of being read-only. */
  poForAppListing?: PoNode;
}) {
  // Shell handle for the branded skip-cascade confirm.
  const shell = useShell();
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
            ✓ {localIsoDate(action.completedAt)}
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
        {/* Mark-done-with-date / backdate. Open the same compact
            date popover the chip surfaces in the External Phase,
            so Internal Phase rows pick up the same affordance. */}
        {action.status !== "skipped" && (
          <ActionCardDateButton action={action} busy={busy} onChangeStatus={onChangeStatus} />
        )}
        {action.status !== "skipped" && action.status !== "done" && (
          <StatusBtn
            label="⏭ Skip"
            tone="ink"
            busy={busy}
            onClick={async () => {
              // Skip silently satisfies the cascade (children promote
              // from blocked → waiting), which can mask "we never
              // actually did this work" mistakes. When there are
              // pending dependents on the same scope, confirm with
              // ops first so they see the downstream impact.
              // Audit 6 #5 — preview list shows the exact dependent
              // names so ops doesn't trust the count blindly.
              if (action.pendingDependentNames.length > 0) {
                const confirmed = await shell.confirm({
                  title: `Skip will unblock ${action.pendingDependentNames.length} dependent${action.pendingDependentNames.length === 1 ? "" : "s"}`,
                  description:
                    `Skipping "${action.doneLabel || action.actionTypeName}" silently satisfies the cascade — the dependent actions below will move from Blocked → Waiting without anyone doing the work this action represents. Proceed only if the skip is intentional.`,
                  previewItems: action.pendingDependentNames,
                  previewLabel: "Actions that will unblock",
                  confirmLabel: "Skip anyway",
                  danger: true,
                });
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
  const total = allBatches.length;
  const gateOk = po.internalPhaseDone;
  const busy = busyBatchId != null && allBatches.some((b) => b.id === busyBatchId);

  // Per-wave snapshot — drives both the inline summary and the
  // checkbox form. A wave is "listed" only when EVERY batch under
  // it has appListedAt set; "partial" when some are listed.
  interface WaveStat {
    waveId: number;
    date:   string;
    listed: number;
    total:  number;
  }
  const waveStats: WaveStat[] = po.waves.map((w) => ({
    waveId: w.id,
    date:   w.availabilityDate,
    listed: w.batches.filter((b) => b.appListedAt != null).length,
    total:  w.batches.length,
  }));
  const fullyListedWaves   = waveStats.filter((w) => w.total > 0 && w.listed === w.total).length;
  const allFullyListed     = waveStats.length > 0 && fullyListedWaves === waveStats.length;
  const overallListedBatches = allBatches.filter((b) => b.appListedAt != null).length;

  const [open, setOpen]       = useState<boolean>(false);
  // Default-checked: every wave that ISN'T fully listed yet. Already-
  // listed waves stay unchecked so submitting doesn't re-stamp them.
  const [checked, setChecked] = useState<Set<number>>(() => {
    const init = new Set<number>();
    for (const w of waveStats) {
      if (!(w.total > 0 && w.listed === w.total)) init.add(w.waveId);
    }
    return init;
  });

  // Backdate input — datetime-local, default empty (= "now" at submit).
  // The HTML input value is local-time without timezone, so we convert
  // to ISO at submit time via `new Date(...).toISOString()`.
  const [backdateLocal, setBackdateLocal] = useState<string>("");

  function toggleWave(id: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function handleSubmit() {
    if (!gateOk) return;
    // Collect the unlisted batches in checked waves only — checked
    // waves whose batches are already listed contribute nothing.
    const ids: number[] = [];
    for (const w of po.waves) {
      if (!checked.has(w.id)) continue;
      for (const b of w.batches) {
        if (b.appListedAt == null) ids.push(b.id);
      }
    }
    if (ids.length === 0) {
      setOpen(false);
      return;
    }
    // Backdate path — convert datetime-local to ISO. Empty string =>
    // "now" at submit (bulk helper picks the timestamp).
    let customStamp: string | undefined;
    if (backdateLocal.trim()) {
      const parsed = new Date(backdateLocal);
      if (!Number.isNaN(parsed.getTime())) customStamp = parsed.toISOString();
    }
    onBulkSetAppListed(ids, true, customStamp);
    setOpen(false);
  }

  function handleUnlistAll() {
    const ids = allBatches.filter((b) => b.appListedAt != null).map((b) => b.id);
    if (ids.length === 0) return;
    const ok = window.confirm(
      `Un-list all ${ids.length} batch${ids.length === 1 ? "" : "es"}? ` +
      `Clears every appListedAt timestamp.`,
    );
    if (!ok) return;
    onBulkSetAppListed(ids, false);
    setOpen(false);
  }

  // Collapsed-state label summarises the current per-wave reality.
  const collapsedLabel = allFullyListed
    ? `✓ All ${waveStats.length} window${waveStats.length === 1 ? "" : "s"} listed`
    : fullyListedWaves > 0
      ? `📱 ${fullyListedWaves}/${waveStats.length} windows listed — pick more`
      : `📱 Pick windows to list (${overallListedBatches}/${total} batches)`;

  if (total === 0) return null;

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={!gateOk || busy}
          onClick={() => setOpen((v) => !v)}
          title={
            !gateOk
              ? "Complete Internal-phase actions before listing batches."
              : "Pick which delivery windows are now listed in the app."
          }
          className={cn(
            "text-[0.7rem] px-2 py-0.5 rounded border transition-colors",
            allFullyListed
              ? "border-green text-green-dark hover:bg-green-pale bg-white"
              : gateOk
                ? "border-brand text-brand-dark hover:bg-brand-pastel bg-white"
                : "border-ink-200 text-ink-400 cursor-not-allowed bg-white",
            busy && "opacity-50 cursor-wait",
          )}
        >
          {busy ? "…" : collapsedLabel}
        </button>
        {allFullyListed && (
          <button
            type="button"
            onClick={handleUnlistAll}
            disabled={busy}
            className="text-[0.65rem] px-2 py-0.5 rounded border border-ink-300 text-ink-600 hover:bg-ink-50 bg-white"
          >
            Un-list all
          </button>
        )}
      </div>

      {/* Per-wave checkbox form. App listing is per delivery window —
          checking a window marks every unlisted batch in it as listed
          on submit; leaving unchecked leaves the window untouched.
          Default state: every not-yet-fully-listed window is checked
          so the common case (list everything now) is one click. */}
      {open && gateOk && (
        <div className="border border-brand rounded-md bg-brand-pastel/30 p-2 space-y-1.5">
          <p className="text-[0.7rem] font-medium text-brand-dark">
            📱 List delivery windows
          </p>
          <p className="text-[0.65rem] text-ink-600 leading-snug">
            Checked windows will be marked as listed. Unchecked windows stay in
            App Listing. Already-fully-listed windows start unchecked so saving
            doesn&apos;t re-stamp them.
          </p>
          <ul className="space-y-1">
            {waveStats.map((w) => {
              const isFullyListed = w.total > 0 && w.listed === w.total;
              const isPartial = w.listed > 0 && w.listed < w.total;
              return (
                <li key={w.waveId} className="flex items-baseline gap-2 text-[0.7rem]">
                  <input
                    type="checkbox"
                    checked={checked.has(w.waveId)}
                    onChange={() => toggleWave(w.waveId)}
                    className="accent-brand"
                  />
                  <span className="text-midnight tabular-nums font-medium">{w.date}</span>
                  <span className="text-ink-500 tabular-nums">{w.total} batch{w.total === 1 ? "" : "es"}</span>
                  {isFullyListed && (
                    <span className="text-[0.6rem] font-semibold tabular-nums px-1.5 py-0.5 rounded border border-green text-green-dark bg-green-pale">
                      ✓ already listed
                    </span>
                  )}
                  {isPartial && (
                    <span className="text-[0.6rem] font-semibold tabular-nums px-1.5 py-0.5 rounded border border-gold text-gold-dark bg-gold-pale">
                      partial {w.listed}/{w.total}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          {/* Backdate input — datetime-local, default empty = "now"
              at submit. Use case: cars actually went live last Friday
              at 3pm but ops is logging it Monday morning. Leave empty
              for "now" — the bulk helper picks the timestamp. */}
          <label className="flex flex-wrap items-baseline gap-1.5 text-[0.65rem] text-ink-600 pt-1 border-t border-brand/20">
            <span className="font-medium">🕒 Listed at</span>
            <input
              type="datetime-local"
              value={backdateLocal}
              onChange={(e) => setBackdateLocal(e.target.value)}
              className="text-[0.7rem] px-1.5 py-0.5 border border-ink-300 rounded bg-white tabular-nums"
            />
            <span className="text-[0.6rem] text-ink-500 italic">
              {backdateLocal ? "backdating to this moment" : "(leave empty = now)"}
            </span>
            {backdateLocal && (
              <button
                type="button"
                onClick={() => setBackdateLocal("")}
                className="text-[0.6rem] text-ink-500 hover:text-midnight underline"
              >
                Clear
              </button>
            )}
          </label>

          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="text-[0.7rem] px-2 py-0.5 rounded border border-ink-300 text-ink-600 hover:bg-ink-50 bg-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={busy || checked.size === 0}
              className="text-[0.7rem] px-2 py-0.5 rounded border border-brand text-brand-dark hover:bg-brand-pastel bg-white font-medium"
            >
              {busy ? "…" : `✓ List ${checked.size} window${checked.size === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}
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

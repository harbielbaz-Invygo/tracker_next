"use client";

/**
 * Action Center per-batch drawer.
 *
 * Two interactive surfaces:
 *
 *  1. Ops confidence — slider 0-100. First save locks
 *     `operations_confidence_at_lock` (immutable snapshot for the
 *     "did Ops know?" analytic). Subsequent saves only update the live
 *     value.
 *
 *  2. Action list — grouped by status (Waiting / Blocked / Done / Skipped).
 *     "Mark done" flips status, stamps `completed_at`, and triggers the
 *     auto-unblock cascade on the server. The drawer re-fetches once on
 *     each successful mutation to reflect any cascade promotions.
 */
import { useEffect, useState, useTransition } from "react";
import type { ActionDetail, DrawerData } from "@/lib/action-center-data";
import { cn } from "@/lib/utils";

interface Props {
  /** Selected batchCode — when this changes, the drawer re-fetches. */
  batchCode: string;
  /** Called whenever the user makes a change that the parent table should reflect. */
  onMutation?: () => void;
  /**
   * `vertical` (default) — action groups stacked top-to-bottom, used in the
   * Stacked Action Center view where the drawer takes the full width.
   * `kanban` — Waiting / Blocked / Done in three columns side-by-side, used
   * in the Side-by-side Action Center view where horizontal space is plentiful.
   */
  layout?: "vertical" | "kanban";
}

export default function ActionCenterDrawer({ batchCode, onMutation, layout = "vertical" }: Props) {
  const [data, setData] = useState<DrawerData | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/action-center-drawer?code=${encodeURIComponent(batchCode)}`);
      if (!res.ok) throw new Error(await res.text());
      setData((await res.json()) as DrawerData);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setData(null);
    refresh().finally(() => {
      if (cancelled) return;
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchCode]);

  if (busy && !data) {
    return <div className="card text-sm text-ink-500">Loading batch…</div>;
  }
  if (error) {
    return (
      <div className="card !bg-flame-pale !border-flame" role="alert">
        <p className="text-sm text-flame-dark">Could not load batch: {error}</p>
      </div>
    );
  }
  if (!data) return null;

  // Alerts split into two streams:
  //   • action-tied (alert.actionId set) → rendered inline on the matching
  //     action row, no separate section.
  //   • batch-level (alert.actionId null) → rendered as a compact strip
  //     above the actions list. None of today's three trigger types produce
  //     these, but the fallback is there for future rules.
  const batchLevelAlerts = data.alerts.filter((a) => a.actionId == null);
  const alertsByActionId = new Map<number, typeof data.alerts>();
  for (const a of data.alerts) {
    if (a.actionId == null) continue;
    const arr = alertsByActionId.get(a.actionId) ?? [];
    arr.push(a);
    alertsByActionId.set(a.actionId, arr);
  }

  // Two prominent actions are promoted out of the generic action list
  // into their own dedicated panels: App Listing (top of drawer, Phase D)
  // and Delivery (bottom, Phase E). Resolve both rows here so we can
  // render the panels with the right state AND filter them out of the
  // ActionsList below. Name matches are case-insensitive so renamed
  // action_types still resolve.
  const appListingAction = data.actions.find((a) =>
    a.actionTypeName.toLowerCase().includes("app listing"),
  );
  const deliveryAction = data.actions.find(
    (a) => a.actionTypeName.toLowerCase() === "delivery",
  );
  const excludedIds = new Set<number>();
  if (appListingAction) excludedIds.add(appListingAction.id);
  if (deliveryAction)   excludedIds.add(deliveryAction.id);
  const actionsForList = excludedIds.size > 0
    ? data.actions.filter((a) => !excludedIds.has(a.id))
    : data.actions;

  return (
    <div className="card">
      <DrawerHeader data={data} onClosed={() => { refresh(); onMutation?.(); }} />
      {data.closedAt && data.closureReason ? (
        <ClosedBanner data={data} />
      ) : null}
      {batchLevelAlerts.length > 0 && (
        <BatchAlertsStrip alerts={batchLevelAlerts} onAcknowledged={refresh} />
      )}
      <AppListingPanel
        action={appListingAction ?? null}
        onMutated={() => { refresh(); onMutation?.(); }}
        disabled={!!data.closedAt}
      />
      <ConfidenceRow data={data} onSaved={() => { refresh(); onMutation?.(); }} disabled={!!data.closedAt} />
      <ActionsList
        data={data}
        actionsOverride={actionsForList}
        alertsByActionId={alertsByActionId}
        layout={layout}
        onMutated={() => { refresh(); onMutation?.(); }}
        disabled={!!data.closedAt}
      />
      {!data.closedAt && (
        <CarDeliveryPanel
          data={data}
          onDelivered={() => { refresh(); onMutation?.(); }}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// App Listing — prominent drawer panel
// ──────────────────────────────────────────────────────────────────
//
// Phase D: the App Listing action is the single most important
// moment in the customer-visible journey — once cars are listed,
// pre-bookings can start. Pulling it out of the action list into
// a dedicated panel near the top of the drawer reflects that
// status. The corresponding action_list row is filtered out by
// the parent so it doesn't render twice.

/**
 * Two states:
 *   • not done → primary CTA, datetime input pre-filled with now (ops
 *     can backdate). Submit fires POST /api/batch-action with newStatus
 *     "done" and a custom completedAt.
 *   • done     → status banner ("✅ Cars listed in app · 2026-05-13 14:32")
 *     with an "Edit timestamp" button that swaps the panel back into
 *     edit mode for adjustments.
 */
function AppListingPanel({
  action, onMutated, disabled,
}: {
  action: ActionDetail | null;
  onMutated: () => void;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draftAt, setDraftAt] = useState<string>("");
  const [pending, setPending] = useState(false);

  // Reset edit state when the selected batch changes (drawer reuses the
  // component but `action.id` shifts).
  useEffect(() => {
    setEditing(false);
    setDraftAt("");
  }, [action?.id]);

  if (!action) {
    return (
      <div className="mb-4 px-3 py-2 rounded-md border border-dashed border-ink-300 bg-ink-50 text-xs text-ink-500">
        <span className="font-medium text-midnight">📱 App Listing</span>
        <span className="ml-2">no App Listing action on this batch — add it via Settings → Batches.</span>
      </div>
    );
  }

  // Local non-null alias — narrowing from the guard above doesn't carry
  // into the nested function declarations below.
  const a = action;
  const isDone = a.status === "done";

  function openEdit() {
    const seed = isDone && a.completedAt ? a.completedAt : new Date().toISOString();
    // datetime-local wants "YYYY-MM-DDTHH:MM" in LOCAL time (no offset).
    const d = new Date(seed);
    if (!Number.isNaN(d.getTime())) {
      const pad = (n: number) => String(n).padStart(2, "0");
      setDraftAt(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
    }
    setEditing(true);
  }

  async function submit() {
    setPending(true);
    try {
      const completedIso = draftAt ? new Date(draftAt).toISOString() : new Date().toISOString();
      const res = await fetch("/api/batch-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchActionId: a.id,
          newStatus: "done",
          newCompletedAt: completedIso,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setEditing(false);
      onMutated();
    } catch (e) {
      alert(`Could not save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPending(false);
    }
  }

  if (isDone && !editing) {
    return (
      <div className="mb-5 rounded-md border-2 border-green bg-green-pale px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-bold text-green-dark flex items-center gap-2">
          <span aria-hidden="true">📱</span>
          ✅ Cars listed in app
          <span className="font-medium text-green-dark/80 tabular-nums">
            · {action.completedAt ? fmtLocalDateTime(action.completedAt) : "—"}
          </span>
        </p>
        {!disabled && (
          <button
            type="button"
            onClick={openEdit}
            className="text-xs font-medium text-green-dark hover:text-midnight underline-offset-2 hover:underline"
            title="Edit the timestamp of when cars were listed"
          >
            ✎ Edit timestamp
          </button>
        )}
      </div>
    );
  }

  // Edit / first-time mode — datetime picker + submit.
  return (
    <div className="mb-5 rounded-md border-2 border-brand bg-brand-pastel/30 px-4 py-3">
      <p className="text-sm font-bold text-midnight mb-2 flex items-center gap-2">
        <span aria-hidden="true">📱</span>
        App Listing
        <span className="text-xs font-medium text-ink-500">
          {isDone ? "Editing timestamp…" : "Mark cars listed in app"}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="datetime-local"
          className="input text-sm py-1"
          value={draftAt}
          onChange={(e) => setDraftAt(e.target.value)}
          disabled={pending || disabled}
          // Pre-fill on mount if not opened via openEdit.
          ref={(el) => {
            if (el && !draftAt && !editing) {
              const d = new Date();
              const pad = (n: number) => String(n).padStart(2, "0");
              setDraftAt(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
            }
          }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={pending || disabled || !draftAt}
          className="btn btn-primary text-sm px-3 py-1.5"
        >
          {pending ? "Saving…" : isDone ? "✓ Update" : "📱 Mark cars listed"}
        </button>
        {isDone && (
          <button
            type="button"
            onClick={() => setEditing(false)}
            disabled={pending}
            className="btn text-sm"
          >
            Cancel
          </button>
        )}
      </div>
      <p className="text-[0.7rem] text-ink-500 mt-1.5">
        Set the date and time customers first saw the cars on the app.
        Defaults to now; backdate as needed.
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Alerts — inline rendering on action rows + fallback strip
// ──────────────────────────────────────────────────────────────────

import type { ActiveAlert } from "@/lib/alert-engine";

/** Fire-and-forget POST to acknowledge an alert. Returns ok-flag. */
async function acknowledgeAlert(alertId: number): Promise<boolean> {
  try {
    const res = await fetch("/api/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "acknowledge", alertId }),
    });
    if (!res.ok) throw new Error(await res.text());
    return true;
  } catch (e) {
    alert(`Could not acknowledge: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Severity → emoji + colour classes. Used by both inline + strip renders. */
function severityVisuals(s: ActiveAlert["severity"]) {
  return {
    critical: { icon: "🚨", cls: "bg-flame-dark/10 border-flame text-flame-dark" },
    high:     { icon: "⚠️", cls: "bg-flame-pale     border-flame text-flame-dark" },
    medium:   { icon: "⚡", cls: "bg-gold-pale      border-gold  text-gold-dark"  },
    info:     { icon: "ℹ️", cls: "bg-ink-50         border-ink-200 text-ink-600"   },
  }[s];
}

/**
 * Inline alert detail rendered immediately under an action row's meta line.
 * The action row itself already shows a severity badge on the title; this
 * block gives the full message, raised time, ack state, and the Ack button.
 */
function AlertInline({ alert, onAcknowledged }: { alert: ActiveAlert; onAcknowledged: () => void }) {
  const [pending, setPending] = useState(false);
  const v = severityVisuals(alert.severity);

  async function onAck() {
    setPending(true);
    const ok = await acknowledgeAlert(alert.id);
    setPending(false);
    if (ok) onAcknowledged();
  }

  return (
    <div
      className={cn(
        "mt-1.5 flex items-start gap-2 px-2.5 py-1.5 rounded-md border text-[0.7rem]",
        v.cls,
        alert.acknowledged && "opacity-60",
      )}
      role="status"
    >
      <span aria-hidden="true" className="text-sm shrink-0 leading-none mt-px">{v.icon}</span>
      <div className="flex-1 min-w-0">
        <p className="font-medium leading-snug">{alert.message}</p>
        <p className="text-[0.65rem] mt-0.5 opacity-70">
          Raised {alert.raisedAt.slice(0, 10)}
          {alert.acknowledged && alert.acknowledgedBy && (
            <> · Acked by <span className="font-medium">{alert.acknowledgedBy}</span></>
          )}
        </p>
      </div>
      {!alert.acknowledged && (
        <button
          type="button"
          disabled={pending}
          onClick={onAck}
          className="shrink-0 text-[0.65rem] font-medium px-2 py-0.5 rounded border
                     border-current bg-white/60 hover:bg-white transition-colors"
          title="Acknowledge — mark that you've seen this alert"
        >
          {pending ? "…" : "Ack"}
        </button>
      )}
    </div>
  );
}

/**
 * Fallback strip for batch-level alerts (no actionId). Today's three
 * trigger types are all action-tied so this stays empty in practice,
 * but a future "PO cancelled by dealer" type alert would land here.
 */
function BatchAlertsStrip({
  alerts, onAcknowledged,
}: {
  alerts: ActiveAlert[];
  onAcknowledged: () => void;
}) {
  return (
    <div className="mb-5">
      <p className="text-[0.7rem] font-medium text-ink-600 uppercase tracking-wide mb-2">
        Batch alerts ({alerts.length})
      </p>
      <ul className="space-y-1.5">
        {alerts.map((a) => (
          <li key={a.id}>
            <AlertInline alert={a} onAcknowledged={onAcknowledged} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Car Delivery — prominent closing panel + confirmation modal
// ──────────────────────────────────────────────────────────────────
//
// Phase E: the Delivery action is the symmetric partner to App Listing.
// Pulling it out of the generic action list into a dedicated bottom-of-
// drawer panel reflects its weight — it's the closing gate. The button
// opens a confirmation modal asking ops to verify what actually shipped:
// total delivered quantity + per-colour breakdown (when a colour matrix
// exists). On submit, /api/batch-close persists the closure with
// qty + colour data, marks the Delivery action done, and the drawer's
// existing ClosedBanner takes over for the post-closure state.

function CarDeliveryPanel({
  data, onDelivered,
}: {
  data: DrawerData;
  onDelivered: () => void;
}) {
  const [showModal, setShowModal] = useState(false);
  return (
    <>
      <div className="mt-5 rounded-md border-2 border-green bg-green-pale/30 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-green-dark flex items-center gap-2">
            <span aria-hidden="true">🚚</span>
            Car Delivery
          </p>
          <p className="text-[0.7rem] text-ink-600 mt-0.5">
            Closing gate — confirm delivered quantity and colours.
            Closes the batch and locks all actions.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="text-sm font-semibold px-4 py-2 rounded-md
                     bg-green-dark text-white border border-green-dark
                     hover:bg-green transition-colors"
          title="Mark this batch delivered — opens the qty + colours confirmation"
        >
          🚚 Mark as delivered
        </button>
      </div>
      {showModal && (
        <CarDeliveryModal
          data={data}
          onClose={() => setShowModal(false)}
          onDelivered={() => {
            setShowModal(false);
            onDelivered();
          }}
        />
      )}
    </>
  );
}

/**
 * Confirmation modal — captures the actual closing data:
 *   • Closure date (datetime, default today, backdate allowed)
 *   • Total delivered quantity (default = requestedQuantity)
 *   • Per-colour delivered quantity (when colorMatrix is configured)
 *
 * On submit, fires POST /api/batch-close with reason="delivered".
 */
function CarDeliveryModal({
  data, onClose, onDelivered,
}: {
  data: DrawerData;
  onClose: () => void;
  onDelivered: () => void;
}) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const [closedAt, setClosedAt] = useState<string>(todayIso);
  const [deliveredQty, setDeliveredQty] = useState<number>(data.quantity);
  const [colorQtys, setColorQtys] = useState<Record<string, number>>(
    Object.fromEntries(
      data.colorMatrix.map((c) => [c.color, c.deliveredQuantity || c.requestedQuantity]),
    ),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Color sum vs delivered qty — helpful sanity check. We don't block on
  // mismatch (the dealer may have substituted colours and shipped the same
  // total count), but a hint makes the mismatch obvious.
  const colorSum = data.colorMatrix.reduce(
    (sum, c) => sum + (colorQtys[c.color] ?? 0),
    0,
  );
  const showColorMismatch =
    data.colorMatrix.length > 0 && colorSum !== deliveredQty;

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/batch-close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId: data.batchId,
          reason: "delivered",
          closedAt,
          deliveredQuantity: deliveredQty,
          colorConfirmations: data.colorMatrix.map((c) => ({
            color: c.color,
            deliveredQuantity: colorQtys[c.color] ?? 0,
          })),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      onDelivered();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="deliver-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4
                 bg-midnight/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg bg-white rounded-lg shadow-2xl border-2 border-green">
        {/* Big green header */}
        <div className="bg-green-pale border-b-2 border-green px-5 py-3 rounded-t-md">
          <h3 id="deliver-modal-title" className="text-xl font-bold text-green-dark">
            🚚 Confirm delivery
          </h3>
          <p className="text-xs text-ink-600 mt-0.5">
            {data.batchCode} · {data.quantity}× {data.modelYear} · {data.dealerName}
          </p>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Closure date */}
          <label className="block">
            <span className="block text-xs font-medium text-ink-600 mb-1">
              Closure date
            </span>
            <input
              type="date"
              className="input tabular-nums"
              value={closedAt}
              onChange={(e) => setClosedAt(e.target.value)}
              disabled={pending}
            />
            <span className="block text-[0.65rem] text-ink-500 mt-1">
              Backdate if cars were delivered on a previous day.
            </span>
          </label>

          {/* Total qty */}
          <label className="block">
            <span className="block text-xs font-medium text-ink-600 mb-1">
              Delivered quantity
              <span className="text-[0.65rem] font-normal text-ink-500 ml-1.5">
                (requested {data.quantity})
              </span>
            </span>
            <input
              type="number"
              min={0}
              className="input tabular-nums"
              value={deliveredQty}
              onChange={(e) => setDeliveredQty(parseInt(e.target.value || "0", 10))}
              disabled={pending}
            />
            {deliveredQty < data.quantity && (
              <span className="block text-[0.65rem] text-flame-dark mt-1">
                ⚠️ Partial delivery — {data.quantity - deliveredQty} unit(s) short of the request.
              </span>
            )}
          </label>

          {/* Per-colour breakdown */}
          {data.colorMatrix.length > 0 ? (
            <div>
              <p className="text-xs font-medium text-ink-600 mb-1.5">
                Colours delivered
                {showColorMismatch && (
                  <span className="text-[0.65rem] font-normal text-flame-dark ml-1.5">
                    (sum {colorSum} ≠ delivered {deliveredQty})
                  </span>
                )}
              </p>
              <div className="rounded-md border border-ink-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-ink-50 text-[0.65rem] text-ink-500 uppercase tracking-wide">
                    <tr>
                      <th className="text-left px-3 py-1.5">Colour</th>
                      <th className="text-right px-3 py-1.5">Requested</th>
                      <th className="text-right px-3 py-1.5">Confirmed</th>
                      <th className="text-right px-3 py-1.5">Delivered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.colorMatrix.map((c) => (
                      <tr key={c.color} className="border-t border-ink-200/60">
                        <td className="px-3 py-1.5 font-medium text-midnight">{c.color}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-ink-500">{c.requestedQuantity}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-ink-500">{c.confirmedQuantity}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          <input
                            type="number"
                            min={0}
                            className="input text-right tabular-nums text-sm py-0.5 px-1 w-20 ml-auto"
                            value={colorQtys[c.color] ?? 0}
                            onChange={(e) =>
                              setColorQtys((curr) => ({
                                ...curr,
                                [c.color]: parseInt(e.target.value || "0", 10),
                              }))
                            }
                            disabled={pending}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="text-[0.7rem] text-ink-500 italic">
              No colour matrix configured for this batch — total quantity only.
            </p>
          )}

          {error && (
            <p role="alert" className="text-sm text-flame-dark">{error}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 bg-ink-50 rounded-b-md border-t border-ink-200">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="btn text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={pending || deliveredQty < 0}
            className="text-sm font-semibold px-4 py-2 rounded-md text-white
                       bg-green-dark hover:bg-green disabled:opacity-50
                       border border-green-dark"
          >
            {pending ? "Confirming…" : "✅ Confirm delivery"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Closed banner
// ──────────────────────────────────────────────────────────────────

function ClosedBanner({ data }: { data: DrawerData }) {
  const isCancelled = data.closureReason === "cancelled";
  return (
    <div
      role="status"
      className={cn(
        "mb-5 rounded-md border-2 px-4 py-3",
        isCancelled
          ? "bg-flame-pale border-flame text-flame-dark"
          : "bg-green-pale border-green text-green-dark",
      )}
    >
      <p className="font-bold text-base">
        {isCancelled ? "🚫 Cancelled" : "✅ Delivered & Closed"}
        <span className="font-medium ml-2 tabular-nums text-sm">
          on {data.closedAt}
        </span>
      </p>
      {isCancelled && data.cancellationNote && (
        <p className="text-xs mt-1 text-midnight">
          <span className="font-medium">Reason:</span> {data.cancellationNote}
        </p>
      )}
      <p className="text-[0.7rem] mt-1 text-ink-600">
        Action statuses are locked. To resume work, restore the batch via the database (no in-app reopen yet).
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Header
// ──────────────────────────────────────────────────────────────────

function DrawerHeader({
  data, onClosed,
}: {
  data: DrawerData;
  onClosed: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const isClosed = !!data.closedAt;

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3 mb-4">
      <div>
        <h2 className="text-lg font-bold text-midnight">
          🛠️ {data.modelYear}
          <code className="ml-2 text-sm font-mono font-medium text-ink-600">{data.batchCode}</code>
        </h2>
        <p className="text-xs text-ink-500 mt-0.5">
          <span className="tabular-nums">{data.quantity}×</span>
          <Sep />
          <span>{data.dealerName}</span>
          <Sep />
          <span className="uppercase tracking-wide">
            {data.lifecycleState === "pre_po" ? "Pre-PO" : "Post-PO"}
          </span>
        </p>
      </div>
      {!isClosed && (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="text-xs font-medium px-3 py-1.5 rounded-md border border-flame text-flame-dark
                     bg-white hover:bg-flame-pale transition-colors"
          title="Cancel this batch — Ops can no longer update its actions"
        >
          🚫 Cancel batch
        </button>
      )}
      {confirming && (
        <CancelModal
          data={data}
          onClose={() => setConfirming(false)}
          onCancelled={() => {
            setConfirming(false);
            onClosed();
          }}
        />
      )}
    </div>
  );
}

/**
 * Big-red cancel confirmation modal. Inline, no third-party deps —
 * simple fixed-position overlay. The dialog warns the operator clearly
 * and requires a deliberate action; an optional reason note goes onto
 * the batch for audit / Slack status checks.
 */
function CancelModal({
  data, onClose, onCancelled,
}: {
  data: DrawerData;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmCancel() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/batch-close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: data.batchId, reason: "cancelled", note: note.trim() || null }),
      });
      if (!res.ok) throw new Error(await res.text());
      onCancelled();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4
                 bg-midnight/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md bg-white rounded-lg shadow-2xl border-2 border-flame">
        {/* Big red header */}
        <div className="bg-flame-pale border-b-2 border-flame px-5 py-3 rounded-t-md">
          <h3 id="cancel-modal-title" className="text-xl font-bold text-flame-dark">
            🚫 Cancel this batch?
          </h3>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-midnight">
            You&apos;re about to cancel{" "}
            <code className="font-mono text-xs bg-ink-100 px-1.5 py-0.5 rounded">{data.batchCode}</code>{" "}
            ({data.quantity}× {data.modelYear}, {data.dealerName}).
          </p>
          <p className="text-sm text-midnight">
            <span className="font-semibold text-flame-dark">This is a hard stop.</span>{" "}
            All action statuses will be locked. The batch will be marked
            <span className="font-semibold"> 🚫 Cancelled</span> on
            the dashboard and timeline. There is no in-app reopen.
          </p>
          <label className="block">
            <span className="block text-xs font-medium text-ink-600 mb-1">
              Reason (optional, shown in Slack status checks)
            </span>
            <textarea
              className="input min-h-[70px]"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Dealer cancelled the PO. Replacement order TBD."
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-flame-dark">{error}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 bg-ink-50 rounded-b-md border-t border-ink-200">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="btn text-sm"
          >
            Keep batch
          </button>
          <button
            type="button"
            onClick={confirmCancel}
            disabled={pending}
            className="text-sm font-semibold px-4 py-2 rounded-md text-white
                       bg-flame-dark hover:bg-flame disabled:opacity-50
                       border border-flame-dark"
          >
            {pending ? "Cancelling…" : "Yes, cancel batch"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Confidence row
// ──────────────────────────────────────────────────────────────────

function ConfidenceRow({
  data, onSaved, disabled = false,
}: {
  data: DrawerData;
  onSaved: () => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<number>(data.operationsConfidence ?? 50);
  const [pending, startTransition] = useTransition();
  const [savedNow, setSavedNow] = useState(false);

  // Reset slider when the drawer switches to a new batch.
  useEffect(() => {
    setDraft(data.operationsConfidence ?? 50);
  }, [data.batchId, data.operationsConfidence]);

  function save() {
    startTransition(async () => {
      try {
        const res = await fetch("/api/batch-confidence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchId: data.batchId, value: draft }),
        });
        if (!res.ok) throw new Error(await res.text());
        setSavedNow(true);
        setTimeout(() => setSavedNow(false), 1400);
        onSaved();
      } catch (e) {
        alert(`Could not save confidence: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  const dirty = draft !== (data.operationsConfidence ?? 50);
  const lockedAt = data.operationsConfidenceAtLock;
  const partnership = data.partnershipConfidence;
  const partnershipLock = data.partnershipConfidenceAtLock;

  return (
    <div className="bg-ink-50 border border-ink-200 rounded-md p-3 mb-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
        <p className="text-xs font-medium text-ink-600 uppercase tracking-wide">
          Ops Confidence
        </p>
        {lockedAt != null && (
          <p className="text-[0.7rem] text-ink-500">
            🔒 Locked at <span className="tabular-nums font-medium text-midnight">{Math.round(lockedAt)}%</span>
          </p>
        )}
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range" min={0} max={100} step={5}
          value={draft}
          onChange={(e) => setDraft(parseInt(e.target.value, 10))}
          aria-label="Ops confidence"
          className="flex-1 accent-brand"
          disabled={disabled}
        />
        <span className={cn(
          "tabular-nums font-bold text-sm w-12 text-right",
          draft >= 70 ? "text-green-dark" : draft >= 40 ? "text-gold-dark" : "text-flame-dark",
        )}>
          {draft}%
        </span>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || pending || disabled}
          className="btn btn-primary text-xs px-3"
          aria-live="polite"
        >
          {savedNow ? "✓ Saved" : pending ? "Saving…" : lockedAt == null ? "Lock & save" : "Save"}
        </button>
      </div>
      {partnership != null && (
        <p className="text-[0.7rem] text-ink-500 mt-2">
          Partnership confidence: <span className="font-medium text-midnight tabular-nums">{Math.round(partnership)}%</span>
          {partnershipLock != null && (
            <> · locked at <span className="tabular-nums">{Math.round(partnershipLock)}%</span></>
          )}
        </p>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Actions list
// ──────────────────────────────────────────────────────────────────

function ActionsList({
  data, actionsOverride, alertsByActionId, onMutated, layout, disabled = false,
}: {
  data: DrawerData;
  /**
   * When provided, render this subset instead of `data.actions`. Used by
   * the parent to filter out actions that have their own dedicated panel
   * (e.g. App Listing or Delivery as prominent buttons). Falls back to
   * `data.actions` when not provided.
   */
  actionsOverride?: ActionDetail[];
  /** Pre-grouped alerts by action id so each row knows its own. */
  alertsByActionId: Map<number, ActiveAlert[]>;
  onMutated: () => void;
  layout: "vertical" | "kanban";
  /** When true (e.g. batch is closed), every status mutation is disabled. */
  disabled?: boolean;
}) {
  const actions = actionsOverride ?? data.actions;
  if (actions.length === 0) {
    return (
      <p className="text-sm text-ink-500 italic">
        No actions yet. {data.lifecycleState === "pre_po"
          ? "This batch is a Pre-PO bet — actions are picked at Intake when the PO arrives."
          : "Pick actions at Intake."}
      </p>
    );
  }

  const groups = {
    waiting: actions.filter((a) => a.status === "waiting"),
    blocked: actions.filter((a) => a.status === "blocked"),
    done:    actions.filter((a) => a.status === "done"),
    skipped: actions.filter((a) => a.status === "skipped"),
  };

  // ── Kanban layout — three columns side-by-side, action cards stacked.
  if (layout === "kanban") {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-start">
          <KanbanColumn
            title="Waiting" tone="waiting" actions={groups.waiting} alertsByActionId={alertsByActionId} onMutated={onMutated} disabled={disabled}
          />
          <KanbanColumn
            title="Blocked" tone="blocked" actions={groups.blocked} alertsByActionId={alertsByActionId} onMutated={onMutated} disabled={disabled}
          />
          <KanbanColumn
            title="Done"    tone="done"    actions={groups.done}    alertsByActionId={alertsByActionId} onMutated={onMutated} disabled={disabled}
          />
        </div>
        {groups.skipped.length > 0 && (
          <ActionGroup
            title="Skipped" tone="skipped"
            actions={groups.skipped}
            alertsByActionId={alertsByActionId}
            onMutated={onMutated}
            disabled={disabled}
            collapsibleByDefault
          />
        )}
      </div>
    );
  }

  // ── Vertical layout (default) — groups stacked top to bottom.
  return (
    <div className="space-y-4">
      {groups.waiting.length > 0 && (
        <ActionGroup
          title="Waiting" tone="waiting" actions={groups.waiting} alertsByActionId={alertsByActionId} onMutated={onMutated} disabled={disabled}
        />
      )}
      {groups.blocked.length > 0 && (
        <ActionGroup
          title="Blocked" tone="blocked" actions={groups.blocked} alertsByActionId={alertsByActionId} onMutated={onMutated} disabled={disabled}
        />
      )}
      {groups.done.length > 0 && (
        <ActionGroup
          title="Done" tone="done" actions={groups.done} alertsByActionId={alertsByActionId} onMutated={onMutated} disabled={disabled} collapsibleByDefault
        />
      )}
      {groups.skipped.length > 0 && (
        <ActionGroup
          title="Skipped" tone="skipped" actions={groups.skipped} alertsByActionId={alertsByActionId} onMutated={onMutated} disabled={disabled} collapsibleByDefault
        />
      )}
    </div>
  );
}

/**
 * Kanban column — header (always visible) + stacked action cards.
 * Columns are independent in height; the parent grid lets each grow as
 * needed, and the side-by-side pane scrolls vertically as a whole.
 */
function KanbanColumn({
  title, tone, actions, alertsByActionId, onMutated, disabled = false,
}: {
  title: string;
  tone: "waiting" | "blocked" | "done" | "skipped";
  actions: ActionDetail[];
  alertsByActionId: Map<number, ActiveAlert[]>;
  onMutated: () => void;
  disabled?: boolean;
}) {
  const headerTone = {
    waiting: "text-brand-dark",
    blocked: "text-flame-dark",
    done:    "text-green-dark",
    skipped: "text-ink-500",
  }[tone];
  return (
    <section aria-label={`${title} actions`}>
      <header className="flex items-baseline gap-2 mb-2">
        <h4 className={cn("text-xs font-medium uppercase tracking-wide", headerTone)}>
          {title}
        </h4>
        <span className="tabular-nums text-ink-400 text-xs">({actions.length})</span>
      </header>
      {actions.length === 0 ? (
        <p className="text-[0.7rem] text-ink-400 italic px-2 py-3 text-center
                      border border-dashed border-ink-200 rounded-md">
          none
        </p>
      ) : (
        <ul className="space-y-2">
          {actions.map((a) => (
            <li key={a.id}>
              <ActionRow
                action={a}
                tone={tone}
                alerts={alertsByActionId.get(a.id) ?? []}
                onMutated={onMutated}
                compact
                disabled={disabled}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ActionGroup({
  title, tone, actions, alertsByActionId, onMutated, collapsibleByDefault = false, disabled = false,
}: {
  title: string;
  tone: "waiting" | "blocked" | "done" | "skipped";
  actions: ActionDetail[];
  alertsByActionId: Map<number, ActiveAlert[]>;
  onMutated: () => void;
  collapsibleByDefault?: boolean;
  disabled?: boolean;
}) {
  // Don't collapse a group by default when any of its rows has an active
  // alert — surfacing the alert is more important than initial tidiness.
  const hasAlertedRow = actions.some((a) => (alertsByActionId.get(a.id)?.length ?? 0) > 0);
  const [collapsed, setCollapsed] = useState(collapsibleByDefault && !hasAlertedRow);
  // Count alerts in this group for the header badge.
  const groupAlertCount = actions.reduce(
    (sum, a) => sum + (alertsByActionId.get(a.id)?.length ?? 0),
    0,
  );
  return (
    <div>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex items-center gap-2 text-xs font-medium text-ink-600 uppercase tracking-wide mb-2 hover:text-midnight"
        aria-expanded={!collapsed}
      >
        <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
        <span>{title} <span className="tabular-nums text-ink-400">({actions.length})</span></span>
        {groupAlertCount > 0 && (
          <span
            className="ml-1 text-[0.65rem] font-semibold tabular-nums px-1.5 py-0.5 rounded-full
                       bg-flame-pale text-flame-dark border border-flame"
            title={`${groupAlertCount} active alert${groupAlertCount === 1 ? "" : "s"} in this group`}
          >
            ⚠ {groupAlertCount}
          </span>
        )}
      </button>
      {!collapsed && (
        <ul className="space-y-2">
          {actions.map((a) => (
            <li key={a.id}>
              <ActionRow
                action={a}
                tone={tone}
                alerts={alertsByActionId.get(a.id) ?? []}
                onMutated={onMutated}
                disabled={disabled}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActionRow({
  action, tone, alerts = [], onMutated, compact = false, disabled = false,
}: {
  action: ActionDetail;
  tone: "waiting" | "blocked" | "done" | "skipped";
  /**
   * Alerts tied to this action (alert.actionId === action.id). Drives:
   *   • severity icon next to the action title
   *   • coloured left-border on the row
   *   • inline alert-detail block under the meta line
   * Empty array (default) → row renders normally with no alert affordances.
   */
  alerts?: ActiveAlert[];
  onMutated: () => void;
  /** Compact mode (kanban): buttons drop below the meta line so the
   *  card fits a narrow column without truncating. */
  compact?: boolean;
  /** Closed-batch mode: every status mutation button is disabled. */
  disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  // Manual backdating: when the operator clicks the 🕒 button next to
  // "Mark done", we expose a datetime-local input pre-filled with now().
  // Saving uses that timestamp instead of the server-side now().
  const [backdating, setBackdating] = useState(false);
  const [customAt, setCustomAt] = useState<string>(""); // datetime-local format

  async function setStatus(
    newStatus: ActionDetail["status"],
    newCompletedAt?: string | null,
  ) {
    setPending(true);
    try {
      const body: Record<string, unknown> = { batchActionId: action.id, newStatus };
      if (newCompletedAt !== undefined && newStatus === "done") {
        // datetime-local input emits "YYYY-MM-DDTHH:MM" in the user's
        // local timezone with no offset — re-anchor to ISO before sending.
        body.newCompletedAt = newCompletedAt
          ? new Date(newCompletedAt).toISOString()
          : null;
      }
      const res = await fetch("/api/batch-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      setBackdating(false);
      onMutated();
    } catch (e) {
      alert(`Could not update: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPending(false);
    }
  }

  function openBackdate() {
    // Pre-fill with right-now-local in datetime-local format.
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    setCustomAt(local);
    setBackdating(true);
  }

  const labelText = tone === "done" ? action.doneLabel : action.waitingLabel;

  // Pick the highest-severity unacknowledged alert for the row's visual
  // treatment. Acknowledged-only rows still get a (faded) badge so the
  // alert presence remains visible without screaming.
  const SEV_RANK: Record<ActiveAlert["severity"], number> = { critical: 4, high: 3, medium: 2, info: 1 };
  const sortedAlerts = [...alerts].sort((a, b) => {
    // Unacknowledged first, then by severity desc.
    if (a.acknowledged !== b.acknowledged) return a.acknowledged ? 1 : -1;
    return SEV_RANK[b.severity] - SEV_RANK[a.severity];
  });
  const topAlert = sortedAlerts[0];
  const topVisuals = topAlert ? severityVisuals(topAlert.severity) : null;

  // Border tone: alerted rows take a coloured border that overrides the
  // status border. Done rows keep their green border since the alert
  // would already have auto-resolved in that case.
  const borderTone = topAlert && tone !== "done"
    ? (topAlert.severity === "critical" ? "border-flame border-l-4 border-l-flame-dark"
       : topAlert.severity === "high"   ? "border-flame border-l-4 border-l-flame"
       : topAlert.severity === "medium" ? "border-gold  border-l-4 border-l-gold"
       :                                  "border-ink-300 border-l-4 border-l-ink-400")
    : {
        waiting: "border-ink-200",
        blocked: "border-ink-200 opacity-75",
        done:    "border-green",
        skipped: "border-ink-200 opacity-60",
      }[tone];

  const allDisabled = disabled || pending;
  const Buttons = backdating ? (
    // Picker mode — choose the completion datetime, then commit.
    <div className={cn("flex items-center gap-1 flex-wrap")}>
      <input
        type="datetime-local"
        className="input text-xs py-1"
        value={customAt}
        onChange={(e) => setCustomAt(e.target.value)}
        disabled={allDisabled}
      />
      <button
        type="button"
        disabled={allDisabled || !customAt}
        onClick={() => setStatus("done", customAt)}
        className="btn btn-primary text-xs"
        title="Mark done with this date + time"
      >
        ✓ Save
      </button>
      <button
        type="button"
        disabled={allDisabled}
        onClick={() => setBackdating(false)}
        className="btn text-xs"
      >
        Cancel
      </button>
    </div>
  ) : (
    <div className={cn("flex items-center gap-1", compact ? "flex-wrap" : "")}>
      {tone !== "done" && (
        <>
          <button
            type="button"
            disabled={allDisabled || tone === "blocked"}
            onClick={() => setStatus("done")}
            className="btn btn-primary text-xs"
            title={
              disabled ? "Batch is closed — actions are locked"
              : tone === "blocked" ? "Cannot complete while blocked by parent actions"
              : "Mark this action done (with the current date + time)"
            }
          >
            ✓ Mark done
          </button>
          {/* Backdating affordance — opens a datetime picker pre-filled with now. */}
          <button
            type="button"
            disabled={allDisabled || tone === "blocked"}
            onClick={openBackdate}
            className="btn text-xs px-2"
            title="Mark done at a specific date + time"
            aria-label="Mark done with a custom date and time"
          >
            🕒
          </button>
        </>
      )}
      {tone !== "skipped" && tone !== "done" && (
        <button
          type="button"
          disabled={allDisabled}
          onClick={() => setStatus("skipped")}
          className="btn text-xs"
        >
          Skip
        </button>
      )}
      {tone === "done" && (
        <button
          type="button"
          disabled={allDisabled}
          onClick={() => {
            if (!confirm("Revert this action to waiting? Any dependent actions that are currently done or waiting will be pushed back to blocked.")) return;
            setStatus("waiting");
          }}
          className="btn text-xs"
        >
          Revert
        </button>
      )}
      {tone === "skipped" && (
        <button
          type="button"
          disabled={allDisabled}
          onClick={() => setStatus("waiting")}
          className="btn text-xs"
        >
          Reopen
        </button>
      )}
    </div>
  );

  const ownerLabel = action.assignedStakeholderName
    ? `@${action.assignedStakeholderName}${action.departmentName ? ` · ${action.departmentName}` : ""}`
    : action.departmentName
      ? action.departmentName
      : "— unassigned —";

  // Compute delay (if any) — only meaningful when an expectedDate exists
  // and the action has either landed (compare to completedAt) or is still
  // pending past its expected date. The full completedAt timestamp is
  // also rendered so the team can see *when* on the day it landed.
  const today = new Date().toISOString().slice(0, 10);
  const actualDate = action.completedAt ? action.completedAt.slice(0, 10) : null;
  const actualDateTime = action.completedAt ? fmtLocalDateTime(action.completedAt) : null;
  const compareTo = actualDate ?? today;
  const delayDays = action.expectedDate
    ? Math.round((new Date(compareTo).getTime() - new Date(action.expectedDate).getTime()) / 86_400_000)
    : 0;
  // Show the signed delay chip ONLY for:
  //   • done actions whose actual completion differs from the plan
  //   • waiting actions whose expectedDate is already past
  // Blocked actions are excluded — their lateness belongs to the parent
  // they depend on (the parent's waiting row will show its own +Xd).
  const showDelay = action.expectedDate && (
    (action.status === "done"    && delayDays !== 0) ||
    (action.status === "waiting" && delayDays > 0)
  );

  const Meta = (
    <p className="text-[0.7rem] text-ink-500 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className={action.assignedStakeholderName ? "text-midnight font-medium" : ""}>
        {ownerLabel}
      </span>
      <Sep />
      <ExpectedDateInlineEditor
        actionId={action.id}
        value={action.expectedDate}
        disabled={disabled}
        onSaved={onMutated}
      />
      {actualDateTime && (
        <>
          <Sep />
          <span
            className="tabular-nums"
            title={`Completed at ${actualDateTime} (local time)`}
          >
            ✓ {actualDateTime}
          </span>
        </>
      )}
      {showDelay && (
        <>
          <Sep />
          <span className={cn(
            "tabular-nums font-medium px-1 rounded",
            delayDays > 0 ? "text-flame-dark bg-flame-pale"
                          : "text-green-dark bg-green-pale",
          )}>
            {delayDays > 0 ? `+${delayDays}d` : `${delayDays}d`}
          </span>
        </>
      )}
      {tone === "blocked" && action.blockedBy.length > 0 && (
        <>
          <Sep />
          <span>waiting on <span className="font-medium text-midnight">{action.blockedBy.join(", ")}</span></span>
        </>
      )}
    </p>
  );

  // Action title with optional severity icon prefix. The icon is the
  // single most-prominent signal that this row needs attention.
  const Title = (
    <p className="text-sm font-medium text-midnight flex items-center gap-1.5 min-w-0">
      {topVisuals && (
        <span
          aria-hidden="true"
          className={cn("text-sm shrink-0 leading-none", topAlert?.acknowledged && "opacity-50")}
          title={`${alerts.length} active alert${alerts.length === 1 ? "" : "s"}`}
        >
          {topVisuals.icon}
        </span>
      )}
      <span className="truncate">{labelText}</span>
    </p>
  );

  // Inline alert details — one block per alert, rendered under the meta.
  const AlertsBlock = alerts.length > 0 ? (
    <div className="space-y-1.5">
      {sortedAlerts.map((a) => (
        <AlertInline key={a.id} alert={a} onAcknowledged={onMutated} />
      ))}
    </div>
  ) : null;

  if (compact) {
    // Kanban card: meta + buttons stacked vertically so a narrow column fits.
    return (
      <div className={cn("rounded-md border bg-white px-3 py-2", borderTone)}>
        {Title}
        {Meta}
        {AlertsBlock}
        <div className="mt-2">{Buttons}</div>
      </div>
    );
  }

  // Vertical (default): meta + buttons side by side, wrap on narrow.
  // When alerts are present, the alert block needs full row width — so we
  // wrap the title/meta/buttons in a top row and the alert block sits below.
  return (
    <div className={cn("px-3 py-2 rounded-md border bg-white", borderTone)}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[10rem]">
          {Title}
          {Meta}
        </div>
        {Buttons}
      </div>
      {AlertsBlock}
    </div>
  );
}

function Sep() {
  return <span aria-hidden="true" className="text-ink-300">·</span>;
}

/**
 * Render an ISO datetime as `YYYY-MM-DD HH:MM` in the viewer's local
 * timezone. The DB stores ISO UTC; the team reading the Action Center reads
 * in their wall-clock time, so we render local.
 */
function fmtLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Click-to-edit chip for an action's planned `expectedDate`.
 *
 * View mode  — `📅 2026-04-30` (or `📅 set date` when null).
 * Edit mode  — narrow `<input type="date">`; saves on Enter or blur,
 *              cancels on Escape.
 *
 * When the parent batch is closed (`disabled`) the chip degrades to a
 * read-only span with no click affordance. Clearing the input and saving
 * persists `null`.
 *
 * Phase 1's auto-shift on VIN-done overwrites these dates for "from-vin"
 * actions; manual edits made before VIN is marked done will be lost when
 * VIN flips. Edit after VIN-done if Ops needs a non-default date.
 */
function ExpectedDateInlineEditor({
  actionId, value, disabled = false, onSaved,
}: {
  actionId: number;
  value: string | null;
  disabled?: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [pending, setPending] = useState(false);

  // Keep draft in sync if the parent reloads with a new value.
  useEffect(() => {
    if (!editing) setDraft(value ?? "");
  }, [value, editing]);

  async function save(next: string) {
    const normalised = next || null;
    // No-op when unchanged.
    if (normalised === (value ?? null)) {
      setEditing(false);
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/batch-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchActionId: actionId,
          newExpectedDate: normalised,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setEditing(false);
      onSaved();
    } catch (e) {
      alert(`Could not save expected date: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPending(false);
    }
  }

  if (disabled) {
    return value
      ? <span className="tabular-nums">📅 {value}</span>
      : <span className="text-ink-400">📅 —</span>;
  }

  if (editing) {
    return (
      <input
        type="date"
        autoFocus
        value={draft}
        disabled={pending}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save(draft);
          } else if (e.key === "Escape") {
            setDraft(value ?? "");
            setEditing(false);
          }
        }}
        onBlur={() => save(draft)}
        className="text-[0.7rem] tabular-nums px-1 py-0 border border-brand rounded bg-white"
        aria-label="Edit expected date"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to edit expected date"
      className={cn(
        "tabular-nums hover:text-brand-dark hover:underline cursor-text",
        !value && "text-ink-400",
      )}
    >
      📅 {value ?? "set date"}
    </button>
  );
}

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
import { useEffect, useState } from "react";
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

  // Delivery is the only action_type still promoted into a dedicated
  // panel (closing gate). App Listing used to live here too, but it's
  // been decoupled into its own first-class column (`batches.appListedAt`)
  // so admin can't break it via Settings rename/delete. The panel
  // reads/writes that column directly via /api/batch-app-listing.
  const deliveryAction = data.actions.find(
    (a) => a.actionTypeName.toLowerCase() === "delivery",
  );
  const excludedIds = new Set<number>();
  if (deliveryAction)   excludedIds.add(deliveryAction.id);
  const actionsForList = excludedIds.size > 0
    ? data.actions.filter((a) => !excludedIds.has(a.id))
    : data.actions;

  // Phase G: when a VIN-not-received alert is firing AND the batch is
  // still open, suggest pushing availability to today + leadTime so the
  // safe runway is restored. The banner one-click-opens the same
  // DateShiftModal as the manual shift button — with the recommended
  // date pre-filled.
  const hasRunwayAlert = data.alerts.some(
    (a) => a.alertType === "no_vin_before_avail",
  );
  const recommendedDate = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + (data.prePoOpsLeadTimeDays ?? 21));
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })();
  const showRecommendShift = hasRunwayAlert && !data.closedAt;

  return (
    <div className="card">
      <DrawerHeader
        data={data}
        onClosed={() => { refresh(); onMutation?.(); }}
        onShifted={() => { refresh(); onMutation?.(); }}
        onAppListed={() => { refresh(); onMutation?.(); }}
        onDelivered={() => { refresh(); onMutation?.(); }}
      />
      {/* Drawer body — banners + action clusters. The four top-level
          actions (Mark as listed, Shift, Cancel, Mark as delivered)
          all live in the unified DrawerHeader above; this body is
          just contextual banners + the work clusters. */}
      <div className="space-y-6">
        {data.closedAt && data.closureReason ? (
          <ClosedBanner data={data} />
        ) : null}
        {batchLevelAlerts.length > 0 && (
          <BatchAlertsStrip alerts={batchLevelAlerts} />
        )}
        {showRecommendShift && (
          <RecommendShiftBanner
            data={data}
            recommendedDate={recommendedDate}
            onShifted={() => { refresh(); onMutation?.(); }}
          />
        )}
        <ActionsList
          data={data}
          actionsOverride={actionsForList}
          alertsByActionId={alertsByActionId}
          layout={layout}
          onMutated={() => { refresh(); onMutation?.(); }}
          disabled={!!data.closedAt}
        />
      </div>
    </div>
  );
}


// ──────────────────────────────────────────────────────────────────
// Alerts — inline rendering on action rows + fallback strip
// ──────────────────────────────────────────────────────────────────

import type { ActiveAlert } from "@/lib/alert-engine";

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
 * block gives the full message + raised time. Alerts auto-resolve when
 * the underlying action lands — no manual dismissal needed (Ack was
 * dropped per ops feedback).
 */
function AlertInline({ alert }: { alert: ActiveAlert }) {
  const v = severityVisuals(alert.severity);
  return (
    <div
      className={cn(
        "mt-1.5 flex items-start gap-2 px-2.5 py-1.5 rounded-md border text-[0.7rem]",
        v.cls,
      )}
      role="status"
    >
      <span aria-hidden="true" className="text-sm shrink-0 leading-none mt-px">{v.icon}</span>
      <div className="flex-1 min-w-0">
        <p className="font-medium leading-snug">{alert.message}</p>
        <p className="text-[0.65rem] mt-0.5 opacity-70">
          Raised {alert.raisedAt.slice(0, 10)}
        </p>
      </div>
    </div>
  );
}

/**
 * Fallback strip for batch-level alerts (no actionId). Today's three
 * trigger types are all action-tied so this stays empty in practice,
 * but a future "PO cancelled by dealer" type alert would land here.
 */
function BatchAlertsStrip({
  alerts,
}: {
  alerts: ActiveAlert[];
}) {
  return (
    <div>
      <p className="text-[0.7rem] font-medium text-ink-600 uppercase tracking-wide mb-2">
        Batch alerts ({alerts.length})
      </p>
      <ul className="space-y-1.5">
        {alerts.map((a) => (
          <li key={a.id}>
            <AlertInline alert={a} />
          </li>
        ))}
      </ul>
    </div>
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
  // Manual entry — only consulted when there are no per-city legs.
  // When legs exist (length > 1), the effective delivered qty is
  // derived from the sum of leg inputs and this state is ignored.
  const [manualDeliveredQty, setManualDeliveredQty] = useState<number>(data.quantity);
  const [colorQtys, setColorQtys] = useState<Record<string, number>>(
    Object.fromEntries(
      data.colorMatrix.map((c) => [c.color, c.deliveredQuantity || c.requestedQuantity]),
    ),
  );
  // Phase γ — per-leg delivered quantity. Initialised from the existing
  // delivered value or full requested (best guess "delivered the lot").
  const [legQtys, setLegQtys] = useState<Record<number, number>>(
    Object.fromEntries(
      data.legs.map((l) => [l.id, l.deliveredQuantity || l.requestedQuantity]),
    ),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same for legs: sum across legs should equal total delivered.
  const legSum = data.legs.reduce(
    (sum, l) => sum + (legQtys[l.id] ?? 0),
    0,
  );

  // Multi-leg batches treat the per-city inputs as the source of
  // truth — the top "Delivered quantity" derives from legSum instead
  // of being its own input. Single-leg / no-leg batches keep the
  // manual top field. (One-row leg tables are hidden anyway.)
  const hasLegs = data.legs.length > 1;
  const deliveredQty = hasLegs ? legSum : manualDeliveredQty;

  // Color sum vs delivered qty — helpful sanity check.
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
          legConfirmations: data.legs.map((l) => ({
            id: l.id,
            deliveredQuantity: legQtys[l.id] ?? 0,
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

          {/* Total qty — auto-derived from per-city sum when legs exist
              (read-only in that case), otherwise a free input. */}
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
              className={cn(
                "input tabular-nums",
                hasLegs && "bg-ink-50 text-midnight cursor-not-allowed",
              )}
              value={deliveredQty}
              readOnly={hasLegs}
              onChange={hasLegs
                ? undefined
                : (e) => setManualDeliveredQty(parseInt(e.target.value || "0", 10))}
              disabled={pending}
              title={hasLegs ? "Auto-calculated from Per city totals below" : undefined}
            />
            {hasLegs && (
              <span className="block text-[0.65rem] text-ink-500 mt-1">
                Σ Auto-calculated from Per city totals below.
              </span>
            )}
            {deliveredQty < data.quantity && (
              <span className="block text-[0.65rem] text-flame-dark mt-1">
                ⚠️ Partial delivery — {data.quantity - deliveredQty} unit(s) short of the request.
              </span>
            )}
          </label>

          {/* Per-leg breakdown (Phase γ) — only for multi-leg batches.
              Single-leg batches don't need this section; the total
              quantity above already says everything. */}
          {data.legs.length > 1 && (
            <div>
              <p className="text-xs font-medium text-ink-600 mb-1.5">
                Per city
                <span className="text-[0.65rem] font-normal text-ink-500 ml-1.5 tabular-nums">
                  (sum {legSum})
                </span>
              </p>
              <div className="rounded-md border border-ink-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-ink-50 text-[0.65rem] text-ink-500 uppercase tracking-wide">
                    <tr>
                      <th className="text-left px-3 py-1.5">City</th>
                      <th className="text-right px-3 py-1.5">Requested</th>
                      <th className="text-right px-3 py-1.5">Delivered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.legs.map((l) => (
                      <tr key={l.id} className="border-t border-ink-200/60">
                        <td className="px-3 py-1.5 font-medium text-midnight">{l.city}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-ink-500">{l.requestedQuantity}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          <input
                            type="number"
                            min={0}
                            className="input text-right tabular-nums text-sm py-0.5 px-1 w-20 ml-auto"
                            value={legQtys[l.id] ?? 0}
                            onChange={(e) =>
                              setLegQtys((curr) => ({
                                ...curr,
                                [l.id]: parseInt(e.target.value || "0", 10),
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
          )}

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
        "rounded-md border-2 px-4 py-3",
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
  data, onClosed, onShifted, onAppListed, onDelivered,
}: {
  data: DrawerData;
  onClosed: () => void;
  onShifted: () => void;
  onAppListed: () => void;
  onDelivered: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [shifting, setShifting] = useState(false);
  const [delivering, setDelivering] = useState(false);
  // App Listing has three states:
  //   false   = idle (button or status pill)
  //   "new"   = inline picker open to set the initial timestamp
  //   "edit"  = inline picker open to edit an existing timestamp
  const [appListingForm, setAppListingForm] = useState<false | "new" | "edit">(false);
  const isClosed = !!data.closedAt;
  const isListed = !!data.appListedAt;

  // ── Workflow gates ──────────────────────────────────────────────
  // Mark as Listed is the customer-facing milestone — ops shouldn't
  // hit it until the INTERNAL phase (Specs, Pricing, SKU, …) is
  // fully cleared. Any waiting/blocked batch_action means there's
  // still work to do before listing.
  //
  // Mark as Delivered is the closing gate — ops shouldn't hit it
  // until the VIN CHASE chain is fully cleared. Same predicate, but
  // applied to batch_vin_stages.
  //
  // Both predicates treat done + skipped as "settled" — a skipped
  // step is an explicit decision to bypass, not a pending item.
  // Empty clusters (no actions / no stages) are also considered
  // settled (nothing to wait on).
  //
  // Exclude the Delivery action itself when computing the internal-
  // phase gate, since the system uses its completion as the close
  // signal — keeping it in would create a chicken/egg loop.
  const internalPhaseSettled = (() => {
    const settledStatuses = new Set(["done", "skipped"]);
    return data.actions
      .filter((a) => a.actionTypeName.toLowerCase() !== "delivery")
      .every((a) => settledStatuses.has(a.status));
  })();
  const pendingInternalCount = data.actions
    .filter((a) => a.actionTypeName.toLowerCase() !== "delivery")
    .filter((a) => a.status === "waiting" || a.status === "blocked")
    .length;

  const vinChaseSettled = data.vinChaseStages.every(
    (s) => s.status === "done" || s.status === "skipped",
  );
  const pendingVinCount = data.vinChaseStages.filter((s) => s.status === "waiting").length;

  return (
    <div className="mb-6 pb-5 border-b border-ink-100">
      {/* ── Two-column header ────────────────────────────────────
          Title rows and shipment details all live in the LEFT
          column so it has the same vertical span as the RIGHT
          action stack — no more dangling whitespace below the
          details while the buttons run on. Collapses to a single
          column on small screens. Right column hides entirely when
          batch is closed; the ClosedBanner below carries the final
          state. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr,16rem] gap-x-6 gap-y-4 items-start">
        {/* LEFT column — every required field clearly labeled so ops
            can find each datum at a glance:
              • PO Number + Batch X of Y
              • Model + year (large)
              • Dealer name
              • Quantity + per-city breakdown
              • PO availability + Ops projection
            Each field has a label so renamed/extended fields stay
            self-describing. */}
        <div className="space-y-2">
          {/* PO Number + Batch position — the primary identifiers. */}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {data.poNumber && (
              <p className="text-base font-mono font-semibold text-midnight tracking-tight">
                {data.poNumber}
              </p>
            )}
            {data.batchNumberInPo != null && data.totalBatchesInPo != null && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded
                           bg-brand-pastel text-brand-dark
                           text-[0.7rem] font-semibold uppercase tracking-wide"
                title={`This batch is #${data.batchNumberInPo} of ${data.totalBatchesInPo} batches under PO ${data.poNumber ?? "—"}`}
              >
                Batch {data.batchNumberInPo} / {data.totalBatchesInPo}
              </span>
            )}
          </div>

          {/* Batch name — the full slug, explicitly labelled. */}
          <p className="text-xs text-ink-600 flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-midnight">🏷️ Batch name:</span>
            <span className="font-mono text-midnight">{data.batchCode}</span>
          </p>

          {/* Model + year — large, prominent. */}
          <h2 className="text-xl font-bold text-midnight flex items-center gap-2">
            <span aria-hidden="true">🛠️</span>
            {data.modelYear}
          </h2>

          {/* Dealer name (labelled) + lifecycle chip. */}
          <p className="text-xs text-ink-600 flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-midnight">🏢 Dealer:</span>
            <span>{data.dealerName}</span>
            <Sep />
            <span className="uppercase tracking-wide text-ink-500">
              {data.lifecycleState === "pre_po" ? "Pre-PO" : "Post-PO"}
            </span>
          </p>

          {/* Quantity + per-city breakdown — same line when single-leg,
              second line when multi-leg so per-city is readable. */}
          <p className="text-xs text-ink-600 flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-midnight">🚚 Qty:</span>
            <span className="tabular-nums">{data.quantity}×</span>
            {data.legs.length > 0 && (
              <>
                <Sep />
                <span className="font-medium text-midnight">Per city:</span>
                {data.legs.map((leg, i) => (
                  <span key={leg.id} className="tabular-nums">
                    {leg.city} ({leg.requestedQuantity}
                    {leg.deliveredQuantity > 0 && (
                      <> · {leg.deliveredQuantity} delivered</>
                    )})
                    {i < data.legs.length - 1 && <span className="text-ink-400 ml-1">·</span>}
                  </span>
                ))}
              </>
            )}
          </p>

          {/* Slight visual gap before the date block. */}
          <div className="pt-1 space-y-2">
            <AvailabilityDatesLine data={data} />
            {/* Listed-state chip — visible whenever the batch was
                listed, including post-closure. After delivery the
                chip is still useful audit info ("when did this batch
                go live?") but the edit affordance hides so the
                timestamp can't be tampered with on a closed record. */}
            {isListed && appListingForm === false && (
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md
                              bg-green-pale border border-green/40
                              text-[0.7rem] font-medium text-green-dark">
                <span aria-hidden="true">📱</span>
                <span>Listed ·</span>
                <span className="tabular-nums">
                  {data.appListedAt ? fmtLocalDateTime(data.appListedAt) : "—"}
                </span>
                {!isClosed && (
                  <button
                    type="button"
                    onClick={() => setAppListingForm("edit")}
                    className="ml-1 text-green-dark hover:text-midnight"
                    title="Edit listing timestamp"
                    aria-label="Edit listing timestamp"
                  >
                    ✎
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT column — vertical action stack */}
        {!isClosed && (
          <div className="flex flex-col gap-2 lg:w-full">
            {/* Mark as listed — modal-trigger button. Hidden when the
                batch is already listed (the green "Listed · ✎" chip in
                the left column carries the edit affordance instead). */}
            {!isListed && (
              <button
                type="button"
                onClick={() => setAppListingForm("new")}
                disabled={!internalPhaseSettled}
                className={cn(
                  "text-sm font-medium px-3 py-2 rounded-md border w-full transition-colors",
                  internalPhaseSettled
                    ? "border-brand text-brand-dark bg-white hover:bg-brand-pastel"
                    // Disabled but ON-BRAND: muted brand-pastel fill, brand
                    // border at half-opacity, brand-dark text at ~70%.
                    // Keeps the button visually identified with "listing"
                    // (vs grey, which loses that association). Lock icon
                    // + "pending" count still communicates the gate.
                    : "border-brand/40 text-brand-dark/70 bg-brand-pastel/40 cursor-not-allowed",
                )}
                title={internalPhaseSettled
                  ? "Mark cars as listed in the app — opens a date/time picker"
                  : `Complete the Internal phase first — ${pendingInternalCount} action(s) still waiting or blocked. Mark them done or skipped to enable listing.`}
              >
                📱 Mark as listed
                {!internalPhaseSettled && (
                  <span className="ml-1 text-[0.65rem] font-normal">
                    🔒 {pendingInternalCount} pending
                  </span>
                )}
              </button>
            )}

            <button
              type="button"
              onClick={() => setShifting(true)}
              className="text-sm font-medium px-3 py-2 rounded-md
                         border border-gold text-gold-dark
                         bg-white hover:bg-gold-pale transition-colors
                         w-full"
              title="Shift the projected availability date — captures bookings + reason"
            >
              📅 Shift availability date
            </button>

            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="text-sm font-medium px-3 py-2 rounded-md
                         border border-flame bg-flame-pale text-flame-dark
                         hover:bg-flame hover:text-white hover:border-flame
                         transition-colors w-full"
              title="Cancel this batch — destructive. Ops can no longer update its actions."
            >
              🚫 Cancel batch
            </button>

            {/* Mark as delivered — visual anchor of the column.
                Larger padding, bolder, filled emerald, shadow.
                Gated on VIN chase completion: ops can't close a batch
                whose dealer-side chain isn't fully settled. */}
            <button
              type="button"
              onClick={() => setDelivering(true)}
              disabled={!vinChaseSettled}
              className={cn(
                "mt-1 text-base font-bold px-4 py-3 rounded-md border-2 transition-colors w-full flex items-center justify-center gap-2",
                vinChaseSettled
                  ? "bg-green-dark text-white border-green-dark hover:bg-green hover:border-green shadow-md"
                  // Disabled but ON-BRAND: muted green-pale fill, green
                  // border at half-opacity, green-dark text at ~70%.
                  // Keeps the button visually identified with "delivery"
                  // even when gated; the 🔒 + pending count carries the
                  // "not yet" signal.
                  : "bg-green-pale/50 text-green-dark/70 border-green/40 cursor-not-allowed",
              )}
              title={vinChaseSettled
                ? "Mark this batch delivered — opens the qty + colours confirmation"
                : `Complete the VIN chase first — ${pendingVinCount} stage(s) still waiting. Mark them done or skipped to enable delivery.`}
            >
              <span aria-hidden="true">🚚</span>
              <span>Mark as delivered</span>
              {!vinChaseSettled && (
                <span className="text-[0.7rem] font-normal opacity-80">
                  🔒 {pendingVinCount} pending
                </span>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Modals — same triggers, just consolidated up here. */}
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
      {shifting && (
        <DateShiftModal
          data={data}
          onClose={() => setShifting(false)}
          onShifted={() => {
            setShifting(false);
            onShifted();
          }}
        />
      )}
      {delivering && (
        <CarDeliveryModal
          data={data}
          onClose={() => setDelivering(false)}
          onDelivered={() => {
            setDelivering(false);
            onDelivered();
          }}
        />
      )}
      {appListingForm !== false && (
        <AppListingModal
          data={data}
          mode={appListingForm}
          onClose={() => setAppListingForm(false)}
          onSaved={() => {
            setAppListingForm(false);
            onAppListed();
          }}
        />
      )}
    </div>
  );
}

/**
 * App Listing date/time picker — modal popup. Matches the visual
 * pattern of DateShiftModal (header + body + footer in a card-shaped
 * dialog with a backdrop). Default value:
 *   • mode="new"   → NOW (so a single Enter / Confirm marks listed now)
 *   • mode="edit"  → the existing data.appListedAt (lets ops adjust)
 *
 * Submits to POST /api/batch-app-listing. Closes on click-outside,
 * Escape key, or Cancel button. Same UX shape as the Shift modal.
 */
function AppListingModal({
  data, mode, onClose, onSaved,
}: {
  data: DrawerData;
  mode: "new" | "edit";
  onClose: () => void;
  onSaved: () => void;
}) {
  // datetime-local format (LOCAL time, no offset): "YYYY-MM-DDTHH:MM"
  const seed = (() => {
    const source = mode === "edit" && data.appListedAt
      ? data.appListedAt
      : new Date().toISOString();
    const d = new Date(source);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();
  const [draftAt, setDraftAt] = useState(seed);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      const iso = draftAt ? new Date(draftAt).toISOString() : new Date().toISOString();
      const res = await fetch("/api/batch-app-listing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: data.batchId, appListedAt: iso }),
      });
      if (!res.ok) throw new Error(await res.text());
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  // Esc closes the modal — mirrors the standard dialog convention.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pending]);

  const title = mode === "edit" ? "✎ Edit App Listing timestamp" : "📱 Mark as listed";
  const ctaLabel = mode === "edit" ? "✓ Update timestamp" : "📱 Mark as listed";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-listing-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4
                 bg-midnight/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      <div className="w-full max-w-md bg-white rounded-lg shadow-2xl border-2 border-brand">
        <div className="bg-brand-pastel border-b-2 border-brand px-5 py-3 rounded-t-md">
          <h3 id="app-listing-modal-title" className="text-xl font-bold text-brand-dark">
            {title}
          </h3>
          <p className="text-xs text-ink-600 mt-0.5">
            {data.batchCode} · {data.quantity}× {data.modelYear}
          </p>
        </div>

        <div className="px-5 py-4 space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-ink-600 mb-1">
              Listing date &amp; time
              <span className="text-[0.65rem] font-normal text-ink-500 ml-1.5">
                (when cars first went live in the app)
              </span>
            </span>
            <input
              type="datetime-local"
              className="input tabular-nums"
              value={draftAt}
              onChange={(e) => setDraftAt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draftAt && !pending) confirm();
              }}
              disabled={pending}
              autoFocus
            />
            <span className="block text-[0.65rem] text-ink-500 mt-1">
              Defaults to now. Backdate if cars were already listed earlier.
            </span>
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
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={pending || !draftAt}
            className="text-sm font-semibold px-4 py-2 rounded-md text-white
                       bg-brand hover:bg-brand-dark disabled:opacity-50
                       border border-brand"
          >
            {pending ? "Saving…" : ctaLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Two-date readout under the drawer header:
 *   📅 PO availability  · 2026-04-15
 *      Ops projection   · 2026-04-20 (+5d)
 *
 * The PO date is what the dealer committed to (locked). The Ops date is
 * the live projection — mutated by the Shift Availability modal, each
 * change logged into `batch_date_revisions`. The signed delta surfaces
 * the slip/lead at a glance; colour matches the row status:
 *   negative (early) → green   ·   zero → muted   ·   positive (late) → flame
 *
 * If ops never set a projection, we show "—" and treat the delta as
 * zero (no slip yet).
 */
function AvailabilityDatesLine({ data }: { data: DrawerData }) {
  const po = data.promisedDate;
  const ops = data.currentProjectedDeliveryDate;
  const DAY_MS_LOCAL = 24 * 60 * 60 * 1000;
  const delta = po && ops
    ? Math.round((new Date(ops).getTime() - new Date(po).getTime()) / DAY_MS_LOCAL)
    : 0;
  const deltaCls = delta > 0 ? "text-flame-dark"
    : delta < 0 ? "text-green-dark"
    : "text-ink-500";
  const deltaText = delta === 0 ? "on plan"
    : delta > 0 ? `+${delta}d late`
    : `${delta}d early`;

  return (
    <p className="text-[0.7rem] text-ink-500 mt-1 flex flex-wrap items-baseline gap-x-3">
      <span className="font-medium text-midnight" aria-hidden="true">📅</span>
      <span>
        <span className="font-medium text-midnight">PO availability:</span>{" "}
        <span className="tabular-nums">{po}</span>
      </span>
      <span aria-hidden="true" className="text-ink-300">·</span>
      <span>
        <span className="font-medium text-midnight">Ops projection:</span>{" "}
        {ops
          ? <span className="tabular-nums">{ops}</span>
          : <span className="italic text-ink-400">—</span>}
      </span>
      {ops && (
        <span className={cn("tabular-nums font-medium", deltaCls)}>
          {deltaText}
        </span>
      )}
    </p>
  );
}

/**
 * Big-red cancel confirmation modal. Inline, no third-party deps —
 * simple fixed-position overlay. The dialog warns the operator clearly
 * and requires a deliberate action; an optional reason note goes onto
 * the batch for audit / Slack status checks.
 */
// ──────────────────────────────────────────────────────────────────
// Recommend-shift banner (Pattern C)
// ──────────────────────────────────────────────────────────────────
//
// Phase G: when a "VIN not received before availability" alert is
// firing on this batch, the engine knows the runway is too short to
// honour the current promised date. Rather than auto-pushing it
// (Pattern B) or asking ops to do the math (Pattern A), we surface a
// banner that names the recommended new date (today + lead time) and
// invites a one-click confirm — opens the Phase F shift modal with
// the recommended date pre-filled. Ops still owns the decision; the
// system removes the friction of remembering the math.

function RecommendShiftBanner({
  data, recommendedDate, onShifted,
}: {
  data: DrawerData;
  recommendedDate: string;
  onShifted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const previous = data.currentProjectedDeliveryDate ?? data.promisedDate;
  const DAY_MS_LOCAL = 24 * 60 * 60 * 1000;
  const recDelay = Math.round(
    (new Date(recommendedDate).getTime() - new Date(previous).getTime()) / DAY_MS_LOCAL,
  );

  return (
    <div className="rounded-md border-2 border-gold bg-gold-pale px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-start gap-2 min-w-0 flex-1">
        <span aria-hidden="true" className="text-lg leading-none mt-0.5">💡</span>
        <div className="min-w-0">
          <p className="text-sm font-bold text-gold-dark leading-snug">
            Recommend shifting availability date
          </p>
          <p className="text-xs text-ink-700 leading-snug mt-0.5">
            VIN not yet received and the safe runway has shrunk.
            Push availability from{" "}
            <span className="font-mono tabular-nums text-midnight">{previous}</span>{" "}
            to{" "}
            <span className="font-mono tabular-nums font-bold text-midnight">{recommendedDate}</span>{" "}
            (today + {data.prePoOpsLeadTimeDays}d
            {recDelay > 0 ? `, +${recDelay}d later` : recDelay < 0 ? `, ${recDelay}d earlier` : ", no change"})
            to restore the runway.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 text-sm font-semibold px-3 py-1.5 rounded-md text-white
                   bg-gold-dark hover:bg-gold border border-gold-dark"
        title="Open the shift modal with the recommended date pre-filled"
      >
        📅 Apply shift
      </button>
      {open && (
        <DateShiftModal
          data={data}
          recommendedDate={recommendedDate}
          onClose={() => setOpen(false)}
          onShifted={() => {
            setOpen(false);
            onShifted();
          }}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Date-shift modal — capture the projected-availability date shift
// ──────────────────────────────────────────────────────────────────
//
// Phase F: every shift to currentProjectedDeliveryDate writes a row to
// batch_date_revisions so the customer-impact metric is precise.
// Ops manually enters the bookings count at the shift moment (the
// number of customer bookings currently held against this batch); the
// reason text captures WHY the shift happened — both feed postmortems
// and the per-batch customer-days lost calculation in Reports (Phase H).
//
// The modal can be invoked directly from the drawer header ("📅 Shift
// availability date"), or in Phase G from a recommend-shift banner with
// a pre-filled new date. Both paths land on the same /api/batch-shift
// endpoint.
function DateShiftModal({
  data, onClose, onShifted, recommendedDate,
}: {
  data: DrawerData;
  onClose: () => void;
  onShifted: () => void;
  /** Optional pre-filled new date (Phase G's recommend-shift banner). */
  recommendedDate?: string;
}) {
  // The "previous" date is the current projection, falling back to the
  // dealer-promised date when ops hasn't set one yet (first shift).
  const previous = data.currentProjectedDeliveryDate ?? data.promisedDate;
  const [newDate, setNewDate] = useState<string>(
    recommendedDate || previous,
  );
  const [bookings, setBookings] = useState<number>(0);
  const [reason, setReason] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const DAY_MS_LOCAL = 24 * 60 * 60 * 1000;
  const delayDays = newDate && previous
    ? Math.round((new Date(newDate).getTime() - new Date(previous).getTime()) / DAY_MS_LOCAL)
    : 0;
  const isNoOp = delayDays === 0;
  const direction = delayDays > 0 ? `+${delayDays}d later` : delayDays < 0 ? `${delayDays}d earlier` : "no change";

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/batch-shift", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId: data.batchId,
          newProjectedDate: newDate,
          bookingsAtShift: bookings,
          reason: reason.trim() || null,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      onShifted();
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
      aria-labelledby="shift-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4
                 bg-midnight/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md bg-white rounded-lg shadow-2xl border-2 border-gold">
        <div className="bg-gold-pale border-b-2 border-gold px-5 py-3 rounded-t-md">
          <h3 id="shift-modal-title" className="text-xl font-bold text-gold-dark">
            📅 Shift availability date
          </h3>
          <p className="text-xs text-ink-600 mt-0.5">
            {data.batchCode} · {data.quantity}× {data.modelYear}
          </p>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs font-medium text-ink-600 mb-1">From</span>
              <input
                type="date"
                className="input tabular-nums"
                value={previous}
                disabled
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-ink-600 mb-1">To</span>
              <input
                type="date"
                className="input tabular-nums"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
                disabled={pending}
              />
            </label>
          </div>
          <p className={cn(
            "text-xs font-medium tabular-nums",
            isNoOp ? "text-ink-500"
              : delayDays > 0 ? "text-flame-dark"
              : "text-green-dark",
          )}>
            Shift: {direction}
          </p>

          <label className="block">
            <span className="block text-xs font-medium text-ink-600 mb-1">
              Bookings at shift
              <span className="text-[0.65rem] font-normal text-ink-500 ml-1.5">
                (customers booked against this batch right now)
              </span>
            </span>
            <input
              type="number"
              min={0}
              className="input tabular-nums"
              value={bookings}
              onChange={(e) => setBookings(parseInt(e.target.value || "0", 10))}
              disabled={pending}
            />
            <span className="block text-[0.65rem] text-ink-500 mt-1">
              Used to compute customer-days lost: {bookings} × {Math.max(0, delayDays)}d ={" "}
              <span className="font-medium text-midnight">{Math.max(0, bookings * delayDays)}</span> customer-day(s).
            </span>
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-ink-600 mb-1">
              Reason (optional)
            </span>
            <textarea
              className="input min-h-[64px]"
              placeholder="e.g. VIN delay from dealer, internal Specs backlog…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
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
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={pending || !newDate}
            className="text-sm font-semibold px-4 py-2 rounded-md text-white
                       bg-gold-dark hover:bg-gold disabled:opacity-50
                       border border-gold-dark"
          >
            {pending ? "Applying…" : "📅 Apply shift"}
          </button>
        </div>
      </div>
    </div>
  );
}

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

// Ops Confidence row removed per user feedback. The slider + the
// /api/batch-confidence endpoint still exist in case we want to bring
// it back — restore by re-rendering <ConfidenceRow .../> in the
// drawer main return. (Component intentionally deleted to keep the
// file lean while it's not in use.)

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
  const internalActions = actionsOverride ?? data.actions;
  const vinStages = data.vinChaseStages;
  if (internalActions.length === 0 && vinStages.length === 0) {
    return (
      <p className="text-sm text-ink-500 italic">
        No actions yet. {data.lifecycleState === "pre_po"
          ? "This batch is a Pre-PO bet — actions are picked at Intake when the PO arrives."
          : "Pick actions at Intake."}
      </p>
    );
  }

  // Two clusters render the drawer's two-flow mental model.
  //   • Internal phase — parallel admin work (Specs / Pricing / SKU /
  //     etc.) driven by `batch_actions`. Kanban variant; status flips
  //     hit /api/batch-action. Surfaces FIRST — ops wraps the
  //     paperwork before the dealer-side chain matters.
  //   • VIN chase — a strict linear chain driven by the `vin_chase_stages`
  //     table (its own catalogue, configured in Settings). One active
  //     step at a time; status flips hit /api/vin-stage.
  return (
    <div className="space-y-6">
      {internalActions.length > 0 && (
        <ClusterSection
          title="🏢 Internal phase"
          subtitle="Specs · Pricing · SKU — runs in parallel"
          accent="brand"
          variant="kanban"
          actions={internalActions}
          alertsByActionId={alertsByActionId}
          onMutated={onMutated}
          layout={layout}
          disabled={disabled}
          lifecycleState={data.lifecycleState}
        />
      )}
      {vinStages.length > 0 && (
        <ClusterSection
          title="🔑 VIN chase"
          subtitle="Strict linear chain — only one step active at a time"
          accent="gold"
          variant="stepper"
          actions={[]}
          vinStages={vinStages}
          batchId={data.batchId}
          alertsByActionId={alertsByActionId}
          onMutated={onMutated}
          layout={layout}
          disabled={disabled}
          lifecycleState={data.lifecycleState}
        />
      )}
    </div>
  );
}

/**
 * One cluster section — title bar with summary counts + the existing
 * Waiting/Blocked/Done/Skipped sub-grouping inside.
 */
function ClusterSection({
  title, subtitle, accent, variant, actions, vinStages, batchId, alertsByActionId, onMutated, layout, disabled, lifecycleState,
}: {
  title: string;
  subtitle: string;
  accent: "brand" | "gold";
  /**
   * `kanban`  — actions render as Waiting/Blocked/Done sub-groups
   *             (used for Internal phase where work runs in parallel).
   * `stepper` — actions render as a numbered chain with one active
   *             step at a time (used for VIN chase, which is strictly
   *             linear: VIN → Plate → Customs → Tracking → Inspection
   *             → Showroom Ready).
   */
  variant: "kanban" | "stepper";
  /** Internal-phase batch_actions. Empty for the stepper variant. */
  actions: ActionDetail[];
  /**
   * Per-batch VIN chase stages — one item per row in `batch_vin_stages`
   * joined with `vin_chase_stages`. Required for the stepper variant,
   * ignored otherwise. Each row already represents this batch's state
   * (status, completedAt) so the stepper doesn't need to look anything
   * else up.
   */
  vinStages?: DrawerData["vinChaseStages"];
  /** Needed by the stepper so mutations can identify their batch. */
  batchId?: number;
  alertsByActionId: Map<number, ActiveAlert[]>;
  onMutated: () => void;
  layout: "vertical" | "kanban";
  disabled: boolean;
  lifecycleState: DrawerData["lifecycleState"];
}) {
  const groups = {
    waiting: actions.filter((a) => a.status === "waiting"),
    blocked: actions.filter((a) => a.status === "blocked"),
    done:    actions.filter((a) => a.status === "done"),
    skipped: actions.filter((a) => a.status === "skipped"),
  };

  const accentBorder = accent === "gold" ? "border-gold/50" : "border-brand/40";
  const accentBg     = accent === "gold" ? "bg-gold-pale/40" : "bg-brand-pastel/30";
  const accentText   = accent === "gold" ? "text-gold-dark" : "text-brand-dark";

  // Header summary — done / total + count of unfinished. Stepper counts
  // vinStages (its own catalogue); kanban counts batch_actions.
  const stagesList = vinStages ?? [];
  const stagesDone    = stagesList.filter((s) => s.status === "done").length;
  const stagesSkipped = stagesList.filter((s) => s.status === "skipped").length;
  const total = variant === "stepper" ? stagesList.length : actions.length;
  const done  = variant === "stepper" ? stagesDone : groups.done.length;
  const pending = variant === "stepper"
    ? stagesList.length - stagesDone - stagesSkipped
    : groups.waiting.length + groups.blocked.length;

  // Each cluster is independently collapsible. Default expanded —
  // when ops opens the drawer they're here to act on actions. They
  // can collapse a cluster to focus on the other (e.g. collapse
  // Internal phase once it's all done to declutter VIN-chase view).
  const [expanded, setExpanded] = useState(true);

  return (
    <section className={cn("rounded-md border-2", accentBorder, accentBg)}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full text-left px-3 py-2 border-b border-current/15
                   focus-visible:outline-2 focus-visible:outline-brand
                   focus-visible:outline-offset-[-2px]
                   hover:bg-white/30 transition-colors rounded-t-md"
        title={expanded ? "Click to collapse" : "Click to expand"}
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-2 min-w-0">
            <span
              aria-hidden="true"
              className={cn("text-xs leading-none shrink-0", accentText)}
            >
              {expanded ? "▾" : "▸"}
            </span>
            <div className="min-w-0">
              <h3 className={cn("text-sm font-bold", accentText)}>{title}</h3>
              {expanded && (
                <p className="text-[0.7rem] text-ink-500 leading-snug">{subtitle}</p>
              )}
            </div>
          </div>
          <p className="text-[0.7rem] text-ink-600 tabular-nums whitespace-nowrap shrink-0">
            {done}/{total} done
            {pending > 0 && (
              <>
                <span aria-hidden="true" className="mx-1 text-ink-400">·</span>
                <span className={cn("font-medium", pending > 0 ? accentText : "")}>
                  {pending} pending
                </span>
              </>
            )}
          </p>
        </div>
      </button>

      {expanded && (
        <div className="p-3">
          {variant === "stepper" ? (
            <VinChaseStepper
              stages={stagesList}
              batchId={batchId}
              onMutated={onMutated}
              disabled={disabled}
            />
          ) : (
            <ClusterBody
              groups={groups}
              alertsByActionId={alertsByActionId}
              onMutated={onMutated}
              layout={layout}
              disabled={disabled}
              lifecycleState={lifecycleState}
            />
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Inner per-status grouping for a cluster. Mirrors the previous root
 * ActionsList rendering but scoped to one cluster's groups.
 */
function ClusterBody({
  groups, alertsByActionId, onMutated, layout, disabled, lifecycleState: _lifecycleState,
}: {
  groups: { waiting: ActionDetail[]; blocked: ActionDetail[]; done: ActionDetail[]; skipped: ActionDetail[] };
  alertsByActionId: Map<number, ActiveAlert[]>;
  onMutated: () => void;
  layout: "vertical" | "kanban";
  disabled: boolean;
  lifecycleState: DrawerData["lifecycleState"];
}) {
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

// ──────────────────────────────────────────────────────────────────
// VIN-chase stepper — strict linear flow renderer
// ──────────────────────────────────────────────────────────────────
//
// Driven directly by `vin_chase_stages` (canonical catalogue) joined
// with `batch_vin_stages` (per-batch state) — see lib/action-center-data.ts.
// One stage active at a time; status flips hit /api/vin-stage. Order is
// `vin_chase_stages.sortOrder`, edited in Settings → VIN Chase Stages.

function VinChaseStepper({
  stages, batchId, onMutated, disabled,
}: {
  /** Per-batch chain — already joined + ordered. Each row carries its own state. */
  stages: DrawerData["vinChaseStages"];
  batchId?: number;
  onMutated: () => void;
  disabled: boolean;
}) {
  // "Current" = first stage whose status is neither done nor skipped.
  const currentIdx = stages.findIndex((s) => s.status !== "done" && s.status !== "skipped");

  return (
    <ol className="space-y-2">
      {stages.map((s, i) => {
        const isDone    = s.status === "done";
        const isSkipped = s.status === "skipped";
        const isCurrent = i === currentIdx;
        const isUpcoming = !isDone && !isSkipped && !isCurrent;
        return (
          <li key={`stage-${s.id}`}>
            <VinStepperRow
              stepNumber={i + 1}
              stage={s}
              batchId={batchId}
              state={
                isDone     ? "done"
                : isSkipped ? "skipped"
                : isCurrent ? "current"
                : "upcoming"
              }
              onMutated={onMutated}
              disabled={disabled || isUpcoming}
              showActions={isCurrent && !disabled}
            />
          </li>
        );
      })}
    </ol>
  );
}

function VinStepperRow({
  stepNumber, stage, batchId, state, onMutated, disabled, showActions,
}: {
  stepNumber: number;
  stage: DrawerData["vinChaseStages"][number];
  batchId?: number;
  state: "done" | "current" | "upcoming" | "skipped";
  onMutated: () => void;
  disabled: boolean;
  showActions: boolean;
}) {
  const [pending, setPending] = useState(false);

  async function setStatus(newStatus: "done" | "skipped" | "waiting") {
    setPending(true);
    try {
      const body: Record<string, unknown> = {
        batchVinStageId: stage.id,
        newStatus,
      };
      if (newStatus === "done") {
        body.newCompletedAt = new Date().toISOString();
      }
      const res = await fetch("/api/vin-stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      onMutated();
    } catch (e) {
      alert(`Could not update: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPending(false);
    }
  }

  // Visual tokens per state.
  const visuals = {
    done:     { rowCls: "bg-green-pale border-green",           iconCls: "bg-green-dark text-white",        icon: "✓",  labelCls: "text-green-dark" },
    current:  { rowCls: "bg-brand-pastel border-brand shadow",  iconCls: "bg-brand text-white",             icon: "●",  labelCls: "text-midnight" },
    upcoming: { rowCls: "bg-white border-ink-200 opacity-50",   iconCls: "bg-ink-100 text-ink-500",         icon: "",   labelCls: "text-ink-500" },
    skipped:  { rowCls: "bg-ink-100 border-ink-200 opacity-60", iconCls: "bg-ink-300 text-white",           icon: "⏭", labelCls: "text-ink-500 line-through" },
  }[state];

  const labelText = state === "done" ? stage.doneLabel : stage.waitingLabel;

  return (
    <div className={cn("flex items-start gap-3 px-3 py-2 rounded-md border", visuals.rowCls)}>
      <div className="flex flex-col items-center gap-0.5 shrink-0 pt-0.5">
        <span className={cn(
          "h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold leading-none",
          visuals.iconCls,
        )}>
          {visuals.icon || stepNumber}
        </span>
        <span className="text-[0.6rem] text-ink-400 tabular-nums">{stepNumber}</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className={cn("text-sm font-medium leading-snug", visuals.labelCls)}>
          {labelText}
        </p>
        <p className="text-[0.7rem] text-ink-500 mt-0.5 flex flex-wrap items-center gap-x-2">
          {state === "done" && stage.completedAt && (
            <span className="tabular-nums text-green-dark">
              ✓ {fmtLocalDateTime(stage.completedAt)}
            </span>
          )}
          {state === "upcoming" && (
            <span className="italic text-ink-400">— waiting for the previous step</span>
          )}
        </p>
      </div>
      {showActions && (
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            disabled={pending || disabled}
            onClick={() => setStatus("done")}
            className="btn btn-primary text-xs"
            title="Mark this step done and advance to the next"
          >
            {pending ? "…" : "✓ Mark done"}
          </button>
          <button
            type="button"
            disabled={pending || disabled}
            onClick={() => setStatus("skipped")}
            className="btn text-xs"
            title="Skip this step — the next step still becomes active"
          >
            Skip
          </button>
        </div>
      )}
      {/*
        Revert — undo Mark done. Visible on every "done" row.
      */}
      {state === "done" && !disabled && (
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (!confirm("Revert this step back to waiting?")) return;
              setStatus("waiting");
            }}
            className="btn text-xs"
            title="Undo Mark done — flips this step back to waiting"
          >
            {pending ? "…" : "↩ Revert"}
          </button>
        </div>
      )}
      {/* batchId is required so the form posts correctly; in practice it's
          always present, but keep the prop defensive on the assumption
          some callers might omit it. */}
      {!batchId && null}
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

  // Pick the highest-severity alert for the row's visual treatment.
  const SEV_RANK: Record<ActiveAlert["severity"], number> = { critical: 4, high: 3, medium: 2, info: 1 };
  const sortedAlerts = [...alerts].sort(
    (a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity],
  );
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
          className="text-sm shrink-0 leading-none"
          title={`${alerts.length} active alert${alerts.length === 1 ? "" : "s"}`}
        >
          {topVisuals.icon}
        </span>
      )}
      <span className="truncate">{labelText}</span>
    </p>
  );

  // The inline alert detail block was dropped — the row already signals
  // lateness via the severity icon on the title + the `+Xd` chip in the
  // meta line, so the pill was redundant. The severity icon stays as a
  // quick scan signal; the `alerts` array is still consulted for it.

  if (compact) {
    // Kanban card: meta + buttons stacked vertically so a narrow column fits.
    return (
      <div className={cn("rounded-md border bg-white px-3 py-2", borderTone)}>
        {Title}
        {Meta}
        <div className="mt-2">{Buttons}</div>
      </div>
    );
  }

  // Vertical (default): meta + buttons side by side, wrap on narrow.
  return (
    <div className={cn("flex flex-wrap items-center gap-3 px-3 py-2 rounded-md border bg-white", borderTone)}>
      <div className="flex-1 min-w-[10rem]">
        {Title}
        {Meta}
      </div>
      {Buttons}
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

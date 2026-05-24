"use client";

/**
 * Action Center · Flow — minimal version.
 *
 * Each batch shows its External-Phase actions as a stacked list of one-
 * line chips. Per chip, ops gets exactly ONE primary control:
 *
 *   • VIN action          → number input (per-leg if multi-city)
 *   • Confirmation action → number input
 *   • Anything else       → "📞 Log contact"   or   "✓ Mark done"
 *
 * Tertiary affordances (backdate, undo, history) live in compact
 * out-of-the-way controls so the row stays scannable. Channel /
 * direction / outcome / escalate selectors are removed — touchpoint
 * defaults to a generic outbound contact with +1d follow-up. If ops
 * needs finer control later, the main Action Center still has it.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActionFlowData } from "@/lib/action-flow-data";
import {
  augmentActions,
  type FlowAction,
  type FlowState,
  type Touchpoint,
} from "@/lib/action-flow-shared";
import type { PoNode, BatchNode, WaveNode, ScopedActionDetail } from "@/lib/action-center-tree-data";
import { cn } from "@/lib/utils";

interface Props { data: ActionFlowData }

export default function ActionFlowShell({ data }: Props) {
  const { tree, touchpointsByAction } = data;
  const router = useRouter();
  const augment = (actions: ScopedActionDetail[]) =>
    augmentActions(actions, touchpointsByAction);

  // PO picker — flat list of External-Phase-eligible POs.
  const allPos = useMemo(() => {
    const flat: { po: PoNode; dealerName: string }[] = [];
    for (const d of tree.dealers) {
      for (const p of d.pos) {
        if (p.isPrePo) continue;
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

  // Optional backdate — hidden behind a toggle so it doesn't clutter
  // the default view. When set, every subsequent log/qty save stamps
  // with this exact moment instead of "now".
  const [backdateOpen, setBackdateOpen] = useState<boolean>(false);
  const [backdateAt, setBackdateAt] = useState<string>("");

  // Undo banner — single, compact, 10s after each successful action.
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  interface LastAction { touchpointId: number; label: string; expiresAt: number }
  const [lastAction, setLastAction] = useState<LastAction | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!lastAction) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [lastAction]);
  useEffect(() => {
    if (lastAction && now >= lastAction.expiresAt) setLastAction(null);
  }, [lastAction, now]);

  function backdateIso(): string | null {
    return backdateAt ? new Date(backdateAt).toISOString() : null;
  }

  async function logContact(action: FlowAction, label: string): Promise<void> {
    setBusyId(action.id);
    setError(null);
    try {
      const res = await fetch("/api/action-touchpoint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId:       action.id,
          channel:        "other",
          direction:      "outbound",
          outcome:        "no_response",
          nextFollowupAt: addDays(1),
          contactedAt:    backdateIso(),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as { touchpoint?: { id: number } };
      if (data.touchpoint?.id) {
        setLastAction({
          touchpointId: data.touchpoint.id,
          label:        `📞 ${label} — contact logged`,
          expiresAt:    Date.now() + 10_000,
        });
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function escalate(action: FlowAction, label: string): Promise<void> {
    setBusyId(action.id);
    setError(null);
    try {
      const res = await fetch("/api/action-touchpoint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId:       action.id,
          channel:        "other",
          direction:      "internal",
          outcome:        "other",
          escalated:      true,
          note:           "Escalated",
          nextFollowupAt: addDays(2),
          contactedAt:    backdateIso(),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as { touchpoint?: { id: number } };
      if (data.touchpoint?.id) {
        setLastAction({
          touchpointId: data.touchpoint.id,
          label:        `↗ ${label} — escalated`,
          expiresAt:    Date.now() + 10_000,
        });
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function markDone(action: FlowAction, label: string): Promise<void> {
    setBusyId(action.id);
    setError(null);
    try {
      const res = await fetch("/api/scope-action", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId:    action.id,
          status:      "done",
          completedAt: backdateIso(),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function undoLast(): Promise<void> {
    if (!lastAction) return;
    const id = lastAction.touchpointId;
    setLastAction(null);
    try {
      await fetch("/api/action-touchpoint", {
        method:  "DELETE",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ id }),
      });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-3">
      {/* PO picker + tiny backdate toggle */}
      <div className="card flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-ink-700">PO</label>
        <select
          value={selectedPoId ?? ""}
          onChange={(e) => setSelectedPoId(e.target.value ? parseInt(e.target.value, 10) : null)}
          className="text-sm px-2 py-1 border border-ink-300 rounded-md bg-white min-w-[260px]"
        >
          {allPos.length === 0 && <option value="">No live POs</option>}
          {allPos.map(({ po, dealerName }) => (
            <option key={po.id} value={po.id}>
              {po.poNumber} — {dealerName}{po.closedAt ? " (closed)" : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setBackdateOpen((v) => !v)}
          className={cn(
            "ml-auto text-[0.65rem] px-2 py-1 rounded-md border",
            backdateAt
              ? "border-gold text-gold-dark bg-gold-pale/40"
              : "border-ink-300 text-ink-600 bg-white hover:bg-ink-50",
          )}
          title="Backdate every log on this page"
        >
          {backdateAt ? `⏮ ${backdateAt.replace("T", " ")}` : "🕒 Live"}
        </button>
      </div>

      {backdateOpen && (
        <div className="card flex flex-wrap items-center gap-2 text-[0.7rem]">
          <span className="text-ink-600">Backdate to</span>
          <input
            type="datetime-local"
            value={backdateAt}
            onChange={(e) => setBackdateAt(e.target.value)}
            className="px-2 py-0.5 border border-ink-300 rounded tabular-nums"
          />
          {backdateAt && (
            <button
              type="button"
              onClick={() => setBackdateAt("")}
              className="text-ink-600 hover:text-midnight underline"
            >
              Clear
            </button>
          )}
          <span className="text-ink-500 italic ml-auto">Applies to all logs until cleared.</span>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-flame-dark bg-flame-pale border border-flame px-3 py-2 rounded-md">
          {error}
        </p>
      )}

      {lastAction && now < lastAction.expiresAt && (
        <div
          role="status"
          className="flex items-center gap-2 text-xs bg-green-pale border border-green px-3 py-1.5 rounded-md"
        >
          <span>✓ {lastAction.label}</span>
          <span className="text-ink-500 tabular-nums">
            · {Math.max(0, Math.ceil((lastAction.expiresAt - now) / 1000))}s
          </span>
          <button
            type="button"
            onClick={undoLast}
            className="ml-auto text-[0.7rem] px-2 py-0.5 rounded border border-flame text-flame-dark hover:bg-flame-pale font-medium"
          >
            ↶ Undo
          </button>
        </div>
      )}

      {!selected ? (
        <p className="text-sm text-ink-500 italic">Pick a PO above to load its External-Phase actions.</p>
      ) : selected.po.waves.length === 0 ? (
        <p className="text-sm text-ink-500 italic">No delivery windows on this PO yet.</p>
      ) : (
        selected.po.waves.map((wave) => (
          <WaveBlock
            key={wave.id}
            wave={wave}
            augment={augment}
            busyId={busyId}
            backdateAt={backdateAt}
            onLogContact={logContact}
            onEscalate={escalate}
            onMarkDone={markDone}
            onQtyChanged={() => { setLastAction(null); router.refresh(); }}
          />
        ))
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Wave block
// ─────────────────────────────────────────────────────────────────

function WaveBlock({
  wave, augment, busyId, backdateAt, onLogContact, onEscalate, onMarkDone, onQtyChanged,
}: {
  wave: WaveNode;
  augment: (actions: ScopedActionDetail[]) => FlowAction[];
  busyId: number | null;
  backdateAt: string;
  onLogContact: (a: FlowAction, label: string) => Promise<void>;
  onEscalate:   (a: FlowAction, label: string) => Promise<void>;
  onMarkDone:   (a: FlowAction, label: string) => Promise<void>;
  onQtyChanged: () => void;
}) {
  return (
    <section className="card !p-0 overflow-hidden">
      <header className="px-3 py-1.5 border-b border-ink-200 bg-ink-50/50 flex flex-wrap items-baseline gap-2 text-xs">
        <span className="font-semibold text-midnight">
          📅 {wave.opsExpectedDate ?? wave.availabilityDate}
        </span>
        <span className="text-ink-500 tabular-nums">
          {wave.batches.length} batch{wave.batches.length === 1 ? "" : "es"}
        </span>
      </header>
      <ul className="divide-y divide-ink-200">
        {wave.batches.map((b) => (
          <BatchBlock
            key={b.id}
            batch={b}
            wave={wave}
            augment={augment}
            busyId={busyId}
            backdateAt={backdateAt}
            onLogContact={onLogContact}
            onEscalate={onEscalate}
            onMarkDone={onMarkDone}
            onQtyChanged={onQtyChanged}
          />
        ))}
      </ul>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// Batch block
// ─────────────────────────────────────────────────────────────────

function BatchBlock({
  batch, wave, augment, busyId, backdateAt, onLogContact, onEscalate, onMarkDone, onQtyChanged,
}: {
  batch: BatchNode;
  wave: WaveNode;
  augment: (actions: ScopedActionDetail[]) => FlowAction[];
  busyId: number | null;
  backdateAt: string;
  onLogContact: (a: FlowAction, label: string) => Promise<void>;
  onEscalate:   (a: FlowAction, label: string) => Promise<void>;
  onMarkDone:   (a: FlowAction, label: string) => Promise<void>;
  onQtyChanged: () => void;
}) {
  const waveTypeIds = new Set(wave.actions.map((a) => a.actionTypeId));
  const batchScope = batch.actions.filter((a) => waveTypeIds.has(a.actionTypeId));
  const isBatchScopeRow = batchScope.length > 0;
  const augmented = augment(batchScope.length > 0 ? batchScope : wave.actions);
  const cars = batch.requestedQuantity;

  // Per-batch roll-up so ops sees totals without scanning every chip.
  // Sum across the chips actually rendered here (matches what the user
  // sees, not the entire DB).
  const totalContacts    = augmented.reduce((n, a) => n + a.contactCount, 0);
  const totalEscalations = augmented.reduce((n, a) => n + a.escalationCount, 0);

  return (
    <li className="px-3 py-2 space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[0.7rem]">
        <code className="text-[0.75rem] text-midnight font-mono font-semibold">{batch.batchCode}</code>
        <span className="text-midnight">{batch.modelYear}</span>
        <span className="text-ink-500 tabular-nums">{cars} cars</span>
        {(batch.confirmedQuantity ?? 0) > 0 && (
          <span className="text-ink-500 tabular-nums">· ✅ {batch.confirmedQuantity}/{cars}</span>
        )}
        {(batch.vinsReceivedQuantity ?? 0) > 0 && (
          <span className="text-ink-500 tabular-nums">· 🔑 {batch.vinsReceivedQuantity}/{cars}</span>
        )}
        {totalContacts > 0 && (
          <span className="text-ink-500 tabular-nums" title="Total touchpoints across this batch">
            · 📞 {totalContacts}
          </span>
        )}
        {totalEscalations > 0 && (
          <span className="text-flame-dark tabular-nums" title="Total escalations across this batch">
            · ↗ {totalEscalations}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {augmented
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((a) => (
            <FlowChip
              key={a.id}
              action={a}
              batch={batch}
              isBatchScopeRow={isBatchScopeRow}
              busy={busyId === a.id}
              backdateAt={backdateAt}
              onLogContact={onLogContact}
              onEscalate={onEscalate}
              onMarkDone={onMarkDone}
              onQtyChanged={onQtyChanged}
            />
          ))}
      </div>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────
// FlowChip — one row, one primary CTA
// ─────────────────────────────────────────────────────────────────

const FLOW_TONE: Record<FlowState, { cls: string; dot: string }> = {
  fresh:              { cls: "border-ink-300 bg-white",          dot: "bg-ink-300" },
  contacted_waiting:  { cls: "border-brand bg-brand-pastel/30",  dot: "bg-brand" },
  stalled:            { cls: "border-flame bg-flame-pale/40",    dot: "bg-flame" },
  partial_response:   { cls: "border-gold bg-gold-pale/40",      dot: "bg-gold" },
  confirmed_pending:  { cls: "border-green bg-green-pale/40",    dot: "bg-green" },
  escalated:          { cls: "border-flame bg-flame-pale/50",    dot: "bg-flame-dark" },
  blocked:            { cls: "border-flame bg-flame-pale/30",    dot: "bg-flame-dark" },
  done:               { cls: "border-green bg-green-pale/50",    dot: "bg-green-dark" },
  skipped:            { cls: "border-ink-300 bg-ink-50 opacity-70", dot: "bg-ink-400" },
};

function FlowChip({
  action, batch, isBatchScopeRow, busy, backdateAt, onLogContact, onEscalate, onMarkDone, onQtyChanged,
}: {
  action: FlowAction;
  batch: BatchNode;
  isBatchScopeRow: boolean;
  busy: boolean;
  backdateAt: string;
  onLogContact: (a: FlowAction, label: string) => Promise<void>;
  onEscalate:   (a: FlowAction, label: string) => Promise<void>;
  onMarkDone:   (a: FlowAction, label: string) => Promise<void>;
  onQtyChanged: () => void;
}) {
  const tone = FLOW_TONE[action.flowState];
  const label = action.doneLabel || action.waitingLabel;
  const isDone = action.status === "done" || action.status === "skipped";
  const isVin          = /vin/i.test(action.actionTypeName);
  const isConfirmation = /confirmation/i.test(action.actionTypeName);
  const qtyKind: "vin" | "confirmation" | null
    = isVin ? "vin" : isConfirmation ? "confirmation" : null;

  return (
    <div className={cn(
      "rounded-md border px-2.5 py-1.5 flex items-center gap-x-2 gap-y-1 flex-wrap text-xs",
      tone.cls,
      busy && "opacity-50 cursor-wait",
    )}>
      <span className={cn("h-2 w-2 rounded-full shrink-0", tone.dot)} aria-hidden />
      <span className="font-medium text-midnight">{label}</span>

      {/* Metric badges — the three numbers ops asked for. Keep them
          compact (badge-style) so they don't dominate the chip but
          remain instantly scannable: "did anyone call? how many times?
          escalated? how long did it take to close?". */}
      {action.contactCount > 0 && (
        <span
          className="text-[0.65rem] tabular-nums text-ink-700 bg-ink-50 border border-ink-200 rounded px-1"
          title={`${action.contactCount} touchpoint${action.contactCount === 1 ? "" : "s"} logged`}
        >
          📞 {action.contactCount}
        </span>
      )}
      {action.escalationCount > 0 && (
        <span
          className="text-[0.65rem] tabular-nums text-flame-dark bg-flame-pale border border-flame rounded px-1"
          title={`${action.escalationCount} escalation${action.escalationCount === 1 ? "" : "s"}`}
        >
          ↗ {action.escalationCount}
        </span>
      )}
      {action.daysSinceLastContact != null && !isDone && (
        <span className="text-[0.65rem] tabular-nums text-ink-500" title="Days since last contact">
          {action.daysSinceLastContact}d ago
        </span>
      )}
      {action.daysToConfirm != null && (
        <span
          className="text-[0.65rem] tabular-nums text-green-dark bg-green-pale border border-green rounded px-1"
          title="Days from first contact to confirmation"
        >
          ⏱ {action.daysToConfirm}d to confirm
        </span>
      )}

      {/* Right side — actions. */}
      <div className="ml-auto flex items-center gap-1">
        {qtyKind && !isDone ? (
          <QtyInline
            kind={qtyKind}
            batch={batch}
            actionId={isBatchScopeRow ? action.id : null}
            backdateAt={backdateAt}
            onSaved={onQtyChanged}
          />
        ) : !isDone ? (
          <>
            <button
              type="button"
              onClick={() => onLogContact(action, label)}
              disabled={busy}
              className="text-[0.7rem] px-2 py-0.5 rounded border border-ink-300 text-ink-700 hover:bg-ink-50 bg-white"
            >
              📞 Contact
            </button>
            <button
              type="button"
              onClick={() => onEscalate(action, label)}
              disabled={busy}
              className="text-[0.7rem] px-1.5 py-0.5 rounded border border-flame text-flame-dark hover:bg-flame-pale bg-white"
              title="Log an internal escalation"
            >
              ↗
            </button>
            <button
              type="button"
              onClick={() => onMarkDone(action, label)}
              disabled={busy}
              className="text-[0.7rem] px-2 py-0.5 rounded border border-green text-green-dark hover:bg-green-pale bg-white"
            >
              ✓ Done
            </button>
          </>
        ) : (
          <span className="text-[0.65rem] uppercase tracking-wide text-ink-500">{action.status}</span>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Inline qty input — VIN (per-leg or scalar) / Confirmation (scalar)
// ─────────────────────────────────────────────────────────────────

function QtyInline({
  kind, batch, actionId, backdateAt, onSaved,
}: {
  kind: "vin" | "confirmation";
  batch: BatchNode;
  actionId: number | null;
  backdateAt: string;
  onSaved: () => void;
}) {
  const multiLeg = kind === "vin" && batch.legs.length >= 2;
  const [open, setOpen] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  const current = kind === "vin"
    ? (batch.vinsReceivedQuantity ?? 0)
    : (batch.confirmedQuantity ?? 0);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[0.7rem] px-2 py-0.5 rounded border border-brand text-brand-dark hover:bg-brand-pastel bg-white tabular-nums"
        title={kind === "vin" ? "Record VINs received" : "Record dealer confirmation count"}
      >
        {kind === "vin" ? "🔑" : "✅"} {current}/{batch.requestedQuantity}
      </button>
    );
  }

  return (
    <QtyForm
      kind={kind}
      batch={batch}
      busy={busy}
      err={err}
      onCancel={() => { setOpen(false); setErr(null); }}
      onSubmit={async (payload) => {
        setBusy(true);
        setErr(null);
        try {
          if (kind === "vin") {
            const body = payload.legs
              ? { batchId: batch.id, legs: payload.legs, ...(actionId ? { actionId } : {}) }
              : { batchId: batch.id, vinsReceivedQuantity: payload.qty, ...(actionId ? { actionId } : {}) };
            const r = await fetch("/api/batch-vins-received", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            if (!r.ok) throw new Error(await r.text());
          } else {
            const r = await fetch("/api/batch-confirmation", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                batchId: batch.id,
                confirmedQuantity: payload.qty,
                ...(actionId ? { actionId } : {}),
              }),
            });
            if (!r.ok) throw new Error(await r.text());
          }
          setOpen(false);
          onSaved();
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }}
      multiLeg={multiLeg}
      // backdateAt is intentionally unused at the qty endpoints — those
      // stamp updatedAt server-side. Kept in the prop chain so the
      // shell's backdate toggle continues to apply to touchpoint logs.
      backdateAt={backdateAt}
    />
  );
}

function QtyForm({
  kind, batch, busy, err, onCancel, onSubmit, multiLeg, backdateAt: _backdateAt,
}: {
  kind: "vin" | "confirmation";
  batch: BatchNode;
  busy: boolean;
  err: string | null;
  onCancel: () => void;
  onSubmit: (payload: { qty: number; legs?: { id: number; vinsReceivedQuantity: number }[] }) => Promise<void>;
  multiLeg: boolean;
  backdateAt: string;
}) {
  const [legQtys, setLegQtys] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {};
    for (const l of batch.legs) {
      init[l.id] = String(l.vinsReceivedQuantity > 0 ? l.vinsReceivedQuantity : l.quantity);
    }
    return init;
  });
  const initialScalar = kind === "vin"
    ? ((batch.vinsReceivedQuantity ?? 0) || batch.requestedQuantity)
    : ((batch.confirmedQuantity ?? 0) || batch.requestedQuantity);
  const [scalarQty, setScalarQty] = useState<string>(String(initialScalar));
  const [localErr, setLocalErr] = useState<string | null>(null);

  const total = multiLeg
    ? batch.legs.reduce((s, l) => s + (parseInt(legQtys[l.id] ?? "0", 10) || 0), 0)
    : Math.max(0, parseInt(scalarQty, 10) || 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalErr(null);
    if (multiLeg) {
      const legs: { id: number; vinsReceivedQuantity: number }[] = [];
      for (const l of batch.legs) {
        const n = parseInt(legQtys[l.id] ?? "0", 10);
        if (!Number.isFinite(n) || n < 0) { setLocalErr(`${l.city}: bad number`); return; }
        if (n > l.quantity) { setLocalErr(`${l.city}: max ${l.quantity}`); return; }
        legs.push({ id: l.id, vinsReceivedQuantity: n });
      }
      await onSubmit({ qty: total, legs });
      return;
    }
    const n = parseInt(scalarQty, 10);
    if (!Number.isFinite(n) || n < 0) { setLocalErr("Bad number"); return; }
    if (n > batch.requestedQuantity) { setLocalErr(`Max ${batch.requestedQuantity}`); return; }
    await onSubmit({ qty: n });
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-center gap-1.5 p-1.5 border border-brand rounded-md bg-brand-pastel/30 text-[0.7rem] w-full"
    >
      <span className="font-medium text-brand-dark">
        {kind === "vin" ? "🔑 VINs received" : "✅ Confirmed"}
      </span>
      {multiLeg ? (
        <>
          {batch.legs.map((l) => (
            <label key={l.id} className="flex items-center gap-1">
              <span className="text-ink-600">{l.city}</span>
              <input
                type="number" min={0} max={l.quantity}
                value={legQtys[l.id] ?? ""}
                onChange={(e) => { setLegQtys((p) => ({ ...p, [l.id]: e.target.value })); setLocalErr(null); }}
                className="w-14 px-1 py-0.5 border border-ink-300 rounded tabular-nums"
              />
              <span className="text-ink-500 tabular-nums">/{l.quantity}</span>
            </label>
          ))}
          <span className="text-ink-500 tabular-nums">= {total}/{batch.requestedQuantity}</span>
        </>
      ) : (
        <>
          <input
            type="number" min={0} max={batch.requestedQuantity}
            value={scalarQty}
            onChange={(e) => { setScalarQty(e.target.value); setLocalErr(null); }}
            className="w-16 px-1 py-0.5 border border-ink-300 rounded tabular-nums"
            autoFocus
          />
          <span className="text-ink-500 tabular-nums">/{batch.requestedQuantity}</span>
        </>
      )}
      {(localErr || err) && <span className="text-flame-dark">{localErr ?? err}</span>}
      <div className="ml-auto flex gap-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="px-2 py-0.5 rounded border border-ink-300 text-ink-600 hover:bg-ink-50 bg-white"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="px-2 py-0.5 rounded border border-brand text-brand-dark hover:bg-brand-pastel bg-white font-medium"
        >
          {busy ? "…" : "Save"}
        </button>
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function addDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Re-export an unused helper so callers importing `Touchpoint` from
// here keep working through the refactor.
export type { Touchpoint };

"use client";

/**
 * Action Center · Flow — test shell for the touchpoint-log workflow.
 *
 * Direction A: every chip has a `📞 N · Md ago` indicator + a popover
 *              with the full touchpoint history and an inline form.
 * Direction B: chip color + sub-label show derived FlowState
 *              (fresh / contacted_waiting / stalled / partial_response /
 *              escalated / confirmed_pending / blocked / done / skipped).
 * Direction C: one-click 📧 📞 💬 ↗ buttons log a touchpoint with smart
 *              defaults (last channel, outcome=no_response, +24h follow-up).
 *
 * Layout: PO picker → external-phase chips per batch, grouped by
 * delivery window. Smaller than the main Action Center on purpose
 * so the new flow can be tried in isolation.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
// Type-only import from the data layer is fine — TS strips it at
// build time. Runtime imports (augmentActions) MUST come from the
// client-safe shared module to keep `db` out of the client bundle.
import type { ActionFlowData } from "@/lib/action-flow-data";
import {
  augmentActions,
  type FlowAction,
  type FlowState,
  type Channel,
  type Outcome,
  type Touchpoint,
} from "@/lib/action-flow-shared";
import type { PoNode, WaveNode, BatchNode, ScopedActionDetail } from "@/lib/action-center-tree-data";
import { cn } from "@/lib/utils";

interface Props { data: ActionFlowData }

export default function ActionFlowShell({ data }: Props) {
  const { tree, touchpointsByAction } = data;
  const router = useRouter();
  // Local augmenter — pure function imported from the data layer.
  // The function CAN'T live on `data` itself because Next.js can't
  // serialise functions from a Server Component to a Client one.
  const augment = (actions: ScopedActionDetail[]) =>
    augmentActions(actions, touchpointsByAction);

  // Flatten POs across dealers for the picker. Pre-PO entries opt out
  // — the flow surface targets External-Phase work.
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

  // Local "last used channel" — drives the C-direction default so a
  // second quick-log click on a different chip stays in the same
  // outreach mode.
  const [lastChannel, setLastChannel] = useState<Channel>("email");

  const [busyActionId, setBusyActionId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function logTouchpoint(opts: {
    actionId: number;
    channel:  Channel;
    direction?: "outbound" | "inbound" | "internal";
    outcome?: Outcome;
    note?:    string | null;
    nextFollowupAt?: string | null;
    escalated?: boolean;
  }): Promise<void> {
    setBusyActionId(opts.actionId);
    setError(null);
    try {
      const res = await fetch("/api/action-touchpoint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
      if (!res.ok) throw new Error(await res.text());
      setLastChannel(opts.channel);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyActionId(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* PO picker */}
      <div className="card flex flex-wrap items-baseline gap-3">
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
        <span className="ml-auto text-[0.65rem] text-ink-500">
          Last channel: <span className="text-midnight font-medium">{lastChannel}</span>
        </span>
      </div>

      {error && (
        <p role="alert" className="text-xs text-flame-dark bg-flame-pale border border-flame px-3 py-2 rounded-md">
          {error}
        </p>
      )}

      {!selected ? (
        <p className="text-sm text-ink-500 italic">Pick a PO above to load its External-Phase actions.</p>
      ) : selected.po.waves.length === 0 ? (
        <p className="text-sm text-ink-500 italic">No delivery windows on this PO yet.</p>
      ) : (
        <div className="space-y-4">
          {selected.po.waves.map((wave) => (
            <WaveBlock
              key={wave.id}
              wave={wave}
              augment={augment}
              busyActionId={busyActionId}
              lastChannel={lastChannel}
              onLog={logTouchpoint}
            />
          ))}
        </div>
      )}

      <FlowStateLegend />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Wave block
// ─────────────────────────────────────────────────────────────────

function WaveBlock({
  wave, augment, busyActionId, lastChannel, onLog,
}: {
  wave: WaveNode;
  augment: (actions: ScopedActionDetail[]) => FlowAction[];
  busyActionId: number | null;
  lastChannel: Channel;
  onLog: (opts: {
    actionId: number;
    channel:  Channel;
    direction?: "outbound" | "inbound" | "internal";
    outcome?: Outcome;
    note?:    string | null;
    nextFollowupAt?: string | null;
    escalated?: boolean;
  }) => Promise<void>;
}) {
  return (
    <section className="card !p-0 overflow-hidden">
      <header className="px-4 py-2 border-b border-ink-200 bg-ink-50/50 flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-semibold text-midnight">
          📅 Delivery Window · {wave.opsExpectedDate ?? wave.availabilityDate}
        </span>
        {wave.opsExpectedDate && wave.opsExpectedDate !== wave.availabilityDate && (
          <span className="text-xs text-ink-500">· PO Expected {wave.availabilityDate}</span>
        )}
        <span className="text-xs text-ink-500 tabular-nums">
          · {wave.batches.length} batch{wave.batches.length === 1 ? "" : "es"}
        </span>
      </header>
      <ul className="divide-y divide-ink-200">
        {wave.batches.map((b) => (
          <BatchBlock
            key={b.id}
            batch={b}
            wave={wave}
            augment={augment}
            busyActionId={busyActionId}
            lastChannel={lastChannel}
            onLog={onLog}
          />
        ))}
      </ul>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// Batch block — chips for the External-Phase actions
// ─────────────────────────────────────────────────────────────────

function BatchBlock({
  batch, wave, augment, busyActionId, lastChannel, onLog,
}: {
  batch: BatchNode;
  wave: WaveNode;
  augment: (actions: ScopedActionDetail[]) => FlowAction[];
  busyActionId: number | null;
  lastChannel: Channel;
  onLog: (opts: {
    actionId: number;
    channel:  Channel;
    direction?: "outbound" | "inbound" | "internal";
    outcome?: Outcome;
    note?:    string | null;
    nextFollowupAt?: string | null;
    escalated?: boolean;
  }) => Promise<void>;
}) {
  // External-Phase batch-scope actions on this batch — fall back to
  // the wave-scope set when the batch hasn't received per-batch
  // copies yet (legacy / pre-cascade rollout).
  const waveTypeIds = new Set(wave.actions.map((a) => a.actionTypeId));
  const batchScope = batch.actions.filter((a) => waveTypeIds.has(a.actionTypeId));
  const externalActions = batchScope.length > 0 ? batchScope : wave.actions;
  const augmented = augment(externalActions);

  return (
    <li className="px-4 py-3 space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
        <code className="text-[0.75rem] text-midnight font-mono font-semibold">{batch.batchCode}</code>
        <span className="text-midnight font-medium">{batch.modelYear}</span>
        <span className="text-ink-300">·</span>
        <span className="tabular-nums">{batch.requestedQuantity} cars</span>
        <span className="text-ink-300">·</span>
        <span className="text-ink-500">📍 {batch.legs.length > 0
          ? batch.legs.map((l) => `${l.city} ${l.quantity}`).join(", ")
          : batch.city}</span>
      </div>
      {/* Stack chips one above the other so each card has full row
          width — gives the touchpoint snippet + quick-log row room
          to breathe instead of cramping into a 220px column. */}
      <div className="flex flex-col gap-2">
        {augmented
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((a) => (
            <FlowChip
              key={a.id}
              action={a}
              busy={busyActionId === a.id}
              lastChannel={lastChannel}
              onLog={onLog}
            />
          ))}
      </div>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────
// FlowChip — the heart of the test page
// ─────────────────────────────────────────────────────────────────

const FLOW_TONE: Record<FlowState, { label: string; cls: string; dot: string }> = {
  fresh:              { label: "fresh",              cls: "border-ink-300 bg-white",       dot: "bg-ink-300" },
  contacted_waiting:  { label: "awaiting reply",     cls: "border-brand bg-brand-pastel/30",dot: "bg-brand" },
  stalled:            { label: "stalled",            cls: "border-flame bg-flame-pale/40", dot: "bg-flame" },
  partial_response:   { label: "partial",            cls: "border-gold bg-gold-pale/40",   dot: "bg-gold" },
  confirmed_pending:  { label: "confirmed",          cls: "border-green bg-green-pale/40", dot: "bg-green" },
  escalated:          { label: "escalated",          cls: "border-flame bg-flame-pale/50", dot: "bg-flame-dark" },
  blocked:            { label: "blocked",            cls: "border-flame bg-flame-pale/30", dot: "bg-flame-dark" },
  done:               { label: "done",               cls: "border-green bg-green-pale/50", dot: "bg-green-dark" },
  skipped:            { label: "skipped",            cls: "border-ink-300 bg-ink-50 opacity-70", dot: "bg-ink-400" },
};

function FlowChip({
  action, busy, lastChannel, onLog,
}: {
  action: FlowAction;
  busy: boolean;
  lastChannel: Channel;
  onLog: (opts: {
    actionId: number;
    channel:  Channel;
    direction?: "outbound" | "inbound" | "internal";
    outcome?: Outcome;
    note?:    string | null;
    nextFollowupAt?: string | null;
    escalated?: boolean;
  }) => Promise<void>;
}) {
  const [showPopover, setShowPopover] = useState<boolean>(false);
  const tone = FLOW_TONE[action.flowState];
  const label = action.doneLabel || action.waitingLabel;

  return (
    <div className={cn(
      "rounded-lg border p-3 transition-shadow",
      tone.cls,
      busy && "opacity-50 cursor-wait",
    )}>
      {/* Top row: dot · label · state · days · history · quick-log
          All on one line now that the chip has full row width.
          Quick-log lives on the far right so the eye scans
          context (left) → controls (right) without re-orienting. */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn("h-2 w-2 rounded-full shrink-0", tone.dot)} aria-hidden />
        <span className="text-sm font-medium text-midnight">{label}</span>
        <span className="uppercase tracking-wide text-[0.6rem] text-ink-500 font-semibold">
          {tone.label}
        </span>
        {action.daysSinceLastContact != null && (
          <span className="text-[0.65rem] tabular-nums text-ink-500">
            · {action.daysSinceLastContact}d ago
          </span>
        )}
        {action.touchpoints.length > 0 && (
          <button
            type="button"
            onClick={() => setShowPopover((v) => !v)}
            disabled={busy}
            className="text-[0.65rem] tabular-nums text-ink-500 hover:text-midnight px-1"
            title="Touchpoint history"
          >
            📞 {action.touchpoints.length}
          </button>
        )}
        {/* Quick-log buttons floated right when the chip is actionable. */}
        {action.status !== "done" && action.status !== "skipped" && (
          <div className="ml-auto flex flex-wrap gap-1">
            <QuickLogBtn label="📧" title="Log email" disabled={busy}
              onClick={() => onLog({ actionId: action.id, channel: "email", outcome: "no_response", nextFollowupAt: addDays(1) })} />
            <QuickLogBtn label="📞" title="Log phone call" disabled={busy}
              onClick={() => onLog({ actionId: action.id, channel: "phone", outcome: "no_response", nextFollowupAt: addDays(1) })} />
            <QuickLogBtn label="💬" title="Log WhatsApp" disabled={busy}
              onClick={() => onLog({ actionId: action.id, channel: "whatsapp", outcome: "no_response", nextFollowupAt: addDays(1) })} />
            <QuickLogBtn label="↗" title="Escalate" tone="flame" disabled={busy}
              onClick={() => onLog({
                actionId: action.id, channel: lastChannel, direction: "internal",
                outcome: "other", escalated: true, note: "Escalated",
                nextFollowupAt: addDays(2),
              })} />
            <QuickLogBtn label="🪟" title="Open details" disabled={busy}
              onClick={() => setShowPopover((v) => !v)} />
          </div>
        )}
      </div>

      {/* Latest snippet — full-width line beneath the header so the
          freshest context reads naturally without competing for
          space with the controls. */}
      {action.latestTouchpoint && (
        <p className="text-[0.7rem] text-ink-600 mt-1.5 line-clamp-2">
          <span className="text-ink-400">latest:</span>{" "}
          {summariseTouchpoint(action.latestTouchpoint)}
        </p>
      )}

      {/* Popover — full history + rich form */}
      {showPopover && (
        <FullPopover
          action={action}
          busy={busy}
          lastChannel={lastChannel}
          onClose={() => setShowPopover(false)}
          onLog={onLog}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Quick-log button
// ─────────────────────────────────────────────────────────────────

function QuickLogBtn({
  label, title, onClick, disabled, tone = "brand",
}: {
  label: string;
  title: string;
  onClick: () => void;
  disabled: boolean;
  tone?: "brand" | "flame";
}) {
  const cls = tone === "flame"
    ? "border-flame text-flame-dark hover:bg-flame-pale"
    : "border-ink-300 text-ink-700 hover:bg-ink-50";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "text-xs px-2 py-1 rounded-md border bg-white transition-colors leading-none",
        cls,
        disabled && "opacity-50 cursor-wait",
      )}
    >
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────
// Full popover — history + full form
// ─────────────────────────────────────────────────────────────────

function FullPopover({
  action, busy, lastChannel, onClose, onLog,
}: {
  action: FlowAction;
  busy: boolean;
  lastChannel: Channel;
  onClose: () => void;
  onLog: (opts: {
    actionId: number;
    channel:  Channel;
    direction?: "outbound" | "inbound" | "internal";
    outcome?: Outcome;
    note?:    string | null;
    nextFollowupAt?: string | null;
    escalated?: boolean;
  }) => Promise<void>;
}) {
  const [channel, setChannel] = useState<Channel>(lastChannel);
  const [direction, setDirection] = useState<"outbound" | "inbound" | "internal">("outbound");
  const [outcome, setOutcome]   = useState<Outcome>("no_response");
  const [note, setNote]         = useState<string>("");
  const [followup, setFollowup] = useState<string>(addDays(1));
  const [escalated, setEscalated] = useState<boolean>(false);

  useEffect(() => { setChannel(lastChannel); }, [lastChannel]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await onLog({
      actionId:       action.id,
      channel,
      direction,
      outcome,
      note:           note.trim() || null,
      nextFollowupAt: followup || null,
      escalated,
    });
    setNote("");
    setEscalated(false);
  }

  return (
    <div className="mt-2 border border-ink-300 rounded-md bg-white p-2 space-y-2 text-[0.7rem]">
      {/* History */}
      <div>
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-ink-500 uppercase tracking-wide text-[0.6rem] font-medium">
            History ({action.touchpoints.length})
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-500 hover:text-midnight text-[0.7rem]"
          >
            ✕
          </button>
        </div>
        {action.touchpoints.length === 0 ? (
          <p className="text-[0.65rem] text-ink-500 italic">No touchpoints yet.</p>
        ) : (
          <ul className="space-y-1 max-h-32 overflow-auto text-[0.65rem]">
            {action.touchpoints.map((t) => (
              <li key={t.id} className="flex items-baseline gap-1.5">
                <span aria-hidden>{channelGlyph(t.channel)}</span>
                <span className="text-ink-400 tabular-nums shrink-0">{t.contactedAt.slice(5, 10)}</span>
                <span className="text-midnight truncate flex-1">
                  {summariseTouchpoint(t)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Form */}
      <form onSubmit={submit} className="space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <label className="text-[0.6rem] text-ink-600 flex flex-col">
            Channel
            <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)}
                    className="mt-0.5 px-1.5 py-0.5 border border-ink-300 rounded text-[0.7rem]">
              <option value="email">📧 Email</option>
              <option value="phone">📞 Phone</option>
              <option value="whatsapp">💬 WhatsApp</option>
              <option value="meeting">🤝 Meeting</option>
              <option value="other">· Other</option>
            </select>
          </label>
          <label className="text-[0.6rem] text-ink-600 flex flex-col">
            Direction
            <select value={direction} onChange={(e) => setDirection(e.target.value as "outbound" | "inbound" | "internal")}
                    className="mt-0.5 px-1.5 py-0.5 border border-ink-300 rounded text-[0.7rem]">
              <option value="outbound">→ We contacted</option>
              <option value="inbound">← Dealer replied</option>
              <option value="internal">↻ Internal handoff</option>
            </select>
          </label>
        </div>
        <label className="text-[0.6rem] text-ink-600 flex flex-col">
          Outcome
          <select value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome)}
                  className="mt-0.5 px-1.5 py-0.5 border border-ink-300 rounded text-[0.7rem]">
            <option value="no_response">No response yet</option>
            <option value="partial">Partial</option>
            <option value="confirmed">Confirmed</option>
            <option value="excuse">Excuse / delay</option>
            <option value="counter_proposal">Counter-proposal</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="text-[0.6rem] text-ink-600 flex flex-col">
          Note (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)}
                 placeholder="What was discussed?"
                 className="mt-0.5 px-1.5 py-0.5 border border-ink-300 rounded text-[0.7rem]" />
        </label>
        <div className="flex items-baseline gap-1.5">
          <label className="text-[0.6rem] text-ink-600 flex items-baseline gap-1">
            Follow-up
            <input type="date" value={followup} onChange={(e) => setFollowup(e.target.value)}
                   className="px-1.5 py-0.5 border border-ink-300 rounded text-[0.7rem] tabular-nums" />
          </label>
          <label className="text-[0.6rem] text-flame-dark flex items-baseline gap-1 ml-auto">
            <input type="checkbox" checked={escalated} onChange={(e) => setEscalated(e.target.checked)} />
            Mark escalated
          </label>
        </div>
        <button type="submit" disabled={busy}
                className="w-full text-[0.7rem] px-2 py-1 rounded border border-brand text-brand-dark hover:bg-brand-pastel disabled:opacity-50">
          {busy ? "…" : "✓ Log touchpoint"}
        </button>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function channelGlyph(c: Channel): string {
  switch (c) {
    case "email":    return "📧";
    case "phone":    return "📞";
    case "whatsapp": return "💬";
    case "meeting":  return "🤝";
    default:         return "·";
  }
}

function summariseTouchpoint(t: Touchpoint): string {
  const parts: string[] = [];
  parts.push(t.direction === "inbound" ? "Dealer replied" : t.direction === "internal" ? "Internal" : "We contacted");
  parts.push(`(${t.outcome.replace("_", " ")})`);
  if (t.escalated) parts.push("· escalated");
  if (t.note) parts.push(`— ${t.note}`);
  return parts.join(" ");
}

function addDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function FlowStateLegend() {
  return (
    <details className="card !p-3 text-xs">
      <summary className="cursor-pointer text-ink-600 font-medium">Flow state legend</summary>
      <ul className="mt-2 grid grid-cols-2 md:grid-cols-3 gap-1.5 text-[0.7rem]">
        {(Object.keys(FLOW_TONE) as FlowState[]).map((s) => (
          <li key={s} className="flex items-baseline gap-1.5">
            <span className={cn("h-1.5 w-1.5 rounded-full", FLOW_TONE[s].dot)} aria-hidden />
            <span className="text-midnight font-medium uppercase tracking-wide text-[0.6rem]">
              {FLOW_TONE[s].label}
            </span>
            <span className="text-ink-500">— {flowDescription(s)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function flowDescription(s: FlowState): string {
  switch (s) {
    case "fresh":             return "no touchpoints yet";
    case "contacted_waiting": return "outreach sent, awaiting reply";
    case "stalled":           return "follow-up date has passed with no progress";
    case "partial_response":  return "got a partial response — needs more";
    case "confirmed_pending": return "dealer confirmed — flip the chip when ready";
    case "escalated":         return "handed off to a different stakeholder";
    case "blocked":           return "upstream dependency unmet";
    case "done":              return "complete";
    case "skipped":           return "intentionally skipped";
  }
}

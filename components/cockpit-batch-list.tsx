"use client";

/**
 * Cockpit batch list — compact card style for the side-by-side view.
 *
 * Trimmed for narrow column display. Each row is a button that selects
 * the batch and surfaces just enough info to triage:
 *   - Batch code (mono)
 *   - Model + qty
 *   - Phase chip + status chip
 *   - Action counts (waiting / blocked / done)
 *   - Next action label when the batch has work pending
 *
 * The CockpitTable (stacked view) stays in place — this is purely the
 * narrow-pane alternative.
 */
import { useState } from "react";
// `import type` ensures the type imports are erased at compile time —
// they don't drag the server-only `lib/cockpit-data.ts` (which imports
// better-sqlite3) into the client bundle.
import type { CockpitRow, DrawerData } from "@/lib/cockpit-data";
// Pure formatter (no DB imports), safe to use from client components.
import { formatStatusCheckMessage } from "@/lib/cockpit-slack";
import { cn } from "@/lib/utils";

interface Props {
  rows: CockpitRow[];
  selectedCode: string | null;
  onSelect: (code: string) => void;
  totalCount: number;
}

export default function CockpitBatchList({
  rows, selectedCode, onSelect, totalCount,
}: Props) {
  /**
   * Slack-button state — track which row is currently fetching its
   * drawer data and which row most recently copied a Slack message.
   * Single-shot state is fine for a list of dozens; if we scale to
   * hundreds, switch to a per-row Map.
   */
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  async function generateSlack(row: CockpitRow) {
    setBusyCode(row.batchCode);
    setCopyError(null);
    try {
      const res = await fetch(`/api/cockpit-drawer?code=${encodeURIComponent(row.batchCode)}`);
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as DrawerData;
      const msg = formatStatusCheckMessage(data);
      await navigator.clipboard.writeText(msg);
      setCopiedCode(row.batchCode);
      setTimeout(() => setCopiedCode((c) => (c === row.batchCode ? null : c)), 1600);
    } catch (e) {
      setCopyError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyCode(null);
    }
  }

  return (
    <div className="border border-ink-200 rounded-lg bg-white flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-ink-200 flex items-baseline gap-2 shrink-0">
        <h3 className="text-sm font-bold text-midnight">Batches</h3>
        <span className="text-xs text-ink-500 tabular-nums">
          ({rows.length} of {totalCount})
        </span>
      </div>

      {/* List */}
      {rows.length === 0 ? (
        <p className="px-4 py-8 text-sm text-ink-500 text-center">
          No batches match the current filters.
        </p>
      ) : (
        <ul className="flex-1 overflow-auto divide-y divide-ink-200/60">
          {rows.map((r) => (
            <li key={r.batchCode}>
              <BatchCard
                row={r}
                selected={r.batchCode === selectedCode}
                onSelect={() => onSelect(r.batchCode)}
                onSlackCopy={() => generateSlack(r)}
                slackBusy={busyCode === r.batchCode}
                slackCopied={copiedCode === r.batchCode}
              />
            </li>
          ))}
        </ul>
      )}
      {copyError && (
        <p role="alert" className="px-3 py-2 text-xs text-flame-dark border-t border-flame">
          Could not copy: {copyError}
        </p>
      )}
    </div>
  );
}

function BatchCard({
  row, selected, onSelect, onSlackCopy, slackBusy, slackCopied,
}: {
  row: CockpitRow;
  selected: boolean;
  onSelect: () => void;
  onSlackCopy: () => void;
  slackBusy: boolean;
  slackCopied: boolean;
}) {
  const isClosed   = row.closedAt != null;
  const isCancelled = row.closureReason === "cancelled";
  return (
    <div
      className={cn(
        "relative",
        selected ? "bg-brand-pastel" : "hover:bg-ink-50",
        isClosed && !selected && "opacity-70",   // subdue closed batches
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        aria-pressed={selected}
        className={cn(
          "w-full text-left px-3 py-2.5 outline-none",
          "focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-[-2px]",
        )}
      >
      {/* Top line: batch code + phase chip + Slack button */}
      <div className="flex items-center justify-between gap-2 mb-1">
        <code className="font-mono text-xs text-midnight truncate" title={row.batchCode}>
          {row.batchCode}
        </code>
        <div className="flex items-center gap-1.5 shrink-0">
          <PhaseChip lifecycle={row.lifecycleState} />
        </div>
      </div>

      {/* Model + qty */}
      <p className="text-sm font-medium text-midnight leading-tight mb-1.5">
        <span className="tabular-nums">{row.quantity}×</span>{" "}
        {row.modelYear === "—" ? <span className="text-ink-400">—</span> : row.modelYear}
      </p>

      {/* Footer: status + counts */}
      <div className="flex flex-wrap items-center gap-1.5 text-[0.7rem]">
        {isClosed ? (
          <ClosureChip cancelled={isCancelled} closedAt={row.closedAt!} />
        ) : (
          <StatusChip
            delivered={row.statusLabel.startsWith("🎉")}
            delayed={row.delayDays > 0}
            ahead={row.delayDays < 0}
            label={row.statusLabel}
          />
        )}
        {!isClosed && row.actionsWaiting > 0 && (
          <CountPill value={row.actionsWaiting} tone="waiting" />
        )}
        {!isClosed && row.actionsBlocked > 0 && (
          <CountPill value={row.actionsBlocked} tone="blocked" />
        )}
        {!isClosed && row.totalActions > 0 && (
          <span className="text-ink-500 tabular-nums">
            {row.actionsDone}/{row.totalActions}
          </span>
        )}
      </div>

      {/* Next action hint, only when there is one and the batch is open. */}
      {row.nextActionLabel && !isClosed && (
        <p className="mt-1.5 text-[0.7rem] text-ink-500 truncate pr-9">
          <span className="text-midnight font-medium">{row.nextActionLabel}</span>
          {row.nextDepartmentName && (
            <>
              <span className="text-ink-300 mx-1" aria-hidden="true">·</span>
              {row.nextDepartmentName}
            </>
          )}
        </p>
      )}
      </button>

      {/* Slack status-check button — absolute, layered on top of the row.
          Stops propagation so clicking it doesn't also select the batch. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (slackBusy) return;
          onSlackCopy();
        }}
        disabled={slackBusy}
        title={slackCopied
          ? "Copied to clipboard"
          : "Copy Slack status-check (groups actions by stakeholder)"}
        aria-label="Copy Slack status check"
        className={cn(
          "absolute top-2 right-2 px-1.5 py-0.5 rounded text-[0.65rem] font-medium",
          "border transition-colors",
          slackCopied
            ? "bg-green-pale text-green-dark border-green"
            : "bg-white text-ink-600 border-ink-300 hover:border-brand hover:text-brand",
          slackBusy && "opacity-60 cursor-wait",
        )}
      >
        {slackBusy ? "…" : slackCopied ? "✓ Copied" : "📋 Slack"}
      </button>
    </div>
  );
}

// ── tiny chips ────────────────────────────────────────────────────

function PhaseChip({ lifecycle }: { lifecycle: "pre_po" | "post_po" }) {
  const isPre = lifecycle === "pre_po";
  return (
    <span className={cn(
      "inline-block px-1.5 py-0.5 rounded text-[0.65rem] font-medium border whitespace-nowrap",
      isPre
        ? "bg-gold-pale text-gold-dark border-gold"
        : "bg-brand-pastel text-brand-dark border-brand",
    )}>
      {isPre ? "Pre-PO" : "Post-PO"}
    </span>
  );
}

function StatusChip({
  delivered, delayed, ahead, label,
}: {
  delivered: boolean; delayed: boolean; ahead: boolean; label: string;
}) {
  const cls = delivered ? "bg-ink-100 text-ink-700 border-ink-300"
    : delayed   ? "bg-flame-pale text-flame-dark border-flame"
    : ahead     ? "bg-brand-pastel text-brand-dark border-brand"
    :             "bg-green-pale text-green-dark border-green";
  return (
    <span className={cn(
      "inline-block px-1.5 py-0.5 rounded text-[0.65rem] font-medium border whitespace-nowrap",
      cls,
    )}>
      {label}
    </span>
  );
}

function CountPill({ value, tone }: { value: number; tone: "waiting" | "blocked" }) {
  const cls = tone === "waiting"
    ? "bg-brand-pastel text-brand-dark"
    : "bg-flame-pale text-flame-dark";
  return (
    <span className={cn(
      "inline-block px-1.5 py-0.5 rounded text-[0.65rem] font-semibold tabular-nums",
      cls,
    )}>
      {tone === "waiting" ? `${value} waiting` : `${value} blocked`}
    </span>
  );
}

function ClosureChip({ cancelled, closedAt }: { cancelled: boolean; closedAt: string }) {
  const cls = cancelled
    ? "bg-flame-pale text-flame-dark border-flame"
    : "bg-green-pale text-green-dark border-green";
  return (
    <span className={cn(
      "inline-block px-1.5 py-0.5 rounded text-[0.65rem] font-medium border whitespace-nowrap",
      cls,
    )}>
      {cancelled ? "🚫 Cancelled" : "✅ Delivered"} · <span className="tabular-nums">{closedAt}</span>
    </span>
  );
}

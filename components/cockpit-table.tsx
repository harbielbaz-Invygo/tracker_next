"use client";

/**
 * Cockpit triage table — pure presentational. Row click opens the drawer.
 *
 * Sticky header, tabular numerals on every count, hit area = full row.
 * No row animation (PRODUCT.md "high-frequency user").
 */
import type { CockpitRow } from "@/lib/cockpit-data";
import { cn } from "@/lib/utils";

interface Props {
  rows: CockpitRow[];
  selectedCode: string | null;
  onSelect: (code: string) => void;
  totalCount: number;
}

export default function CockpitTable({ rows, selectedCode, onSelect, totalCount }: Props) {
  return (
    <div className="border border-ink-200 rounded-lg bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-ink-200 flex items-baseline gap-2">
        <h3 className="text-sm font-bold text-midnight">Batches</h3>
        <span className="text-xs text-ink-500 tabular-nums">
          ({rows.length} of {totalCount})
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-8 text-sm text-ink-500 text-center">
          No batches match the current filters.
        </p>
      ) : (
        <div className="max-h-[460px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 sticky top-0 z-[1]">
              <tr className="text-left text-xs font-medium text-ink-600 border-b border-ink-200">
                <Th>Batch</Th>
                <Th>Model</Th>
                <Th>Dealer</Th>
                <Th>Phase</Th>
                <Th>Next action</Th>
                <Th>Department</Th>
                <Th align="right">Waiting</Th>
                <Th align="right">Blocked</Th>
                <Th align="right">Done</Th>
                <Th>Status</Th>
                <Th align="right">Ops Conf</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const selected = r.batchCode === selectedCode;
                return (
                  <tr
                    key={r.batchCode}
                    role="button"
                    aria-pressed={selected}
                    tabIndex={0}
                    onClick={() => onSelect(r.batchCode)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(r.batchCode);
                      }
                    }}
                    className={cn(
                      "border-b border-ink-200/60 cursor-pointer outline-none",
                      selected
                        ? "bg-brand-pastel"
                        : "hover:bg-ink-50 focus-visible:bg-ink-50",
                      "focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-[-2px]",
                    )}
                  >
                    <Td><code className="font-mono text-midnight">{r.batchCode}</code></Td>
                    <Td>{r.modelYear}</Td>
                    <Td>{r.dealerName}</Td>
                    <Td>
                      <PhaseChip lifecycle={r.lifecycleState} />
                    </Td>
                    <Td>
                      {r.nextActionLabel ? (
                        <span className="text-midnight">{r.nextActionLabel}</span>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </Td>
                    <Td>
                      {r.nextDepartmentName ? (
                        <DepartmentChip name={r.nextDepartmentName} />
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </Td>
                    <Td align="right" tabular>
                      <CountPill value={r.actionsWaiting} tone="waiting" />
                    </Td>
                    <Td align="right" tabular>
                      <CountPill value={r.actionsBlocked} tone="blocked" />
                    </Td>
                    <Td align="right" tabular>
                      <span className="text-ink-600">{r.actionsDone}</span>
                      {r.totalActions > 0 && (
                        <span className="text-ink-400">/{r.totalActions}</span>
                      )}
                    </Td>
                    <Td>
                      <StatusChip
                        delivered={r.statusLabel.startsWith("🎉")}
                        delayed={r.delayDays > 0}
                        ahead={r.delayDays < 0}
                        label={r.statusLabel}
                      />
                    </Td>
                    <Td align="right" tabular>
                      {r.operationsConfidence != null ? (
                        <span className={cn(
                          "font-medium",
                          r.operationsConfidence >= 70 ? "text-green-dark"
                          : r.operationsConfidence >= 40 ? "text-gold-dark"
                          : "text-flame-dark",
                        )}>
                          {Math.round(r.operationsConfidence)}%
                        </span>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── tiny presentational helpers ────────────────────────────────

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      scope="col"
      className={cn(
        "px-3 py-2 font-medium uppercase tracking-wide whitespace-nowrap",
        align === "right" && "text-right",
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children, align = "left", tabular = false,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  tabular?: boolean;
}) {
  return (
    <td
      className={cn(
        "px-3 py-2 whitespace-nowrap text-midnight align-middle",
        align === "right" && "text-right",
        tabular && "tabular-nums",
      )}
    >
      {children}
    </td>
  );
}

function PhaseChip({ lifecycle }: { lifecycle: "pre_po" | "post_po" }) {
  const isPre = lifecycle === "pre_po";
  return (
    <span className={cn(
      "inline-block px-2 py-0.5 rounded-md text-[0.7rem] font-medium border whitespace-nowrap",
      isPre
        ? "bg-gold-pale text-gold-dark border-gold"
        : "bg-brand-pastel text-brand-dark border-brand",
    )}>
      {isPre ? "Pre-PO" : "Post-PO"}
    </span>
  );
}

function DepartmentChip({ name }: { name: string }) {
  return (
    <span className="inline-block px-2 py-0.5 rounded-md text-xs font-medium bg-ink-100 text-midnight border border-ink-200 whitespace-nowrap">
      {name}
    </span>
  );
}

function CountPill({ value, tone }: { value: number; tone: "waiting" | "blocked" }) {
  if (value === 0) return <span className="text-ink-400 tabular-nums">0</span>;
  const cls = tone === "waiting"
    ? "bg-brand-pastel text-brand-dark"
    : "bg-flame-pale text-flame-dark";
  return (
    <span className={cn(
      "inline-block px-1.5 py-0.5 rounded-md text-xs font-semibold tabular-nums",
      cls,
    )}>
      {value}
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
      "inline-block px-2 py-0.5 rounded-md text-xs font-medium border whitespace-nowrap",
      cls,
    )}>
      {label}
    </span>
  );
}

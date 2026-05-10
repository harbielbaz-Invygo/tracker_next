"use client";

/**
 * Requests table — pure presentational. The parent shell owns the rows
 * (after filtering) and the currently-selected batch code.
 *
 * Mirrors `tracker_v1/dashboard.py:_batch_table_row`.
 *
 * Density notes (PRODUCT.md "Respect the high-frequency user"):
 *   - No animation on row hover.
 *   - Tabular numerals on every column where digits land.
 *   - Click anywhere on the row to select; Enter activates when focused.
 */
import type { DashboardRow } from "@/lib/dashboard-data";
import { cn } from "@/lib/utils";

interface Props {
  rows: DashboardRow[];
  selectedCode: string | null;
  onSelect: (code: string) => void;
  totalCount: number;
}

export default function BatchTable({ rows, selectedCode, onSelect, totalCount }: Props) {
  return (
    <div className="border border-ink-200 rounded-lg bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-ink-200 flex items-baseline gap-2">
        <h3 className="text-sm font-bold text-midnight">Requests</h3>
        <span className="text-xs text-ink-500 tabular-nums">
          ({rows.length} of {totalCount})
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-8 text-sm text-ink-500 text-center">
          No batches match the current filters.
        </p>
      ) : (
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 sticky top-0 z-[1]">
              <tr className="text-left text-xs font-medium text-ink-600 border-b border-ink-200">
                <Th>Batch</Th>
                <Th>Submitted</Th>
                <Th>Stage</Th>
                <Th>PO</Th>
                <Th>Promised</Th>
                <Th>Delivery</Th>
                <Th>Status</Th>
                <Th align="right">Risk</Th>
                <Th>Conf (P/O)</Th>
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
                    <Td>
                      <code className="font-mono text-midnight" title={`${r.dealerName} · ${r.modelYear} · ${r.quantity}× · ${r.poNumber ?? "no PO"}`}>
                        {r.batchCode}
                      </code>
                    </Td>
                    <Td tabular>{r.requestedAt}</Td>
                    <Td>
                      <span className="inline-block px-2 py-0.5 bg-ink-100 rounded-md text-xs font-medium text-midnight">
                        {r.stageDisplay}
                      </span>
                    </Td>
                    <Td tabular>{r.poStatusLabel}</Td>
                    <Td tabular>{r.promisedDate}</Td>
                    <Td tabular>{r.deliveryStatusLabel}</Td>
                    <Td>
                      <StatusChip status={r.status} label={r.statusLabel} />
                    </Td>
                    <Td align="right">
                      <RiskBar value={r.risk} />
                    </Td>
                    <Td tabular className="text-ink-500">{r.confidenceLabel}</Td>
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
  children,
  align = "left",
  tabular = false,
  className,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  tabular?: boolean;
  className?: string;
}) {
  return (
    <td
      className={cn(
        "px-3 py-2 whitespace-nowrap text-midnight align-middle",
        align === "right" && "text-right",
        tabular && "tabular-nums",
        className,
      )}
    >
      {children}
    </td>
  );
}

function StatusChip({ status, label }: { status: DashboardRow["status"]; label: string }) {
  const cls = {
    on_track:  "bg-green-pale  text-green-dark  border-green",
    ahead:     "bg-brand-pastel text-brand-dark border-brand",
    delayed:   "bg-flame-pale  text-flame-dark  border-flame",
    delivered: "bg-ink-100     text-ink-700     border-ink-300",
  }[status];
  return (
    <span className={cn("inline-block px-2 py-0.5 rounded-md text-xs font-medium border whitespace-nowrap", cls)}>
      {label}
    </span>
  );
}

function RiskBar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  const color =
    v >= 75 ? "bg-flame"
    : v >= 40 ? "bg-gold"
    : "bg-green";
  return (
    <div className="flex items-center gap-2 justify-end">
      <span className="tabular-nums text-xs font-medium text-midnight w-7 text-right">{v}</span>
      <div className="w-16 h-1.5 bg-ink-200 rounded overflow-hidden" aria-hidden="true">
        <div className={cn("h-full", color)} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

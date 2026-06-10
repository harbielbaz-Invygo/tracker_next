"use client";

/**
 * Settings → Batches editor.
 *
 * Accordion-style admin override for any batch's fields. One row at a time
 * expands inline to a full edit form grouped by section (PO header /
 * Identity / Dates / Closure / Commercial / Confidence / Notes).
 *
 * Save mutates via /api/settings { resource: "batch", op: "update", … }.
 * Delete via { resource: "batch", op: "delete", id }.
 *
 * Action STATUS is NOT edited here — that lives in the live, scope-aware
 * Action Center (one click via the footer link). The collapsed row shows a
 * read-only "X/Y done" chip sourced from the same scope-aware `actions`
 * table the Action Center uses, so the two never diverge.
 *
 * Per the design call: PO-level edits do NOT propagate. A warning chip on
 * the PO header section tells the admin when other batches share the PO,
 * so they know to repeat the edit on each one.
 */
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SettingsData, BatchEditRow } from "@/lib/settings-data";
import { cn } from "@/lib/utils";
import { CollapsibleCard } from "./settings-shell";

interface Props {
  data: SettingsData;
}

const FEASIBILITY_OPTIONS: Array<"feasible" | "at_risk" | "infeasible"> =
  ["feasible", "at_risk", "infeasible"];

export default function SettingsBatches({ data }: Props) {
  const router = useRouter();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [search, setSearch]         = useState("");
  const [dealerFilter, setDealerFilter] = useState<string>("all");
  const [lifecycleFilter, setLifecycleFilter] = useState<"all" | "pre_po" | "post_po">("all");

  // ── Bulk selection ────────────────────────────────────────────
  // Set of selected batch IDs. The sticky action bar appears when
  // size > 0. "Select all visible" toggles every currently-filtered row.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.batches.filter((b) => {
      if (dealerFilter !== "all" && b.dealerName !== dealerFilter) return false;
      if (lifecycleFilter !== "all" && b.lifecycleState !== lifecycleFilter) return false;
      if (!q) return true;
      const hay = `${b.batchCode} ${b.dealerName} ${b.model ?? ""} ${b.poNumber ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [data.batches, search, dealerFilter, lifecycleFilter]);

  const visibleIds = useMemo(() => filtered.map((b) => b.id), [filtered]);
  const visibleSelectedCount = visibleIds.filter((id) => selectedIds.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;

  function toggleSelected(id: number) {
    setSelectedIds((curr) => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAllVisible() {
    setSelectedIds((curr) => {
      const next = new Set(curr);
      if (allVisibleSelected) {
        // Clear only the visible ones — preserve selections that
        // exist on rows hidden by current filters.
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }

  /**
   * Delete every selected batch. Iterates serially so partial failures
   * are clearly reported (and so we don't slam Turso with a parallel
   * blast of deletes that share FK dependencies). Refreshes the server
   * component once at the end so a successful batch wipe propagates.
   */
  async function deleteSelected() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(
      `Delete ${ids.length} batch${ids.length === 1 ? "" : "es"}? ` +
      `This also deletes each batch's actions, vehicles, milestones, and alerts. ` +
      `Cannot be undone.`,
    )) return;

    setBulkBusy(true);
    setBulkError(null);
    setBulkProgress({ done: 0, total: ids.length });
    const failures: { id: number; error: string }[] = [];
    for (const id of ids) {
      try {
        const res = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resource: "batch", op: "delete", id }),
        });
        if (!res.ok) {
          const txt = await res.text();
          failures.push({ id, error: txt.slice(0, 200) });
        }
      } catch (e) {
        failures.push({ id, error: e instanceof Error ? e.message : String(e) });
      } finally {
        setBulkProgress((p) => p ? { ...p, done: p.done + 1 } : p);
      }
    }
    setBulkBusy(false);
    setBulkProgress(null);
    if (failures.length > 0) {
      // Keep failed IDs selected so the operator can retry or
      // investigate; clear the ones that succeeded.
      const failedIds = new Set(failures.map((f) => f.id));
      setSelectedIds(failedIds);
      setBulkError(
        `${failures.length} of ${ids.length} delete${ids.length === 1 ? "" : "s"} failed. ` +
        `First error: ${failures[0].error}`,
      );
    } else {
      setSelectedIds(new Set());
    }
    router.refresh();
  }

  return (
    <CollapsibleCard
      title="Batches"
      description="Admin override — edit any batch's data after creation. Most updates should still go through Intake (create) and the Action Center (action statuses)."
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <label className="block">
          <span className="block text-xs font-medium text-ink-600 mb-1">Search</span>
          <input
            className="input"
            placeholder="batch code, model, dealer, PO…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-ink-600 mb-1">Dealer</span>
          <select
            className="input"
            value={dealerFilter}
            onChange={(e) => setDealerFilter(e.target.value)}
          >
            <option value="all">All dealers</option>
            {data.dealers.map((d) => (
              <option key={d.id} value={d.name}>{d.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-ink-600 mb-1">Phase</span>
          <select
            className="input"
            value={lifecycleFilter}
            onChange={(e) => setLifecycleFilter(e.target.value as "all" | "pre_po" | "post_po")}
          >
            <option value="all">All</option>
            <option value="pre_po">Pre-PO only</option>
            <option value="post_po">Post-PO only</option>
          </select>
        </label>
      </div>

      {/* Bulk-action bar — only visible when something is selected.
          Sits above the table so the count + Delete button are always
          findable without scrolling back to the top. */}
      {selectedIds.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 px-3 py-2 rounded-md border-2 border-flame bg-flame-pale">
          <p className="text-sm font-medium text-flame-dark">
            <span className="tabular-nums">{selectedIds.size}</span>
            {" "}batch{selectedIds.size === 1 ? "" : "es"} selected
            {bulkProgress && (
              <span className="ml-2 text-xs font-normal text-ink-600 tabular-nums">
                · deleting {bulkProgress.done}/{bulkProgress.total}…
              </span>
            )}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={clearSelection}
              disabled={bulkBusy}
              className="btn text-xs"
              title="Clear selection"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={deleteSelected}
              disabled={bulkBusy}
              className="text-xs font-semibold px-3 py-1.5 rounded-md text-white
                         bg-flame-dark hover:bg-flame disabled:opacity-50
                         border border-flame-dark"
              title="Delete every selected batch (irreversible)"
            >
              {bulkBusy ? "Deleting…" : `🗑 Delete selected (${selectedIds.size})`}
            </button>
          </div>
        </div>
      )}
      {bulkError && (
        <p role="alert" className="mb-3 text-sm text-flame-dark bg-flame-pale border border-flame px-3 py-2 rounded-md">
          {bulkError}
        </p>
      )}

      <div className="border border-ink-200 rounded-md overflow-hidden">
        {filtered.length === 0 ? (
          <p className="px-4 py-8 text-sm text-ink-500 text-center">
            No batches match the filters.
          </p>
        ) : (
          <>
            {/* Header row — "select all visible" checkbox + counts. */}
            <div className="flex items-center gap-3 px-3 py-2 bg-ink-50 border-b border-ink-200">
              <label
                className="flex items-center gap-2 text-xs text-ink-600 cursor-pointer select-none"
                title={allVisibleSelected ? "Clear all visible" : "Select all visible"}
              >
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  ref={(el) => { if (el) el.indeterminate = someVisibleSelected; }}
                  onChange={toggleSelectAllVisible}
                  className="h-4 w-4 accent-brand"
                  disabled={bulkBusy}
                />
                <span>
                  Select all
                  <span className="text-ink-500 tabular-nums ml-1">
                    ({filtered.length} visible)
                  </span>
                </span>
              </label>
            </div>
            <ul className="divide-y divide-ink-200">
              {filtered.map((b) => (
                <li key={b.id}>
                  <SummaryRow
                    batch={b}
                    expanded={expandedId === b.id}
                    onToggle={() => setExpandedId((v) => (v === b.id ? null : b.id))}
                    selected={selectedIds.has(b.id)}
                    onToggleSelect={() => toggleSelected(b.id)}
                    selectDisabled={bulkBusy}
                  />
                  {expandedId === b.id && (
                    <DetailForm
                      key={b.id /* reset draft per-batch */}
                      batch={b}
                      departments={data.departments}
                      dealers={data.dealers}
                    />
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </CollapsibleCard>
  );
}

// ──────────────────────────────────────────────────────────────────
// Summary row
// ──────────────────────────────────────────────────────────────────

function SummaryRow({
  batch, expanded, onToggle, selected, onToggleSelect, selectDisabled,
}: {
  batch: BatchEditRow;
  expanded: boolean;
  onToggle: () => void;
  /** True when this batch is part of the bulk selection. */
  selected: boolean;
  /** Toggle the selection for this batch (does NOT toggle expansion). */
  onToggleSelect: () => void;
  /** True while a bulk-delete is running — locks the checkbox. */
  selectDisabled: boolean;
}) {
  const actionStats = useMemo(() => {
    let waiting = 0, blocked = 0, done = 0;
    for (const a of batch.actions) {
      if (a.status === "waiting") waiting++;
      else if (a.status === "blocked") blocked++;
      else if (a.status === "done") done++;
    }
    return { waiting, blocked, done };
  }, [batch.actions]);

  // The row is two clickable surfaces side-by-side: a checkbox for
  // selection (does NOT toggle expansion), and the rest of the row
  // (expansion toggle). Wrapped in a div, not a button, so the
  // checkbox can be its own interactive element.
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2.5",
        "hover:bg-ink-50",
        expanded && "bg-brand-pastel hover:bg-brand-pastel",
        selected && "bg-flame-pale/40 hover:bg-flame-pale/50",
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        disabled={selectDisabled}
        className="h-4 w-4 accent-flame-dark shrink-0 cursor-pointer"
        aria-label={`Select batch ${batch.batchCode}`}
        title={selected ? "Click to deselect" : "Click to select for bulk action"}
      />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          "flex-1 min-w-0 text-left flex flex-wrap items-center gap-3 outline-none",
          "focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2 rounded",
        )}
      >
        <span aria-hidden="true" className="text-ink-500">{expanded ? "▾" : "▸"}</span>
        <code className="font-mono text-sm text-midnight">{batch.batchCode}</code>
        <span className="text-xs text-ink-500">·</span>
        <span className="text-sm text-midnight">{batch.dealerName}</span>
        <span className="text-xs text-ink-500">·</span>
        <span className="text-sm tabular-nums">{batch.requestedQuantity}× {batch.model ?? ""} {batch.year ?? ""}</span>
        <span className="ml-auto flex items-center gap-2 text-xs">
          <PhaseChip lifecycle={batch.lifecycleState} />
          <span className="text-ink-500 tabular-nums">
            {actionStats.done}/{batch.actions.length} done
          </span>
        </span>
      </button>
    </div>
  );
}

function PhaseChip({ lifecycle }: { lifecycle: "pre_po" | "post_po" }) {
  const isPre = lifecycle === "pre_po";
  return (
    <span className={cn(
      "inline-block px-2 py-0.5 rounded-md text-[0.7rem] font-medium border whitespace-nowrap",
      isPre ? "bg-gold-pale text-gold-dark border-gold" : "bg-brand-pastel text-brand-dark border-brand",
    )}>
      {isPre ? "Pre-PO" : "Post-PO"}
    </span>
  );
}

/** Read-only status pill for the batch editor's action mirror. */
function StatusBadge({ status }: { status: "waiting" | "blocked" | "done" | "skipped" }) {
  const style: Record<typeof status, string> = {
    done:    "bg-green-pale text-green-dark border-green",
    blocked: "bg-flame-pale text-flame-dark border-flame",
    skipped: "bg-ink-100 text-ink-500 border-ink-300",
    waiting: "bg-gold-pale text-gold-dark border-gold",
  };
  return (
    <span className={cn(
      "inline-block px-2 py-0.5 rounded-md text-[0.7rem] font-medium border whitespace-nowrap tabular-nums",
      style[status],
    )}>
      {status}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────
// Detail form (expanded row)
// ──────────────────────────────────────────────────────────────────

function DetailForm({
  batch, departments, dealers,
}: {
  batch: BatchEditRow;
  departments: SettingsData["departments"];
  dealers: SettingsData["dealers"];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedNow, setSavedNow] = useState(false);

  // Per-batch form state, hydrated from the row.
  const [draft, setDraft] = useState<Partial<BatchEditRow>>({
    poNumber: batch.poNumber,
    poReference: batch.poReference,
    actualPoDate: batch.actualPoDate,
    expectedPoDate: batch.expectedPoDate,
    poTotalSar: batch.poTotalSar,
    poSubtotalSar: batch.poSubtotalSar,
    poTaxTotalSar: batch.poTaxTotalSar,

    dealerId: batch.dealerId,
    model: batch.model,
    year: batch.year,
    category: batch.category,
    requestedQuantity: batch.requestedQuantity,
    deliveredQuantity: batch.deliveredQuantity,
    confirmedQuantity: batch.confirmedQuantity,
    appDisplayCities: batch.appDisplayCities,
    dealerReceivingCity: batch.dealerReceivingCity,

    requestedAt: batch.requestedAt,
    dealerPromisedDeliveryDate: batch.dealerPromisedDeliveryDate,
    currentProjectedDeliveryDate: batch.currentProjectedDeliveryDate,
    appListedAt: batch.appListedAt,
    vinReceivingDate: batch.vinReceivingDate,
    poExpectedDateAtLock: batch.poExpectedDateAtLock,
    opsProjectedDeliveryDateAtLock: batch.opsProjectedDeliveryDateAtLock,

    vinsReceivedQuantity: batch.vinsReceivedQuantity,
    vinReceivedAtIntake: batch.vinReceivedAtIntake,

    closedAt: batch.closedAt,
    closureReason: batch.closureReason,
    cancellationNote: batch.cancellationNote,

    lifecycleState: batch.lifecycleState,
    feasibilityStatus: batch.feasibilityStatus,

    buyBackRate: batch.buyBackRate,
    contractLengthMonths: batch.contractLengthMonths,
    colorSummary: batch.colorSummary,
    unitPriceSar: batch.unitPriceSar,
    taxPct: batch.taxPct,
    lineAmountSar: batch.lineAmountSar,

    partnershipConfidence: batch.partnershipConfidence,
    operationsConfidence: batch.operationsConfidence,
    riskScore: batch.riskScore,

    notes: batch.notes,
  });

  function set<K extends keyof BatchEditRow>(key: K, value: BatchEditRow[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function callApi(body: unknown): Promise<void> {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
  }

  function run(promise: Promise<void>) {
    startTransition(async () => {
      try {
        await promise;
        setError(null);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function saveBatch() {
    run((async () => {
      await callApi({
        resource: "batch", op: "update",
        id: batch.id,
        fields: draft,
      });
      setSavedNow(true);
      setTimeout(() => setSavedNow(false), 1400);
    })());
  }

  function deleteBatch() {
    if (!confirm(`Delete batch ${batch.batchCode}? This also deletes its actions, vehicles, and milestones. Cannot be undone.`)) return;
    run(callApi({ resource: "batch", op: "delete", id: batch.id }));
  }

  return (
    <div className="px-4 py-4 bg-ink-50/50 border-t border-ink-200 space-y-5">
      {/* PO Header */}
      <Section title="PO Header"
               warning={batch.poBatchCount > 1
                 ? `This PO has ${batch.poBatchCount} batches total. Edits to PO-level fields here only update this batch — repeat for the other ${batch.poBatchCount - 1}.`
                 : undefined}>
        <FieldGrid>
          <Field label="PO Number">
            <input className="input" value={draft.poNumber ?? ""}
                   onChange={(e) => set("poNumber", e.target.value || null)} />
          </Field>
          <Field label="PO Reference">
            <input className="input" value={draft.poReference ?? ""}
                   onChange={(e) => set("poReference", e.target.value || null)} />
          </Field>
          <Field label="Actual PO Date">
            <input type="date" className="input" value={draft.actualPoDate ?? ""}
                   onChange={(e) => set("actualPoDate", e.target.value || null)} />
          </Field>
          <Field label="Expected PO Date">
            <input type="date" className="input" value={draft.expectedPoDate ?? ""}
                   onChange={(e) => set("expectedPoDate", e.target.value || null)} />
          </Field>
          <Field label="PO Total SAR">
            <input type="number" step="0.01" className="input tabular-nums" value={draft.poTotalSar ?? ""}
                   onChange={(e) => set("poTotalSar", numOrNull(e.target.value))} />
          </Field>
          <Field label="PO Subtotal SAR">
            <input type="number" step="0.01" className="input tabular-nums" value={draft.poSubtotalSar ?? ""}
                   onChange={(e) => set("poSubtotalSar", numOrNull(e.target.value))} />
          </Field>
          <Field label="PO Tax SAR">
            <input type="number" step="0.01" className="input tabular-nums" value={draft.poTaxTotalSar ?? ""}
                   onChange={(e) => set("poTaxTotalSar", numOrNull(e.target.value))} />
          </Field>
        </FieldGrid>
      </Section>

      {/* Identity */}
      <Section title="Identity">
        <FieldGrid>
          <Field label="Dealer">
            <select className="input" value={draft.dealerId ?? ""}
                    onChange={(e) => set("dealerId", parseInt(e.target.value, 10))}>
              {dealers.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Model">
            <input className="input" value={draft.model ?? ""}
                   onChange={(e) => set("model", e.target.value || null)} />
          </Field>
          <Field label="Year">
            <input type="number" className="input tabular-nums" value={draft.year ?? ""}
                   onChange={(e) => set("year", numOrNull(e.target.value))} />
          </Field>
          <Field label="Category">
            <input className="input" value={draft.category ?? ""}
                   onChange={(e) => set("category", e.target.value || null)} />
          </Field>
          <Field label="Quantity (requested)">
            <input type="number" className="input tabular-nums" value={draft.requestedQuantity ?? ""}
                   onChange={(e) => set("requestedQuantity", numOrZero(e.target.value))} />
          </Field>
          <Field label="Confirmed" hint="dealer-confirmed cars · set by the Confirmation action">
            <input type="number" className="input tabular-nums" value={draft.confirmedQuantity ?? ""}
                   onChange={(e) => set("confirmedQuantity", numOrNull(e.target.value))} />
          </Field>
          <Field label="Delivered">
            <input type="number" className="input tabular-nums" value={draft.deliveredQuantity ?? ""}
                   onChange={(e) => set("deliveredQuantity", numOrZero(e.target.value))} />
          </Field>
          <Field label="VINs received" hint="caps delivered at close">
            <input type="number" className="input tabular-nums" value={draft.vinsReceivedQuantity ?? ""}
                   onChange={(e) => set("vinsReceivedQuantity", numOrZero(e.target.value))} />
          </Field>
          <Field label="VIN received at intake" hint="skips early VIN-chase steps">
            <select className="input" value={draft.vinReceivedAtIntake ? "yes" : "no"}
                    onChange={(e) => set("vinReceivedAtIntake", e.target.value === "yes")}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </Field>
          <Field label="Receiving City">
            <input className="input" value={draft.dealerReceivingCity ?? ""}
                   onChange={(e) => set("dealerReceivingCity", e.target.value || null)} />
          </Field>
          <Field label="App Display Cities">
            <input className="input" value={draft.appDisplayCities ?? ""}
                   onChange={(e) => set("appDisplayCities", e.target.value || null)} />
          </Field>
        </FieldGrid>
      </Section>

      {/* Dates & status */}
      <Section title="Dates & status">
        <FieldGrid>
          <Field label="Submitted">
            <input type="date" className="input" value={draft.requestedAt ?? ""}
                   onChange={(e) => set("requestedAt", e.target.value)} />
          </Field>
          <Field label="Promised delivery">
            <input type="date" className="input" value={draft.dealerPromisedDeliveryDate ?? ""}
                   onChange={(e) => set("dealerPromisedDeliveryDate", e.target.value)} />
          </Field>
          <Field label="Projected delivery">
            <input type="date" className="input" value={draft.currentProjectedDeliveryDate ?? ""}
                   onChange={(e) => set("currentProjectedDeliveryDate", e.target.value || null)} />
          </Field>
          <Field label="App listed" hint="when cars went live in-app · drives PO→Listed">
            <input type="date" className="input" value={draft.appListedAt ?? ""}
                   onChange={(e) => set("appListedAt", e.target.value || null)} />
          </Field>
          <Field label="VIN receiving date" hint="dealer's commitment to share VINs">
            <input type="date" className="input" value={draft.vinReceivingDate ?? ""}
                   onChange={(e) => set("vinReceivingDate", e.target.value || null)} />
          </Field>
          <Field label="PO expected @ lock" hint="baseline · affects variance">
            <input type="date" className="input" value={draft.poExpectedDateAtLock ?? ""}
                   onChange={(e) => set("poExpectedDateAtLock", e.target.value || null)} />
          </Field>
          <Field label="Ops projected @ lock" hint="baseline · affects variance">
            <input type="date" className="input" value={draft.opsProjectedDeliveryDateAtLock ?? ""}
                   onChange={(e) => set("opsProjectedDeliveryDateAtLock", e.target.value || null)} />
          </Field>
          <Field label="Target PO date" hint="computed from promised − lead time">
            <input className="input bg-ink-100" value={batch.targetPoDate ?? "—"} disabled />
          </Field>
          <Field label="Lifecycle">
            <select className="input" value={draft.lifecycleState ?? "post_po"}
                    onChange={(e) => set("lifecycleState", e.target.value as "pre_po" | "post_po")}>
              <option value="pre_po">Pre-PO</option>
              <option value="post_po">Post-PO</option>
            </select>
          </Field>
          <Field label="Feasibility">
            <select className="input" value={draft.feasibilityStatus ?? "feasible"}
                    onChange={(e) => set("feasibilityStatus", e.target.value)}>
              {FEASIBILITY_OPTIONS.map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
              ))}
            </select>
          </Field>
        </FieldGrid>
      </Section>

      {/* Closure — realised outcome. Drives on-time rate, delivered % and
          customer-days on Insights. closedAt without closureReason="delivered"
          is "closed but not counted as delivered". */}
      <Section title="Closure"
               warning={draft.closedAt && !draft.closureReason
                 ? "Closed date set without a closure reason — set 'delivered' for it to count as an on-time delivery on Insights."
                 : undefined}>
        <FieldGrid>
          <Field label="Delivered / closed on" hint="actual delivery date · stamps the Delivery action when reason = delivered">
            <input type="date" className="input" value={draft.closedAt ?? ""}
                   onChange={(e) => set("closedAt", e.target.value || null)} />
          </Field>
          <Field label="Closure reason">
            <select className="input" value={draft.closureReason ?? ""}
                    onChange={(e) => set("closureReason", (e.target.value || null) as BatchEditRow["closureReason"])}>
              <option value="">— open —</option>
              <option value="delivered">delivered</option>
              <option value="cancelled">cancelled</option>
            </select>
          </Field>
          <Field label="Cancellation note">
            <input className="input" value={draft.cancellationNote ?? ""}
                   onChange={(e) => set("cancellationNote", e.target.value || null)} />
          </Field>
        </FieldGrid>
      </Section>

      {/* Commercial */}
      <Section title="Commercial">
        <FieldGrid>
          <Field label="Buy-back rate (SAR)">
            <input type="number" className="input tabular-nums" value={draft.buyBackRate ?? ""}
                   onChange={(e) => set("buyBackRate", numOrNull(e.target.value))} />
          </Field>
          <Field label="Contract length (months)">
            <input type="number" className="input tabular-nums" value={draft.contractLengthMonths ?? ""}
                   onChange={(e) => set("contractLengthMonths", numOrNull(e.target.value))} />
          </Field>
          <Field label="Colors">
            <input className="input" value={draft.colorSummary ?? ""}
                   onChange={(e) => set("colorSummary", e.target.value || null)} />
          </Field>
          <Field label="Unit price (SAR)">
            <input type="number" step="0.01" className="input tabular-nums" value={draft.unitPriceSar ?? ""}
                   onChange={(e) => set("unitPriceSar", numOrNull(e.target.value))} />
          </Field>
          <Field label="Tax %">
            <input type="number" className="input tabular-nums" value={draft.taxPct ?? ""}
                   onChange={(e) => set("taxPct", numOrNull(e.target.value))} />
          </Field>
          <Field label="Line amount (SAR)">
            <input type="number" step="0.01" className="input tabular-nums" value={draft.lineAmountSar ?? ""}
                   onChange={(e) => set("lineAmountSar", numOrNull(e.target.value))} />
          </Field>
        </FieldGrid>
      </Section>

      {/* Confidence */}
      <Section title="Confidence">
        <FieldGrid>
          <Field label="Partnership (live)" hint={
            batch.partnershipConfidenceAtLock != null
              ? `🔒 locked at ${Math.round(batch.partnershipConfidenceAtLock)}%`
              : "not locked yet"
          }>
            <input type="number" min={0} max={100} className="input tabular-nums" value={draft.partnershipConfidence ?? ""}
                   onChange={(e) => set("partnershipConfidence", numOrNull(e.target.value))} />
          </Field>
          <Field label="Operations (live)" hint={
            batch.operationsConfidenceAtLock != null
              ? `🔒 locked at ${Math.round(batch.operationsConfidenceAtLock)}%`
              : "not locked yet"
          }>
            <input type="number" min={0} max={100} className="input tabular-nums" value={draft.operationsConfidence ?? ""}
                   onChange={(e) => set("operationsConfidence", numOrNull(e.target.value))} />
          </Field>
          <Field label="Risk score">
            <input type="number" min={0} max={100} className="input tabular-nums" value={draft.riskScore ?? ""}
                   onChange={(e) => set("riskScore", numOrNull(e.target.value))} />
          </Field>
        </FieldGrid>
      </Section>

      {/* Notes */}
      <Section title="Notes">
        <textarea className="input min-h-[60px]" value={draft.notes ?? ""}
                  onChange={(e) => set("notes", e.target.value || null)} />
      </Section>

      {/* Actions — READ-ONLY mirror of the live, scope-aware action state.
          Status is changed in the Action Center (footer link), never here,
          so there's a single source of truth and no legacy/scope-aware
          drift. This block exists only so the admin can see the canonical
          state inline while editing a batch's fields. */}
      <Section title={`Actions (${batch.actions.length})`}>
        <p className="text-[0.7rem] text-ink-500 mb-2">
          Read-only — change action status in the Action Center.
        </p>
        {batch.actions.length === 0 ? (
          <p className="text-xs text-ink-500 italic">
            No actions yet. {batch.lifecycleState === "pre_po"
              ? "This is a Pre-PO bet — actions are picked when its PO arrives."
              : ""}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {batch.actions.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 px-2.5 py-1.5 rounded-md bg-white border border-ink-200">
                <span className="text-sm font-medium text-midnight flex-1 min-w-[10rem]">
                  {a.status === "done" ? a.doneLabel : a.waitingLabel}
                </span>
                <span className="text-[0.7rem] text-ink-500">{a.departmentName ?? "— unassigned —"}</span>
                {a.completedAt && (() => {
                  // Local-time yyyy-mm-dd; naive slice(0,10) on the UTC
                  // ISO mis-aligns by a day for near-midnight picks in
                  // non-UTC timezones.
                  const d = new Date(a.completedAt);
                  const pad = (n: number) => String(n).padStart(2, "0");
                  const local = Number.isNaN(d.getTime())
                    ? a.completedAt.slice(0, 10)
                    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
                  return <span className="text-[0.7rem] text-ink-500 tabular-nums">✓ {local}</span>;
                })()}
                <StatusBadge status={a.status} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Footer actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-ink-200">
        <div className="text-xs text-ink-500">
          {error && <span role="alert" className="text-flame-dark">{error}</span>}
        </div>
        <div className="flex gap-2">
          <a
            href="/action-center"
            className="btn text-sm"
          >Open in Action Center</a>
          <button
            type="button"
            className="btn text-sm"
            disabled={pending}
            onClick={deleteBatch}
          >Delete batch</button>
          <button
            type="button"
            className="btn btn-primary text-sm"
            disabled={pending}
            onClick={saveBatch}
          >
            {savedNow ? "✓ Saved" : pending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Tiny presentational helpers
// ──────────────────────────────────────────────────────────────────

function Section({
  title, warning, children,
}: {
  title: string;
  warning?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-ink-600 uppercase tracking-wide mb-2">{title}</p>
      {warning && (
        <div className="mb-3 px-3 py-2 rounded-md bg-gold-pale border border-gold text-xs text-midnight" role="note">
          ⚠️ {warning}
        </div>
      )}
      {children}
    </div>
  );
}

function FieldGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 md:grid-cols-3 gap-3">{children}</div>;
}

function Field({
  label, hint, children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-ink-600 mb-1">
        {label}
        {hint && <span className="text-ink-400 ml-2 font-normal">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function numOrNull(s: string): number | null {
  if (!s.trim()) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function numOrZero(s: string): number {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

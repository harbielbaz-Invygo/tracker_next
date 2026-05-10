"use client";

/**
 * Settings → Batches editor.
 *
 * Accordion-style admin override for any batch's fields. One row at a time
 * expands inline to a full edit form grouped by section (PO header /
 * Identity / Dates / Commercial / Confidence / Notes / Actions).
 *
 * Save mutates via /api/settings { resource: "batch", op: "update", … }.
 * Delete via { resource: "batch", op: "delete", id }.
 *
 * The action list inside the expanded row is editable too (status flip +
 * department reassign) — same APIs Cockpit uses.
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

const STAGE_OPTIONS = [
  "request_submitted", "contract_signed", "po_issued",
  "dealer_policy_resolved", "color_matrix_received",
  "dummy_listed", "dummy_approved",
  "dealer_confirmation", "vin_assigned", "plate_assigned",
  "customs_card_received", "registration", "insurance",
  "inspection", "system_setup", "app_listing_real",
  "booking_enabled", "first_booking", "delivered",
];

const FEASIBILITY_OPTIONS: Array<"feasible" | "at_risk" | "infeasible"> =
  ["feasible", "at_risk", "infeasible"];

const ACTION_STATUS_OPTIONS: Array<"waiting" | "blocked" | "done" | "skipped"> =
  ["waiting", "blocked", "done", "skipped"];

export default function SettingsBatches({ data }: Props) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [search, setSearch]         = useState("");
  const [dealerFilter, setDealerFilter] = useState<string>("all");
  const [lifecycleFilter, setLifecycleFilter] = useState<"all" | "pre_po" | "post_po">("all");

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

  return (
    <CollapsibleCard
      title="Batches"
      description="Admin override — edit any batch's data after creation. Most updates should still go through Intake (create) and Cockpit (action statuses)."
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

      <div className="border border-ink-200 rounded-md overflow-hidden">
        {filtered.length === 0 ? (
          <p className="px-4 py-8 text-sm text-ink-500 text-center">
            No batches match the filters.
          </p>
        ) : (
          <ul className="divide-y divide-ink-200">
            {filtered.map((b) => (
              <li key={b.id}>
                <SummaryRow
                  batch={b}
                  expanded={expandedId === b.id}
                  onToggle={() => setExpandedId((v) => (v === b.id ? null : b.id))}
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
        )}
      </div>
    </CollapsibleCard>
  );
}

// ──────────────────────────────────────────────────────────────────
// Summary row
// ──────────────────────────────────────────────────────────────────

function SummaryRow({
  batch, expanded, onToggle,
}: {
  batch: BatchEditRow;
  expanded: boolean;
  onToggle: () => void;
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

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className={cn(
        "w-full text-left px-3 py-2.5 flex flex-wrap items-center gap-3",
        "hover:bg-ink-50 focus-visible:bg-ink-50 outline-none",
        "focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-[-2px]",
        expanded && "bg-brand-pastel hover:bg-brand-pastel",
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
    allocatedQuantity: batch.allocatedQuantity,
    deliveredQuantity: batch.deliveredQuantity,
    appDisplayCities: batch.appDisplayCities,
    dealerReceivingCity: batch.dealerReceivingCity,

    requestedAt: batch.requestedAt,
    dealerPromisedDeliveryDate: batch.dealerPromisedDeliveryDate,
    currentProjectedDeliveryDate: batch.currentProjectedDeliveryDate,

    currentStage: batch.currentStage,
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

  async function callBatchAction(body: unknown): Promise<void> {
    const res = await fetch("/api/batch-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
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

  function setActionStatus(actionId: number, newStatus: "waiting" | "done" | "blocked" | "skipped") {
    run(callBatchAction({ batchActionId: actionId, newStatus }));
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
          <Field label="Allocated">
            <input type="number" className="input tabular-nums" value={draft.allocatedQuantity ?? ""}
                   onChange={(e) => set("allocatedQuantity", numOrZero(e.target.value))} />
          </Field>
          <Field label="Delivered">
            <input type="number" className="input tabular-nums" value={draft.deliveredQuantity ?? ""}
                   onChange={(e) => set("deliveredQuantity", numOrZero(e.target.value))} />
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
          <Field label="Target PO date" hint="computed from promised − lead time">
            <input className="input bg-ink-100" value={batch.targetPoDate ?? "—"} disabled />
          </Field>
          <Field label="Current stage">
            <select className="input" value={draft.currentStage ?? ""}
                    onChange={(e) => set("currentStage", e.target.value)}>
              {STAGE_OPTIONS.map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
              ))}
            </select>
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

      {/* Actions */}
      <Section title={`Actions (${batch.actions.length})`}>
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
                {a.completedAt && (
                  <span className="text-[0.7rem] text-ink-500 tabular-nums">✓ {a.completedAt.slice(0, 10)}</span>
                )}
                <select
                  className="input text-xs py-1 max-w-[8rem]"
                  value={a.status}
                  onChange={(e) => setActionStatus(a.id, e.target.value as typeof ACTION_STATUS_OPTIONS[number])}
                  disabled={pending}
                  aria-label={`Status of ${a.actionTypeName}`}
                >
                  {ACTION_STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
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
            href="/cockpit"
            className="btn text-sm"
          >Open in Cockpit</a>
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

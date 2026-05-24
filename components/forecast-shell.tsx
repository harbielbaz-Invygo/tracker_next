"use client";

/**
 * Forecast shell — submission form + list of existing Forecasts.
 *
 * Form fields (v2):
 *   - Dealer: pick existing OR add new (auto-creates a dealer row)
 *   - Items: city + quantity (≥ 1 row, "Add another item" extends)
 *   - Expected Delivery Date
 *   - Expected PO Signing Date (optional)
 *   - Submitting user: filtered to Partnership-department members
 *     (falls back to all users when the migration hasn't run).
 *
 * After a successful submit we router.refresh() so the new row shows
 * up in the list below.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ForecastRow, ForecastFormOptions, ForecastStatus } from "@/lib/forecast-data";
import { cn } from "@/lib/utils";

interface Props {
  rows: ForecastRow[];
  options: ForecastFormOptions;
}

interface ItemDraft {
  city: string;
  quantity: number | "";
}

export default function ForecastShell({ rows, options }: Props) {
  const router = useRouter();

  // Dealer mode — pick existing or type a new name.
  const [dealerMode, setDealerMode] = useState<"existing" | "new">("existing");
  const [dealerId,   setDealerId]   = useState<number | "">("");
  const [dealerName, setDealerName] = useState<string>("");

  // Items
  const [items, setItems] = useState<ItemDraft[]>([{ city: "", quantity: "" }]);

  // Dates
  const [expectedDeliveryDate,  setExpectedDeliveryDate]  = useState<string>("");
  const [expectedPoSigningDate, setExpectedPoSigningDate] = useState<string>("");

  // Submitter
  const [submitterId, setSubmitterId] = useState<number | "">("");

  const [submitting,  setSubmitting]  = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function resetForm() {
    setDealerMode("existing");
    setDealerId("");
    setDealerName("");
    setItems([{ city: "", quantity: "" }]);
    setExpectedDeliveryDate("");
    setExpectedPoSigningDate("");
    setSubmitterId("");
  }

  function addItem() {
    setItems((prev) => [...prev, { city: "", quantity: "" }]);
  }
  function removeItem(idx: number) {
    setItems((prev) => prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx));
  }
  function updateItem(idx: number, patch: Partial<ItemDraft>) {
    setItems((prev) => prev.map((it, i) => i === idx ? { ...it, ...patch } : it));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    // Dealer validation
    if (dealerMode === "existing" && dealerId === "") {
      setSubmitError("Pick a dealer or switch to 'Add new'.");
      return;
    }
    if (dealerMode === "new" && !dealerName.trim()) {
      setSubmitError("Enter the new dealer's name.");
      return;
    }
    // Items validation — every row needs city + qty.
    const cleanedItems: { city: string; quantity: number }[] = [];
    for (const [i, it] of items.entries()) {
      const c = it.city.trim();
      const q = it.quantity;
      if (!c || q === "" || !Number.isFinite(q) || (q as number) <= 0) {
        setSubmitError(`Item ${i + 1}: enter a city and a positive quantity.`);
        return;
      }
      cleanedItems.push({ city: c, quantity: q as number });
    }
    if (!expectedDeliveryDate) {
      setSubmitError("Expected delivery date is required.");
      return;
    }
    if (submitterId === "") {
      setSubmitError("Pick the submitting user.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/forecast/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(dealerMode === "existing" ? { dealerId } : { dealerName: dealerName.trim() }),
          items:                    cleanedItems,
          expectedDeliveryDate,
          expectedPoSigningDate:    expectedPoSigningDate || null,
          // Dropdown binds a Partnership stakeholder (not a user). The
          // auth account that clicked submit lives in submittedByUserId
          // server-side.
          submittedByStakeholderId: submitterId,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      resetForm();
      router.refresh();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function onCancel(batchId: number, label: string) {
    if (!confirm(`Cancel forecast for ${label}? This counts as a miss in the partner's accuracy stats.`)) return;
    try {
      const res = await fetch("/api/forecast/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId }),
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      alert(`Could not cancel: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const totalQty = items.reduce(
    (sum, it) => sum + (typeof it.quantity === "number" ? it.quantity : 0),
    0,
  );

  return (
    <div className="space-y-6">
      <section className="card">
        <h2 className="text-base font-bold text-midnight mb-3">Submit a Forecast</h2>
        <form onSubmit={onSubmit} className="space-y-4">
          {/* Dealer — picker with mode toggle for new dealer entry. */}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
            <Field label="Dealer" required>
              {dealerMode === "existing" ? (
                <select
                  className="input"
                  value={dealerId}
                  onChange={(e) => setDealerId(e.target.value === "" ? "" : Number(e.target.value))}
                  disabled={submitting}
                  required
                >
                  <option value="">Pick a dealer…</option>
                  {options.dealers.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  className="input"
                  placeholder="New dealer name (e.g. Hyundai of Riyadh)"
                  value={dealerName}
                  onChange={(e) => setDealerName(e.target.value)}
                  disabled={submitting}
                  required
                />
              )}
            </Field>
            <button
              type="button"
              onClick={() => {
                setDealerMode((m) => m === "existing" ? "new" : "existing");
                setDealerId("");
                setDealerName("");
              }}
              disabled={submitting}
              className="text-xs px-3 py-2 rounded-md border border-brand text-brand-dark hover:bg-brand-pastel/40 whitespace-nowrap"
            >
              {dealerMode === "existing" ? "+ Add new dealer" : "← Pick existing"}
            </button>
          </div>

          {/* Items — city × quantity, ≥ 1 row. */}
          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="block text-xs font-medium text-midnight">
                Cities &amp; quantities<span className="text-flame-dark"> *</span>
              </span>
              <span className="text-[0.7rem] text-ink-500 tabular-nums">
                Total: <span className="text-midnight font-medium">{totalQty}</span> car{totalQty === 1 ? "" : "s"}
              </span>
            </div>
            <div className="space-y-1.5">
              {items.map((it, idx) => (
                <div key={idx} className="grid grid-cols-[auto_1fr_8rem_auto] items-baseline gap-2">
                  <span className="text-[0.7rem] text-ink-500 tabular-nums w-[3.5rem]">
                    Item {idx + 1}
                  </span>
                  <input
                    type="text"
                    className="input"
                    placeholder="City (e.g. Riyadh)"
                    value={it.city}
                    onChange={(e) => updateItem(idx, { city: e.target.value })}
                    disabled={submitting}
                    required
                  />
                  <input
                    type="number"
                    min={1}
                    step={1}
                    className="input tabular-nums"
                    placeholder="Qty"
                    value={it.quantity}
                    onChange={(e) => updateItem(idx, {
                      quantity: e.target.value === "" ? "" : Number(e.target.value),
                    })}
                    disabled={submitting}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => removeItem(idx)}
                    disabled={submitting || items.length <= 1}
                    title={items.length <= 1 ? "At least one item required." : "Remove this item"}
                    className={cn(
                      "text-[0.7rem] px-2 py-1 rounded border",
                      items.length <= 1
                        ? "border-ink-200 text-ink-300 cursor-not-allowed"
                        : "border-flame text-flame-dark hover:bg-flame-pale",
                    )}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addItem}
              disabled={submitting}
              className="mt-2 text-[0.7rem] px-2 py-1 rounded border border-brand text-brand-dark hover:bg-brand-pastel/40"
            >
              + Add another item
            </button>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Expected delivery date" required>
              <input
                type="date"
                className="input tabular-nums"
                value={expectedDeliveryDate}
                onChange={(e) => setExpectedDeliveryDate(e.target.value)}
                disabled={submitting}
                required
              />
            </Field>
            <Field label="Expected PO signing date">
              <input
                type="date"
                className="input tabular-nums"
                value={expectedPoSigningDate}
                onChange={(e) => setExpectedPoSigningDate(e.target.value)}
                disabled={submitting}
              />
            </Field>
          </div>

          {/* Submitter */}
          <Field label="Submitting user" required>
            <select
              className="input"
              value={submitterId}
              onChange={(e) => setSubmitterId(e.target.value === "" ? "" : Number(e.target.value))}
              disabled={submitting}
              required
            >
              <option value="">Pick the Partnership member…</option>
              {options.users.map((u) => (
                <option key={u.id} value={u.id}>{u.label}</option>
              ))}
            </select>
            {options.users.length === 0 && (
              <p className="mt-1 text-[0.7rem] text-flame-dark">
                No Partnership members configured. Assign users to the Partnership department in Settings.
              </p>
            )}
          </Field>

          <div className="flex items-center justify-between gap-3 pt-1">
            <p className="text-xs text-ink-500">
              A &quot;Pre-PO App Listing&quot; action is created automatically — you can mark it done in the Action Center as soon as cars go live in the app.
            </p>
            <button
              type="submit"
              disabled={submitting}
              className={cn(
                "btn btn-primary",
                submitting && "opacity-60 cursor-wait",
              )}
            >
              {submitting ? "Submitting…" : "Submit Forecast"}
            </button>
          </div>
          {submitError && (
            <p role="alert" className="text-sm text-flame-dark">
              {submitError}
            </p>
          )}
        </form>
      </section>

      <section className="card p-0 overflow-hidden">
        <header className="px-4 py-3 border-b border-ink-200 flex items-baseline justify-between gap-2">
          <h2 className="text-base font-bold text-midnight">Forecasts</h2>
          <span className="text-xs text-ink-500 tabular-nums">
            {rows.length} {rows.length === 1 ? "submission" : "submissions"}
          </span>
        </header>
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-sm text-ink-500 text-center">
            No forecasts yet. Submit one above to get started.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-[0.65rem] text-ink-500 uppercase tracking-wide">
                <tr>
                  <th className="text-left px-3 py-2">Batch</th>
                  <th className="text-left px-3 py-2">Dealer</th>
                  <th className="text-left px-3 py-2">City</th>
                  <th className="text-right px-3 py-2">Qty</th>
                  <th className="text-left px-3 py-2">Expected</th>
                  <th className="text-left px-3 py-2">Submitted</th>
                  <th className="text-left px-3 py-2">By</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.batchId} className="border-t border-ink-200/60">
                    <td className="px-3 py-2 font-mono text-[0.7rem] text-midnight">{r.batchCode}</td>
                    <td className="px-3 py-2 text-midnight">{r.dealerName}</td>
                    <td className="px-3 py-2">{r.city}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.quantity}</td>
                    <td className="px-3 py-2 tabular-nums">{r.expectedDeliveryDate}</td>
                    <td className="px-3 py-2 tabular-nums">{r.submittedAt}</td>
                    <td className="px-3 py-2 text-ink-600">{r.submittedByName}</td>
                    <td className="px-3 py-2"><StatusChip status={r.status} /></td>
                    <td className="px-3 py-2 text-right">
                      {r.status === "open" ? (
                        <button
                          type="button"
                          onClick={() => onCancel(r.batchId, r.batchCode)}
                          className="text-[0.7rem] font-medium text-flame-dark hover:text-flame px-2 py-0.5"
                        >
                          Cancel
                        </button>
                      ) : (
                        <span className="text-[0.65rem] text-ink-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Field({
  label, required, children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-midnight mb-1">
        {label}{required && <span className="text-flame-dark"> *</span>}
      </span>
      {children}
    </label>
  );
}

function StatusChip({ status }: { status: ForecastStatus }) {
  const map: Record<ForecastStatus, { label: string; cls: string }> = {
    open:       { label: "Open",       cls: "bg-brand-pastel text-brand-dark border-brand" },
    fulfilled:  { label: "Fulfilled",  cls: "bg-green-pale text-green-dark border-green" },
    superseded: { label: "Superseded", cls: "bg-gold-pale text-gold-dark border-gold" },
    cancelled:  { label: "Cancelled",  cls: "bg-flame-pale text-flame-dark border-flame" },
  };
  const m = map[status];
  return (
    <span className={cn(
      "inline-block px-1.5 py-0.5 rounded text-[0.65rem] font-medium border whitespace-nowrap",
      m.cls,
    )}>
      {m.label}
    </span>
  );
}

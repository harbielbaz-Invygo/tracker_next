"use client";

/**
 * Forecast shell — submission form + list of existing Forecasts.
 *
 * Form fields (kept minimal per the design discussion):
 *   - Dealer (required, dropdown)
 *   - Quantity (required, integer)
 *   - City (required, text)
 *   - Expected Delivery Date (required, ISO yyyy-mm-dd)
 *   - Submitting user (Partnership team member, required)
 *
 * Submitter is picked from the standard `users` table. We don't track
 * a separate "Partnership" role today — Q&A decision was to reuse
 * `ops` and have ops manually pick the right person in the dropdown.
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

export default function ForecastShell({ rows, options }: Props) {
  const router = useRouter();

  // Form state
  const [dealerId,    setDealerId]    = useState<number | "">("");
  const [quantity,    setQuantity]    = useState<number | "">("");
  const [city,        setCity]        = useState<string>("");
  const [expectedDate, setExpectedDate] = useState<string>("");
  const [submitterId, setSubmitterId] = useState<number | "">("");
  const [submitting,  setSubmitting]  = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function resetForm() {
    setDealerId("");
    setQuantity("");
    setCity("");
    setExpectedDate("");
    setSubmitterId("");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (dealerId === "" || quantity === "" || !city.trim() || !expectedDate || submitterId === "") {
      setSubmitError("All fields are required.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/forecast/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dealerId, quantity, city: city.trim(), expectedDate, submittedByUserId: submitterId,
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

  return (
    <div className="space-y-6">
      <section className="card">
        <h2 className="text-base font-bold text-midnight mb-3">Submit a Forecast</h2>
        <form onSubmit={onSubmit} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          <Field label="Dealer" required>
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
          </Field>

          <Field label="Quantity" required>
            <input
              type="number"
              min={1}
              step={1}
              className="input tabular-nums"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value === "" ? "" : Number(e.target.value))}
              disabled={submitting}
              required
            />
          </Field>

          <Field label="City" required>
            <input
              type="text"
              className="input"
              placeholder="e.g. Riyadh"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              disabled={submitting}
              required
            />
          </Field>

          <Field label="Expected delivery date" required>
            <input
              type="date"
              className="input tabular-nums"
              value={expectedDate}
              onChange={(e) => setExpectedDate(e.target.value)}
              disabled={submitting}
              required
            />
          </Field>

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
          </Field>

          <div className="md:col-span-2 lg:col-span-3 flex items-center justify-between gap-3">
            <p className="text-xs text-ink-500">
              A "Pre-PO App Listing" action is created automatically — you can mark it done in the Action Center as soon as cars go live in the app.
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
            <p role="alert" className="md:col-span-2 lg:col-span-3 text-sm text-flame-dark">
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

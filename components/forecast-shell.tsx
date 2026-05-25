"use client";

/**
 * Forecast shell — Pre-PO listing exception flow.
 *
 * The Forecast tab covers the *exception* path where Partnership lists
 * cars on the app BEFORE a real PO is signed:
 *
 *   1. Capture what was committed to customers per row
 *      (city × car model × qty × listing date × per-row availability).
 *   2. Track the dealer's promised PO-signing date so the
 *      auto-attached follow-up actions know what to chase.
 *   3. Booking counts are updated in the Action Center pre-PO drawer
 *      (not here) — this surface is for submission + manual link only.
 *   4. When the signed PO finally arrives, the operator manually links
 *      this Forecast to its post-PO batch through a diff-aware dialog,
 *      so spelling drift (Jeedah → Jeddah) or model swaps (Accent →
 *      MG5) or qty drift (20 → 25) are reviewed before binding the
 *      two records together.
 *
 * The standard PO-first flow stays on the Intake tab. This shell is
 * only used when Partnership has gone live before the PO exists.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  ForecastRow, ForecastFormOptions, ForecastStatus, ForecastLeg,
  ForecastLinkCandidate,
} from "@/lib/forecast-data";
import ConfirmDialog from "./confirm-dialog";
import { useConfirmDialog } from "./use-confirm-dialog";
import { cn } from "@/lib/utils";

interface Props {
  rows: ForecastRow[];
  options: ForecastFormOptions;
  linkCandidates: ForecastLinkCandidate[];
}

interface RowDraft {
  city: string;
  carModel: string;
  quantity: number | "";
  promisedAvailabilityDate: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function ForecastShell({ rows, options, linkCandidates }: Props) {
  const router = useRouter();
  const { confirm, alert, dialogProps } = useConfirmDialog();

  // ── Form state ────────────────────────────────────────────
  // Dealer mode — pick existing or type a new name.
  const [dealerMode, setDealerMode] = useState<"existing" | "new">("existing");
  const [dealerId,   setDealerId]   = useState<number | "">("");
  const [dealerName, setDealerName] = useState<string>("");

  // Per-row commitments. Each row carries city × model × qty plus an
  // optional per-row promised availability date. The "Listed on" date
  // is captured once for the whole submission (rows go live together);
  // when Partnership lists rows on different days they should submit
  // them as separate Forecasts.
  const [rowsDraft, setRowsDraft] = useState<RowDraft[]>([
    { city: "", carModel: "", quantity: "", promisedAvailabilityDate: "" },
  ]);
  const [listedAt, setListedAt] = useState<string>(todayIso());

  // PO-wide dates.
  const [expectedDeliveryDate,  setExpectedDeliveryDate]  = useState<string>("");
  const [promisedPoSigningDate, setPromisedPoSigningDate] = useState<string>("");

  // Submitter — defaults to first Partnership user if available.
  const [submitterId, setSubmitterId] = useState<number | "">(() => {
    return options.users[0]?.id ?? "";
  });

  const [submitting,  setSubmitting]  = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);

  // ── Link-PO dialog state ─────────────────────────────────
  const [linkOpenFor, setLinkOpenFor] = useState<ForecastRow | null>(null);

  function resetForm() {
    setDealerMode("existing");
    setDealerId("");
    setDealerName("");
    setRowsDraft([{ city: "", carModel: "", quantity: "", promisedAvailabilityDate: "" }]);
    setListedAt(todayIso());
    setExpectedDeliveryDate("");
    setPromisedPoSigningDate("");
    setSubmitterId(options.users[0]?.id ?? "");
  }

  function addRow() {
    setRowsDraft((prev) => [
      ...prev,
      { city: "", carModel: "", quantity: "", promisedAvailabilityDate: "" },
    ]);
  }
  function removeRow(idx: number) {
    setRowsDraft((prev) => prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx));
  }
  function updateRow(idx: number, patch: Partial<RowDraft>) {
    setRowsDraft((prev) => prev.map((it, i) => i === idx ? { ...it, ...patch } : it));
  }

  // ── Submit ───────────────────────────────────────────────
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setSubmitSuccess(null);

    if (dealerMode === "existing" && dealerId === "") {
      setSubmitError("Pick a dealer or switch to 'Add new'.");
      return;
    }
    if (dealerMode === "new" && !dealerName.trim()) {
      setSubmitError("Enter the new dealer's name.");
      return;
    }
    const cleanedRows: {
      city: string; carModel: string | null; quantity: number;
      listedAt: string | null; promisedAvailabilityDate: string | null;
    }[] = [];
    for (const [i, it] of rowsDraft.entries()) {
      const c = it.city.trim();
      const q = it.quantity;
      const m = it.carModel.trim();
      if (!c || q === "" || !Number.isFinite(q) || (q as number) <= 0) {
        setSubmitError(`Row ${i + 1}: enter a city and a positive quantity.`);
        return;
      }
      if (!m) {
        setSubmitError(`Row ${i + 1}: enter the car model that was listed.`);
        return;
      }
      cleanedRows.push({
        city: c,
        carModel: m,
        quantity: q as number,
        listedAt: listedAt || null,
        promisedAvailabilityDate: it.promisedAvailabilityDate || null,
      });
    }
    if (!expectedDeliveryDate) {
      setSubmitError("PO-wide expected delivery date is required as a fallback for rows that don't set their own.");
      return;
    }
    if (submitterId === "") {
      setSubmitError("Pick the submitting Partnership member.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/forecast/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(dealerMode === "existing" ? { dealerId } : { dealerName: dealerName.trim() }),
          items: cleanedRows,
          expectedDeliveryDate,
          expectedPoSigningDate: promisedPoSigningDate || null,
          submittedByUserId: submitterId,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as { batchCode: string };
      setSubmitSuccess(`Forecast ${data.batchCode} submitted.`);
      resetForm();
      router.refresh();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function onCancel(row: ForecastRow) {
    const ok = await confirm({
      title: `Cancel Forecast ${row.batchCode}?`,
      description:
        `This counts as a miss in the partner's accuracy stats. ` +
        (row.totalBookings > 0
          ? `\n\n⚠ ${row.totalBookings} customer booking${row.totalBookings === 1 ? "" : "s"} ${row.totalBookings === 1 ? "is" : "are"} already recorded on this Forecast — you'll need to notify those customers separately.`
          : `\n\nNo customer bookings recorded on this Forecast.`),
      confirmLabel: "Cancel Forecast",
      cancelLabel:  "Keep open",
      danger:       true,
    });
    if (!ok) return;
    try {
      const res = await fetch("/api/forecast/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: row.batchId }),
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      await alert({
        title: "Could not cancel Forecast",
        description: e instanceof Error ? e.message : String(e),
        danger: true,
      });
    }
  }

  // Filter link candidates to same-dealer when a row is open, with
  // cross-dealer rows surfaced below as a fallback (dealer renames
  // happen — operator can still pick one and see the diff).
  const candidatesForOpenRow = useMemo(() => {
    if (!linkOpenFor) return { sameDealer: [], otherDealer: [] };
    const same = linkCandidates.filter((c) => c.dealerId === linkOpenFor.dealerId);
    const other = linkCandidates.filter((c) => c.dealerId !== linkOpenFor.dealerId);
    return { sameDealer: same, otherDealer: other };
  }, [linkOpenFor, linkCandidates]);

  const today = todayIso();

  return (
    <div className="space-y-6">
      <ConfirmDialog {...dialogProps} />

      {/* ── Submission form ──────────────────────────────────── */}
      <section className="card">
        <h2 className="text-base font-bold text-midnight mb-1">Submit a pre-PO Forecast</h2>
        <p className="text-xs text-ink-500 mb-3 leading-snug">
          For the exception case: Partnership listed cars on the app before the
          dealer signed the PO. Each row records what customers actually saw —
          city, car model, quantity. The dealer&apos;s promised PO-signing date
          drives the Action Center follow-up; bookings come in over time and are
          updated from the Action Center pre-PO drawer.
        </p>
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

          {/* Listed-on date — applies to every row in this submission. */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Listed on app (date)" required>
              <input
                type="date"
                className="input tabular-nums"
                value={listedAt}
                onChange={(e) => setListedAt(e.target.value)}
                disabled={submitting}
                required
              />
            </Field>
            <Field label="Promised PO-signing date">
              <input
                type="date"
                className="input tabular-nums"
                value={promisedPoSigningDate}
                onChange={(e) => setPromisedPoSigningDate(e.target.value)}
                disabled={submitting}
              />
              <p className="text-[0.65rem] text-ink-500 mt-1 leading-snug">
                Drives the PO-signing chase in the Action Center.
              </p>
            </Field>
            <Field label="PO-wide expected delivery" required>
              <input
                type="date"
                className="input tabular-nums"
                value={expectedDeliveryDate}
                onChange={(e) => setExpectedDeliveryDate(e.target.value)}
                disabled={submitting}
                required
              />
              <p className="text-[0.65rem] text-ink-500 mt-1 leading-snug">
                Fallback for rows that don&apos;t set their own.
              </p>
            </Field>
          </div>

          {/* Per-row listing rows. */}
          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="block text-xs font-medium text-midnight">
                Listed rows<span className="text-flame-dark"> *</span>
              </span>
              <span className="text-[0.7rem] text-ink-500 tabular-nums">
                {rowsDraft.length} row{rowsDraft.length === 1 ? "" : "s"} · Total cars:{" "}
                <span className="text-midnight font-medium">
                  {rowsDraft.reduce((s, r) => s + (typeof r.quantity === "number" ? r.quantity : 0), 0)}
                </span>
              </span>
            </div>
            <div className="space-y-1.5">
              {rowsDraft.map((row, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-[auto_1fr_1fr_5rem_8rem_auto] items-baseline gap-2"
                >
                  <span className="text-[0.7rem] text-ink-500 tabular-nums w-[2.5rem]">
                    #{idx + 1}
                  </span>
                  <input
                    type="text"
                    className="input"
                    placeholder="City"
                    value={row.city}
                    onChange={(e) => updateRow(idx, { city: e.target.value })}
                    disabled={submitting}
                    required
                  />
                  <input
                    type="text"
                    className="input"
                    placeholder="Car model"
                    value={row.carModel}
                    onChange={(e) => updateRow(idx, { carModel: e.target.value })}
                    disabled={submitting}
                    required
                  />
                  <input
                    type="number"
                    min={1}
                    step={1}
                    className="input tabular-nums"
                    placeholder="Qty"
                    value={row.quantity}
                    onChange={(e) => updateRow(idx, {
                      quantity: e.target.value === "" ? "" : Number(e.target.value),
                    })}
                    disabled={submitting}
                    required
                  />
                  <input
                    type="date"
                    className="input tabular-nums text-[0.75rem]"
                    placeholder="Avail. date"
                    title="Per-row promised availability date (optional — falls back to PO-wide)"
                    value={row.promisedAvailabilityDate}
                    onChange={(e) => updateRow(idx, { promisedAvailabilityDate: e.target.value })}
                    disabled={submitting}
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(idx)}
                    disabled={submitting || rowsDraft.length <= 1}
                    title={rowsDraft.length <= 1 ? "At least one row required." : "Remove this row"}
                    className={cn(
                      "text-[0.7rem] px-2 py-1 rounded border",
                      rowsDraft.length <= 1
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
              onClick={addRow}
              disabled={submitting}
              className="mt-2 text-[0.7rem] px-2 py-1 rounded border border-brand text-brand-dark hover:bg-brand-pastel/40"
            >
              + Add another row
            </button>
          </div>

          {/* Submitter */}
          <Field label="Submitting Partnership member" required>
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
            <p className="text-xs text-ink-500 leading-snug">
              A &quot;Pre-PO App Listing&quot; action and a &quot;PO Signing chase&quot;
              follow-up are auto-attached. Mark them done in the Action Center pre-PO drawer.
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
          {submitSuccess && !submitError && (
            <p role="status" className="text-sm text-green-dark">
              ✓ {submitSuccess}
            </p>
          )}
        </form>
      </section>

      {/* ── Existing Forecasts list ───────────────────────────── */}
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
          <ul className="divide-y divide-ink-200">
            {rows.map((r) => (
              <ForecastListRow
                key={r.batchId}
                row={r}
                today={today}
                onCancel={() => onCancel(r)}
                onOpenLink={() => setLinkOpenFor(r)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* ── Manual Link-PO dialog ─────────────────────────────── */}
      {linkOpenFor && (
        <LinkPoDialog
          forecast={linkOpenFor}
          sameDealer={candidatesForOpenRow.sameDealer}
          otherDealer={candidatesForOpenRow.otherDealer}
          onClose={() => setLinkOpenFor(null)}
          onLinked={() => {
            setLinkOpenFor(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Row renderer + supporting widgets
// ──────────────────────────────────────────────────────────────────

function ForecastListRow({
  row, today, onCancel, onOpenLink,
}: {
  row: ForecastRow;
  today: string;
  onCancel: () => void;
  onOpenLink: () => void;
}) {
  const poSigningStatus = poSigningChase(row.promisedPoSigningDate, today, row.status);
  return (
    <li className="px-4 py-3 space-y-2">
      {/* Headline strip — batch code, dealer, status, action buttons. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 justify-between">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <code className="font-mono text-[0.75rem] text-midnight">{row.batchCode}</code>
          <span className="text-sm text-midnight font-medium">{row.dealerName}</span>
          <StatusChip status={row.status} />
          {row.linkedPo && (
            <span className="text-[0.65rem] text-brand-dark bg-brand-pastel/60 border border-brand/40 rounded px-1.5 py-0.5">
              🔗 linked to {row.linkedPo.batchCode}
              {row.linkedPo.poNumber && ` · ${row.linkedPo.poNumber}`}
            </span>
          )}
          {row.totalBookings > 0 && (
            <span className="text-[0.65rem] text-gold-dark bg-gold-pale/60 border border-gold rounded px-1.5 py-0.5 tabular-nums">
              {row.totalBookings} booking{row.totalBookings === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {row.status === "open" && !row.linkedPo && (
            <button
              type="button"
              onClick={onOpenLink}
              className="text-[0.7rem] px-2 py-0.5 rounded border border-brand text-brand-dark hover:bg-brand-pastel/40 font-medium"
            >
              🔗 Link PO
            </button>
          )}
          {row.status === "open" && (
            <button
              type="button"
              onClick={onCancel}
              className="text-[0.7rem] font-medium text-flame-dark hover:text-flame px-2 py-0.5"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Meta strip — dates + submitter + PO chase chip. */}
      <div className="text-[0.7rem] text-ink-600 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="tabular-nums">📅 Submitted {row.submittedAt}</span>
        <span>by <span className="text-brand-dark">{row.submittedByName}</span></span>
        <span className="tabular-nums">🚚 Expected delivery {row.expectedDeliveryDate}</span>
        {row.promisedPoSigningDate && (
          <span
            className={cn(
              "tabular-nums",
              poSigningStatus.tone === "overdue" && "text-flame-dark font-medium",
              poSigningStatus.tone === "due-soon" && "text-gold-dark font-medium",
            )}
            title={poSigningStatus.tooltip}
          >
            📝 PO signing {row.promisedPoSigningDate}
            {poSigningStatus.suffix && ` · ${poSigningStatus.suffix}`}
          </span>
        )}
      </div>

      {/* Per-row legs — show only when the pre-PO listing extension is
          populated (legacy rows without legs collapse this block). */}
      {row.legs.length > 0 && (
        <div className="border border-ink-200 rounded-md bg-ink-50/40">
          <table className="w-full text-[0.7rem]">
            <thead className="bg-ink-100/60">
              <tr className="text-left text-ink-500">
                <th className="px-2 py-1 font-medium">City</th>
                <th className="px-2 py-1 font-medium">Model</th>
                <th className="px-2 py-1 font-medium text-right">Qty</th>
                <th className="px-2 py-1 font-medium tabular-nums">Listed</th>
                <th className="px-2 py-1 font-medium tabular-nums">Avail.</th>
                <th className="px-2 py-1 font-medium text-right">Bookings</th>
              </tr>
            </thead>
            <tbody>
              {row.legs.map((leg) => (
                <tr key={leg.legId} className="border-t border-ink-200/60">
                  <td className="px-2 py-1 text-midnight">{leg.city}</td>
                  <td className="px-2 py-1 text-midnight">{leg.carModel ?? <span className="text-ink-400">—</span>}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{leg.quantity}</td>
                  <td className="px-2 py-1 tabular-nums text-ink-600">
                    {leg.listedAt ?? <span className="text-ink-400">—</span>}
                  </td>
                  <td className="px-2 py-1 tabular-nums text-ink-600">
                    {leg.promisedAvailabilityDate ?? <span className="text-ink-400">—</span>}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {leg.bookingsCount > 0 ? (
                      <span className="text-gold-dark font-medium">{leg.bookingsCount}</span>
                    ) : (
                      <span className="text-ink-400">0</span>
                    )}
                    <span className="text-ink-300 ml-0.5">/ {leg.quantity}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-2 py-1 text-[0.6rem] text-ink-500 leading-snug border-t border-ink-200/60">
            Booking counts are updated from the Action Center pre-PO drawer.
          </p>
        </div>
      )}
    </li>
  );
}

function poSigningChase(
  promised: string | null,
  today: string,
  status: ForecastStatus,
): { tone: "ok" | "due-soon" | "overdue"; suffix: string | null; tooltip: string } {
  if (!promised) return { tone: "ok", suffix: null, tooltip: "" };
  if (status !== "open") return { tone: "ok", suffix: null, tooltip: "Forecast no longer open." };
  const daysToSigning = daysBetween(promised, today);
  if (daysToSigning < 0) {
    return {
      tone: "overdue",
      suffix: `${-daysToSigning}d overdue`,
      tooltip: "The dealer's promised PO-signing date has passed. Chase them.",
    };
  }
  if (daysToSigning <= 3) {
    return {
      tone: "due-soon",
      suffix: `due in ${daysToSigning}d`,
      tooltip: "PO signing is imminent — confirm with the dealer.",
    };
  }
  return { tone: "ok", suffix: null, tooltip: "PO signing is comfortably in the future." };
}

function daysBetween(later: string, earlier: string): number {
  const ms = new Date(later).getTime() - new Date(earlier).getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

// ──────────────────────────────────────────────────────────────────
// Manual Link-PO dialog
// ──────────────────────────────────────────────────────────────────

function LinkPoDialog({
  forecast, sameDealer, otherDealer, onClose, onLinked,
}: {
  forecast: ForecastRow;
  sameDealer: ForecastLinkCandidate[];
  otherDealer: ForecastLinkCandidate[];
  onClose: () => void;
  onLinked: () => void;
}) {
  const [pickedBatchId, setPickedBatchId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [showCrossDealer, setShowCrossDealer] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const picked = useMemo(() => {
    if (pickedBatchId == null) return null;
    return [...sameDealer, ...otherDealer].find((c) => c.batchId === pickedBatchId) ?? null;
  }, [pickedBatchId, sameDealer, otherDealer]);

  // Diff banner — compares the Forecast's first leg with the picked
  // PO. The Forecast may have multiple legs; we surface the per-row
  // diffs as additional rows so the operator sees every drift.
  const diffs = useMemo(() => {
    if (!picked) return null;
    const totalForecastQty = forecast.legs.reduce((s, l) => s + l.quantity, 0)
      || forecast.quantity;
    const qtyDiff = picked.quantity - totalForecastQty;
    return {
      qtyDiff,
      perLeg: forecast.legs.map((leg) => {
        const cityMatch = picked.city.toLowerCase().replace(/[^a-z]/g, "")
          === leg.city.toLowerCase().replace(/[^a-z]/g, "");
        const modelMatch = leg.carModel && picked.model
          && leg.carModel.toLowerCase() === picked.model.toLowerCase();
        return {
          legId: leg.legId,
          forecastCity: leg.city,
          poCity: picked.city,
          cityMatch,
          forecastModel: leg.carModel,
          poModel: picked.model,
          modelMatch: modelMatch ?? false,
          forecastQty: leg.quantity,
        };
      }),
    };
  }, [picked, forecast.legs, forecast.quantity]);

  async function submit() {
    if (!picked) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/forecast/link-po", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          forecastBatchId: forecast.batchId,
          poBatchId:       picked.batchId,
          note:            note.trim() || null,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      onLinked();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-midnight/40 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative z-10 w-full max-w-2xl bg-white rounded-lg shadow-xl border border-ink-200 max-h-[85vh] flex flex-col">
        <header className="px-5 py-3 border-b border-ink-200 flex items-baseline justify-between">
          <h2 className="text-base font-bold text-midnight">
            🔗 Link Forecast to signed PO
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-500 hover:text-midnight text-sm"
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="px-5 py-4 space-y-3 overflow-y-auto flex-1">
          {/* Forecast summary */}
          <div className="border border-ink-200 rounded-md bg-gold-pale/30 p-3">
            <p className="text-[0.7rem] text-ink-600 uppercase font-semibold tracking-wide mb-1">
              Forecast (Pre-PO)
            </p>
            <p className="text-sm text-midnight font-medium">
              {forecast.batchCode} · {forecast.dealerName}
            </p>
            <p className="text-[0.7rem] text-ink-600 mt-0.5">
              {forecast.legs.length === 0
                ? `${forecast.quantity} cars in ${forecast.city}`
                : forecast.legs.map((l) =>
                    `${l.quantity}× ${l.carModel ?? "—"} in ${l.city}`,
                  ).join(" · ")}
            </p>
          </div>

          {/* Picker */}
          <div>
            <label className="block text-xs font-medium text-midnight mb-1">
              Pick the signed PO that fulfils this Forecast
            </label>
            {sameDealer.length === 0 && !showCrossDealer && (
              <p className="text-xs text-ink-500 italic mb-2">
                No recent same-dealer POs found. The PO might be on a different
                dealer record (renames happen) —{" "}
                <button
                  type="button"
                  onClick={() => setShowCrossDealer(true)}
                  className="underline text-brand-dark"
                >
                  show cross-dealer candidates
                </button>
                .
              </p>
            )}
            <select
              className="input"
              value={pickedBatchId ?? ""}
              onChange={(e) => setPickedBatchId(e.target.value === "" ? null : Number(e.target.value))}
              disabled={submitting}
            >
              <option value="">— Pick a post-PO batch —</option>
              {sameDealer.length > 0 && (
                <optgroup label={`Same dealer (${forecast.dealerName})`}>
                  {sameDealer.map((c) => (
                    <option key={c.batchId} value={c.batchId} disabled={c.alreadyLinkedTo != null}>
                      {labelCandidate(c)}
                    </option>
                  ))}
                </optgroup>
              )}
              {(showCrossDealer || sameDealer.length === 0) && otherDealer.length > 0 && (
                <optgroup label="Other dealers (last 90d)">
                  {otherDealer.map((c) => (
                    <option key={c.batchId} value={c.batchId} disabled={c.alreadyLinkedTo != null}>
                      {labelCandidate(c)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {sameDealer.length > 0 && !showCrossDealer && otherDealer.length > 0 && (
              <button
                type="button"
                onClick={() => setShowCrossDealer(true)}
                className="mt-1 text-[0.65rem] text-brand-dark underline"
              >
                + Also show other-dealer candidates
              </button>
            )}
          </div>

          {/* Diff banner */}
          {picked && diffs && (
            <div className="border border-ink-200 rounded-md bg-ink-50/40">
              <p className="px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wide text-ink-500 border-b border-ink-200">
                Differences — won&apos;t block, just review
              </p>
              <ul className="px-3 py-2 text-xs text-ink-700 space-y-1">
                {forecast.dealerId !== picked.dealerId && (
                  <li className="text-flame-dark">
                    ⚠ <strong>Dealer mismatch:</strong> Forecast on {forecast.dealerName} → PO on {picked.dealerName}
                  </li>
                )}
                {diffs.qtyDiff !== 0 && (
                  <li className={diffs.qtyDiff > 0 ? "text-gold-dark" : "text-flame-dark"}>
                    {diffs.qtyDiff > 0 ? "▲" : "▼"} <strong>Qty drift:</strong>{" "}
                    {diffs.qtyDiff > 0 ? "+" : ""}{diffs.qtyDiff} cars
                    ({forecast.legs.reduce((s, l) => s + l.quantity, 0) || forecast.quantity} forecast → {picked.quantity} on PO)
                  </li>
                )}
                {diffs.perLeg.map((d) => (
                  <li key={d.legId}>
                    Row #{d.legId}: {d.forecastCity}
                    {!d.cityMatch && (
                      <span className="text-gold-dark"> → city &quot;{d.poCity}&quot; (spelling drift)</span>
                    )}
                    {d.forecastModel && (
                      <>
                        {" · "}
                        {d.forecastModel}
                        {!d.modelMatch && d.poModel && (
                          <span className="text-flame-dark"> → model swapped to &quot;{d.poModel}&quot;</span>
                        )}
                      </>
                    )}
                  </li>
                ))}
                {diffs.qtyDiff === 0 && forecast.dealerId === picked.dealerId
                  && diffs.perLeg.every((d) => d.cityMatch && d.modelMatch) && (
                  <li className="text-green-dark">✓ Forecast and PO match cleanly.</li>
                )}
              </ul>
            </div>
          )}

          {/* Note */}
          <label className="block">
            <span className="block text-xs font-medium text-midnight mb-1">
              Note (optional — captured in the audit trail)
            </span>
            <textarea
              rows={2}
              className="input text-xs"
              placeholder='e.g. "Dealer switched to MG5 after market check"'
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={submitting}
            />
          </label>

          {error && (
            <p role="alert" className="text-sm text-flame-dark">
              {error}
            </p>
          )}
        </div>
        <footer className="px-5 py-3 bg-ink-50/40 border-t border-ink-200 flex justify-end gap-2 rounded-b-lg">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm rounded-md border border-ink-300 bg-white text-ink-700 hover:bg-ink-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!picked || submitting}
            className={cn(
              "px-3 py-1.5 text-sm font-semibold rounded-md bg-brand text-white hover:bg-brand-dark",
              (!picked || submitting) && "opacity-60 cursor-not-allowed",
            )}
          >
            {submitting ? "Linking…" : "Confirm link"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function labelCandidate(c: ForecastLinkCandidate): string {
  const parts = [c.batchCode];
  if (c.poNumber) parts.push(`PO ${c.poNumber}`);
  parts.push(`${c.quantity}× ${c.model ?? "?"} in ${c.city}`);
  if (c.poDate) parts.push(`signed ${c.poDate}`);
  if (c.alreadyLinkedTo != null) parts.push("[already linked]");
  return parts.join(" · ");
}

// ──────────────────────────────────────────────────────────────────
// Small shared widgets
// ──────────────────────────────────────────────────────────────────

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

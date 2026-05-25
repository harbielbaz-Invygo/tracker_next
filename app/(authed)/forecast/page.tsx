/**
 * Forecast — the Pre-PO exception flow.
 *
 * Partnership team commits to a Qty / City / Expected Delivery Date
 * before the PO is signed. We capture the commitment so we can later
 * measure how confident their commitments actually were.
 *
 * On submit we create:
 *   - a pre_po `batches` row with only those minimum fields
 *   - a 1:1 `batch_forecasts` row (submission date + submitter)
 *   - a "Pre-PO App Listing" action (auto-created on every Forecast)
 *
 * When the real PO arrives, Ops links the Forecast via Intake (PR 3)
 * and the same record flips to post_po. The Forecast row stays for
 * accuracy tracking (drift, listing accuracy, qty shortfall).
 *
 * Access: Ops + Admin.
 */
import AccessGate from "@/components/access-gate";
import PageHeader from "@/components/page-header";
import ForecastShell from "@/components/forecast-shell";
import {
  getForecastRows,
  getForecastFormOptions,
  getForecastLinkCandidates,
} from "@/lib/forecast-data";

export const dynamic = "force-dynamic";

export default async function ForecastPage() {
  const [rows, options, linkCandidates] = await Promise.all([
    getForecastRows(),
    getForecastFormOptions(),
    // All recent post-PO batches; client filters to same-dealer when
    // the operator opens the link dialog on a specific Forecast row.
    getForecastLinkCandidates(null),
  ]);

  return (
    <AccessGate view="Forecast">
      <div>
        <PageHeader
          view="Forecast"
          subtitle={<>Pre-PO bets. Capture an upcoming batch before the PO is signed, on Partnership&apos;s commitment. Used to track whether confidence-driven bets actually translate into delivered cars.</>}
        />

        <div
          className="card !bg-gold-pale !border-gold flex gap-3 mb-4"
          role="note"
        >
          <span aria-hidden="true" className="text-lg leading-snug">⚠️</span>
          <p className="text-sm text-midnight leading-snug">
            <span className="font-semibold">Pre PO Ops Lead Time Rule:</span> after PO
            signing, Operations needs{" "}
            <span className="font-semibold tabular-nums">21 days</span> to deliver
            (configurable in Settings).
          </p>
        </div>

        <ForecastShell rows={rows} options={options} linkCandidates={linkCandidates} />
      </div>
    </AccessGate>
  );
}

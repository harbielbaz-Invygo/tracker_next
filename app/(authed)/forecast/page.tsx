/**
 * Forecast — the Pre-PO exception flow.
 *
 * Cars get tracked BEFORE the PO is signed, on the strength of Partnership's
 * confidence. The system locks confidence at submit so we can later answer:
 * "was the partnership team's confidence trustworthy?"
 *
 * When the PO arrives, Ops opens the Forecast record, hits "Convert to Intake",
 * lands on the Intake page pre-filled, and the batch flips from `pre_po` to
 * `post_po`. Confidence-at-conversion is preserved for the analytic.
 *
 * Access: Ops + Admin (Ops captures the request on behalf of Partnership).
 *
 * Phase D ports the request-details + commitment form here.
 */
import AccessGate from "@/components/access-gate";
import PageHeader from "@/components/page-header";

export default function ForecastPage() {
  return (
    <AccessGate view="Forecast">
      <div>
        <PageHeader
          view="Forecast"
          subtitle={<>Pre-PO bets. Capture an upcoming batch before the PO is signed, on Partnership&apos;s confidence. Used to track whether confidence-driven bets actually hit their dates.</>}
        />

        <div
          className="card !bg-gold-pale !border-gold-brand flex gap-3"
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

        <div className="card mt-4">
          <p className="text-sm text-ink-600">
            🚧 Scaffold placeholder — Phase D delivers the request-details form
            with locked-at-submit Partnership confidence.
          </p>
        </div>
      </div>
    </AccessGate>
  );
}

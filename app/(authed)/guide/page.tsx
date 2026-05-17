/**
 * Guide — operator handbook for the tool.
 *
 * Renamed from "About" once the content grew past a simple landing.
 * Now covers: what the tool is, the workflow each batch goes through,
 * who is involved at each step, a map of the pages, the glossary,
 * and the tech stack.
 *
 * Public: anyone (guest included) can read it. No data exposure.
 * Server component, no client state — pure render.
 */
import Link from "next/link";
import AccessGate from "@/components/access-gate";
import PageHeader from "@/components/page-header";
import { ViewIcon } from "@/components/view-icons";
import type { ViewName } from "@/lib/access";

const APP_VERSION = "0.1.0";
const APP_NAME = "Vehicles Onboarding Tracker";

const PAGE_SUMMARIES: { view: ViewName; href: string; what: string; who: string }[] = [
  {
    view: "Insights",
    href: "/insights",
    what:
      "Leadership-level health: customer impact, on-time rate, dealer reliability, ops performance, the per-batch Plan-vs-Reality timeline, and the closure breakdown (Listed / Delivered / Partly / Cancelled). The unified view — everything that used to live on Dashboard + Reports.",
    who: "Leadership, ops leads, anyone reviewing the pipeline.",
  },
  {
    view: "Intake",
    href: "/intake",
    what:
      "Post-PO onboarding. Upload the dealer's PO PDF, split into batches, capture model / colours / per-city quantities, set the dealer-promised availability date.",
    who: "Ops, when a new PO lands.",
  },
  {
    view: "Forecast",
    href: "/forecast",
    what:
      "Pre-PO bets — projections we make before a PO is signed, with Partnership confidence captured per row.",
    who: "Partnership team, ahead of Intake.",
  },
  {
    view: "Action Center",
    href: "/action-center",
    what:
      "The daily ops surface. Every open batch, sorted by what's needed next. Update action statuses, capture Ops confidence, mark batches as listed or delivered, generate Slack status checks.",
    who: "Ops, every day.",
  },
  {
    view: "Settings",
    href: "/settings",
    what:
      "Admin configuration — departments, action types, the dependency DAG between actions, Pre-PO lead-time rule, and user accounts.",
    who: "Admins only.",
  },
];

const GLOSSARY: { group: string; terms: { term: string; def: string }[] }[] = [
  {
    group: "Entities",
    terms: [
      { term: "PO",
        def: "Purchase Order. A dealer document committing to a number of cars at agreed terms. One PO usually produces multiple batches." },
      { term: "Batch",
        def: "A slice of a PO with shared (model, year, commercial terms, delivery date). The unit of work everywhere in this tool — every status, action, and date is per-batch." },
      { term: "Dealer",
        def: "The trade partner issuing the PO. Their reliability is tracked across all batches in the Insights → Trust → Dealer Reliability tab." },
      { term: "Leg",
        def: "A per-city slice of a batch. A 30-car batch delivered to Riyadh / Jeddah / Dammam has three legs. Each leg has its own requested and delivered quantity." },
    ],
  },
  {
    group: "Lifecycle",
    terms: [
      { term: "Pre-PO",
        def: "The bet phase. We've projected an intake but no PO is signed yet. Partnership confidence is the steering signal." },
      { term: "Post-PO",
        def: "The execution phase. PO is signed, the internal action checklist + VIN chase are in motion." },
      { term: "Internal phase",
        def: "The sequence of internal actions (Specs, Pricing, SKU, App Listing, …) that must complete before delivery. Configured in Settings → Action Types." },
      { term: "VIN chase",
        def: "Sequence of stages from VIN receipt to plate / handover. Decoupled from the internal phase so both can progress in parallel." },
    ],
  },
  {
    group: "Dates",
    terms: [
      { term: "Promised date",
        def: "Dealer-promised availability date — the line we drew when the PO was signed. Reference for on-time vs delayed." },
      { term: "Projected date / Ops projection",
        def: "Ops' current realistic estimate of when the batch will actually be available. Shifts when an action slips; each shift logged as a re-promise." },
      { term: "Closure date",
        def: "The day the batch was formally closed — either delivered or cancelled. Stored on `batches.closedAt`." },
    ],
  },
  {
    group: "Status",
    terms: [
      { term: "On track",
        def: "Projected date == promised date. We're on plan." },
      { term: "Ahead",
        def: "Projected date is earlier than promised. We expect to beat the promise." },
      { term: "Delayed",
        def: "Projected date is later than promised. Days late = projected − promised." },
      { term: "Ready to deliver",
        def: "Every internal action and every VIN chase stage is done or skipped. Just waiting for Mark as Delivered." },
      { term: "Listed on app",
        def: "Cars went live in the customer app for the first time. Date captured on `appListedAt`." },
      { term: "Delivered",
        def: "Closed with `closureReason='delivered'`. Counts cars that actually reached customers." },
      { term: "Partly delivered",
        def: "Some units shipped but not all (deliveredQuantity > 0 and < quantity). Includes in-flight partials and cancelled-after-partial." },
      { term: "Cancelled",
        def: "Closed with `closureReason='cancelled'`. Reason captured in a cancellation note." },
    ],
  },
  {
    group: "Metrics",
    terms: [
      { term: "Customer-days lost",
        def: "North Star. Sum of (days late × cars in batch) across affected batches. The single number that says 'how much pain did slipping cause customers'." },
      { term: "On-time rate",
        def: "% of delivered batches that landed on or before promised. Null until the first delivery." },
      { term: "Re-promises",
        def: "Count of Ops projection shifts on a batch. Each shift is a date the dealer was told and then walked back from — trust erosion signal." },
      { term: "Severity",
        def: "Bucket on customer-days impact: Mild (1–7d), Moderate (8–21d), Severe (>21d). Drives the Customer Impact distribution bars." },
      { term: "Confidence",
        def: "Two separate signals: Partnership confidence (Pre-PO bet quality) and Ops confidence (Post-PO execution likelihood). Both 0–100, both visible per batch." },
    ],
  },
  {
    group: "Configuration",
    terms: [
      { term: "Action type",
        def: "A canonical step in the internal phase (e.g. \"Car Specs Required\"). Each has a waiting label, a done label, and a default department." },
      { term: "Action dependency",
        def: "DAG edge: action B is blocked until action A is done. Edited in Settings → Dependencies." },
      { term: "Department",
        def: "An owning team (Operations / Partnership / Commercial / …). Drives the Action Center's Department filter and the Trust → Ops Performance table." },
      { term: "Stakeholder",
        def: "A named person inside a department. Captures \"who specifically owes this work\". Visible in the Slack status-check message." },
      { term: "Color matrix",
        def: "Per-color quantity breakdown captured at intake when the dealer specifies colours. Drives the colour-confirmation table in the Confirm-Delivery modal." },
    ],
  },
];

/**
 * Operational workflow — the canonical lifecycle a batch goes through
 * from the first commitment to the final delivery. Each step names:
 *   - what happens
 *   - who drives it
 *   - which page it lives on
 *   - which key fields / artefacts it produces
 */
const WORKFLOW_STEPS: {
  step: number;
  title: string;
  who: string;
  where: string;
  what: string;
  outputs: string;
}[] = [
  {
    step: 1,
    title: "Forecast (Pre-PO bet)",
    who: "Partnership team member submits.",
    where: "Forecast",
    what:
      "Before a PO is signed, Partnership commits to a Qty / City / Expected Delivery Date based on a dealer conversation. The submission date and submitter are captured to measure how reliable these commitments turn out to be.",
    outputs:
      "A pre_po batch + a batch_forecasts row + a Pre-PO App Listing action (auto-created, waiting).",
  },
  {
    step: 2,
    title: "Pre-PO App Listing (optional)",
    who: "Ops, if leadership decides to list cars before the PO arrives.",
    where: "Action Center",
    what:
      "Cars go live in the customer app on the strength of the partnership commitment alone. Marking the Pre-PO App Listing action done captures the moment.",
    outputs:
      "Pre-PO App Listing action flipped to done. Drives the \"forecast-only\" cars number in the Insights closure strip.",
  },
  {
    step: 3,
    title: "Intake (Post-PO)",
    who: "Ops, when the dealer's PO PDF lands.",
    where: "Intake",
    what:
      "Drop the PO PDF. Form auto-fills with model / year / quantities / cities / promised date. Pick the actions this batch needs and assign each to a department. If this Intake fulfils a Forecast, link it via the picker — the existing pre_po batch flips to post_po (or splits into children when one PO becomes multiple batches).",
    outputs:
      "post_po batches with all standard actions + VIN chase stages created. Forecasts linked via parentForecastBatchId / lifecycle flip.",
  },
  {
    step: 4,
    title: "Internal phase + VIN chase",
    who: "Each department's stakeholder owns the actions assigned to them. Ops tracks daily.",
    where: "Action Center",
    what:
      "Two parallel streams run until both reach done. Internal phase (Specs / Pricing / SKU / App Listing). VIN chase (Send Dealer Email → VIN → Plate → Customs → Tracking → Inspection → Ready in Showroom). Any slip pushes the Ops-projected availability date and is logged as a re-promise.",
    outputs:
      "Per-batch action_status updates. Ops Confidence adjustments. Optional re-promise events (with bookings_at_shift) that drive the customer-impact metric.",
  },
  {
    step: 5,
    title: "App Listing (Post-PO)",
    who: "Ops marks live once the cars are actually visible in the customer app.",
    where: "Action Center",
    what:
      "The standard App Listing action flips to done. Sets batches.appListedAt for the canonical \"listed\" marker. Difference between Pre-PO and Post-PO listing dates feeds the Forecast Reliability accuracy metric.",
    outputs:
      "appListedAt set on the batch. Counts toward \"confirmed\" cars in the Insights closure strip.",
  },
  {
    step: 6,
    title: "Delivery",
    who: "Ops confirms when cars are physically handed over.",
    where: "Action Center → Mark as Delivered modal",
    what:
      "Pick closure date, enter delivered quantity per city (multi-leg), optionally per-color confirmation. The top quantity auto-sums from per-city if multi-leg. Saves and closes the batch.",
    outputs:
      "closedAt + closureReason='delivered' on the batch. deliveredQuantity per leg captured. Drives the on-time rate metric.",
  },
  {
    step: 7,
    title: "Cancellation (alt path)",
    who: "Ops, when the dealer pulls a PO or a forecast doesn't translate.",
    where: "Action Center (Cancel batch) / Forecast (Cancel forecast)",
    what:
      "Closes the batch with closureReason='cancelled' + a cancellation note. Cancelled forecasts count as a miss in per-submitter accuracy stats.",
    outputs:
      "closedAt + closureReason='cancelled'. Drives the Cancelled tile + dealer reliability cancel rate.",
  },
  {
    step: 8,
    title: "Review (continuous)",
    who: "Leadership + ops leads.",
    where: "Insights",
    what:
      "Customer-days lost (North Star), on-time rate, dealer reliability, ops performance, forecast reliability, the per-batch Plan-vs-Reality timeline, and the closure-cars breakdown. Period-scoped: 30d / 90d / 6m / all-time.",
    outputs:
      "Read-only dashboards. No mutation; this is where the operational signals get sliced and reviewed.",
  },
];

/**
 * Who works on what — roles + their main responsibilities and where
 * inside the tool they spend time.
 */
const ROLES: { role: string; works_on: string; lives_on: string }[] = [
  {
    role: "Partnership team",
    works_on:
      "Pre-PO commitments. Submits forecasts on the strength of a dealer conversation, before any PO is signed.",
    lives_on: "Forecast page · Insights → Trust → Forecast Reliability",
  },
  {
    role: "Operations team",
    works_on:
      "Day-to-day execution. Drops PO PDFs at Intake, marks actions / VIN stages as they complete, adjusts Ops confidence, captures re-promises when projections shift, confirms delivery.",
    lives_on: "Intake · Action Center · Action Center drawer",
  },
  {
    role: "Specs / Pricing / Logistics / Operations departments",
    works_on:
      "Owners of specific internal-phase actions. Each action_type has a default department configured in Settings; an action is done by the stakeholder assigned to that department on that batch.",
    lives_on: "Action Center (filter by Department) · Action Center drawer",
  },
  {
    role: "Stakeholders",
    works_on:
      "Named people inside a department. The Slack status-check message groups pending actions by stakeholder so each person sees only what they're on the hook for.",
    lives_on: "Action Center batch-card 📋 Slack button (copies their list)",
  },
  {
    role: "Admin",
    works_on:
      "Tool configuration. Maintains action types + their dependency DAG, departments + stakeholders, the Pre-PO Ops Lead Time rule, and user accounts.",
    lives_on: "Settings",
  },
  {
    role: "Leadership / reviewers",
    works_on:
      "Reads but doesn't write. Reviews customer-days lost, on-time rate, dealer reliability, forecast accuracy, and per-batch timelines. Scopes by period.",
    lives_on: "Insights",
  },
];

const TECH_STACK: { name: string; role: string }[] = [
  { name: "Next.js 15 (App Router)", role: "Framework — server components, route handlers, edge middleware" },
  { name: "Drizzle ORM",             role: "Type-safe SQL — schema, migrations, queries" },
  { name: "libSQL / Turso",          role: "SQLite-compatible database — production" },
  { name: "better-sqlite3",          role: "Local SQLite — development" },
  { name: "NextAuth (v5)",           role: "Credentials-based auth, role-gated routes" },
  { name: "Tailwind CSS",            role: "Design system — palette tokens, spacing, components" },
  { name: "TypeScript",              role: "End-to-end type checking — schema → API → UI" },
];

export default function GuidePage() {
  return (
    <AccessGate view="Guide">
      <div className="space-y-6">
        <PageHeader
          view="Guide"
          subtitle={`Operator handbook for ${APP_NAME} — what it is, how a batch flows, who works on what, and the vocabulary.`}
        />

        <section className="card">
          <h2 className="text-base font-bold text-midnight mb-2">What this is</h2>
          <p className="text-sm text-ink-600 leading-relaxed">
            {APP_NAME} is the internal system that runs a vehicle's onboarding
            journey end-to-end — from the moment a dealer issues a PO, through
            the internal phase (specs, pricing, SKU, app listing, …) and the
            VIN chase, all the way to physical delivery in the customer app.
          </p>
          <p className="text-sm text-ink-600 leading-relaxed mt-2">
            One source of truth for who owes whom what — visible to leadership
            at a glance, actionable for ops on a per-batch basis, and audited
            so promised-vs-actual dates never drift quietly.
          </p>
        </section>

        <section className="card p-0 overflow-hidden">
          <header className="px-4 py-3 border-b border-ink-200">
            <h2 className="text-base font-bold text-midnight">Workflow</h2>
            <p className="text-xs text-ink-500 mt-0.5">
              The canonical lifecycle of a batch — what happens, who drives it, and which page it lives on.
            </p>
          </header>
          <ol className="divide-y divide-ink-200/60">
            {WORKFLOW_STEPS.map((s) => (
              <li key={s.step} className="px-4 py-3 flex gap-3">
                <span className="shrink-0 mt-0.5 inline-flex items-center justify-center h-6 w-6 rounded-full bg-brand-pastel text-brand-dark text-xs font-bold tabular-nums">
                  {s.step}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-semibold text-midnight">{s.title}</span>
                    <span className="text-[0.65rem] font-medium text-ink-500 uppercase tracking-wide">
                      {s.where}
                    </span>
                  </p>
                  <p className="text-sm text-ink-600 leading-snug mt-0.5">{s.what}</p>
                  <p className="text-[0.7rem] text-ink-500 mt-1">
                    <span className="font-medium text-midnight">Who:</span> {s.who}
                  </p>
                  <p className="text-[0.7rem] text-ink-500">
                    <span className="font-medium text-midnight">Outputs:</span> {s.outputs}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="card p-0 overflow-hidden">
          <header className="px-4 py-3 border-b border-ink-200">
            <h2 className="text-base font-bold text-midnight">Who works on what</h2>
            <p className="text-xs text-ink-500 mt-0.5">
              Roles + their main responsibilities and where in the tool they spend time.
            </p>
          </header>
          <ul className="divide-y divide-ink-200/60">
            {ROLES.map((r) => (
              <li key={r.role} className="px-4 py-3">
                <p className="text-sm font-semibold text-midnight">{r.role}</p>
                <p className="text-sm text-ink-600 leading-snug mt-0.5">{r.works_on}</p>
                <p className="text-[0.7rem] text-ink-500 mt-1">
                  <span className="font-medium text-midnight">Lives on:</span> {r.lives_on}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="card p-0 overflow-hidden">
          <header className="px-4 py-3 border-b border-ink-200">
            <h2 className="text-base font-bold text-midnight">Pages at a glance</h2>
            <p className="text-xs text-ink-500 mt-0.5">
              Same order as the sidebar. Click any title to jump there.
            </p>
          </header>
          <ul className="divide-y divide-ink-200/60">
            {PAGE_SUMMARIES.map((p) => (
              <li key={p.view} className="px-4 py-3 flex gap-3">
                <span className="shrink-0 mt-0.5 text-ink-500">
                  <ViewIcon view={p.view} className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <Link
                    href={p.href as never}
                    className="text-sm font-semibold text-brand-dark hover:underline"
                  >
                    {p.view}
                  </Link>
                  <p className="text-sm text-ink-600 leading-snug mt-0.5">{p.what}</p>
                  <p className="text-[0.7rem] text-ink-500 mt-1 italic">{p.who}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="card p-0 overflow-hidden">
          <header className="px-4 py-3 border-b border-ink-200">
            <h2 className="text-base font-bold text-midnight">Definitions</h2>
            <p className="text-xs text-ink-500 mt-0.5">
              The vocabulary used across the app, grouped so you can scan a
              single area at a time.
            </p>
          </header>
          <div className="divide-y divide-ink-200/60">
            {GLOSSARY.map((g) => (
              <div key={g.group} className="px-4 py-3">
                <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-ink-500 mb-2">
                  {g.group}
                </p>
                <dl className="grid grid-cols-1 md:grid-cols-[max-content,1fr] gap-x-4 gap-y-2">
                  {g.terms.map((t) => (
                    <div key={t.term} className="contents">
                      <dt className="text-sm font-semibold text-midnight md:whitespace-nowrap md:pt-0.5">
                        {t.term}
                      </dt>
                      <dd className="text-sm text-ink-600 leading-snug">
                        {t.def}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </section>

        <section className="card p-0 overflow-hidden">
          <header className="px-4 py-3 border-b border-ink-200">
            <h2 className="text-base font-bold text-midnight">Built with</h2>
          </header>
          <ul className="divide-y divide-ink-200/60">
            {TECH_STACK.map((t) => (
              <li key={t.name} className="px-4 py-2 flex flex-wrap items-baseline gap-x-3">
                <span className="text-sm font-medium text-midnight">{t.name}</span>
                <span className="text-xs text-ink-500">{t.role}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-xs text-ink-500">
              Version <code className="text-midnight">{APP_VERSION}</code>
            </span>
            <span className="text-xs text-ink-500 tabular-nums">
              This page rendered {new Date().toISOString().slice(0, 10)}
            </span>
          </div>
        </section>
      </div>
    </AccessGate>
  );
}

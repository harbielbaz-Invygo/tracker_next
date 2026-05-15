/**
 * About — what this tool is, who it's for, and a quick map of the pages.
 *
 * Public: anyone (guest included) can read it. No data exposure; it's
 * just descriptive copy + a pages-at-a-glance section that mirrors the
 * sidebar.
 *
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

const TECH_STACK: { name: string; role: string }[] = [
  { name: "Next.js 15 (App Router)", role: "Framework — server components, route handlers, edge middleware" },
  { name: "Drizzle ORM",             role: "Type-safe SQL — schema, migrations, queries" },
  { name: "libSQL / Turso",          role: "SQLite-compatible database — production" },
  { name: "better-sqlite3",          role: "Local SQLite — development" },
  { name: "NextAuth (v5)",           role: "Credentials-based auth, role-gated routes" },
  { name: "Tailwind CSS",            role: "Design system — palette tokens, spacing, components" },
  { name: "TypeScript",              role: "End-to-end type checking — schema → API → UI" },
];

export default function AboutPage() {
  return (
    <AccessGate view="About">
      <div className="space-y-6">
        <PageHeader
          view="About"
          subtitle={`What ${APP_NAME} is, who it's for, and a quick map of the pages.`}
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

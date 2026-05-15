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

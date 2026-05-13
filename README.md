# invygo · Vehicles Onboarding Tracker

Internal app for tracking subscription vehicles from partner-submission → PO → operational fulfilment → delivery. Built on **Next.js 15 (App Router) + TypeScript + Drizzle + Turso (libSQL) + Auth.js v5**.

Live: https://project-n2y2q.vercel.app

> Originally scaffolded from the Streamlit prototype in `../tracker_v1/`. That code is the historical reference for business rules; this Next.js codebase is the production source of truth.

---

## Stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Framework | **Next.js 15** (App Router) | Server components everywhere; Edge-safe middleware for auth gating |
| Language | **TypeScript** (strict) | DB → server → UI fully typed via Drizzle inference |
| Database | **Turso** / **libSQL** via **Drizzle ORM** | SQLite dialect; local dev uses `file:./data/tracker.db` |
| Auth | **Auth.js v5** (Credentials provider) | bcrypt-hashed passwords stored in `users` table |
| Styling | **Tailwind** + custom `globals.css` + `lib/brand.ts` tokens | Single source of truth for brand colours |
| PDF parsing | **pdf-parse** + custom regex (`lib/po-parser.ts`) | Server-only; routes that touch it set `runtime = "nodejs"` |
| Hosting | **Vercel** | GitHub → main triggers production deploy |

---

## Local setup

```bash
cd tracker_next

# 1. Install
npm install

# 2. Environment — copy and fill in
cp .env.example .env.local
#   - DATABASE_URL: file:./data/tracker.db (local) or a libsql:// URL (Turso)
#   - TURSO_AUTH_TOKEN: required only for libsql:// URLs
#   - NEXTAUTH_SECRET: openssl rand -base64 32
#   - NEXTAUTH_URL: http://localhost:3000

# 3. Create the database tables (local SQLite or remote Turso)
npm run db:push

# 4. Seed 8 demo scenarios + 2 users
npm run db:seed

# 5. Dev server
npm run dev
# → http://localhost:3000
```

### Demo accounts (seed)

| Username | Password   | Role  |
| -------- | ---------- | ----- |
| `admin`  | `admin123` | admin |
| `ops1`   | `ops123`   | ops   |

⚠️ **The seed passwords are public in `scripts/seed.ts`. Rotate them immediately in production** — either via Settings → Users (admin only) or by running `scripts/rotate-passwords.ts` with `NEW_ADMIN_PW` / `NEW_OPS_PW` set in the env.

---

## What's in the box

```
tracker_next/
├── app/
│   ├── (authed)/                Layout + sidebar + role-gated routes
│   │   ├── dashboard/page.tsx       Plan-vs-Reality timeline + activity table
│   │   ├── forecast/page.tsx        Pre-PO bets (Partnership confidence)
│   │   ├── intake/page.tsx          PDF drop → form → batch creation
│   │   ├── action-center/page.tsx   Action status board (Ops daily surface)
│   │   ├── reports/page.tsx         Departments + stakeholders performance
│   │   └── settings/page.tsx        Admin config: 5 collapsible sections
│   ├── api/
│   │   ├── auth/                    Auth.js handlers
│   │   ├── batch-action/route.ts    Action status flips + auto-shift + auto-close
│   │   ├── batch-close/route.ts     Manual deliver / cancel
│   │   ├── health/route.ts          Public liveness probe
│   │   ├── intake/create/route.ts   Submit a PO → N batches
│   │   ├── po-parse/route.ts        Upload a PDF → ParsedPO JSON
│   │   ├── settings/route.ts        Consolidated admin mutations
│   │   └── timeline/route.ts        Per-batch timeline payload
│   └── login/page.tsx               Inline login card
├── components/                   Server + client UI building blocks
│   ├── intake-form.tsx              The big Intake state machine
│   ├── settings-shell.tsx           5 collapsible editors
│   ├── settings-batches.tsx         Per-batch admin override
│   ├── timeline-svg.tsx             Plan vs Reality SVG (port of Python)
│   ├── dashboard-shell.tsx          Table + drawer + activity table
│   ├── action-center-shell.tsx      Stacked / side-by-side toggle
│   └── …
├── lib/
│   ├── access.ts                    Pure role rules (admin / ops / guest)
│   ├── api-auth.ts                  requireAuth(["role"]) helper for routes
│   ├── auth.ts / auth.config.ts     NextAuth v5 (Node + Edge configs)
│   ├── brand.ts                     Brand tokens for TS callers
│   ├── action-center-data.ts        Action Center + drawer queries
│   ├── dashboard-data.ts            Dashboard table + per-batch timeline
│   ├── db/                          schema.ts + libsql client
│   ├── env.ts                       Zod-validated env, hard-fails in prod
│   ├── expected-date.ts             Pure offset+anchor → expectedDate
│   ├── intake-data.ts               Intake form options payload
│   ├── po-parser.ts                 Parser + Slack formatter (no fs imports)
│   ├── po-parser-server.ts          Node-only PDF wrapper
│   ├── reports-data.ts              Departments + stakeholders aggregation
│   ├── rules.ts                     Key/value rules (Pre PO Ops Lead Time)
│   ├── settings-data.ts             Settings page payload
│   └── utils.ts                     cn(), makeBatchCode(), isoDate()
├── docs/
│   ├── DEPLOYMENT.md                Production runbook
│   └── seed-data-backup-…md         Snapshot of the prior demo data
├── scripts/
│   ├── seed.ts                      8-scenario synthetic seed
│   ├── verify-login.ts              Diagnostic: bcrypt + DB reachability
│   └── rotate-passwords.ts          Maintenance: rotate admin/ops1 hashes
└── middleware.ts                    Public/authed route guard (Edge runtime)
```

---

## Key concepts

### One Batch = one (PO item × delivery split)

Matches the Python model. Item-level fields (model, year, contract, colours) and split-level fields (qty, city, dates) cohabitate on the same row. Multiple batches share a `poNumber` when one PO has multiple splits.

### PO Availability is locked; Ops Expected is auto-floored

At Intake the form shows two dates per split:

- **PO Availability date** — the dealer-promised date from the PO. Read-only. Drives Partnership Confidence + Reliability metrics.
- **Ops Expected Delivery** — Ops's own commitment. Auto-defaults to `max(POAvailability, today + leadTimeDays)` so it always satisfies the operational floor. Editable. Drives Ops Confidence.

When `OpsExpected > POAvailability` for any split, the batch is marked `feasibility_status = at_risk`, the Intake form shows a "Ops ETA past dealer promise" caution, and the Slack announcement leads with **⚠️ OPS BEHIND PROMISE — {model → city: Ops ETA +Nd past dealer promise}**.

Pre PO Ops Lead Time defaults to **21 days**; admin tunes it in Settings → Rules.

### Actions, not stages

The Streamlit version had 19 hard-coded stages. The Next.js version replaces them with admin-configured **action types** (Specs / Pricing / SKU / VIN / Plate / Customs Card / Inspection / App Listing / Delivery) and a **dependency DAG** between them. Each batch picks a subset of actions at Intake; statuses flip in the Action Center; downstream actions auto-unblock when parents are done; post-VIN expected dates auto-shift when VIN slips.

### Departments + stakeholders

Replaces the per-action "owner" string from the Python version. Action types route to a default department (configurable). At Intake, Ops picks one stakeholder per department to own all that department's actions on this batch.

### Roles

| Role  | Access |
| ----- | ------ |
| admin | Everything, including Settings + Users + Batches editor |
| ops   | Forecast, Intake, Action Center, Reports — read & mutate batches and actions but not configuration |
| guest | Dashboard only (public read view) |

---

## Production deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the full runbook covering Turso provisioning, Vercel env var setup, secret rotation, and post-deploy smoke tests. Short version:

```bash
# 1. Push code
git push origin <feature-branch>     # opens PR → review → merge to main
                                     # Vercel auto-deploys on merge to main

# 2. First-time only — push schema to Turso + seed
DATABASE_URL=libsql://… TURSO_AUTH_TOKEN=… npm run db:push
DATABASE_URL=libsql://… TURSO_AUTH_TOKEN=… npm run db:seed

# 3. First-time only — set Vercel env vars (Settings → Environment Variables)
#    DATABASE_URL, TURSO_AUTH_TOKEN, NEXTAUTH_SECRET, NEXTAUTH_URL
```

### Health check

```
GET https://project-n2y2q.vercel.app/api/health
→ 200 {"ok":true,"ts":"…"}
```

`ok:false` + 503 means the deployment can't reach the database — check `DATABASE_URL` and `TURSO_AUTH_TOKEN` in Vercel.

---

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev`       | Dev server (`http://localhost:3000`) |
| `npm run build`     | Production build (Vercel runs this automatically) |
| `npm run start`     | Run the production build locally |
| `npm run db:push`   | Push schema to the configured `DATABASE_URL` |
| `npm run db:seed`   | Wipe + reseed with the 8 demo scenarios |
| `npm run lint`      | ESLint over the codebase |
| `npx tsc --noEmit`  | Type-check everything |

Ad-hoc scripts (run with `npx tsx scripts/<name>.ts`):

- `verify-login.ts` — bcrypt round-trip diagnostic; useful right after deploy or password rotation.
- `rotate-passwords.ts` — rewrite admin/ops1 password hashes from env vars; verifies the round-trip before exiting.

---

## Migration history

The Plan-vs-Reality timeline, PO parser regex, batch-code shape, and dealer/lead-time rules are line-for-line ports of the Streamlit version at `../tracker_v1/`. Two cosmetic changes from the original:

1. **Stages → Actions** — admin-configurable instead of hard-coded.
2. **PO Availability + Ops Expected** are now two separate dates with two separate confidence metrics, replacing the old single "promised date".

Both changes are documented in `docs/seed-data-backup-2026-05-10.md`.

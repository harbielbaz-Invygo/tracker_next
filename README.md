# invygo · Uploading Vehicles Tracker — Next.js scaffold

A scaffolded port of the Streamlit prototype (`../tracker_v1/`) onto **Next.js 15 + TypeScript + Tailwind + Drizzle + Auth.js**.

Status: **scaffold ready** — every page renders, auth works, the PO parser is fully ported. The form/timeline UI for restricted views are placeholders pointing at their Python counterparts.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15** (App Router) | Server components, edge-compatible, deploys to Vercel |
| Language | **TypeScript** | Type-safety across DB → server → UI |
| Styling | **Tailwind CSS** + custom `globals.css` | Brand tokens map cleanly via `tailwind.config.ts` |
| Database | **SQLite** (better-sqlite3) via **Drizzle ORM** | One schema file, swap to Postgres in one config change |
| Auth | **Auth.js v5** (Credentials provider) | Same username/password model as Streamlit version |
| PDF | **pdf-parse** + custom regex | Same logic as `po_parser.py`, line-for-line |
| Hosting | **Vercel** (recommended) | Native Next.js, zero config |

---

## Setup

```bash
cd "tracker_next"

# 1. Install
npm install

# 2. Environment
cp .env.example .env
# then edit .env — set AUTH_SECRET (run `openssl rand -base64 32` to generate)

# 3. Create the database tables
npm run db:push

# 4. Seed users + dealers
npm run db:seed

# 5. Run the dev server
npm run dev
# open http://localhost:3000
```

### Demo accounts

| Username | Password | Role |
|---|---|---|
| `admin` | `admin123` | Admin (all views) |
| `partner1` | `partner123` | Partnership |
| `ops1` | `ops123` | Operations |

---

## What's included

```
tracker_next/
├── app/
│   ├── layout.tsx                         Root layout (Alexandria font, session provider)
│   ├── page.tsx                           Redirect to /dashboard
│   ├── login/page.tsx                     Inline login card
│   ├── (authed)/
│   │   ├── layout.tsx                     Sidebar + brand header
│   │   ├── dashboard/page.tsx             ⚠ placeholder (port view_dashboard here)
│   │   ├── pre-po/page.tsx                ⚠ placeholder (port view_new_request)
│   │   ├── vehicles-upload/page.tsx       ✅ working — PDF upload + parser + Slack
│   │   ├── ops-follow-up/page.tsx         ⚠ placeholder
│   │   └── settings/page.tsx              ⚠ placeholder (port view_settings)
│   └── api/
│       ├── auth/[...nextauth]/route.ts    Auth.js routes
│       └── po-parse/route.ts              ✅ working — POST a PDF, get ParsedPO
├── lib/
│   ├── auth.ts                            Auth config + role/access helpers
│   ├── auth/handlers.ts                   Auth handler re-export
│   ├── brand.ts                           invygo brand tokens (in TS)
│   ├── db/
│   │   ├── schema.ts                      ✅ Full port of data_model.py
│   │   └── index.ts                       Drizzle client
│   ├── po-parser.ts                       ✅ Full port of po_parser.py + Slack formatter
│   └── utils.ts                           cn(), makeBatchCode(), isoDate()
├── components/
│   ├── brand-header.tsx                   invygo wordmark
│   ├── sidebar.tsx                        Grouped nav with access badges
│   └── access-gate.tsx                    Wrap restricted pages
├── scripts/seed.ts                        npm run db:seed
├── tailwind.config.ts                     Brand colours
├── drizzle.config.ts                      Drizzle CLI config
└── middleware.ts                          Route guard
```

### Already working

- ✅ **Auth flow** — login form, JWT session, sign-out, role on session
- ✅ **Sidebar nav** with grouped items (Partnership / Operations / Admin) and access badges (🌐 / ✅ / 🔒)
- ✅ **Dashboard route** is public; restricted routes show inline sign-in card via `<AccessGate />`
- ✅ **PO PDF parser** — upload a PDF in `/vehicles-upload`, see all fields extracted + a Slack-ready announcement with copy button. Works against PO-0109 (multi-item) and PO-0114 (with discount column).

### Placeholders to port

For each placeholder, the Python source code is small and well-tested. Roughly:

| Page | Port from Python |
|---|---|
| Dashboard | `tracker_v1/dashboard.py` → `view_dashboard` (table + filters + SVG timeline) |
| Pre PO Upload | `tracker_v1/dashboard.py` → `view_new_request` (3-section form) |
| Vehicles Upload (form) | `view_new_vehicles_upload_request` (the hierarchical Items × Splits form) |
| Ops Follow Up | (pending design) |
| Settings | `view_settings` (3 tabs: Rules / Stage Names / Data Editor) |

---

## Key design decisions

### One Batch = one (Item × Split)
Matches the Python schema. Batch fields like `model`, `year`, `buyBackRate`, `colorSummary` come from the **PO item**; `requestedQuantity`, `dealerReceivingCity`, `dealerPromisedDeliveryDate` come from the **delivery split**. Multiple batches sharing one PO link via `poNumber`.

### Stage codes match
Same 19 stage codes as Python (`request_submitted` → `delivered`). The Plan vs Reality timeline logic is portable verbatim — just rewrite the SVG generation as a React component that returns `<svg>` markup.

### Database driver swap
SQLite for local dev (zero setup). Move to **Neon** or **Supabase** Postgres for production:

1. Replace `better-sqlite3` with `postgres` + `drizzle-orm/postgres-js`
2. Update `lib/db/index.ts` to use the postgres-js adapter
3. Update `drizzle.config.ts` dialect to `"postgresql"`

That's it — schema definitions stay identical.

### Brand consistency
The Tailwind config exposes every invygo brand colour by name (`bg-brand`, `text-midnight`, `border-flame`, etc.) and the same tokens are available as TypeScript constants (`Brand.BLUE`, `Brand.MIDNIGHT`, ...) for charts and inline styles. Single source of truth: `lib/brand.ts` + `tailwind.config.ts`.

---

## Deploy to Vercel

```bash
# 1. Push this folder to GitHub
git init && git add . && git commit -m "Initial scaffold"
git remote add origin <your-github-url>
git push -u origin main

# 2. In Vercel dashboard:
#    - "New Project" → import the repo
#    - Add the AUTH_SECRET env var
#    - For DATABASE_URL, point at a Neon/Supabase Postgres URL
#      (and complete the driver swap noted above)
#    - Deploy
```

Vercel auto-detects Next.js. ~2-minute deploys.

---

## Migration from `tracker_v1` (the Python version)

Both codebases can coexist. The Streamlit version is the **source of truth for business logic**; this Next.js version mirrors it. When porting a feature:

1. Open the Python function (e.g., `view_new_request` in `dashboard.py`)
2. Read the logic top-to-bottom
3. Build the equivalent React/TS in the matching `app/...` route
4. Use **server actions** for mutations (no separate API routes needed)
5. Use **`<AccessGate view="…">`** to enforce role-based access
6. Reuse `lib/po-parser.ts`, `lib/brand.ts`, `lib/utils.ts` everywhere

The `lib/po-parser.ts` test bench against `PO-0109` and `PO-0114` is the same fixture the Python version was verified on — extraction is identical to the byte.

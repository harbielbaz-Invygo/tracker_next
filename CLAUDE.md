# tracker_next — Working Agreement

Notes for Claude (and any sub-agents) working in this repo. Keep this file short and current.

## Repo layout

- `tracker_next/` — Next.js 15 App Router app (this directory). Drizzle ORM + libSQL/Turso, Auth.js v5, Tailwind, TypeScript strict.
- `tracker_v1/` — the legacy Streamlit dashboard the new app replaces. Read it for ground truth on business rules.

## Workflow

### Auto-merge (default)

When a change is ready (type-check clean, tests pass if relevant):

1. Open the PR with a clear title + summary + test plan.
2. **Squash-merge and delete the branch immediately** — `gh pr merge <#> --squash --delete-branch`.
3. Switch back to `main` and pull.

Do **not** wait for an explicit "marge" / "merge" confirmation. The user has authorised auto-merge.

This rule applies to sub-agents too. If you spawn an Agent to land a PR, tell it to follow the auto-merge flow.

### When to stop and ask first

Don't auto-merge — pause and confirm — if the change involves any of:

- **Schema migrations** (`lib/db/schema.ts` changes, new `drizzle/*.sql` files, `ALTER TABLE` in any form).
- **Secrets, environment variables, or auth config** changes.
- **Destructive operations** — deleting data, force-pushing, dropping columns, removing prod feature flags.
- **CI failure on the open PR** — if checks go red after push, stop and report; don't merge red.
- **Cross-cutting refactors** that the user hasn't already signed off on the design for.

### Quality gates before merging

- `npx tsc --noEmit` exits 0.
- **Run `npm run build` when a change moves runtime values across the
  client/server boundary** — e.g. extracting a function into a shared
  module that's imported by both a server route and a `"use client"`
  component. TypeScript doesn't enforce these boundaries; webpack
  does. `tsc` passing has shipped builds that fail on Vercel with
  `UnhandledSchemeError: node:fs is not handled by plugins`. The
  bundle-time check catches it; the type-check doesn't.
- No `console.log` left in committed code.
- No unrelated formatting noise in the diff.
- Commit message + PR body explain the *why*, not just the *what*.

## Conventions

- **Commit + PR titles** use Conventional Commits: `feat(scope): …`, `fix(scope): …`. Scope is usually the top-level surface (`action-center`, `sidebar`, `dashboard`, `reports`, etc).
- **Defensive queries** — wrap reads of optional/migration-pending tables in `try/catch` on `"no such table"`. Same in both server data layer + API routes.
- **No emojis in code/docs** unless the user explicitly asks. (The brand UI does use them — that's intentional.)
- **Tailwind tokens** — use the brand palette (`brand`, `gold`, `flame`, `green`, `ink`, `midnight`), not raw hex.
- **Server components by default**; `"use client"` only when interactivity actually requires it.

### Color tokens — meanings (locked)

Different palettes have different semantic loads. Don't mix.

| Token | Meaning | Examples |
|---|---|---|
| `brand` (cyan/teal) | Active / primary / "take this action" | Nav active state, primary CTA, current row highlight |
| `green` | Done / settled / on-time | Done status chips, "Mark as listed/delivered" success, on-time KPIs |
| `gold` | Warning / late / needs attention (status, NOT destructive) | Delayed status, "Shift availability date", mid-bucket urgency stripe, "blocked" badge |
| `flame` | Destructive intent (irreversible action) OR critical severity | Cancel batch, Delete, critical alerts (severity="critical"), urgency stripe ≥7d late |
| `ink-*` | Neutral content, secondary text | Everything else |
| `midnight` | Strongest neutral (deepest text) | Page titles, primary readable text |

**Don't apply `flame` to a passive STATUS** (e.g. "this is delayed"). That's `gold`. Reserve `flame` for things the user is about to do that destroys state, or for the most extreme severity.

### Spacing system (Tailwind step values)

Four-step rhythm for vertical + horizontal gaps. Use these tokens directly; avoid one-offs like `gap-3`, `mt-5`, `py-3.5`.

| Step | Token | When |
|---|---|---|
| `xs` | `gap-1` (4px) / `space-y-1` | Within a single chip / pill / micro-content |
| `sm` | `gap-2` (8px) / `space-y-2` | Within a button group / list row / form row |
| `md` | `gap-4` (16px) / `space-y-4` | Between form fields, between sub-cards in a card |
| `lg` | `gap-6` (24px) / `space-y-6` | Between top-level page blocks |

Padding inside containers uses the same scale: `px-2 py-1` (compact), `px-3 py-2` (default), `px-4 py-3` (roomy), `px-5 py-4` (hero / spacious).

Exceptions are fine when there's a typographic reason (e.g. `pt-2` to break a rhythm group inside a column), but document why in a brief comment.

## Don't

- Don't create `README.md`/docs unless asked.
- Don't `git add -A`/`git add .` — stage specific files.
- Don't `--amend` to fix a hook failure — make a new commit.
- Don't skip hooks (`--no-verify`) or signing.

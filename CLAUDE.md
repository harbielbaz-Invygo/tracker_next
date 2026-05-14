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
- No `console.log` left in committed code.
- No unrelated formatting noise in the diff.
- Commit message + PR body explain the *why*, not just the *what*.

## Conventions

- **Commit + PR titles** use Conventional Commits: `feat(scope): …`, `fix(scope): …`. Scope is usually the top-level surface (`action-center`, `sidebar`, `dashboard`, `reports`, etc).
- **Defensive queries** — wrap reads of optional/migration-pending tables in `try/catch` on `"no such table"`. Same in both server data layer + API routes.
- **No emojis in code/docs** unless the user explicitly asks. (The brand UI does use them — that's intentional.)
- **Tailwind tokens** — use the brand palette (`brand`, `gold`, `flame`, `green`, `ink`, `midnight`), not raw hex.
- **Server components by default**; `"use client"` only when interactivity actually requires it.

## Don't

- Don't create `README.md`/docs unless asked.
- Don't `git add -A`/`git add .` — stage specific files.
- Don't `--amend` to fix a hook failure — make a new commit.
- Don't skip hooks (`--no-verify`) or signing.

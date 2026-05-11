# Deployment runbook

Current production setup:

- **Hosting**: Vercel (project `vehicles-tracker` under `invygo-s-projects` team).
- **Database**: Turso libSQL DB `vehicles-tracker-harbielbaz-invygo.aws-ap-south-1.turso.io` (Mumbai region).
- **DNS**: Vercel-provided alias `https://project-n2y2q.vercel.app`. Custom domain not yet bound.
- **Repo**: https://github.com/harbielbaz-Invygo/tracker_next, `main` branch is the production branch.

The deploy is git-driven: anything merged to `main` triggers an auto-deploy in Vercel. Preview deploys for non-main branches share the same Turso DB (no separate preview DB yet — see "Future improvements" below).

---

## First-time provisioning

Do this once when bootstrapping a fresh environment.

### 1. Turso database

```bash
turso db create vehicles-tracker --region bom         # or via dashboard
turso db tokens create vehicles-tracker --expiry never
```

Capture the URL (`libsql://…turso.io`) and the auth token. The token is shown once — store it in your password manager immediately.

### 2. Vercel project

Either import the GitHub repo from the Vercel dashboard (recommended) or push a new project via `vercel` CLI. In project settings:

- **Framework Preset**: Next.js (Vercel auto-detects; verify it's not "Other")
- **Root Directory**: empty (the repo root *is* the Next.js project)
- **Build/Output/Install/Dev Command**: leave on the Next.js defaults
- **Production Branch**: `main`

### 3. Environment variables

In Vercel → Settings → Environment Variables, add the following with all three environments (Production / Preview / Development) checked:

| Variable | Source |
| --- | --- |
| `DATABASE_URL` | The `libsql://…` URL from step 1 |
| `TURSO_AUTH_TOKEN` | The token from step 1 |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32` — must be 32+ chars |
| `NEXTAUTH_URL` | The Vercel-assigned production URL (e.g. `https://project-xxxxx.vercel.app`) |

`NEXTAUTH_URL` matters: NextAuth uses it to anchor cookies and login redirects. If it's wrong, login appears to succeed but redirects fail with "redirect_uri mismatch" or an empty session.

### 4. Schema + seed

From a developer machine with the env vars exported, push the schema and seed once:

```powershell
$env:DATABASE_URL = "libsql://…"
$env:TURSO_AUTH_TOKEN = "…"
npm run db:push
npm run db:seed
```

The seed wipes any existing data and reinserts 8 demo scenarios + 2 users. Safe to re-run; `seed.ts` refuses to run against `NODE_ENV=production` unless `ALLOW_PROD_SEED=yes-i-am-sure` is set.

### 5. First deploy

```bash
git push origin main
```

Vercel detects the push, runs the build, and serves on the production alias. ~90 second build time on a cold cache.

### 6. Post-deploy verification

```bash
curl https://<your-prod-url>/api/health
# → {"ok":true,"ts":"2026-…"}
```

If `ok:false` and `status:503`, the deployment can't reach Turso — re-check the env vars in Vercel.

Then load `https://<your-prod-url>/login` in a browser and sign in with the seeded `admin / admin123`.

### 7. Rotate the seeded passwords immediately

The demo passwords are committed in `scripts/seed.ts`. Don't leave them in place. Either:

- **Via the app**: log in as admin → Settings → Users → Reset password for both seeded users.
- **Via script**:
  ```powershell
  $env:DATABASE_URL = "libsql://…"
  $env:TURSO_AUTH_TOKEN = "…"
  $env:NEW_ADMIN_PW = "<strong-pw>"
  $env:NEW_OPS_PW   = "<strong-pw>"
  npx tsx scripts/rotate-passwords.ts
  ```

---

## Ongoing deploys

Standard git-driven flow:

1. Branch off main: `git checkout -b feat/<name>` or `fix/<name>`.
2. Work + commit + push.
3. Open a PR on GitHub. Vercel builds a preview deploy automatically and posts the URL in the PR.
4. Merge to main once reviewed → Vercel auto-deploys to production.

**Branch protection**: enable "Require a pull request before merging" on `main` in GitHub Settings → Branches. Prevents accidental direct pushes that would skip review.

---

## Routine maintenance

### Rotate the Turso token

Tokens don't expire by default, but rotate annually or after any suspected exposure.

1. Turso dashboard → DB → Tokens → **Create Token** (`vercel-prod`, Full Access, Never).
2. Copy the new token.
3. Vercel → Settings → Environment Variables → edit `TURSO_AUTH_TOKEN` → paste new value → Save.
4. Vercel → Deployments → most recent → `⋯` → Redeploy → uncheck "Use existing Build Cache" → confirm.
5. Wait for green. Health check.
6. Turso dashboard → revoke the old token.

### Rotate `NEXTAUTH_SECRET`

Same flow as above for the secret in Vercel. Side effect: every existing session is invalidated, so users will need to log in again after the redeploy. Plan accordingly.

### Adding a new user

Admin only. Settings → Users → "Add new user" form. Fill in username, name, email, role, and an initial password (8+ chars). Hand the password to the new user out-of-band and ask them to change it on first login via the same Settings page.

### Wiping demo data

When the team is ready to switch from the seeded scenarios to real POs, two options:

- **Re-seed without scenarios**: edit `scripts/seed.ts` and shrink the `SCENARIOS` array to `[]`, then run `npm run db:seed` against Turso. Keeps users + departments + action types + dealers intact; wipes only batches.
- **Direct delete**: `turso db shell vehicles-tracker "DELETE FROM batches;"`. The FK cascades take care of `batch_actions`, `vehicles`, `milestones`, etc.

---

## Troubleshooting

### "DEPLOYMENT_NOT_FOUND" on a previously-working URL

Vercel rotates the per-deployment URL hash when an older deployment is superseded. Always link to the stable production alias (`https://project-n2y2q.vercel.app`), not the per-deploy hash (`https://vehicles-tracker-<hash>-….vercel.app`).

### "Invalid credentials" at login

The bcrypt round-trip is failing. Most likely causes:

- The DB the deploy is pointing at doesn't have the expected user. Run `scripts/verify-login.ts` against the same `DATABASE_URL` and confirm the user row exists.
- `NEXTAUTH_SECRET` was changed but the page is still using a cached cookie. Clear cookies and try again.
- `NEXTAUTH_URL` doesn't match the actual URL the user is on — cookies get bound to the wrong domain. Update the env var to match the alias and redeploy.

### Build fails with "No Output Directory named 'public'"

Vercel auto-detected the project as a static site. In Settings → Build & Development Settings, set Framework Preset to **Next.js** and clear any "Override" toggles on Build Command / Output Directory / Install Command. Redeploy.

### Build fails with env validation errors

`lib/env.ts` hard-fails on missing variables in production. Check that all four required vars (`DATABASE_URL`, `TURSO_AUTH_TOKEN`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`) are present in Vercel for the failing environment.

### Live site responds 200 but data looks wrong

Use the diagnostic scripts:

```powershell
$env:DATABASE_URL = "libsql://…"
$env:TURSO_AUTH_TOKEN = "…"
npx tsx scripts/verify-login.ts        # confirm DB reachable, users exist
```

If the script connects but the deployment doesn't, the deployment env vars are pointing at a different DB.

---

## Future improvements

Not done yet, in priority order:

1. **Separate preview DB** — provision a second Turso DB and set its credentials only on Vercel's Preview + Development environments so feature branches can't mutate production data.
2. **Custom domain** — bind `tracker.invygo.com` (or whichever) in Vercel → Settings → Domains and update `NEXTAUTH_URL` accordingly.
3. **Drizzle migrations** — currently using `db:push` which is fine for a small schema, but a migration history (`drizzle-kit generate`) becomes valuable once the team is bigger than one.
4. **PDF size limit** — Vercel Hobby tier caps function request bodies at ~4.5 MB. Most invygo POs are under 1 MB, but if a future PDF exceeds it, the upload will 413. Move PDF parsing to a streaming endpoint or a separate service if this becomes a regular problem.

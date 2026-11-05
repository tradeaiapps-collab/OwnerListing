# Production runbook (Vercel + Neon)

Short checklist for going live. Detail lives in `docs/DEPLOY_VERCEL.md` (step by step) and `docs/DEPLOYMENT.md` (hardening). Use a **paid** Vercel plan (Pro) and a **paid** Neon plan for production: free tiers forbid commercial use, pause when idle and give no guaranteed backups.

## One-time setup (account owner)
1. **Neon**: new project, region Sydney (`aws-ap-southeast-2`), Postgres version 17 or newest offered. Turn on point-in-time restore (history retention 7+ days on the paid plan). Create two roles as in `DEPLOYMENT.md` section 1 (owner/migration, restricted app).
2. **Vercel**: create `ownerlisting-public` (`APP_MODE=public`) and `ownerlisting-admin` (`APP_MODE=admin`) from this repo. `vercel.json` pins functions to Sydney (`syd1`). `main` deploys to production automatically; PR branches get preview URLs. Set `DATABASE_URL` to the **pooled** app-role string.
3. **Secrets**: generate each with `openssl rand -base64 48`, a different value per variable and per project. Required list: `DEPLOY_VERCEL.md` env table. Elena and cron: `ELENA_LEARNING_CRON_SECRET` plus every `*_CRON_SECRET` in `.env.example` must be set on the **public** project.
4. **Domain**: add `www.` to public and `admin.` to admin in Vercel, create the CNAMEs at the registrar (`DEPLOY_VERCEL.md` step 6). Vercel issues and renews TLS itself. Then set `APP_URL` / `ADMIN_APP_URL` and Google redirect URIs, and redeploy.
5. **GitHub repo secrets** (Settings, Secrets and variables, Actions): `APP_URL`, `ADMIN_APP_URL`, and each cron secret the scheduled workflows name (for example `ELENA_LEARNING_CRON_SECRET`, same value as Vercel). Workflows skip with a warning until set.
6. **GitHub Environment** `production` (Settings, Environments): add required reviewers and the secret `PROD_DATABASE_URL` (Neon **direct** owner-role string).

## Every release
1. PR merges to `main` after CI is green. Vercel deploys both projects.
2. If the PR added a file under `db/`: Actions, **Production migrate**, Run workflow, approve. Migrations are additive and run once each.
3. Check `https://PUBLIC/api/health` and `https://ADMIN/api/health` return `{"ok":true}`.
4. Rollback: Vercel, Deployments, previous deployment, **Promote to Production**. A bad migration: restore from Neon point-in-time to a new branch, then switch `DATABASE_URL`.

## Monitoring
- **Uptime**: `.github/workflows/uptime-check.yml` calls `/api/health` on both sites every 15 minutes; a failure emails repo watchers.
- **Errors**: every uncaught server error writes one JSON line (`event: request_error`, route, digest, message, no request data) from `instrumentation.ts`. View in Vercel, Logs, filter `request_error`; add Vercel alerts or a log drain (Datadog, Sentry via Vercel integration) to be paged.
- **Scheduled jobs**: the cron workflows in `.github/workflows/` fail loudly on any non-2xx; Elena runs weekly (Sunday 17:30 UTC) and monthly (1st).
- **Backups**: Neon point-in-time restore. Test a restore once before launch.

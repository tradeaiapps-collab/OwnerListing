# Go-live checklist for john (Vercel + Supabase)

Nothing here has been run. Every step marked **[you]** needs your account, a secret or your go-ahead. Detail: `PRODUCTION_RUNBOOK.md` (short list), `DEPLOY_VERCEL.md` (env table, step by step), `DEPLOYMENT.md` (hardening), `PROVIDER_KEYS.md` (provider keys). Never paste connection strings or secrets into chat or a PR.

## 0. Blockers to decide first
1. **Uploads cannot work on Vercel as built.** Photos, documents and ID images need `STORAGE_DRIVER=s3` (Supabase Storage S3 endpoint, Cloudflare R2, Wasabi or AWS) **and** a ClamAV `clamd` reachable over TCP (`CLAMD_HOST`, `CLAMD_PORT`); without both, uploads answer 503. Vercel cannot run clamd, and its request body limit is about 4.5 MB. Choose: (a) a small always-on server (about A$8 a month VPS or container) running clamd, or (b) host the app on a container platform instead of Vercel. Until then the site goes live without uploads (listings have no photos).
2. **Email**: SES Sydney SMTP, entered at `/staff/messaging` after first sign-in. Without it no email sends.
3. **Google sign-in** is the only sign-in: create the OAuth client first (redirect URIs below).
4. Keep `INVESTMENT_MODULE_ENABLED=false` until counsel signs off, unless you decide otherwise (the Projects tab is hidden when off).
5. No live PayWay keys until pen test and counsel sign-off (CLAUDE.md rule).

## 1. Accounts [you]
- Supabase Pro, project in Sydney (`ap-southeast-2`). Save the DB password in your password manager.
- Vercel Pro, two projects from this repo: `ownerlisting-public` (`APP_MODE=public`) and `ownerlisting-admin` (`APP_MODE=admin`).
- Domain at your registrar; Google Cloud OAuth client; GitHub repo admin (secrets and environments).

## 2. Database roles [you, Supabase SQL editor]
Create the owner/migration role and the restricted app role as in `DEPLOYMENT.md` section 1. After migrating, run `REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM <app_role>;`. Leave the Supabase Data API off.

## 3. Environment variables
Generate each secret separately with `openssl rand -base64 48` (keys marked 32 use `openssl rand -base64 32`). Never reuse a value across variables or between the two projects (except `THEME_PREVIEW_SECRET`, same on both).

| Variable | Public project | Admin project | Notes |
|---|---|---|---|
| `APP_MODE` | `public` | `admin` | |
| `APP_URL` | `https://www.<domain>` | `https://www.<domain>` | exact origin, no path |
| `ADMIN_APP_URL` | empty | `https://admin.<domain>` | |
| `DATABASE_URL` | app role, pooler port 6543 | same | owner role only in GitHub, see section 5 |
| `SESSION_SECRET` | secret A | secret B (different) | 32+ chars |
| `GOOGLE_CLIENT_ID` / `_SECRET` | yes | same pair | redirect URIs: `APP_URL/api/auth/google/callback` and `ADMIN_APP_URL/api/auth/google/callback` |
| `TRUSTED_PROXY_HOPS` | `1` | `1` | |
| `STAFF_BOOTSTRAP_ADMIN_EMAILS` | empty | your Google email | first super admin |
| `MFA_SECRET_KEY` (32) | yes | yes, same | losing it breaks saved MFA |
| `PROVIDER_CREDENTIAL_KEY` (32) | yes | yes, same | seals Domain/Meta keys; do not rotate casually |
| `MESSAGING_SETTINGS_KEY`, `SYNDICATION_SETTINGS_KEY` | yes | same | see `.env.example` |
| `OFFER_LINK_TOKEN_KEY` (32), `MANDATE_FLOOR_KEY` | yes | empty | offers refused without them |
| `ALERT_UNSUBSCRIBE_KEY`, `ALERT_CRON_SECRET`, `API_TOKEN_SECRET`, `SMS_CODE_SECRET` | yes | empty | fail-closed when empty |
| `ID_IMAGE_KEY` (32) | only with storage + clamd | empty | never rotate once ID images exist |
| `THEME_PREVIEW_SECRET` | yes | same value | optional |
| `STORAGE_DRIVER=s3`, `S3_*`, `CLAMD_HOST`, `CLAMD_PORT=3443`, `CLAMD_TLS_CA_B64`, `CLAMD_TLS_CERT_B64`, `CLAMD_TLS_KEY_B64` | after decision 0.1 (decided: Vercel + ClamAV VPS, see `deploy/clamav/README.md`) | empty | |
| `NEXT_PUBLIC_MAP_PROVIDER`, `_TILE_URL`, `_ATTRIBUTION` | provider chosen | same | map tiles required by `check:providers --production` |
| `INVESTMENT_MODULE_ENABLED` | `false` or `true` | same | |
| every `*_CRON_SECRET` in `.env.example` | yes (32+ chars) | empty | same value as the GitHub secret of the same name |

Run `npm run check:providers -- --production` with the production values loaded locally; exit 1 means stop.

## 4. Domain and TLS [you]
`www.` to public and `admin.` to admin in Vercel; CNAMEs at the registrar; Vercel issues TLS. Then set `APP_URL` / `ADMIN_APP_URL`, Google redirect URIs, and redeploy.

## 5. GitHub [you]
- Actions must be running again (it has been failing to start since about 6 Nov: check Settings, Billing). Re-run CI on main first.
- Environment `production` with required reviewers and secret `PROD_DATABASE_URL` (owner role, direct connection port 5432; Session pooler string if the runner has no IPv6).
- Repo secrets: `APP_URL`, `ADMIN_APP_URL`, and each cron secret named in `.github/workflows/*.yml` (grep `secrets.`). Workflows skip with a warning until set.

## 6. Migrations (per-module, timestamped)
`npm run migrate:plan` shows the exact order (154 files at this commit: 001 to 016 numbered, then timestamps up to `20261118160000_moderation_queue.sql`) and with `DATABASE_URL` set lists pending files read-only. Order is plain filename sort; two files may share a timestamp and then sort by name. Each file is its own transaction, applied once, stop at first failure.
1. Back up (Supabase backup plus PITR) and confirm a restore works once.
2. Actions, **Production migrate**, Run workflow, approve. Expect `applied <file>` per file and no `failed`.
3. Re-run: must apply nothing. `SELECT count(*) FROM schema_migration;` equals 154.

## 7. Seed plan
- **Do not seed demo data in production.** `scripts/seed-demo.mjs` refuses to run unless `DATABASE_URL` is localhost, and must stay that way.
- The only seed is the first super admin: set `STAFF_BOOTSTRAP_ADMIN_EMAILS`, open the admin site, sign in with that Google account.
- Then configure in the admin site: `/staff/messaging` (SMTP), `/staff/cron-secrets` (generate, copy to GitHub secrets), `/staff/public-holidays`, `/staff/feeds`, `/staff/meta-leads`, `/staff/listing-optimization-settings`, `/staff/valuation-settings`, `/staff/elena-training`, plans and fees.
- Real content (plans, state disclosure templates) comes from migrations, not seeds.

## 8. Smoke test (read-only, no secrets)
```
APP_URL=https://www.<domain> ADMIN_APP_URL=https://admin.<domain> npm run smoke:prod
```
Checks health on both sites, key public pages, the public/admin split, anonymous refusals, cron endpoints fail closed, security headers. The heavier `scripts/smoke.mjs` writes rows: scratch database only, never production.
Then by hand: Google sign-in, staff sign-in on admin, list a property (after storage), each cron workflow once via Actions, Actions "Uptime check" green.

## 9. Rollback
Vercel: promote the previous deployment. Pause a job at `/staff/cron-secrets` or disable the workflow. Bad migration: corrective forward migration, or Supabase PITR restore then confirm `DATABASE_URL`.

# Deployment

Stack: Next.js app, PostgreSQL. Env reference: `.env.example` (comments say which settings fail closed).

Splitting public and admin sites (`APP_MODE`, `ADMIN_APP_URL`) and the free Vercel test deploy: docs/DEPLOY_VERCEL.md.

## 1. Database
1. Create a PostgreSQL database and two roles: an owner/migration role and a runtime app role.
2. Run migrations as the owner role: `DATABASE_URL=... npm run migrate`. It applies `db/*.sql` in filename order, once each, one transaction per file, and records them in `schema_migration`. Re-run after every deploy that adds a file; it stops at the first failure.
3. Runtime role: grant only the privileges the app needs (SELECT/INSERT, UPDATE where a table needs it). **Revoke TRUNCATE, UPDATE and DELETE** from the app role on the append-only tables, because row triggers do not block TRUNCATE (docs/security-review-2026-10.md, "Not fixed" item 2): `audit_event`, `enquiry_message`, `chat_message`, `override_log`, `trust_account_approval`, `messaging_outbox` and the ledgers from `db/20261024150000_append_only_ledgers.sql`. Also revoke TRUNCATE (only) on `messaging_setting`, which the app does update. Simplest: `REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM <app_role>;` then check with `\dp`. The app must never connect as the owner role.

## 2. Build and start
```
npm ci
npm run typecheck && npm test
npm run build
npm run start      # next start -p 3004
```
Put a TLS-terminating reverse proxy in front. Set `TRUSTED_PROXY_HOPS` to the real number of proxies (client IP is read from the right of x-forwarded-for). Set `APP_URL` to the exact public https origin, or state-changing routes return 403.

## 3. Required env
Which provider keys each feature needs: `docs/PROVIDER_KEYS.md`. Run `npm run check:providers -- --production` with the deployment env before every deploy; exit 1 means stop.

`APP_URL`, `DATABASE_URL`, `TRUSTED_PROXY_HOPS`, `SESSION_SECRET` (32+ chars), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Google OAuth redirect URI: `${APP_URL}/api/auth/google/callback`. Set `STAFF_BOOTSTRAP_ADMIN_EMAILS` (comma list) for the first deploy so the first admin can sign in at `/api/auth/google/start?as=staff`; that admin then invites everyone else at `/staff/invites` (any Google account; the verified email must exactly match an active invite, and the role comes from the invite). The bootstrap emails work only while no active super_admin exists; clear the variable once a second admin exists. `PAYWAY_*` stay unset until the merchant account exists. No live payment keys until pen test and counsel sign-off.

## 4. Backups
- Daily full backup plus WAL archiving (point-in-time recovery); keep at least 30 days; encrypted; stored off the primary host.
- Test a restore monthly into a scratch database; `npm run migrate` against it should apply nothing.
- Audit, chat and ledger tables are never rewritten; do not "clean" them after a restore.
- Uploaded files (once storage exists) need their own versioned backup; the database holds only keys and SHA-256 hashes.
- Retention and deletion periods are pending counsel (docs/COUNSEL_QUESTIONS.md).
- ID images are encrypted with `ID_IMAGE_KEY`; back the key up separately (secrets manager). Restoring an ID image from backup after the retention job deleted it would break the retention promise: exclude `id/` from long-term file backups or keep backups no longer than 30 days.

## 4a. In-house ID photo review (holds sensitive personal information)
Do not turn this on for real users until counsel has approved the retention periods (7 days after approval, 30 after rejection), the privacy notice wording (`ID_IMAGE_CONSENT_TEXT`, versioned in `src/domain/id-image.ts`) and Privacy Act handling of ID images and selfies (biometric information is sensitive information), and a pen test has been done.
- Needs all of: `STORAGE_DRIVER` + `STORAGE_LOCAL_DIR` (encrypted volume, not web-served), `CLAMD_HOST` + `CLAMD_PORT`, `ID_IMAGE_KEY` (`openssl rand -base64 32`), `ID_RETENTION_CRON_SECRET` (32+ chars). Any one missing = off.
- Schedule daily: `curl -fsS -X POST -H "x-cron-secret: $ID_RETENTION_CRON_SECRET" $APP_URL/api/internal/id-images/retention`. Safe to repeat; answers `{counts:{deleted,failed}}`; investigate any `failed`.
- Never rotate `ID_IMAGE_KEY` while images are stored (they become unreadable); wait until the queue is empty and 30 days have passed.
- Images are viewable only by the reviewer holding the 30-minute claim, through `/api/staff/id-review/[id]/image/[part]` (no-store, every view in `id_review_access`).

## 4b. Account deletion retention (daily)
- `.github/workflows/account-retention.yml` calls `POST $APP_URL/api/internal/accounts/retention` with header `x-cron-secret` every day at 02:00 UTC. Set repository secrets `APP_URL` (public address) and `ACCOUNT_RETENTION_CRON_SECRET` (same value as the app, 32+ chars). Until both are set the run is skipped with a warning.
- `.github/workflows/scheduled-reports.yml` calls `POST $APP_URL/api/internal/reports/run` with header `x-cron-secret` every hour at :05. It sends the staff report schedules that are due (set up at `/staff/report-builder`) to their owners by email. Set repository secrets `APP_URL` and `REPORTS_CRON_SECRET` (same value as the app, 32+ chars). Until both are set the run is skipped with a warning; without email settings (`/staff/messaging`) runs are stored but not sent.
- Manual run: Actions > Account retention (daily) > Run workflow, or the same curl by hand. Safe to repeat; answers `{counts:{finalised,purged}}`.
- Every run writes one `job.account_retention_run` audit event (aggregate `job` / `account-retention`, payload = counts), plus one event per account changed. A missing day in the audit trail means the scheduler stopped.

## 5. Smoke test after deploy
Home loads; Google sign-in works; `/plans` loads; an upload answers 503 (storage off, expected); checkout answers "not available yet" (expected); `/api/webhooks/payway` rejects unsigned posts.

## 6. Blocked on providers (stays off or fails closed)
| Area | Behaviour now | Needs |
|---|---|---|
| Staff sign-in linking | First-login linking by email match waits | Google Workspace domain (hd claim) |
| Email and SMS (alerts, verification) | Built (SMTP via nodemailer; Twilio-compatible SMS). Fails closed: nothing sends until an admin enters settings in `/staff/messaging` (section 6a) | SMTP account or email provider, SMS account and sender, Spam Act consent wording (counsel) |
| Payments | Adapter stub; nothing can be marked paid, so nothing publishes | Westpac PayWay merchant account and docs |
| File storage and malware scan | Upload and download answer 503 | Storage provider, scanner, encryption at rest |
| ID verification | In-house photo ID + selfie review is built but off until storage, ClamAV, `ID_IMAGE_KEY` and `ID_RETENTION_CRON_SECRET` are all set (page says "not available yet", approval blocked) | Settings below; counsel sign-off; pen test |
| ABN check | Adapter built, reads ABN_LOOKUP_GUID (unset = not confirmed, staff review) | ABN Lookup GUID |
| AI | Rules-only engine; features report off | Self-hosted model and OCR server |
| Legal text | Draft terms and contract template | Counsel review |
| Investor projects | Off: `INVESTMENT_MODULE_ENABLED` unset/false, database switch off (no row). Investor routes answer 404 | Counsel sign-off (COUNSEL_QUESTIONS 9), then section 6b |

## 6b. Staff roles (`/staff/roles`)
Migration `db/20261025140000_staff_roles.sql` adds `staff_role_def` and `staff_role_def_version` (insert-only), seeds the six built-in roles and makes `staff_invite.role` a foreign key to them. Existing invites are not rewritten; the migration stops if any invite has an unknown role. Rollback steps are in the file header (only while no custom role is in use). After deploying: a super admin creates custom roles (key `custom_*`) in `/staff/roles`, then assigns them in `/staff/invites`. Built-in role permissions live in code and cannot be edited. Role edits take effect on each staff member's next request. Download the access review from `/api/staff/roles/export` (CSV) for periodic access reviews.

## 6a. Email and SMS settings (`/staff/messaging`)
1. Set `MESSAGING_SETTINGS_KEY` (`openssl rand -base64 32`) on the server. Without it the page shows "encryption key not configured" and saves nothing; secrets already saved cannot be decrypted, so DB-held SMS/email stay off. Keep the key out of the database and backups; losing it means the auth token and SMTP password must be entered again.
2. A super admin signs in and opens `/staff/messaging` (`messaging.settings`, held by super admin by default; API `GET`/`PUT /api/staff/messaging`, `POST /api/staff/messaging/test`). SMS: provider `twilio`, account SID, auth token (or API key SID plus its secret as the token), sender (+61 number, sender ID or messaging service SID). Email: SMTP host, port (465 implicit TLS, otherwise STARTTLS is required), user and password (both or neither), from address. Secrets are write-only: the page shows only "set". Every change is in the audit log (field name, who, when; never the value).
3. Environment variables `SMS_*` and `SMTP_*` (see `.env.example`) override the saved value for that field; the page says when a field comes from the server. Settings are read at send time, so a change takes effect without a restart.
4. "Send test SMS/email to me": 5 per hour per admin; email goes to the admin's own account address; SMS to the number typed. Unconfigured = 409 and nothing sent.
5. Every send attempt (verification codes, alerts, tests) adds a row to `messaging_outbox` (insert-only: channel, template, keyed hash of the recipient, status `sent`/`failed`/`not_configured`, provider reference, error code; no body, address or number). The recipient hash is an HMAC under `SESSION_SECRET`. Add `messaging_outbox` and `messaging_setting` to the REVOKE TRUNCATE list in section 1 (the outbox has a trigger; TRUNCATE bypasses it).
6. No automatic retries inside the adapters (a timed-out request may still have been delivered); the alert outbox worker retries failed alerts. The SMS host is fixed (`api.twilio.com`, no redirects). The SMTP host is admin-entered, so it is guarded: a public DNS name only (no IP literals, `localhost`, `.internal`/`.local` names), ports 25, 465, 587 or 2525 only, and at send time every resolved address must be public (no private, loopback, link-local, metadata or reserved range); the connection goes to that resolved address with the certificate checked against the name. Also deny the app server egress to internal networks and the cloud metadata address at the network level (defence in depth). Test SMS goes only to Australian mobiles (+614...), 5 per hour per admin and 20 per hour overall.

## 6b. Investor projects module (keep OFF until counsel signs off)
1. Migration `db/20261025150000_investments.sql`. Add `investment_setting_history`, `investment_posting_setting_history`, `investment_project_status_history`, `investor_declaration`, `investment_message`, `investment_contract_file`, `investment_contract_history` and `investment_fee_history` to the REVOKE TRUNCATE list in section 1 (they also have triggers).
2. Two keys: set `INVESTMENT_MODULE_ENABLED=true` (exactly `true`; anything else is off), then a super admin opens `/staff/investments/settings`, ticks "Counsel has approved the investor offering documents and disclosure wording" for the current disclosure version and turns the database switch on. Turning off there (or unsetting the env) takes effect on the next request; nothing is deleted. Every change is in `investment_setting_history` and the audit log.
3. Choose the posting model on the same page (Model 1 commission % or fixed; Model 2 upfront fee and disclosure rule). Applies to projects posted afterwards only.
4. Signed agreement uploads use the same storage and ClamAV settings as documents (keys under `investments/`); without them uploads answer 503. Model 2 upfront fee uses the Westpac PayWay port and answers 503 until connected. Fee notices and message notices go through the messaging outbox (section 6a) from the platform address, with a link back to the platform; no message text or contact details are emailed. Reply-by-email is not built.
5. Replace the DRAFT risk warning and agreement template with counsel's wording (bump their versions; investors then re-acknowledge and the admin re-confirms).

## 7. End-to-end smoke script (scratch database only)
`scripts/smoke.mjs` drives the running app over HTTP (about 90 steps): terms, draft listing with price, publish gate, browse and search, saved items, buyer verification, enquiry and messages, offer-link request and issue, offer submit (single use), owner offers, offer analysis, contract draft preview, owner and staff reports, key pages, and the provider-off routes. It is not run by `npm test`.
```
npm run migrate && npm run build && npm run start      # in another shell, with the env from section 3
DATABASE_URL=... APP_URL=http://localhost:3004 SESSION_SECRET=<same as the server> node scripts/smoke.mjs
```
It seeds users, a law firm and trust account, and buyer verification straight into the database and signs session cookies the way `src/server/auth/session.ts` does, so use a throwaway database: the append-only tables cannot be cleaned. Exit code 1 on any unexpected status (500, 502, 504 always fail).
Blocked by design, so the script seeds the result in SQL: publishing needs compliance-approved disclosure config (`src/config/disclosures.ts` is empty, so the gate answers "no configuration" and fails closed), the listing fee paid (PayWay is a stub), and an approved trust account (normally two staff approvals). Also fail closed and expected: AI summary "unavailable", checkout refused, `/api/webhooks/payway` 503 while its secret is unset.

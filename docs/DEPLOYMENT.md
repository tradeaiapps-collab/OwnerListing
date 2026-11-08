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
- Needs all of: `STORAGE_DRIVER=s3` + the S3 settings in section "File storage (S3)" below (production), or `STORAGE_DRIVER=local-disk` + `STORAGE_LOCAL_DIR` (dev and staging only; refused in production), `CLAMD_HOST` + `CLAMD_PORT`, `ID_IMAGE_KEY` (`openssl rand -base64 32`), `ID_RETENTION_CRON_SECRET` (32+ chars). Any one missing = off.
- Schedule daily: `curl -fsS -X POST -H "x-cron-secret: $ID_RETENTION_CRON_SECRET" $APP_URL/api/internal/id-images/retention`. Safe to repeat; answers `{counts:{deleted,failed}}`; investigate any `failed`.
- Never rotate `ID_IMAGE_KEY` while images are stored (they become unreadable); wait until the queue is empty and 30 days have passed.
- Images are viewable only by the reviewer holding the 30-minute claim, through `/api/staff/id-review/[id]/image/[part]` (no-store, every view in `id_review_access`).

## 4b. Account deletion retention (daily)
- `.github/workflows/account-retention.yml` calls `POST $APP_URL/api/internal/accounts/retention` with header `x-cron-secret` every day at 02:00 UTC. Set repository secrets `APP_URL` (public address) and `ACCOUNT_RETENTION_CRON_SECRET` (same value as the app, 32+ chars). Until both are set the run is skipped with a warning.
- `.github/workflows/scheduled-reports.yml` calls `POST $APP_URL/api/internal/reports/run` with header `x-cron-secret` every hour at :05. It sends the staff report schedules that are due (set up at `/staff/report-builder`) to their owners by email. Set repository secrets `APP_URL` and `REPORTS_CRON_SECRET` (same value as the app, 32+ chars). Until both are set the run is skipped with a warning; without email settings (`/staff/messaging`) runs are stored but not sent.
- `.github/workflows/dispute-escalation.yml` calls `POST $APP_URL/api/internal/disputes/escalate` with header `x-cron-secret` hourly. It sends buyer-seller disputes still unresolved after 5 days to staff (they are also escalated whenever someone opens a dispute list). Generate the secret at `/staff/cron-secrets` or set `DISPUTES_CRON_SECRET` (32+ chars) and the repository secret of the same name beside `APP_URL`.
- `.github/workflows/staff-automation.yml` calls `POST $APP_URL/api/internal/staff-automation/run` with header `x-cron-secret` every 15 minutes. It applies listing-age workflow rules, sends the next batch (100 messages per campaign) of campaigns that are due or part way through, and runs scheduled tasks that are due (set up at `/staff/automation` and `/staff/campaigns`). Set repository secret `STAFF_AUTOMATION_CRON_SECRET` (same value as the app, 32+ chars) beside `APP_URL`. Campaign email needs `ALERT_UNSUBSCRIBE_KEY` (32+ chars); campaign SMS needs the Twilio settings from docs/PROVIDER_KEYS.md.
- Manual run: Actions > Account retention (daily) > Run workflow, or the same curl by hand. Safe to repeat; answers `{counts:{finalised,purged}}`.
- Every run writes one `job.account_retention_run` audit event (aggregate `job` / `account-retention`, payload = counts), plus one event per account changed. A missing day in the audit trail means the scheduler stopped.

## 4c. Agent invitation reminders (hourly)
- `.github/workflows/agent-invite-reminders.yml` calls `POST $APP_URL/api/internal/appointments/reminders` with header `x-cron-secret` at 15 past every hour. Set repository secrets `APP_URL` and `APPOINTMENT_REMINDER_CRON_SECRET` (same value as the app, 32+ chars). Until both are set the run is skipped with a warning.
- `.github/workflows/signing-reminders.yml` calls `POST $APP_URL/api/internal/signing/reminders` with header `x-cron-secret` at 25 past every hour. Set repository secret `SIGNING_REMINDER_CRON_SECRET` (same value as the app, 32+ chars) next to `APP_URL`. Until both are set the run is skipped with a warning.
- Each invitation unanswered for 48 hours gets one reminder to the agent. Safe to repeat; answers `{reminded}`.
- Elena lead qualifier: `.github/workflows/lead-followups.yml` every 15 minutes; setup in `docs/ELENA_LEAD_QUALIFIER.md`.

## 4d. Scheduled agent reports (hourly)
- `.github/workflows/agent-reports.yml` calls `POST $APP_URL/api/internal/agent-reports/run` with header `x-cron-secret` at 5 minutes past every hour. Set repository secrets `APP_URL` and `AGENT_REPORT_CRON_SECRET` (same value as the app, 32+ chars). Until both are set the run is skipped; the route answers 503 while the secret is unset.
- Reports are emailed to the agent's own account email at 8am Brisbane time (daily, Mondays, or the 1st) through the normal email settings; the delivery log on /staff/messaging shows each one (template `agent_report`). With email not configured the schedule still advances and the run is marked "not sent".
- Answers `{counts:{due,sent,notSent,skipped}}`. Safe to repeat: each report is claimed before it is sent, so overlapping runs never send twice. Reports hold counts, money and listing titles only, never buyer names.


## 4e. Elena market-shift alerts (daily)
- `.github/workflows/market-shifts.yml` calls `POST $APP_URL/api/internal/market-shifts/run` with header `x-cron-secret` at 21:30 UTC (7:30am Brisbane) every day. Set repository secrets `APP_URL` and `MARKET_SHIFT_CRON_SECRET` (same value as the app, 32+ chars). Until both are set the run is skipped; the route answers 503 while the secret is unset.
- For every area where an agent has an active appointment on a published listing (suburb, property type, sale or rent) it compares the market now with a month ago and sends an in-app notification (kind `market_shift`, category Listings, so agents control it in notification settings). Each shift is sent once per agent, area, kind and month (table `market_shift_alert`), so re-runs are safe. Answers `{counts:{areas,shifts,notified}}`; one failing area never stops the rest.
- Run it only after migration `20261105200000_market_shift_alerts.sql` has been applied (`npm run migrate`). Rollback: disable the workflow; the table is append-only and can stay.

## 5. Smoke test after deploy
Home loads; Google sign-in works; `/plans` loads; an upload answers 503 (storage off, expected); checkout answers "not available yet" (expected); `/api/webhooks/payway`, `/api/webhooks/mls` and `/api/webhooks/push-status` reject unsigned posts (503 while their secret is unset). Staff can check provider keys at `GET /api/staff/providers/health`.

## 6. Blocked on providers (stays off or fails closed)
| Area | Behaviour now | Needs |
|---|---|---|
| Staff sign-in linking | First-login linking by email match waits | Google Workspace domain (hd claim) |
| Email and SMS (alerts, verification) | Built (SMTP via nodemailer; Twilio-compatible SMS). Fails closed: nothing sends until an admin enters settings in `/staff/messaging` (section 6a) | SMTP account or email provider, SMS account and sender, Spam Act consent wording (counsel) |
| Payments | Adapter stub; nothing can be marked paid, so nothing publishes | Westpac PayWay merchant account and docs |
| File storage and malware scan | Upload and download answer 503 | Storage provider, scanner, encryption at rest |
| ID verification | In-house photo ID + selfie review is built but off until storage, ClamAV, `ID_IMAGE_KEY` and `ID_RETENTION_CRON_SECRET` are all set (page says "not available yet", approval blocked) | Settings below; counsel sign-off; pen test |
| MLS / Zillow property data | Skeleton built (client, webhooks, tables, health). Nothing is fetched until the keys are set and a provider PR implements the sync | `MLS_API_KEY`, `MLS_API_BASE_URL`, `MLS_WEBHOOK_SECRET`, `ZILLOW_API_KEY`, `ZILLOW_API_BASE_URL`, `PROVIDER_CREDENTIAL_KEY` (docs/PROVIDER_KEYS.md) |
| FCM / APNs push | Keys read by `check:providers`; delivery-status webhook `/api/webhooks/push-status?provider=fcm\|apns` answers 503 until the secret is set | `FCM_*`, `APNS_*`, `PUSH_STATUS_WEBHOOK_SECRET` |
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

## File storage (S3)

Production file storage is `STORAGE_DRIVER=s3`: AWS S3 or any S3-compatible service (Wasabi, Backblaze B2, Cloudflare R2). It covers every upload: listing photos, inspection photos, ID images, signed documents and contract templates (keys `listings/`, `inspections/`, `id/`, `investments/`). Local disk is refused in production.

Settings (`.env.example`): `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` are all required, otherwise uploads answer 503. Optional: `S3_ENDPOINT` (https origin of a compatible service; blank = AWS), `S3_FORCE_PATH_STYLE`, `S3_SSE` (`AES256` default, or `aws:kms`), `S3_KMS_KEY_ID`, `S3_CONDITIONAL_PUT=0` (only if the service rejects `If-None-Match`). An `http://` endpoint is refused in production.

What the code does: every request is TLS and AWS Signature V4 signed; every write sends `x-amz-server-side-encryption` and fails if the service answers with a different mode; objects never overwrite (`If-None-Match: *`) and are stored with `Content-Disposition: attachment` and `Cache-Control: private, no-store`; only `id/` objects can be deleted. The app routes already serve bytes with the stored content type, `X-Content-Type-Options: nosniff` and a sandbox CSP after the access check. `signedUrl(key, { ttlSeconds, filename, contentType })` makes a link valid 1 to 3600 seconds (default 300) that forces `attachment`, for any route that wants to hand the browser a direct link after its own access check.

Bucket setup (once, by whoever owns the account):
1. Create a private bucket in the same region as the app. Turn on **Block all public access** (all four settings).
2. Enable **versioning**. For `id/` objects add a lifecycle rule that expires non-current versions after 1 day, otherwise a "deleted" ID image survives as an old version and breaks the retention promise.
3. Default encryption: SSE-S3 (`AES256`), or SSE-KMS with a customer key (`S3_SSE=aws:kms`, `S3_KMS_KEY_ID`). Add a bucket policy that denies `s3:PutObject` without encryption and denies any request with `aws:SecureTransport` false.
4. Create one IAM user (or API key) for the app with only `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on `arn:aws:s3:::BUCKET/*`. No list, no bucket-admin. With KMS, also `kms:GenerateDataKey` and `kms:Decrypt` on the key.
5. Optional IP restriction: add a bucket-policy `Deny` with `NotIpAddress` `aws:SourceIp` set to the app's egress addresses (signed links are then only usable from those addresses; skip this if browsers use signed links directly).
6. Backups: versioning is the first copy; add cross-region or cross-account replication for the second.

CDN (optional, recommended for listing photos only): put CloudFront or Cloudflare in front of the app's `/api/photos/...` routes, not the bucket. The bucket stays private. Those routes send `Cache-Control: private`, so configure the CDN to respect origin cache headers and never cache ID images, documents or contracts (their routes send `no-store`). Do not make the bucket a CDN origin without an Origin Access Control.

Check after deploy: upload a photo (200), confirm the object in the console shows the encryption setting, open a signed link (downloads, not displays), open it again after the expiry (403), and try the bucket URL without a signature (403).

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
`APP_URL`, `DATABASE_URL`, `TRUSTED_PROXY_HOPS`, `SESSION_SECRET` (32+ chars), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Google OAuth redirect URI: `${APP_URL}/api/auth/google/callback`. `PAYWAY_*` stay unset until the merchant account exists. No live payment keys until pen test and counsel sign-off.

## 4. Backups
- Daily full backup plus WAL archiving (point-in-time recovery); keep at least 30 days; encrypted; stored off the primary host.
- Test a restore monthly into a scratch database; `npm run migrate` against it should apply nothing.
- Audit, chat and ledger tables are never rewritten; do not "clean" them after a restore.
- Uploaded files (once storage exists) need their own versioned backup; the database holds only keys and SHA-256 hashes.
- Retention and deletion periods are pending counsel (docs/COUNSEL_QUESTIONS.md).

## 5. Smoke test after deploy
Home loads; Google sign-in works; `/plans` loads; an upload answers 503 (storage off, expected); checkout answers "not available yet" (expected); `/api/webhooks/payway` rejects unsigned posts.

## 6. Blocked on providers (stays off or fails closed)
| Area | Behaviour now | Needs |
|---|---|---|
| Staff sign-in linking | First-login linking by email match waits | Google Workspace domain (hd claim) |
| Email and SMS (alerts, verification) | Built (SMTP via nodemailer; Twilio-compatible SMS). Fails closed: nothing sends until an admin enters settings in `/staff/messaging` (section 6a) | SMTP account or email provider, SMS account and sender, Spam Act consent wording (counsel) |
| Payments | Adapter stub; nothing can be marked paid, so nothing publishes | Westpac PayWay merchant account and docs |
| File storage and malware scan | Upload and download answer 503 | Storage provider, scanner, encryption at rest |
| ID verification | Manual reviewer checklist only; image storage missing, approval blocked | DVS provider or image storage |
| ABN check | Adapter built, reads ABN_LOOKUP_GUID (unset = not confirmed, staff review) | ABN Lookup GUID |
| AI | Rules-only engine; features report off | Self-hosted model and OCR server |
| Legal text | Draft terms and contract template | Counsel review |

## 6a. Email and SMS settings (`/staff/messaging`)
1. Set `MESSAGING_SETTINGS_KEY` (`openssl rand -base64 32`) on the server. Without it the page shows "encryption key not configured" and saves nothing; secrets already saved cannot be decrypted, so DB-held SMS/email stay off. Keep the key out of the database and backups; losing it means the auth token and SMTP password must be entered again.
2. A super admin signs in and opens `/staff/messaging` (`staff.manage`; API `GET`/`PUT /api/staff/messaging`, `POST /api/staff/messaging/test`). SMS: provider `twilio`, account SID, auth token (or API key SID plus its secret as the token), sender (+61 number, sender ID or messaging service SID). Email: SMTP host, port (465 implicit TLS, otherwise STARTTLS is required), user and password (both or neither), from address. Secrets are write-only: the page shows only "set". Every change is in the audit log (field name, who, when; never the value).
3. Environment variables `SMS_*` and `SMTP_*` (see `.env.example`) override the saved value for that field; the page says when a field comes from the server. Settings are read at send time, so a change takes effect without a restart.
4. "Send test SMS/email to me": 5 per hour per admin; email goes to the admin's own account address; SMS to the number typed. Unconfigured = 409 and nothing sent.
5. Every send attempt (verification codes, alerts, tests) adds a row to `messaging_outbox` (insert-only: channel, template, keyed hash of the recipient, status `sent`/`failed`/`not_configured`, provider reference, error code; no body, address or number). The recipient hash is an HMAC under `SESSION_SECRET`. Add `messaging_outbox` and `messaging_setting` to the REVOKE TRUNCATE list in section 1 (the outbox has a trigger; TRUNCATE bypasses it).
6. No automatic retries inside the adapters (a timed-out request may still have been delivered); the alert outbox worker retries failed alerts. The SMS host is fixed (`api.twilio.com`, no redirects). The SMTP host is admin-entered, so it is guarded: a public DNS name only (no IP literals, `localhost`, `.internal`/`.local` names), ports 25, 465, 587 or 2525 only, and at send time every resolved address must be public (no private, loopback, link-local, metadata or reserved range); the connection goes to that resolved address with the certificate checked against the name. Also deny the app server egress to internal networks and the cloud metadata address at the network level (defence in depth). Test SMS goes only to Australian mobiles (+614...), 5 per hour per admin and 20 per hour overall.

## 7. End-to-end smoke script (scratch database only)
`scripts/smoke.mjs` drives the running app over HTTP (about 90 steps): terms, draft listing with price, publish gate, browse and search, saved items, buyer verification, enquiry and messages, offer-link request and issue, offer submit (single use), owner offers, offer analysis, contract draft preview, owner and staff reports, key pages, and the provider-off routes. It is not run by `npm test`.
```
npm run migrate && npm run build && npm run start      # in another shell, with the env from section 3
DATABASE_URL=... APP_URL=http://localhost:3004 SESSION_SECRET=<same as the server> node scripts/smoke.mjs
```
It seeds users, a law firm and trust account, and buyer verification straight into the database and signs session cookies the way `src/server/auth/session.ts` does, so use a throwaway database: the append-only tables cannot be cleaned. Exit code 1 on any unexpected status (500, 502, 504 always fail).
Blocked by design, so the script seeds the result in SQL: publishing needs compliance-approved disclosure config (`src/config/disclosures.ts` is empty, so the gate answers "no configuration" and fails closed), the listing fee paid (PayWay is a stub), and an approved trust account (normally two staff approvals). Also fail closed and expected: AI summary "unavailable", checkout refused, `/api/webhooks/payway` 503 while its secret is unset.

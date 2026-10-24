# Deployment

Stack: Next.js app, PostgreSQL. Env reference: `.env.example` (comments say which settings fail closed).

## 1. Database
1. Create a PostgreSQL database and two roles: an owner/migration role and a runtime app role.
2. Run migrations as the owner role: `DATABASE_URL=... npm run migrate`. It applies `db/*.sql` in filename order, once each, one transaction per file, and records them in `schema_migration`. Re-run after every deploy that adds a file; it stops at the first failure.
3. Runtime role: grant only the privileges the app needs (SELECT/INSERT, UPDATE where a table needs it). **Revoke TRUNCATE, UPDATE and DELETE** from the app role on the append-only tables, because row triggers do not block TRUNCATE (docs/security-review-2026-10.md, "Not fixed" item 2): `audit_event`, `enquiry_message`, `chat_message`, `override_log`, `trust_account_approval` and the ledgers from `db/20261024150000_append_only_ledgers.sql`. Simplest: `REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM <app_role>;` then check with `\dp`. The app must never connect as the owner role.

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
- ID images are encrypted with `ID_IMAGE_KEY`; back the key up separately (secrets manager). Restoring an ID image from backup after the retention job deleted it would break the retention promise: exclude `id/` from long-term file backups or keep backups no longer than 30 days.

## 4a. In-house ID photo review (holds sensitive personal information)
Do not turn this on for real users until counsel has approved the retention periods (7 days after approval, 30 after rejection), the privacy notice wording (`ID_IMAGE_CONSENT_TEXT`, versioned in `src/domain/id-image.ts`) and Privacy Act handling of ID images and selfies (biometric information is sensitive information), and a pen test has been done.
- Needs all of: `STORAGE_DRIVER` + `STORAGE_LOCAL_DIR` (encrypted volume, not web-served), `CLAMD_HOST` + `CLAMD_PORT`, `ID_IMAGE_KEY` (`openssl rand -base64 32`), `ID_RETENTION_CRON_SECRET` (32+ chars). Any one missing = off.
- Schedule daily: `curl -fsS -X POST -H "x-cron-secret: $ID_RETENTION_CRON_SECRET" $APP_URL/api/internal/id-images/retention`. Safe to repeat; answers `{counts:{deleted,failed}}`; investigate any `failed`.
- Never rotate `ID_IMAGE_KEY` while images are stored (they become unreadable); wait until the queue is empty and 30 days have passed.
- Images are viewable only by the reviewer holding the 30-minute claim, through `/api/staff/id-review/[id]/image/[part]` (no-store, every view in `id_review_access`).

## 5. Smoke test after deploy
Home loads; Google sign-in works; `/plans` loads; an upload answers 503 (storage off, expected); checkout answers "not available yet" (expected); `/api/webhooks/payway` rejects unsigned posts.

## 6. Blocked on providers (stays off or fails closed)
| Area | Behaviour now | Needs |
|---|---|---|
| Staff sign-in linking | First-login linking by email match waits | Google Workspace domain (hd claim) |
| Email and SMS (alerts, verification) | Delivery port fails closed, nothing sends | Provider, consent wording |
| Payments | Adapter stub; nothing can be marked paid, so nothing publishes | Westpac PayWay merchant account and docs |
| File storage and malware scan | Upload and download answer 503 | Storage provider, scanner, encryption at rest |
| ID verification | In-house photo ID + selfie review is built but off until storage, ClamAV, `ID_IMAGE_KEY` and `ID_RETENTION_CRON_SECRET` are all set (page says "not available yet", approval blocked) | Settings below; counsel sign-off; pen test |
| ABN check | Adapter built, no env wiring | ABN Lookup GUID |
| AI | Rules-only engine; features report off | Self-hosted model and OCR server |
| Legal text | Draft terms and contract template | Counsel review |

## 7. End-to-end smoke script (scratch database only)
`scripts/smoke.mjs` drives the running app over HTTP (about 90 steps): terms, draft listing with price, publish gate, browse and search, saved items, buyer verification, enquiry and messages, offer-link request and issue, offer submit (single use), owner offers, offer analysis, contract draft preview, owner and staff reports, key pages, and the provider-off routes. It is not run by `npm test`.
```
npm run migrate && npm run build && npm run start      # in another shell, with the env from section 3
DATABASE_URL=... APP_URL=http://localhost:3004 SESSION_SECRET=<same as the server> node scripts/smoke.mjs
```
It seeds users, a law firm and trust account, and buyer verification straight into the database and signs session cookies the way `src/server/auth/session.ts` does, so use a throwaway database: the append-only tables cannot be cleaned. Exit code 1 on any unexpected status (500, 502, 504 always fail).
Blocked by design, so the script seeds the result in SQL: publishing needs compliance-approved disclosure config (`src/config/disclosures.ts` is empty, so the gate answers "no configuration" and fails closed), the listing fee paid (PayWay is a stub), and an approved trust account (normally two staff approvals). Also fail closed and expected: AI summary "unavailable", checkout refused, `/api/webhooks/payway` 503 while its secret is unset.

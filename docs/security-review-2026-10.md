# Security review, October 2026 (PRs #51 to #56)

Scope: offer screens, documents UI and download route, plans/checkout/PayWay webhook, staff admin, enquiries chat, buyer verification page, safe-next redirect, nav.
Fixes are in the PR "Security review fixes for PRs #51-#56". This file lists what was fixed (short) and what was NOT fixed and why.

## Fixed in this PR

| Severity | Finding | Fix |
|---|---|---|
| High | Billing writes were multi-step and non-atomic (`replaceInvoices`, `settle`, `flagMismatch`, `addPrice` + audit). A crash left an invoice failed with no replacement, or a payment half applied. | `Queryable.transaction` added (real pool only); the four writes now run in one transaction. |
| High | Webhook replay: `eventSeen` then `settle` was check-then-act, so two concurrent copies of one event both ran (duplicate audit rows). `settle` also set `listing_fee_paid` even when the invoice had meanwhile stopped being pending. | `payment_event` insert (primary key) is now the first step inside the transaction; a duplicate does nothing. The listing fee is only set when the pending invoice was really updated; otherwise an admin case is opened. |
| Medium | `plan_price`, `add_on_price`, `payment_event`, `document_deletion_request` are documented as insert-only but had no database guard. | New migration `20261024150000_append_only_ledgers.sql` (row triggers reject UPDATE/DELETE). |
| Low | A malformed listing id (`/api/listings/<not-a-uuid>/...`, checkout) reached PostgreSQL and produced a 500 (cast error) instead of the 404 used everywhere else. | `createPgListingRepository.get` and `listingOwner` treat a non-UUID as not found without querying. |
| Low | Document downloads had `attachment` + `nosniff` but no CSP. | Added `content-security-policy: default-src 'none'; sandbox`. |
| Low | Webhook buffered an arbitrarily large body before the size check. | Content-Length over 64 KB is refused before reading (handler still checks real size). |

## Not fixed (needs a decision or is out of minimal-patch scope)

1. **Medium: no per-user rate limit or quota on document upload.** The route buffers up to 100 MB in memory per request; any owner or approved contractor can repeat it. Needs a per-user counter (reuse `countHitPg`, fail closed) and a storage quota; product to set numbers. **Update:** the `deletion-request` half is now fixed: 5 requests per user per 10 minutes and at most 20 open (non-`delete_now`) requests per user, enforced in the same SQL statement as the insert, failing closed (429 over a limit, 503 on a store error). Upload limits were added earlier; the storage quota numbers still need a product decision.
2. **Low: TRUNCATE is not blocked by the row triggers** on `audit_event`, `enquiry_message`, `chat_message`, `override_log`, `trust_account_approval` and the new ledgers. Revoke TRUNCATE/UPDATE/DELETE from the application database role in deployment (ops task, not a migration the app can safely assume).
3. **Low: `property_document` has no DELETE guard**, although the rule is "published files are never deletable". No code path deletes. Adding a trigger depends on whether the pre-publish `delete_now` outcome will ever really delete; decide first.
4. **Low: a concurrent double checkout** now rolls back cleanly, but the loser hits `invoice_one_live_per_listing` and answers 500 instead of returning the winner's invoice. No money or data risk.
5. **Low (product): a `failed` payment event permanently fails the invoice**, so a later successful retry on the same invoice is flagged to admin instead of paid. Safe (fails closed) but may annoy owners; checkout then creates a new invoice.
6. **Low: trust account approval has a small read-then-write gap** between `planTrustDecision` and the write (two simultaneous first approvals both succeed; the unique key `(check_id, staff_user_id)` stops one person counting twice, and a final approval still needs two different people). Closing it needs the plan inside one statement or `SELECT ... FOR UPDATE`.
7. **Info: webhook has no timestamp tolerance.** Replay protection is the unique event id plus idempotent handling, which is sufficient; add a timestamp if PayWay signs one. Single shared secret, no rotation support.
8. **Info: `GET /api/enquiries/[id]/messages` marks the thread read.** Affects only the caller's own read marker; no CSRF impact.
9. **Info: auto-reply settings accept `agent` accounts** (only `buyer` is refused). They only touch the caller's own settings and own listings.
10. **Info: IP rate-limit bucket** falls back to one shared `unknown` bucket if `TRUSTED_PROXY_HOPS` is wrong. That can only block offers (denial), never bypass the limit.

## Checked and found sound

- Every state-changing route calls `csrfGuard` (or `staffGate`, which calls it) first; the webhook is HMAC-authenticated and correctly exempt. Every `getActor`/`getStaff` call is awaited.
- Staff role is read from the database per request; the staff cookie is domain-separated from user sessions; staff cannot review their own ID check; safety-gate case resolution needs a second, different, authorised person.
- Document download: all denials answer 404 (no existence leak), storage is touched only after the access check, non-public downloads are audited, content type is the sniffed type, `attachment`, `nosniff`, `private, no-store`.
- Offers: owner checks are inside the SQL; non-owners get 404; the link is single-use, bound to one buyer and re-checked for eligibility at submit time; limits fail closed (429/503).
- Enquiries: non-participants get the same 404 as a missing thread; messages are insert-only with a DB trigger; per-buyer limits fail closed.
- Webhook signature: hex HMAC-SHA256 of the raw body, `timingSafeEqual`, strict 64-hex format check, rejected while the secret is unset.
- SQL: all `src/server/*-db.ts` statements are constant text with bound parameters; the only interpolated pieces are constant fragments.
- Open redirect: `safeNext` allows only `/` plus a short character allowlist (no `//`, `\`, `:`, `%`); the callback re-validates the cookie value and prefixes the configured app URL. The checkout redirect only follows `https://` URLs returned by the provider adapter.
- No secrets, tokens or personal data in logs (the one `console.error` logs a storage key only).

## Independent review of PR #69 (appointed agents, deletion-request limits, price gate)

Result: no Critical or High findings. Appointed-agent access fails closed (revoked, other listing or agent, unverified or expired licence on the state-local date, other state, lookup error, missing dependency, unknown time zone all answer 404 via `isAppointedAgent`). Offer decisions (`offer.approve`, owner check in the route), contract drafts and auto-reply drafts stay owner-only (tests cover the 403/404 paths). Enquiry/thread ids give the same 404 to non-parties. The buyer is re-checked against the listing's owner, not the acting agent. Audit events carry the real actor id, and offer-link events also carry `byAppointedAgent`. All new SQL is parameterised.

| Severity | Finding | Status |
|---|---|---|
| Medium | The deletion-request guard was one statement, but under READ COMMITTED two concurrent requests from one user both read the old count and both insert, so a burst could exceed the limits. | Fixed: `recordDeletionRequest` takes `pg_advisory_xact_lock` on the requester inside a transaction before the guard statement (single statement if the pool offers no transaction). Test: `tests/deletion-request-lock.test.ts`. |
| Low (product) | The "open" cap counts every non-`delete_now` request ever made (insert-only ledger, no resolved flag), so after 20 a user is blocked permanently. Safe, but needs a review/resolution record to be a real "open" count. | Not fixed. |
| Low | Appointed agents are not checked against listing status: they can read threads and offers on draft, withdrawn or sold listings (the owner can too). Issuing links still needs `published`. | Not fixed; acceptable. |
| Low | Offer GET and offer-analysis routes do not require current terms for the agent (the issue route does). Read-only. | Not fixed. |
| Info | The licence lookup loads all verified licences per check (constant query). Could filter by user id later. | Not fixed. |
# Security review addendum, October 2026 (PR #68 and PRs #59, #63, #64, #65, #66)

Scope: PR #68 (mobile-number SMS verification, provider ID-check and its webhook) and code merged since the last review: #59 offer-link encryption, #63 alert fields, #64 terms gate and upload limits, #65 reports/CSV and trust runner, #66 publish alerts and saved listings. Fixes are on the #68 branch.

## Fixed in PR #68

| Severity | Finding | Fix |
|---|---|---|
| High | One mobile number could verify any number of accounts (only 3 sends per number per hour). Phone verification is the sybil/abuse barrier for contacting sellers. | Partial unique index on `buyer_verification(phone_e164)` for verified rows; `markVerified` refuses (one statement) when another account holds the number. The answer is generic (no "taken by another account"), so only someone who controls the number can learn anything. |
| Medium | Unknown-reference webhook burned the event id: the `id_check_log` row was inserted (and committed) before the session lookup. A result that arrived just before `recordSession`, or a provider retry after our 404, was then answered "duplicate" and the result was lost for good. | The session is looked up first; an unknown reference now changes and logs nothing, so the retry applies normally. |
| Medium | Personal data recoverable from stored hashes: rate-limit buckets and `phone_attempt_log.ip_hash` were plain SHA-256 of the mobile number or IP (about 10^8 or 4x10^9 candidates, trivially enumerated). | Both are now HMAC-SHA-256 under `SMS_CODE_SECRET`. Note: rotating the secret resets the counters. |
| Medium | In-thread offer link route (`POST /api/enquiries/[id]/offer-link`, #59) had no terms gate although #64 says offer links need current terms. | `requireCurrentTerms` for `request` and `issue` (fails closed); test added. |
| Low | ID webhook accepted any non-empty secret. | Needs the same 32-character minimum as the SMS secret; shorter is treated as unset (503). |
| Low | `.env.example` still said `OFFER_LINK_TOKEN_KEY` is not present in the code. | Stale comment removed (the key is listed above and read in `enquiry-db.ts`). |

## Not fixed

1. **Low: two sends can leave two live codes** (`createCode` is two statements). Guesses always go to the newest, per-user and per-IP limits still apply, so no bypass. Wrap in one statement or transaction later.
2. **Low: consent is recorded per send but is not tied to the number** that was texted. Add `phone_e164` (or its keyed hash) to `phone_sms_consent` when counsel confirms what the record must show.
3. **Low: `consume` then `markVerified` are separate statements**; a crash between them costs the buyer one code (no security impact).
4. **Low: expired offer-link ciphertext stays in `offer_link_request` until someone reads that thread or the link is used** (wipe is lazy). Add a periodic wipe job.
5. **Low: legacy `POST /api/listings/[id]/offer-links` returns the raw token to the owner**, unlike the in-thread flow where the owner never sees it. The link is bound to one buyer so the owner cannot use it, but consider retiring the legacy route.
6. **Low: trust runner stores `automationError` (a raw exception message) in evidence and the admin case text.** Staff-only, but provider errors can contain URLs or request details; store a fixed code instead.
7. **Low: publish alerts load up to 5000 saved searches inside the publish request** (timeout-bounded, best effort). Move to a queue before alert volume grows. The send-then-log order can double send after a crash between the two.
8. **Low: saved-listing 200 cap is check-then-insert**; a burst of parallel requests can exceed it by a few rows. No other impact.
9. **Low: upload byte quota counts the declared Content-Length and is check-then-act**; parallel uploads can slightly exceed the daily quota.
10. **Info: `/api/staff/reports` needs `report.sales`**, so `technical` and `compliance` staff (who hold `report.operations`/`report.audit`) are refused entirely. Safe; change the gate if they should see their sections.
11. **Info: ID webhook has no timestamp tolerance** (same as the payment webhook): replay protection is the unique event id plus first-result-wins. Single shared secret.

## Checked and found sound

- Code hashing: 6-digit code from `randomInt`, HMAC-SHA-256 keyed by `SMS_CODE_SECRET` and bound to user id and code row id; `timingSafeEqual` on strict 64-hex; plaintext never stored or logged. Fails closed (503) when the SMS port is unconfigured or the secret is missing or under 32 characters.
- Brute force: 5 guesses per code enforced inside one atomic UPDATE; 10 per user and 30 per IP per 10 minutes on top (refused attempts still count); 5 sends per user, 10 per IP, 3 per number per hour. A counter error counts as over the limit.
- Consent (Spam Act) is recorded, insert-only, after the rate limits and before the SMS; no consent, no SMS.
- No enumeration on send: the response never depends on whether the number belongs to another account. A wrong code and "no live code" give the same answer.
- Webhook: raw-body HMAC with `timingSafeEqual`, 413 before reading, 401 before parsing, strict payload checks, unique event id, first result wins, a failed check can never be overridden by a later pass; no ID images or document numbers anywhere (tests assert it).
- Every new state-changing route calls `csrfGuard` first and awaits `getActor`; all are buyer-only; no id in the path, so no IDOR. SQL is constant text with bound parameters; migration triggers make consent and both logs append-only.
- No phone number, code, IP or provider payload is logged (`console` is not used in the new code).
- #59: AES-256-GCM, random 12-byte IV, AAD bound to the request row, key must be exactly 32 bytes of base64 or sealing and opening throw (nothing stored or shown); the token is shown only to the verified buyer, with `no-store`, and wiped on use. #65: CSV cells starting `= + - @ tab CR` are prefixed with an apostrophe (owner listing titles included); owner reports are scoped by `owner_user_id` in SQL and the per-listing report answers 404 to non-owners; staff report sections follow role permissions, exports are audited, no personal data or account numbers are selected. #66: saved listings are scoped to the session buyer and published listings only; unique index on (saved search, listing) stops repeat alerts.

# Security review addendum, October 2026 (PR #79, staff invites)

Scope: staff sign-in through the admin-managed `staff_invite` allowlist, `STAFF_BOOTSTRAP_ADMIN_EMAILS`, the invite/revoke/set_role routes and the migration that drops `app_user.staff_role`. Fixes are on the #79 branch.

## Fixed in PR #79

| Severity | Finding | Fix |
|---|---|---|
| High | Bootstrap race: the "insert a super_admin only if none exists" statement ran on its own, so under READ COMMITTED two bootstrap sign-ins (two listed emails, or an env list left set) could both see no admin and both insert, giving several super_admins. | Runs in one transaction under the same advisory lock as `changeInvite`. Now audited as `staff.bootstrap_admin_created` (no email). Test with four concurrent sign-ins. |
| Medium | `upsertGoogleUser` (owner/buyer sign-in) did `ON CONFLICT (google_sub) DO UPDATE SET email`, which also rewrote the email of a staff (admin) account. The email is now the key to the role, so a Google email change would silently move or drop a staff role. | The update applies to owner, agent and buyer accounts only. Admin (and vendor) emails are never rewritten. |
| Medium | A staff cookie (4 h) outlived a revoke and came back to life if the same address was invited again (for example a reassigned mailbox): the old holder regained access without signing in, while the new holder is refused (account bound to the first Google subject). | `staffFromRequest` requires `accepted_at IS NOT NULL`. A fresh invite is pending until its holder signs in; a role change copies `accepted_at`, so live sessions survive a role change. |
| Low | `changeInvite` trusted the actor from the gate. A super_admin revoked a moment earlier could still finish a revoke/set_role already past the gate. | The actor's active, signed-in invite and role are re-read under the lock; otherwise 403. |

## Not fixed

1. **Low: a mailbox that is reassigned to a new person cannot sign in** if the old holder had signed in (the account is bound to the old Google subject, correctly refused). Recovery is by hand in the database. Add an admin "reset Google link" action (audited) when needed.
2. **Low: the last-admin count includes pending (never signed-in) super_admin invites.** Not a lockout today, because the acting admin is always an active admin and cannot change themselves, but a mistyped super_admin invite counts as an admin.
3. **Low: every denied staff sign-in writes an audit row for anyone who can start the staff flow** (no rate limit). Add a per-IP limit or sample the rows.
4. **Low: a bootstrap-listed email does one extra write, so its timing differs from an unlisted one.** Needs an attacker holding a verified Google account for the address, so it reveals nothing they do not already hold.
5. **Info: migration is lossy and not reversible.** It copies only active admin accounts with a well-formed email; suspended staff roles and the `staff_role` column are dropped. Take a backup before applying. Safer later: ship the copy in one release and drop the column in the next (a rolling deploy with old code still reading `staff_role` fails at the drop). Re-running is guarded by `schema_migration` (the file itself is not idempotent).
6. **Info: a never-signed-in invite is exposed to whoever first controls that address at Google** (any Google account is allowed by design). Invite only addresses the person already uses; revoke unused invites.

## Checked and found sound

- Email match: trimmed, lower-cased, ASCII only, single `@`, at most 254 characters; look-alike Unicode, inner whitespace and control characters never match. Plus and dot variants, other domains and Workspace aliases do not match (exact compare; Google reports the primary address), so they fail closed. Bootstrap list drops empty, blank and invalid entries; no env entry means no bootstrap.
- Takeover: an existing owner, buyer or vendor account with the invited email is never converted or linked (denied as `account_conflict`); an admin account linked to a different Google subject is denied; linking a pre-provisioned admin is a single `UPDATE ... WHERE google_sub IS NULL`. Suspended admins are denied at sign-in and on every request. `email_verified=true` is required in `readIdentity`.
- set_role/revoke/invite need `staff.manage` (super_admin only) through `staffGate`, which runs `csrfGuard` first and awaits the lookup; no self change; the last super_admin is protected by an advisory lock in one real transaction (the production pool provides `transaction`); concurrent mutual revokes leave one admin (test).
- Role is read from the active invite on each request; revoking takes effect at once. The staff cookie uses a domain-separated HMAC and carries no role; user and staff tokens do not verify as each other.
- Every denial returns the same generic failed login; audit rows carry reason codes, ids and roles but no emails or names. All SQL is constant text with bound parameters.
- `staff_invite` triggers: no delete, email/role/inviter/created_at immutable, `accepted_at` and revoke set once. CHECK constraints refuse non-normalised emails. Unique partial index allows one active invite per email.
## PR #78 review: APP_MODE split, ADMIN_APP_URL, brand, Vercel docs

### Fixed in this review

| Severity | Finding | Fix |
|---|---|---|
| High | **Proxy allow-list compared the raw path.** `NextURL.pathname` keeps percent-encoding and repeated slashes (`/%73taff`, `/api/%73taff/me`, `//staff`, `/%2573taff`, `/api//staff/me`) while the router decodes them, so these could reach `/staff` and `/api/staff` on a public deployment (and public routes on admin). Also `/Staff`, `;params`, backslashes, `..` after decoding. Staff sign-in checks (`/api/auth/google/start/?as=staff`) had the same hole. | `normalizePath` decodes (up to 3 rounds), collapses slashes, drops `;params`, resolves dot segments, lower-cases; an undecodable path or one with NUL/leftover `%` is refused. `isAllowed` works on that. Tests cover every variant above. |
| Medium | **Matcher skipped `/_next/static` and `/_next/image` by prefix**, so `/_next/static/..%2fstaff` was never seen by the proxy; and `isAllowed` exempted all of `/_next/` (including `/_next/data`, `/_next/webpack-hmr`). | Matcher is now `/:path*`; only `/_next/static/`, `/_next/image`, `favicon.ico`, `robots.txt` are exempt, checked after normalisation. |
| Low | Proxy read `ol_role` with `req.cookies`, the route with `readCookie` (a different parser); with duplicate cookies they could disagree. | Proxy uses `readCookie`. |
| Low | `staffFromRequest` honoured a valid staff cookie on any deployment (only the proxy blocked it). | Returns null when `APP_MODE` resolves to `public` (defence in depth). |
| Low | `.env.example` shipped `APP_MODE=all`; copying it to production would expose staff routes publicly. | Now `APP_MODE=` (unset: `all` in development, `public` in production). |
| Info | Deploy doc did not say the alert scheduler must call the public host. | Added (admin answers 404 to webhooks and cron). |

### Checked and found sound

- Fail closed: unset in production, blank, typos (`Admn`, `publc`, `true`) all resolve to `public`; `all` only when set explicitly or in non-production.
- 404 (not 403) in the wrong mode for staff pages, `/api/staff/*`, staff sign-in and callback (public), and every buyer/owner/listing/webhook/internal/auth-me route (admin). All HTTP methods pass through the proxy (HEAD, OPTIONS included).
- `csrfGuard` trusts only `ADMIN_APP_URL` in admin and only `APP_URL` otherwise; missing or invalid value gives 403. Google redirect URI and `secure` cookies come from the same per-mode URL; admin without `ADMIN_APP_URL` has sign-in off.
- Cookies are host-only (no `Domain`; test scans `app/` and `src/`), and the two projects use different `SESSION_SECRET`s per the docs, so a cookie from one host does not verify on the other.
- Split of shared routes: public keeps `/api/auth/me`, logout, webhooks (`payway`, `id-check`) and `/api/internal/alerts/run` (secret-gated), so provider callbacks and the scheduler work; admin has only staff, staff sign-in, logout, health. `/api/auth/me` returns only id and type of the caller's own session; the staff cookie is a separate cookie that routes outside `/api/staff` do not read.
- `/api/health` returns `{ok:true}` with no database call.
- Brand: values are trimmed, cut to 60 characters and rendered only as React text children and Next metadata (escaped); no `dangerouslySetInnerHTML`. `NEXT_PUBLIC_*` is public by design and the docs say so.
- Docs recommend no unsafe settings (no live payment keys, separate secrets, no cookie domain).

### Not fixed

1. **Info: `/_next/data/...` URLs** are rewritten by `NextURL` to the underlying page path, so they are judged like the page itself (correct today, and the App Router does not use them).
2. **Low: a new route is allowed in public by default** (deny-list for staff). A future staff-only route must live under `/staff` or `/api/staff`; consider a test that fails if a route file name contains "staff" elsewhere.
3. **Low: admin `/` redirect and `failed()` redirect use `req.url`/`appUrl`**; behind Vercel these are the real host, but check if a custom proxy rewrites Host.
# Security review addendum, October 2026 (PR #77: messaging settings, SMTP and SMS adapters, outbox)

Independent review of `feat/messaging-settings`. Fixes are on the same branch.

## Fixed in PR #77

| Severity | Finding | Fix |
|---|---|---|
| High | SSRF through the admin-entered SMTP host: any host (`localhost`, `169.254.169.254`, `10.x`, decimal IPs such as `2130706433`) and any port 1-65535 was accepted, and nodemailer resolved the name itself. A compromised or malicious super admin could probe the internal network and metadata service, and the "Send test" button would return distinguishable results. | `src/domain/net-guard.ts`. Save time: public DNS names only (no IP literals, numeric last label, `localhost`, `.internal`/`.local`/`.lan` and similar); ports 25, 465, 587, 2525 only; the same rules apply to values already stored or set in the environment (invalid = email off). Send time: the host is resolved once, every answer must be public (loopback, private, CGNAT, link-local incl. metadata, documentation, multicast, reserved, IPv4-mapped, NAT64, 6to4, Teredo, ULA all refused), and the connection goes to that address with `tls.servername` set to the name and certificate verification on, so DNS rebinding between check and connect is closed. Outbox code `blocked_host`. |
| High | nodemailer 8.0.11 (the pinned range `^8.0.11`) has 12 published advisories (`npm` bulk advisory API): addressparser DoS (high, fixed <=10.0.5), file read / SSRF through `raw` (high, <=9.0.0), recipient-domain parsing bypasses (<10.1.4), process-global DNS cache reusing TLS `servername` across transports, i.e. cross-tenant credential disclosure (<10.0.2). Several are mitigated by our strict single-recipient regex, but not all. | Bumped to `^10.2.1` (latest, no advisories at review time); `@types/nodemailer` dropped (v10 ships its own types). Typecheck and tests pass on 10.2.1. `package-lock.json` is not committed here: regenerate it with `npm install`. |
| Medium | Test SMS could be sent to any E.164 number worldwide (5 per hour per admin), so a hijacked admin session could pump premium-rate or international numbers. | Test SMS accepts only Australian mobiles (`+614XXXXXXXX`), the only numbers the platform texts, plus an overall cap of 20 per hour across all staff. Both counters fail closed (a counter error or missing row refuses). |
| Low | `messaging_outbox` was insert-only through row triggers, which TRUNCATE bypasses. | `BEFORE TRUNCATE` statement trigger added to the (unreleased) migration, and the table named in the REVOKE TRUNCATE list in `docs/DEPLOYMENT.md` section 1 (with `messaging_setting`, TRUNCATE only). |
| Low | Email address regex allowed control characters other than CR/LF/space in the local part. | Control characters excluded. |

## Not fixed

1. **Low: one key, no version or rotation.** `MESSAGING_SETTINGS_KEY` has no key id; rotating it makes saved secrets unreadable until re-entered (documented). Do not reuse `OFFER_LINK_TOKEN_KEY` (not enforced).
2. **Low: AAD binds the field name only**, not a row version, so a database writer could swap an older sealed value into the same field. A database writer can also just overwrite it, so no new capability.
3. **Low: the outbox write is best-effort** (a failed insert is swallowed so a sent message is not re-sent). A database outage can therefore lose an outbox row. Acceptable; the send itself is the risk being avoided.
4. **Low: the shared "msg-test:all" bucket lets one admin exhaust test sends for others for an hour.** Test sends only.
5. **Info: network egress.** Application-level SSRF guards are in place; also deny egress from the app to internal ranges and the metadata address at the network level.
6. **Info: the test-send audit row is written after the send, outside any transaction**; a crash between them loses the audit row for that test message (the outbox row, written first, still shows it).

## Checked and found sound

- Secrets: SMS auth token and SMTP password are write-only. They are sealed before the transaction, never selected into a response (GET returns set/not set; display values only for non-secret fields, masked for ids, numbers, addresses), never in the audit payload (field name, role, set/cleared), never in error output (adapters map to a fixed code vocabulary; SMTP/Twilio error text is discarded; `SmsSendError` carries a code only), and not logged (no `console`, `logger: false`, `debug: false`). The outbox stores template, status, provider reference and fixed code only; recipient is HMAC-SHA-256 under `SESSION_SECRET` (32+ characters, else null, never a plain hash).
- AES-256-GCM: reuses the reviewed offer-link primitive: random 12-byte IV per seal, tag verified, AAD `messaging-setting:<field>` so a value cannot be moved to another field, key strictly 32 bytes of base64 (checked before any write; the PUT returns 503 and saves nothing without it, and stored secrets stop resolving when the key is missing or wrong, so the channel fails closed). Tampered or wrong-field ciphertext opens to `undefined`.
- Routes: all three call `staffGate` first (csrfGuard, awaited `getStaff`, `staff.manage` from the role read from the database); owners and buyers have no staff session (401). Unknown settings are rejected, values validated server-side, responses `no-store`.
- Header injection: recipient must match a strict address pattern (no whitespace, quotes, commas, angle brackets), `from` is validated the same way at save time, subject rejects CR/LF and is length-capped, plain text only, `disableFileAccess`/`disableUrlAccess` on, no attachments or `raw`.
- SMTP TLS: TLS 1.2 minimum, certificate verification on, implicit TLS on 465, STARTTLS required otherwise (no clear-text credentials), 10 s timeouts, no automatic retry.
- Twilio: fixed host `api.twilio.com`, HTTPS, `redirect: "error"`, 10 s timeout, SID URL-encoded, form-encoded body, E.164 check before any request, credentials sent only to that host.
- SQL: all parameterised or constant. Migration: field whitelist and secret-must-be-encrypted CHECKs, `template` and `error_code` CHECKs keep free text out of the outbox, update/delete triggers.
- Atomicity: setting upserts and their audit rows share one transaction (test forces the audit insert to fail and checks nothing is saved).

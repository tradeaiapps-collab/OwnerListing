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

## Independent review of PR #80 (in-house photo ID + selfie images)

### Fixed in PR #80

| Severity | Finding | Fix |
|---|---|---|
| High | JPEG stripping copied everything from the first SOS to the end of the file. Data after EOI survived: Pixel/Samsung motion-photo MP4 (a video of the person, with its own location atoms), MPF second images, appended ZIP/PDF/HTML polyglots. COM/APPn segments between scans of a progressive JPEG survived too; only the strings `Exif\0\0` and the XMP namespace were caught. | `cleanJpeg` now walks the entropy-coded data and every later segment, keeps image-structure markers only (SOFn, DHT, DAC, DQT, DRI, DNL, SOS; JFIF, ICC, Adobe) and stops at EOI; a file without EOI is refused. JPGn (0xF0-0xFD) segments are dropped too. Tests added. |
| Medium | WebP kept every chunk except `EXIF`/`XMP `, so any unknown chunk (arbitrary data) survived. | Allow-list: `VP8X`, `VP8 `, `VP8L`, `ALPH`, `ICCP`. Test added. |
| Medium | Approval without seeing every image: the "view" audit row is written before storage is read (correct), but `viewedParts` counted it even when the read failed or the image failed its integrity check, so a reviewer could approve having seen nothing. | A second row `shown:<part>` is written after decryption and the hash check, just before the bytes are sent (the image is refused if it cannot be written); `approvalBlocker` counts only `shown:` rows. Test added. |
| Medium | Claim checked only before the save: `approvalBlocker` and `saveIdReview` were separate, and `saveIdReview` did not look at the claim. A reviewer whose claim expired (and was taken by another reviewer) between the two could still approve; any reviewer could reject or "needs more" a check that another reviewer held. | `saveIdReview` re-checks in the same UPDATE: an approval needs the reviewer's live claim (DB clock); any other decision is refused while someone else holds a live claim. Postgres test added. |
| Low | Decompression bomb aimed at the reviewer's browser: a few hundred bytes could declare a 100000 x 100000 canvas (server never decodes, the staff browser would). | PNG IHDR (must be first, 13 bytes), JPEG SOFn and WebP VP8X canvas capped at 16384 px a side and 120 MP. Test added. |

### Not fixed

1. **Medium: pending submissions never expire.** Retention only runs after a decision, so images of a check nobody reviews stay indefinitely (and the buyer cannot resubmit while it is pending). Needs a product/counsel decision (for example auto-"needs more" after N days, which then starts the 30-day clock) and a queue SLA alert.
2. **Low: orphaned encrypted objects.** If storage removal fails after a failed insert (errors are swallowed), or the process dies between `put` and the insert, the object has no row and retention can never find it. Encrypted and unlinkable to a person, but it should be swept: add a storage lifecycle rule (or sweep job) for `id/` objects older than the longest possible retention.
3. **Low: no key rotation story.** The sealed format has a version byte but no key id; changing `ID_IMAGE_KEY` makes every live image fail its integrity check (fails closed, nothing leaks). Rotate only after the queue is drained and retention has run, or add a key id plus `ID_IMAGE_KEY_PREVIOUS` for decrypt.
4. **Low: free-text decision reasons go into the staff audit log** and could contain a document number typed by a reviewer. Add guidance in the review screen, or a pattern check that refuses long digit runs.
5. **Info: "live selfie" is client-asserted** (`selfieSource=camera`); the server cannot prove the photo was taken live. Reviewers must still judge it.
6. **Info: Australian documents need one approval** (`requiredApprovals` is 1 for AU, and only AU is accepted here), so the two-person rule never applies to this flow. A staff member's own *separate* buyer account is not detectable as "own identity".
7. **Info: ICC profiles (JPEG APP2, PNG iCCP, WebP ICCP) are kept** for colour accuracy; they can carry free-text description/copyright tags but not location data.

### Checked and found sound

- AES-256-GCM: random 12-byte IV per image, AAD binds submission id, part and storage key (a swapped or copied blob fails), key must be exactly 32 bytes of base64 or every operation throws; HMAC sub-key derived separately for rate-limit buckets and IP hashes. Plaintext zeroed after streaming.
- Fails closed: nothing collected, shown or approved unless storage (with delete), scanner, key and a 32+ character retention secret are all configured; availability is derived from config and enforced server side. Scanner errors and any verdict other than "clean" refuse the upload before anything is stored.
- Body: CSRF, buyer-only, multipart only; rate limits (per user and per IP, refused attempts count, counter errors fail closed) and buyer-state checks run before the body is read; missing or non-numeric Content-Length (chunked) is refused before reading; per-file 10 MB after.
- Type from bytes only (declared type and filename ignored); HEIC/PDF/other refused; PNG keeps image chunks only and drops data after IEND; WebP drops data after the RIFF size.
- IDOR: submission ids must be UUIDs, `part` is matched against a fixed list, storage keys are server-generated random hex and the storage adapter refuses any other shape and deletes `id/` keys only. Only the live claim holder can view; everyone else gets the same 404. The buyer route returns status only, never images, keys or hashes.
- Claim: atomic UPDATE refuses own check, a reviewer who already approved, and a live claim by someone else; re-claiming resets the view window.
- Audit: view row before any storage read (a failed write refuses the view); event log and consent are insert-only (triggers); no image data, key, hash, IP or document number is logged.
- Image response: fixed `content-type` from the CHECK-constrained column, `no-store`, `nosniff`, `default-src 'none'; sandbox`, `inline`, `no-referrer`, CORP same-origin.
- Retention: secret compared with `timingSafeEqual` over SHA-256 digests; idempotent (ENOENT counts as deleted, `markDeleted` is conditional); a partial failure leaves the row unmarked so the next run retries; keys and hashes cleared with a CHECK that none remain; the decision row is kept.
- Consent with the current wording version is required before processing and recorded before anything is stored. All SQL is constant text with bound parameters.

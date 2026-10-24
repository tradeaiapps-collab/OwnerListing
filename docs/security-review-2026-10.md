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

1. **Medium: no per-user rate limit or quota on document upload.** The route buffers up to 100 MB in memory per request; any owner or approved contractor can repeat it. Needs a per-user counter (reuse `countHitPg`, fail closed) and a storage quota; product to set numbers. Same for `deletion-request` inserts (append-only table can be spammed by its owner).
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

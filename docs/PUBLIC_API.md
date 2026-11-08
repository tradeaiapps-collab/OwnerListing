# Public API (keys, OAuth tokens, webhooks, OpenAPI)

Built 5 Nov 2026. Spec: `GET /api/v1/openapi` (OpenAPI 3.1, built in `src/domain/openapi.ts`; `tests/public-api.test.ts` checks it against the route files). Dashboard: `/settings/developer`. Builds on [API_STANDARDS.md](API_STANDARDS.md) (versions, error shape, Idempotency-Key).

## Auth
- Owners and agents create keys (`olk_<id>.<secret>`) on `/settings/developer` (session only; a key cannot mint keys). The secret is shown once; only SHA-256 is stored. Max 10 active keys. Revoking takes effect on the next call, including tokens already issued.
- Scopes: `listings.read`, `offers.read`, `webhooks.manage`. A key sends `Authorization: Bearer <key>`.
- OAuth 2.0 client credentials: `POST /api/v1/oauth/token` (form body: grant_type, client_id=`olk_<id>`, client_secret, optional scope) returns a one-hour `olt_` token that can only narrow the key's scopes. Signed with `API_TOKEN_SECRET` (falls back to `SESSION_SECRET`).
- 120 calls per 60 s per key (429 + Retry-After). Every authenticated call is logged by route template and status (`api_request_log`), never bodies.

## Webhooks
- Events: `listing.published`, `offer.submitted`, `message.created`, `appointment.created`. Recorded by Postgres triggers (`api_event`), so every code path emits them. Payloads are ids and statuses only (no message text, offer terms or contact details). Only the listing owner's endpoints receive them.
- Endpoints: https only, public host, port 443, max 5 per user. Delivery resolves DNS once, refuses non-public addresses, connects to that address, follows no redirects.
- Header `OL-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` with the `whsec_` secret (shown once). 8 s timeout. Retries after 1 min, 5 min, 30 min, 2 h (5 attempts), same event id. An endpoint is disabled after 10 consecutive failed deliveries.
- Worker: `POST /api/internal/webhooks/run` with header `x-cron-secret` = `ALERT_CRON_SECRET`, from the same scheduler as the alert outbox (every minute).

## Elena for developers
`POST /api/v1/developer/assistant` answers from the OpenAPI document; `GET /api/v1/developer/usage` gives 7-day counts and suggestions (use webhooks instead of polling, back off on 429, fix scopes, failing endpoints). Rule based and self-hosted; she sees route templates and status counts only.

## Not done
Mobile app, MLS/Zillow/CRM connectors, per-key IP allowlists, webhook delivery log in the UI, key rotation endpoint.

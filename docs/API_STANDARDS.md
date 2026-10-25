# API standards (versions, errors, idempotency)

Built 25 Oct 2026 to the House Listing Spec's API conventions. Code: `src/server/api/`. Every route handler is wrapped in `withApi` (enforced by `tests/api-standards.test.ts`).

## Versions
- Integrations call `/api/v1/...`. The proxy rewrites it to the handler under `/api/...` and marks the request as v1; responses carry `Api-Version: v1`.
- Unversioned `/api/...` is the **legacy** contract the site's own pages use. Its bodies are unchanged.
- `/api/v2/...` (or any unreleased version) answers 404 `unsupported_version` with `details.supportedVersions`.
- A released version never changes incompatibly. A breaking change ships as a new version (add it to `API_VERSIONS` in `version.ts` and give it its own formatting in `with-api.ts`); the old one keeps working.

## Errors (v1)
```json
{ "error": { "code": "not_found", "message": "Listing not found.", "correlationId": "…", "reasons": [], "fields": {}, "nextStep": "…", "details": {} } }
```
`code` is stable and is what clients branch on; `message` is for people. Codes and statuses: `src/server/api/errors.ts` (`API_ERROR_CODES`). A route can name a specific code by returning `code` in its body (e.g. `mfa_required`); otherwise the status decides. Unknown route codes and other extras go under `details`. A thrown error becomes 500 `internal` with no internal detail.

## Idempotency
- Every v1 write (POST, PUT, PATCH, DELETE) needs `Idempotency-Key: <uuid>`, else 400 `idempotency_key_required`. Legacy writes honour a key when sent.
- Keys are per caller (user, staff member, or anonymous client). The same key for a different request is 422 `idempotency_key_reused`; a repeat while the first is running is 409 `idempotency_in_progress` (`Retry-After: 1`).
- Successful results are kept 24 hours and replayed with `Idempotent-Replayed: true`. Failed results are not kept, so a corrected retry can reuse the key. `Set-Cookie` is never replayed.
- Exempt: `/api/auth/*`, `/api/webhooks/*` (providers have their own event ids), `/api/internal/*`, `/api/dev/*`.
- Table `api_idempotency_key`. Expired rows are reused on the next claim; purge with `DELETE FROM api_idempotency_key WHERE expires_at < now()` on a schedule.

## Every response
`X-Correlation-Id` (the caller's own when it sends a well-formed one). It appears in v1 error bodies too, for support.

## Not done yet
- The site's own pages still call the legacy paths; moving them to `/api/v1` (send `Idempotency-Key`, read `error.message`) is a follow-up.
- The spec's `publish_blocked` 422 and `If-Match` version checks need changes inside the routes themselves (publish still answers 200 with reasons).
- The correlation id is not yet passed into audit events.

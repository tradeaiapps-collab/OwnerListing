# Elena: offers comparison and sale paperwork

Elena helps with the workflow. She gives no legal advice, never accepts, rejects or sends an offer, and never commits money.

## Offers comparison and counter draft
- Page `/listings/{id}/offer-analysis` (owner, or agent with `offers.view`). API `GET /api/listings/{id}/offers/compare`.
- Code: `src/domain/offer-compare.ts` (pure rules, same with AI off), tests `tests/offer-compare.test.ts`, `tests/elena-offers-routes.test.ts`.
- Columns "Offer A, B…" (oldest first, newest 8 open offers): price vs asking, deposit and share, conditions, finance (condition + verified pre-approval), settlement days, reply-by (only an owner counter has an expiry), plain-language reading, and per-offer questions (no amounts, nothing from another offer).
- `POST /api/listings/{id}/offers/{offerId}/counter-draft` turns a coach scenario (hold firm, middle, quick) into counter terms. The owner edits them and sends with the existing owner-only counter route after a confirmation. No message is written to the buyer. The floor price is only used server-side to clamp scenarios.
- Rate limits 120/h (compare) and 30/h (draft) per user; audit events `offer.compare_viewed`, `offer.counter_drafted`.

## Sale paperwork
- Page `/listings/{id}/paperwork`; API `GET/PUT /api/listings/{id}/paperwork` (PUT is owner only). Code `src/domain/sale-paperwork.ts`, `src/server/sale-paperwork-db.ts`, migration `db/20261120150000_elena_paperwork.sql`.
- Items come only from existing rules: required disclosures (compliance config; "not configured" is shown, not guessed), trust account (publish gate), contract of sale (signing document or active contract file), inspection reports (recommended, never block), buyer ID check, and the settlement tracker's own checklist (later stages shown as "later step").
- Reminders: off by default, per listing. Runs on the automations tick (`/api/internal/automations/run`). Starts a day after first seen; one message per person per day, 3 in all, then she stops and tells the owner. Owner and accepted buyer each hear only about their own blocking, current-stage items. Fixed wording through the content filter (no amounts, no contact details), insert-only log (`elena_paperwork_message`), buyer name is not stored in that log. Delivery uses the person's notification settings (can be in-app, email or text).
- Not covered: owner ID checks (no existing rule requires one), certificate expiry, replies by email.

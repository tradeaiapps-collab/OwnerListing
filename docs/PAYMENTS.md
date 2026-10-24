# Payments

**Status: not live. No live payment keys exist anywhere.** Live keys wait for a penetration test and counsel sign-off.

## What is covered
- The platform charges only its own listing fee or plan fee (invoice, GST in cents). It never holds deposits or bond money: deposits go to the nominated solicitor's trust account.
- Nothing publishes without a verified trust account and a paid listing fee (`decidePublish`, fail closed).

## How it fits together
- `PaymentProvider` port (`src/domain/billing.ts`): hosted checkout plus signature-checked webhook parsing. Card numbers are entered on the provider's hosted page and never reach our servers or logs.
- `src/adapters/westpac-payway.ts`: fails closed until the merchant account and PayWay documentation exist. Settings come from `PAYWAY_*` environment variables, never code.
- `src/adapters/fake-payment-provider.ts`: tests only; refuses to start in production.
- `src/server/payment-webhook.ts`: answers 503 while the secret is unset, 401 for a missing or wrong HMAC-SHA256 signature, applies each event once, and opens an admin case for any payment that cannot be applied.
- `payment_event` is append-only (`db/20261024150000_append_only_ledgers.sql`). A listing's paid flag changes only when a verified, matching payment settles a pending invoice, in one transaction with its audit row.

## Before any live key
1. Penetration test of the checkout, webhook and settlement paths.
2. Counsel sign-off (see `docs/COUNSEL_QUESTIONS.md`).
3. A real PayWay adapter written against the bank's documentation, with its own security review.
4. Owner approval by name.

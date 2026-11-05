# Provider keys

Which outside accounts and keys each feature needs, where to get them, and what happens until they are set.
Every feature below fails closed: with its key missing or wrong it switches itself off; nothing half-works.
Full comments for every variable: `.env.example`. Never commit real values; put them in the host's environment (Vercel project settings) or `.env.local` on your PC.

## Check before every deploy
```
npm run check:providers -- --production
```
Run it with the deployment's environment loaded. It prints each provider as OK, OFF, PART (some keys missing) or BAD (a wrong format or a placeholder such as `changeme`, `your-key`, `<paste here>`), with the key names only, never values. Exit 1 means do not deploy:
- Google sign-in, the MFA key and map tiles are required.
- Any provider with a placeholder or wrongly formatted value.
- PayWay with only some of its keys.

PayWay, SMTP, SMS and ABN Lookup may stay OFF; their features then stay off as described below. The server also logs the same summary (names only) once at start-up.

## The keys

| Provider | Unlocks | Keys | Where to get them | Until set |
|---|---|---|---|---|
| Google sign-in (required) | All sign-in | `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL` (`ADMIN_APP_URL` on the admin deployment) | Google Cloud console, APIs & Services, Credentials, OAuth client ID (Web). Authorised redirect URI: `${APP_URL}/api/auth/google/callback` (and the admin host's). `SESSION_SECRET`: `openssl rand -base64 48` | Sign-in off |
| Two-step sign-in (required) | MFA for owners and agents | `MFA_SECRET_KEY` | Generate: `openssl rand -base64 32`. Never rotate casually: enrolled authenticators become unreadable | Owners and agents cannot finish signing in |
| Westpac PayWay | Package checkout, payment webhook | `PAYWAY_MERCHANT_ID`, `PAYWAY_API_KEY`, `PAYWAY_WEBHOOK_SECRET` | Westpac merchant account, PayWay settings. No live keys until pen test and counsel sign-off. The adapter (`src/adapters/westpac-payway.ts`) is still a stub until the PayWay docs are in hand | Checkout "not available yet"; nothing publishes |
| Email (SMTP) | Alerts, account email, email-and-password sign-up and password reset links | `SMTP_HOST`, `SMTP_PORT` (465, 587, 2525 or 25), `SMTP_FROM`, optional `SMTP_USER` + `SMTP_PASSWORD` (both or neither) | Any SMTP provider (e.g. the email host's SMTP relay). Or an admin saves them in `/staff/messaging` (needs `MESSAGING_SETTINGS_KEY`) | No email sent |
| SMS | Mobile verification, SMS sign-in codes, SMS alerts | `SMS_PROVIDER=twilio`, `SMS_ACCOUNT_SID` (AC...), `SMS_AUTH_TOKEN`, `SMS_SENDER` (+61 number, sender ID or MG...), optional `SMS_API_KEY_SID`; `SMS_CODE_SECRET` (`openssl rand -base64 48`) | Twilio console (or a Twilio-compatible provider). Or `/staff/messaging` for the account fields | No SMS; MFA offers the authenticator app only |
| Browser push (Web Push) | Push to Chrome, Edge, Firefox, Safari | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | `npx web-push generate-vapid-keys` (free, no account). Subject: `mailto:` or https URL. Do not rotate casually: browsers must subscribe again | No browser push; the Settings tab says it is not switched on |
| Android push (FCM) | Push to the Android app | `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` | Firebase console, Project settings, Service accounts, generate a private key (free) | Android devices are not pushed to |
| iPhone push (APNs) | Push to the iPhone app | `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRIVATE_KEY`, optional `APNS_PRODUCTION=1` | Apple Developer account, Keys, create an APNs key (.p8). Sandbox until `APNS_PRODUCTION=1` | iPhones are not pushed to |
| ABN Lookup | Confirming ABNs with the ABR | `ABN_LOOKUP_GUID` | Free: register at abr.business.gov.au (ABN Lookup web services); the GUID arrives by email | Checksum only, "not confirmed", staff review |
| Address suggestions | Street address suggestions in the listing form (fills suburb, state, postcode) | `GOOGLE_PLACES_API_KEY`, optional `ADDRESS_PHOTON_URL` (self-hosted Photon), `ADDRESS_LOOKUP=off` to turn it off | Google Cloud console: enable Places API (New), create an API key restricted to it (server-side, no referrer restriction needed) | Photon's public OpenStreetMap service: fair-use only, fine for testing and a small beta |
| Map tiles (required) | Listing page map, search map, staff listings map, location picker | `NEXT_PUBLIC_MAP_PROVIDER=openstreetmap` (chosen 30 Oct 2026, no key), or `custom` with `NEXT_PUBLIC_MAP_TILE_URL` (https, with `{z}`, `{x}`, `{y}`) and `NEXT_PUBLIC_MAP_ATTRIBUTION`. Baked in at build: redeploy after changing | OpenStreetMap needs nothing. For custom: a paid or self-hosted tile provider (e.g. MapTiler, Stadia, Thunderforest) | Unset: the maps still draw OpenStreetMap tiles, but the production check fails until the provider is chosen. OSM's tile policy allows light use only; the check prints a note |

## SMS notifications (Twilio)

Provider: Twilio (already the SMS adapter). SendGrid is Twilio's email product, so it is not used for texts; email stays on SMTP.
- Texts go only for messages, appointments and offers, only to a verified Australian (+61) or US (+1) mobile, and only when the user turned SMS on for that category. At most 5 per hour and 15 per day per user, two segments each (long wording is shortened, the opt-out hint stays).
- Delivery status: the app sends a status callback URL with every text (`APP_URL/api/webhooks/twilio/status`). Replies: in the Twilio console set "A message comes in" to `APP_URL/api/webhooks/twilio/inbound` (POST). A reply of STOP switches that person's texts off and is written to the consent log.
- Both endpoints check Twilio's `X-Twilio-Signature` and answer 503 until `APP_URL` is https and a signing token exists (the auth token above, or `SMS_WEBHOOK_AUTH_TOKEN` when sending with an API key).
- Cost: every text stores its segments and an estimate (`SMS_COST_PER_SEGMENT_CENTS`; the default of 8 is a placeholder, use your Twilio AU/US rate). `/staff/messaging` shows texts, segments and cost per month and type. Twilio status callbacks do not normally carry a price, so the figure is an estimate to check against the Twilio invoice; the app uses a price when one is sent.
- Not built: other countries, bulk sending, marketing texts, billing the cost on to customers.

## Adding a provider
Add its keys to `.env.example` (the test fails otherwise) and an entry in `src/config/provider-check.mjs` that mirrors the real reader; `tests/provider-check.test.ts` checks the two agree.

## Team payouts (Stripe Connect)

Pays approved team commissions to members' bank accounts. Keys: `PAYOUTS_ENABLED=1`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (endpoint `/api/webhooks/stripe`, events `account.updated`, `transfer.created`, `transfer.reversed`). Not part of `check:providers` yet.
- Off by default; every payout route answers "not switched on yet" until set. `sk_live_` keys are refused unless `PAYOUTS_ALLOW_LIVE=1` (needs pen test and counsel sign-off).
- Members onboard on Stripe's hosted page (`POST /api/me/payout-account`): Stripe does the identity check (KYC) and holds bank details, so no card or bank numbers reach this server (PCI scope stays with Stripe). A payout needs `kyc_status = verified`.
- Funds come from the platform's Stripe balance; how an agency funds it (top-up) is a decision for john and counsel, as is whether this counts as the platform holding money.

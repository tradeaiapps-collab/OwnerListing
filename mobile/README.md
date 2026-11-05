# OwnerListing phone app (iPhone and Android)

One React Native codebase (Expo SDK 58, expo-router) for both stores. All data comes from the website's existing API; the app adds no
business logic of its own.

## What it does

| Screen | Who | API |
| --- | --- | --- |
| Sign in, second step | everyone | `POST /api/mobile/auth/login`, `POST /api/auth/mfa/verify`, `/api/auth/mfa/sms/send` |
| Search, property | everyone | `GET /api/listings`, `GET /api/listings/{id}`, `GET /api/listings/{id}/photos` |
| Saved | buyers | `GET/POST /api/buyer/saved-listings`, `DELETE /api/buyer/saved-listings/{id}` |
| Appointments | owners, agents | `GET /api/agent/appointments` (agent), `GET /api/listings/mine` + `/api/listings/{id}/agent-appointments` (owner) |
| Messages | owner and agent of an appointment | `GET/POST /api/agent-appointments/{id}/messages` |
| Alerts | everyone | `GET /api/notifications`, `POST /api/notifications/read` |
| Account | everyone | `GET/PUT /api/push/preferences`, `POST /api/mobile/auth/logout` |

Sign-up, password reset, Google sign-in, setting up the second step, enquiries, offers and the buyer ID check stay on the website for
now; the app opens the right website page for them.

## How sign-in works

- `POST /api/mobile/auth/login` checks the password exactly like the website (same rate limits) and returns a 15-minute access token
  (`olm1.…`) and a refresh token (`olr1_…`). The app keeps both only in the Keychain (iPhone) or the Keystore-backed secure store
  (Android) via expo-secure-store, readable after first unlock, this device only.
- Every call sends `Authorization: Bearer <access token>`. The server ignores cookies on such a request, and skips the browser
  origin check only for a correctly signed, unexpired token.
- On a 401 the app refreshes once (`POST /api/mobile/auth/refresh`) and retries. Each refresh token works once; a used one coming back
  revokes the whole phone session (someone copied it). Sessions end after 30 idle days or 90 days in all, and at once on sign-out,
  suspension, deletion, a password reset or a staff MFA reset.
- Owners and agents (and buyers who set one up) must pass the second step on the phone too. Until then every other route answers 401.
- Server code: `src/server/auth/mobile-token.ts`, `src/server/auth/mobile-session-db.ts`, `src/server/mobile-auth.ts`,
  table `mobile_session` (`db/20261105160000_mobile_session.sql`).

## Push

The server (PR #166) sends straight to Google FCM and Apple APNs. The app registers the phone's native token
(`getDevicePushTokenAsync`, not an Expo token) with `POST /api/push/devices` after sign-in, removes it on sign-out, and a tapped push
opens the screen for its link (`src/lib/links.ts`) and reports the open to `/api/push/event`.

## One-time setup (owner's accounts and keys)

1. **Apple Developer Program** (USD 99 a year) and **Google Play Console** (USD 25 once), in the business's name.
2. **Choose the app id** before the first store upload; it can never change after. Default here: `au.com.ownerlisting.app`
   (override with `OWNERLISTING_BUNDLE_ID`).
3. **Android push (FCM):** create a Firebase project, add an Android app with that id, download `google-services.json` (keep it out of
   git) and point `GOOGLE_SERVICES_JSON` at it for builds. For the server, create a service account key and set `FCM_PROJECT_ID`,
   `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` (docs/PROVIDER_KEYS.md).
4. **iPhone push (APNs):** in Apple Developer, Keys, create a key with Apple Push Notifications enabled, download the `.p8` once.
   Server: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` (= the app id), `APNS_PRIVATE_KEY`, and `APNS_PRODUCTION=1` for
   store builds. The app needs nothing for APNs.
5. **Expo account** (free) and `npm i -g eas-cli`, then `eas init` (sets the project id) and set `OWNERLISTING_API_URL`
   (the website's https origin) as an EAS environment variable for `preview` and `production`.

## Run it

```bash
cd mobile
npm install
OWNERLISTING_API_URL=http://<your PC's LAN IP>:3004 npx expo start   # dev server must run: npm run dev in the repo root
npm run typecheck
```

Push needs a real phone and a development build (`eas build --profile development`); Expo Go cannot receive FCM/APNs tokens.
`npx expo start --web` gives a browser preview for design checks only (tokens kept in memory, no push).

Store builds: `eas build --platform all --profile production`, then `eas submit`.

## Tests

The app's logic (API client with single-flight refresh, link routing, formatting) is pure TypeScript and is tested in the main test
run: `tests/mobile-app-lib.test.ts`. Server sign-in: `tests/mobile-auth.test.ts`, `tests/mobile-auth-pg.test.ts`.

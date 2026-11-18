# OwnerListing on iPhone and Android

Three ways to put the site on a phone. Nothing here is published to a store; every store step below is yours.

| Option | Where | Store accounts | Good for |
| --- | --- | --- | --- |
| 1. Installable website (PWA) | the site itself | none | Works today on Android (Chrome) and iPhone (Safari). |
| 2. Site in a store app (Capacitor) | `capacitor/` | Apple + Google | A store listing for the **public website** with no extra screens. |
| 3. Native app (Expo) | `mobile/` | Apple + Google | Push, offline saved copies, agent and owner workflows. See `mobile/README.md`. |

Pick 2 **or** 3 for the stores, not both: they are two different apps (ids `au.com.ownerlisting.site` and `au.com.ownerlisting.app`).
Apple can reject an app that is only a website in a frame (guideline 4.2), so option 3 is the safer store route; option 2 is the quick one.

## 1. Installable website (done, in this repo)

- `/manifest.webmanifest` (name from Site appearance), icons in `public/icons/`, offline page at `/offline`.
- Service worker `public/push-sw.js` (also does web push): offline page and built files only. Pages and API answers are never stored.
- Install banner (`app/pwa-register.tsx`): Install button on Android/desktop Chrome; "Share, Add to Home Screen" steps on iPhone Safari.
  Hidden once installed; a dismissal hides it for 30 days.
- Needs https on the live site (localhost is fine for testing). Replace the placeholder icons by overwriting the PNGs in `public/icons/`
  (192, 512, 512 maskable with the artwork inside the central 80%, 180 for iPhone).

## 2. Capacitor shell (`capacitor/`)

`ios/` and `android/` projects are generated. They open the live site given by `OWNERLISTING_APP_URL`.

```bash
cd capacitor && npm install
OWNERLISTING_APP_URL=https://<your live public site> npx cap sync
npx cap open android      # Android Studio
npx cap open ios          # Xcode (Mac only)
```

Defaults you can change before the first upload: app id `au.com.ownerlisting.site` (permanent once uploaded), name `OwnerListing`
(`OWNERLISTING_APP_ID`, `OWNERLISTING_APP_NAME`). Replace the default Capacitor icons and splash in the two projects.
The live site must be deployed first (docs/PRODUCTION_RUNBOOK.md); a PC address will not work for other people's phones.

## What only you can do

1. **Apple Developer Program** (USD 99 a year) and **Google Play Console** (USD 25 once), in the business's name. Google asks for identity checks and, for new personal accounts, a closed test before production.
2. **Decide option 2 or 3** (above) and the final **app id**.
3. **Signing.** Android: create an upload key (`keytool`) in Android Studio, keep it and its passwords safe; never commit it. iPhone: in Xcode choose your team, let it manage signing, or create the certificates in Apple Developer. A Mac is required for iPhone builds (or EAS cloud builds for option 3).
4. **Store listings:** app name, description, screenshots (phone sizes), icon 1024x1024, support URL, **privacy policy URL**, age rating, and the data-safety (Google) and App Privacy (Apple) forms. Real estate and a sign-in: give reviewers a test account.
5. **Push (only option 3):** Firebase project and APNs key, steps in `mobile/README.md`.
6. Upload (Play Console internal test first, TestFlight first) and submit for review.

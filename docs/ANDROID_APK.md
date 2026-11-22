# Android APK (sideload, debug-signed)

Builds the Capacitor shell in `capacitor/`: a thin app that opens the OwnerListing website. Debug-signed only: not for Google Play. The site currently runs only on john's PC (public site port 3005), so the URL is chosen at build time with `OWNERLISTING_APP_URL`; nothing is hard-coded.

## Which URL?
- Phone on the same Wi-Fi as the PC: `http://<PC LAN IP>:3005` (run `ipconfig`, use the IPv4 address; allow Node through Windows Firewall on private networks; start the site so it listens on all interfaces, e.g. `npm run dev -- -H 0.0.0.0` with the port you normally use).
- `localhost` will NOT work: on the phone it means the phone.
- Later, when a hosted site exists: its `https://` origin.

## Build on GitHub (no installs)
Actions, "Android debug APK", Run workflow, enter the URL. The run also publishes release `android-latest`; open `https://github.com/tradeaiapps-collab/ownerlisting/releases/download/android-latest/ownerlisting.apk` on the phone (signed in to GitHub, as the repo is private) to download the APK. The artifact `ownerlisting-debug-apk` has the same file.

## Build on the PC (easiest)
Prerequisites: Node 22, and Android Studio (open it once so it installs the SDK and a JDK).
Double-click `capacitor\build-android-apk.bat`, type the address, wait. `ownerlisting.apk` appears on your Desktop.

### Manual steps (same thing)
```
cd capacitor
npm install
set OWNERLISTING_APP_URL=http://192.168.1.20:3005
npx cap sync android
cd android
gradlew.bat assembleDebug
```
(PowerShell: `$env:OWNERLISTING_APP_URL="..."`.) Result: `capacitor\android\app\build\outputs\apk\debug\app-debug.apk`. If Gradle can't find the SDK, create `capacitor\android\local.properties` with `sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk`.

## Install on the phone
1. Copy `app-debug.apk` to the phone (USB, Drive, email).
2. Open it; when asked, allow "Install unknown apps" for that app (Files/Chrome).
3. Open OwnerListing. A blank "no website address" screen means it was built without the URL.
To change the URL, rebuild and reinstall.

## Not covered
Play Store needs a release keystore and Play account. iOS needs a Mac with Xcode and an Apple Developer account.

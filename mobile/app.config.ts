import type { ExpoConfig } from "expo/config";

/**
 * Build settings. Values that differ per environment come from the shell (or EAS secrets), never from the repo:
 *   OWNERLISTING_API_URL     https origin of the website, e.g. https://ownerlisting.com.au (default: the local dev server)
 *   GOOGLE_SERVICES_JSON     path to the Firebase google-services.json for Android push (FCM)
 *   EAS_PROJECT_ID           set by `eas init`
 * The iPhone push key (APNs .p8) is not needed in the app at all: the server holds it (docs/PROVIDER_KEYS.md, APNS_*).
 */
const BUNDLE_ID = process.env["OWNERLISTING_BUNDLE_ID"] ?? "au.com.ownerlisting.app";

const config: ExpoConfig = {
  name: "OwnerListing",
  slug: "ownerlisting",
  scheme: "ownerlisting",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: true,
    infoPlist: { ITSAppUsesNonExemptEncryption: false }
  },
  android: {
    package: BUNDLE_ID,
    ...(process.env["GOOGLE_SERVICES_JSON"] ? { googleServicesFile: process.env["GOOGLE_SERVICES_JSON"] } : {}),
    permissions: ["POST_NOTIFICATIONS"]
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-notifications", { color: "#1f2a44" }]
  ],
  experiments: { typedRoutes: false },
  extra: {
    apiUrl: process.env["OWNERLISTING_API_URL"] ?? "http://localhost:3004",
    ...(process.env["EAS_PROJECT_ID"] ? { eas: { projectId: process.env["EAS_PROJECT_ID"] } } : {})
  }
};

export default config;

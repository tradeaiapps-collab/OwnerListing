import type { ExpoConfig } from "expo/config";

/**
 * Store-ready Expo config. Values that differ per environment come from the environment (shell or EAS variables), never from the repo:
 *   OWNERLISTING_API_URL      https origin of the website (required for preview and production builds)
 *   OWNERLISTING_PRIVACY_URL  public privacy policy page (store listings need it)
 *   OWNERLISTING_BUNDLE_ID    app id, default au.com.ownerlisting.app (permanent after the first upload)
 *   GOOGLE_SERVICES_JSON      Firebase google-services.json for Android push (EAS file variable)
 *   EAS_PROJECT_ID            set by `eas init`
 * buildConfig is exported so tests can call it; everything lives in this one file because Expo's config loader cannot resolve sibling .ts files.
 */
export type StoreEnv = Record<string, string | undefined>;

export const DEFAULT_BUNDLE_ID = "au.com.ownerlisting.app";
export const DEV_API_URL = "http://localhost:3004";
export const BRAND_NAVY = "#14213d";

/** Build profile names (eas.json sets EAS_BUILD_PROFILE during cloud builds). */
const isStoreBuild = (env: StoreEnv) => env["EAS_BUILD_PROFILE"] === "production" || env["EAS_BUILD_PROFILE"] === "preview";

export function resolveApiUrl(env: StoreEnv): string {
  const url = (env["OWNERLISTING_API_URL"] ?? "").trim().replace(/\/+$/, "");
  if (!url) {
    if (isStoreBuild(env)) throw new Error("OWNERLISTING_API_URL must be set (https origin of the website) for preview and production builds.");
    return DEV_API_URL;
  }
  if (env["EAS_BUILD_PROFILE"] === "production" && !url.startsWith("https://")) throw new Error("OWNERLISTING_API_URL must be https:// for production builds.");
  return url;
}

export function buildConfig(env: StoreEnv): ExpoConfig {
  const bundleId = env["OWNERLISTING_BUNDLE_ID"] ?? DEFAULT_BUNDLE_ID;
  const apiUrl = resolveApiUrl(env);
  // Defaults to the site's public /privacy and /support pages; set the env vars only to point elsewhere.
  const privacyUrl = env["OWNERLISTING_PRIVACY_URL"] ?? `${apiUrl}/privacy`;
  const supportUrl = env["OWNERLISTING_SUPPORT_URL"] ?? `${apiUrl}/support`;
  return {
    name: "OwnerListing",
    slug: "ownerlisting",
    scheme: "ownerlisting",
    version: "1.0.0",
    orientation: "portrait",
    userInterfaceStyle: "automatic",
    icon: "./assets/icon.png",
        ios: {
      bundleIdentifier: bundleId,
      supportsTablet: true,
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        // Only strings for permissions the app can actually trigger today. Add Camera/Photos strings when a feature needs them.
        NSUserNotificationsUsageDescription: "OwnerListing sends alerts about offers, messages, inspections and settlements for your listings and saved homes."
      }
    },
    android: {
      package: bundleId,
      adaptiveIcon: { foregroundImage: "./assets/adaptive-icon.png", monochromeImage: "./assets/adaptive-icon-mono.png", backgroundColor: BRAND_NAVY },
      ...(env["GOOGLE_SERVICES_JSON"] ? { googleServicesFile: env["GOOGLE_SERVICES_JSON"] } : {}),
      permissions: ["POST_NOTIFICATIONS"],
      blockedPermissions: ["android.permission.RECORD_AUDIO", "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE", "android.permission.SYSTEM_ALERT_WINDOW"]
    },
    web: { favicon: "./assets/favicon.png" },
    plugins: [
      "expo-router",
      "expo-secure-store",
      ["expo-notifications", { color: BRAND_NAVY }],
      ["expo-splash-screen", { image: "./assets/splash-icon.png", imageWidth: 200, resizeMode: "contain", backgroundColor: BRAND_NAVY }]
    ],
    experiments: { typedRoutes: false },
    extra: {
      apiUrl,
      privacyPolicyUrl: privacyUrl,
      supportUrl,
      ...(env["EAS_PROJECT_ID"] ? { eas: { projectId: env["EAS_PROJECT_ID"] } } : {})
    }
  };
}

export default buildConfig(process.env);

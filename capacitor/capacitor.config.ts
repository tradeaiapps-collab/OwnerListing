import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The app is a thin shell around the public website: it opens OWNERLISTING_APP_URL (https origin of the live public site).
 * Defaults (placeholders, change before the first store upload; an app id cannot change afterwards):
 *   OWNERLISTING_APP_ID    au.com.ownerlisting.site   (differs from the Expo phone app in ../mobile on purpose)
 *   OWNERLISTING_APP_NAME  OwnerListing
 */
const url = process.env["OWNERLISTING_APP_URL"];

const config: CapacitorConfig = {
  appId: process.env["OWNERLISTING_APP_ID"] ?? "au.com.ownerlisting.site",
  appName: process.env["OWNERLISTING_APP_NAME"] ?? "OwnerListing",
  webDir: "www",
  ...(url ? { server: { url, cleartext: url.startsWith("http://"), allowNavigation: [new URL(url).host] } } : {}),
  ios: { contentInset: "automatic", backgroundColor: "#14213d" },
  android: { backgroundColor: "#14213d", allowMixedContent: false },
  plugins: {
    SplashScreen: { backgroundColor: "#14213d", launchShowDuration: 800 },
    StatusBar: { style: "DARK", backgroundColor: "#14213d" }
  }
};

export default config;

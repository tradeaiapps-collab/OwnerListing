/** Single source of truth for the user-facing brand. Change NEXT_PUBLIC_SITE_NAME (or SITE_NAME), never a literal in app/ or src/. */
const DEFAULT_NAME = "OwnerListing";
const DEFAULT_TAGLINE = "Sell or rent your property yourself";

/** The name the pre-recorded presenter clips say aloud; those clips are only used while the site brand is still this. */
export const DEFAULT_BRAND_NAME = DEFAULT_NAME;

/** PLACEHOLDER support mailbox for the default brand; legal pages override via SUPPORT_EMAIL. */
export const DEFAULT_SUPPORT_EMAIL = "support@ownerlisting.com.au";

/** Release asset the "Get the app" page links to (built by the Android APK workflow). */
export const ANDROID_APK_URL = "https://github.com/tradeaiapps-collab/OwnerListing/releases/download/android-latest/ownerlisting.apk";

export interface Brand { name: string; tagline: string }

const clean = (v: string | undefined) => {
  const t = v?.trim();
  return t ? t.slice(0, 60) : undefined;
};

export function readBrand(env: Record<string, string | undefined> = process.env): Brand {
  return {
    name: clean(env["NEXT_PUBLIC_SITE_NAME"]) ?? clean(env["SITE_NAME"]) ?? DEFAULT_NAME,
    tagline: clean(env["NEXT_PUBLIC_SITE_TAGLINE"]) ?? clean(env["SITE_TAGLINE"]) ?? DEFAULT_TAGLINE
  };
}

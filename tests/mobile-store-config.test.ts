import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { buildConfig, resolveApiUrl } from "../mobile/app.config";

const prod = { EAS_BUILD_PROFILE: "production", OWNERLISTING_API_URL: "https://ownerlisting.example/" };

describe("phone app store config", () => {
  it("uses the permanent default app id on both platforms and lets env override it", () => {
    const c = buildConfig(prod);
    expect(c.ios?.bundleIdentifier).toBe("au.com.ownerlisting.app");
    expect(c.android?.package).toBe("au.com.ownerlisting.app");
    expect(buildConfig({ ...prod, OWNERLISTING_BUNDLE_ID: "x.y.z" }).android?.package).toBe("x.y.z");
  });

  it("takes the API base URL from the environment and trims the trailing slash", () => {
    expect(buildConfig(prod).extra?.["apiUrl"]).toBe("https://ownerlisting.example");
    expect(resolveApiUrl({})).toBe("http://localhost:3004");
  });

  it("refuses preview/production builds without an API URL, and production over http", () => {
    expect(() => resolveApiUrl({ EAS_BUILD_PROFILE: "production" })).toThrow(/OWNERLISTING_API_URL/);
    expect(() => resolveApiUrl({ EAS_BUILD_PROFILE: "preview" })).toThrow(/OWNERLISTING_API_URL/);
    expect(() => resolveApiUrl({ EAS_BUILD_PROFILE: "production", OWNERLISTING_API_URL: "http://192.168.1.2:3004" })).toThrow(/https/);
    expect(resolveApiUrl({ EAS_BUILD_PROFILE: "preview", OWNERLISTING_API_URL: "http://192.168.1.2:3004" })).toBe("http://192.168.1.2:3004");
  });

  it("carries a privacy policy URL placeholder that env can replace", () => {
    expect(buildConfig(prod).extra?.["privacyPolicyUrl"]).toBe("https://ownerlisting.example/privacy");
    expect(buildConfig({ ...prod, OWNERLISTING_PRIVACY_URL: "https://x.test/p" }).extra?.["privacyPolicyUrl"]).toBe("https://x.test/p");
  });

  it("requests only the notification permission and blocks risky ones", () => {
    const c = buildConfig(prod);
    expect(c.android?.permissions).toEqual(["POST_NOTIFICATIONS"]);
    expect(c.android?.blockedPermissions).toContain("android.permission.RECORD_AUDIO");
    expect(c.ios?.infoPlist?.["NSUserNotificationsUsageDescription"]).toMatch(/alerts/);
    expect(c.ios?.infoPlist?.["ITSAppUsesNonExemptEncryption"]).toBe(false);
  });

  it("points at icon and splash files that exist", () => {
    const c = buildConfig(prod);
    const files = [c.icon, "./assets/splash-icon.png", c.android?.adaptiveIcon?.foregroundImage, c.android?.adaptiveIcon?.monochromeImage, c.web?.favicon];
    for (const f of files) expect(existsSync(`mobile/${String(f).replace("./", "")}`), String(f)).toBe(true);
  });

  it("eas.json has development, preview and production profiles with channels", () => {
    const eas = JSON.parse(readFileSync("mobile/eas.json", "utf8")).build;
    expect(Object.keys(eas)).toEqual(["development", "preview", "production"]);
    expect(eas.production.android.buildType).toBe("app-bundle");
    expect(eas.preview.channel).toBe("preview");
  });
});

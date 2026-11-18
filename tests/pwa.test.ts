import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildManifest, installMode, isIosSafari, INSTALL_DISMISS_DAYS } from "../src/domain/pwa";
import { DEFAULT_THEME } from "../src/domain/site-theme";
import { isAllowed } from "../src/config/app-mode";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1";
const ctx = { standalone: false, hasPromptEvent: false, userAgent: "Mozilla/5.0 (X11; Linux) Chrome/120", dismissedAt: null, now: 1_800_000_000_000 };

describe("manifest", () => {
  const m = buildManifest({ name: "OwnerListing", tagline: "Sell or rent your property yourself" });
  it("is installable on Android and iPhone", () => {
    expect(m).toMatchObject({ display: "standalone", scope: "/", id: "/" });
    expect(m.icons.some(i => i.sizes === "192x192")).toBe(true);
    expect(m.icons.some(i => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
    for (const i of m.icons) expect(existsSync(`public${i.src}`)).toBe(true);
    expect(existsSync("public/icons/apple-touch-icon.png")).toBe(true);
  });
  it("keeps the short name short and shortcuts public (Projects included)", () => {
    expect(buildManifest({ name: "A Very Long Brand Name", tagline: "t" }).short_name.length).toBeLessThanOrEqual(12);
    expect(m.shortcuts.map(s => s.name)).toContain("Projects");
    for (const s of m.shortcuts) expect(isAllowed("public", s.url.split("?")[0]!, null, undefined)).toBe(true);
  });
  it("is served on the public site and the offline page too", () => {
    for (const p of ["/manifest.webmanifest", "/offline", "/push-sw.js", "/icons/icon-192.png"]) expect(isAllowed("public", p, null, undefined)).toBe(true);
  });
});

describe("install prompt", () => {
  it("hides when installed or recently dismissed", () => {
    expect(installMode({ ...ctx, standalone: true, hasPromptEvent: true })).toBe("hidden");
    expect(installMode({ ...ctx, hasPromptEvent: true, dismissedAt: ctx.now - 86_400_000 })).toBe("hidden");
    expect(installMode({ ...ctx, hasPromptEvent: true, dismissedAt: ctx.now - (INSTALL_DISMISS_DAYS + 1) * 86_400_000 })).toBe("prompt");
  });
  it("shows the native prompt where the browser offers it and iPhone steps in Safari only", () => {
    expect(installMode({ ...ctx, hasPromptEvent: true })).toBe("prompt");
    expect(installMode({ ...ctx, userAgent: IPHONE })).toBe("ios");
    expect(isIosSafari(IPHONE_CHROME)).toBe(false);
    expect(installMode({ ...ctx })).toBe("hidden");
  });
});

describe("service worker", () => {
  const sw = readFileSync("public/push-sw.js", "utf8");
  it("never stores pages or API answers", () => {
    expect(sw).toContain('req.method !== "GET"');
    expect(sw).toMatch(/_next\/static\//);
    expect(sw.slice(sw.indexOf('"fetch"'), sw.indexOf('"push"'))).not.toMatch(/\/api\//);
    expect(sw).toContain('"/offline"');
  });
  it("still handles web push", () => {
    for (const e of ['"push"', '"notificationclick"', '"notificationclose"']) expect(sw).toContain(e);
  });
});

describe("top navigation", () => {
  it("still has the Projects tab", () => {
    expect(DEFAULT_THEME.navigation.some(n => n.id === "projects" && n.visible)).toBe(true);
  });
});

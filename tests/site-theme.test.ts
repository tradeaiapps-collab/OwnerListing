import { describe, expect, it } from "vitest";
import { inspectSiteAsset, MAX_ASSET_BYTES } from "../src/domain/site-asset";
import {
  COLOUR_KEYS, DEFAULT_THEME, NAV_CATALOG, assetUrl, buildThemeCss, changedFields, contrastRatio, fontStylesheetUrl, parseStoredTheme, safeLink, validateTheme,
  type ThemeSettings
} from "../src/domain/site-theme";

const clone = (): ThemeSettings => structuredClone(DEFAULT_THEME);
const errorsOf = (s: unknown) => { const r = validateTheme(s); return r.ok ? {} : r.errors; };
const mutate = (fn: (t: ThemeSettings) => void): unknown => { const t = clone(); fn(t); return t; };

describe("defaults", () => {
  it("are valid, pass WCAG AA for every checked pair in light and dark, and equal the current built-in look", () => {
    const r = validateTheme(DEFAULT_THEME);
    expect(r.ok).toBe(true);
    expect(DEFAULT_THEME.colours.light).toMatchObject({ bg: "#fbfaf7", surface: "#f3efe7", text: "#1c1f26", muted: "#5d6271", border: "#e2dccf", buttonBg: "#14213d", accent: "#9a7536" });
    expect(DEFAULT_THEME.colours.dark).toMatchObject({ bg: "#0b1020", surface: "#121a2e", text: "#e7e2d8", buttonBg: "#d4b37a", buttonText: "#0b1020" });
    expect(DEFAULT_THEME.typography).toMatchObject({ bodyFont: "inter", headingFont: "playfair" });
    expect(DEFAULT_THEME.navigation.map(n => n.id)).toEqual(NAV_CATALOG.map(n => n.id));
    expect(DEFAULT_THEME.navigation.slice(0, 3).map(n => n.label)).toEqual(["Browse", "Plans", "List a property"]);
  });
  it("round-trip through JSON unchanged", () => {
    const r = validateTheme(JSON.parse(JSON.stringify(DEFAULT_THEME)));
    expect(r.ok && r.value).toEqual(DEFAULT_THEME);
  });
});

describe("colours accept hex only", () => {
  const bad = [
    "red", "red;}body{display:none", "#fff", "#12345", "#1234567", "rgb(0,0,0)", "url(javascript:alert(1))", "#ffffff;}", "var(--x)", " #zzzzzz", "expression(alert(1))",
    "#ffffff\n}", "#ffffff /*", "</style><script>alert(1)</script>", 12345, null, {}, ["#ffffff"]
  ];
  it.each(bad)("rejects %j", v => {
    expect(errorsOf(mutate(t => { (t.colours.light as unknown as Record<string, unknown>)["bg"] = v; }))["colours.light.bg"]).toBeTruthy();
    expect(errorsOf(mutate(t => { (t.colours.dark as unknown as Record<string, unknown>)["link"] = v; }))["colours.dark.link"]).toBeTruthy();
  });
  it("normalises upper case hex to lower case", () => {
    const r = validateTheme(mutate(t => { t.colours.light.accent = "#0B5FD6"; }));
    expect(r.ok && r.value.colours.light.accent).toBe("#0b5fd6");
  });
  it("a rejected value never reaches the generated CSS", () => {
    const evil = mutate(t => { (t.colours.light as unknown as Record<string, unknown>)["bg"] = "red;}body{display:none"; });
    expect(validateTheme(evil).ok).toBe(false);
    // Even if a corrupted row bypassed validation, the CSS builder falls back to the defaults rather than emit it.
    const css = buildThemeCss(evil as ThemeSettings);
    expect(css).not.toContain("display:none");
    expect(css).toBe(buildThemeCss(DEFAULT_THEME));
  });
  it("the CSS is built from the normalised copy, not the raw input (padding and upper-case hex are cleaned)", () => {
    const padded = mutate(t => { t.colours.light.bg = " #FFFFFF\n"; });
    expect(validateTheme(padded).ok).toBe(true);
    const css = buildThemeCss(padded as ThemeSettings);
    expect(css).toContain("--bg:#ffffff;");
    expect(css).not.toMatch(/[A-F]{6}|\n/);
  });
});

describe("contrast (WCAG AA)", () => {
  it("computes known ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });
  it("refuses text that is too close to its background, per pair, in both modes", () => {
    expect(errorsOf(mutate(t => { t.colours.light.text = "#f0f0f0"; }))["colours.light.text"]).toMatch(/Contrast .* required/);
    expect(errorsOf(mutate(t => { t.colours.dark.muted = "#181d26"; }))["colours.dark.muted"]).toMatch(/at least 4.5:1/);
    expect(errorsOf(mutate(t => { t.colours.light.buttonBg = "#ffffff"; }))["colours.light.buttonText"]).toBeTruthy();
    expect(errorsOf(mutate(t => { t.colours.light.headerText = "#f6f7f9"; }))["colours.light.headerText"]).toBeTruthy();
    expect(errorsOf(mutate(t => { t.colours.light.link = "#ffff00"; }))["colours.light.link"]).toBeTruthy();
    expect(errorsOf(mutate(t => { t.colours.light.primary = "#fefefe"; }))["colours.light.primary"]).toMatch(/3:1/);
  });
  it("allows 4.5:1 exactly and rejects just under", () => {
    // #767676 on white is 4.54:1; #787878 is 4.44:1.
    expect(errorsOf(mutate(t => { t.colours.light.muted = "#767676"; t.colours.light.surface = "#ffffff"; t.colours.light.bg = "#ffffff"; }))["colours.light.muted"]).toBeUndefined();
    expect(errorsOf(mutate(t => { t.colours.light.muted = "#787878"; t.colours.light.surface = "#ffffff"; t.colours.light.bg = "#ffffff"; }))["colours.light.muted"]).toBeTruthy();
  });
  it("a dark theme with a dark page and light text passes; the same colours in the wrong mode slot fail", () => {
    const t = clone(); t.colours.light = structuredClone(DEFAULT_THEME.colours.dark);
    expect(validateTheme(t).ok).toBe(true);
    const u = clone(); u.colours.light.bg = "#0f1218";
    expect(errorsOf(u)["colours.light.text"]).toBeTruthy();
  });
});

describe("numbers are range-checked (rejected, not clipped)", () => {
  const cases: [string, string, unknown[]][] = [
    ["typography", "baseSize", [13, 21, 1e9, -5, 16.5, NaN, Infinity, "16", null]],
    ["typography", "headingScale", [0.9, 1.7, 1e12, -1, NaN, "1.2"]],
    ["layout", "radius", [-1, 25, 1e9, 3.5, "10"]],
    ["layout", "headerHeight", [47, 121, 99999999, 0]],
    ["layout", "logoHeight", [15, 97, Number.MAX_SAFE_INTEGER * 2]]
  ];
  for (const [group, key, values] of cases) {
    it.each(values)(`${group}.${key} rejects %j`, v => {
      expect(errorsOf(mutate(t => { (t[group as "layout"] as unknown as Record<string, unknown>)[key] = v; }))[`${group}.${key}`]).toBeTruthy();
    });
  }
  it("accepts the limits", () => {
    expect(validateTheme(mutate(t => { t.typography.baseSize = 14; t.typography.headingScale = 1.6; t.layout.radius = 0; t.layout.headerHeight = 120; t.layout.logoHeight = 96; })).ok).toBe(true);
  });
  it("rounds the heading scale to 2 decimals", () => {
    const r = validateTheme(mutate(t => { t.typography.headingScale = 1.2345; }));
    expect(r.ok && r.value.typography.headingScale).toBe(1.23);
  });
});

describe("choices come from allow-lists", () => {
  it("rejects fonts outside the list, including CSS and URL injection", () => {
    for (const f of ["Comic Sans", "system-ui, sans-serif; } body { display:none", "url(https://evil.test/x.woff)", "Inter", "../inter", ""]) {
      expect(errorsOf(mutate(t => { t.typography.bodyFont = f; }))["typography.bodyFont"], f).toBeTruthy();
      expect(errorsOf(mutate(t => { t.typography.headingFont = f; }))["typography.headingFont"], f).toBeTruthy();
    }
    expect(validateTheme(mutate(t => { t.typography.bodyFont = "inter"; t.typography.headingFont = "playfair"; })).ok).toBe(true);
  });
  it("rejects unknown density, button size and icon style", () => {
    expect(errorsOf(mutate(t => { (t.layout as unknown as Record<string, unknown>)["density"] = "huge"; }))["layout.density"]).toBeTruthy();
    expect(errorsOf(mutate(t => { (t.layout as unknown as Record<string, unknown>)["buttonSize"] = "xl"; }))["layout.buttonSize"]).toBeTruthy();
    expect(errorsOf(mutate(t => { (t.layout as unknown as Record<string, unknown>)["iconStyle"] = "duotone"; }))["layout.iconStyle"]).toBeTruthy();
  });
  it("builds the font stylesheet link only from the allow-list", () => {
    expect(fontStylesheetUrl(["system", "georgia"])).toBeNull();
    expect(fontStylesheetUrl(["inter", "inter", "playfair"])).toBe("https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Playfair+Display:wght@400;600;700&display=swap");
    expect(fontStylesheetUrl(["evil.test/x"])).toBeNull();
  });
});

describe("plain text fields", () => {
  const injections = ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "a{color:red}", "x`y", "line\nbreak", "bell\u0007", "\u0000"];
  it.each(injections)("site name and tagline reject %j", v => {
    expect(errorsOf(mutate(t => { t.brand.siteName = v; }))["brand.siteName"]).toBeTruthy();
    expect(errorsOf(mutate(t => { t.brand.tagline = v; }))["brand.tagline"]).toBeTruthy();
    expect(errorsOf(mutate(t => { t.footer.text = v; }))["footer.text"]).toBeTruthy();
    expect(errorsOf(mutate(t => { t.navigation[0]!.label = v; }))["navigation.0.label"]).toBeTruthy();
  });
  it("caps lengths", () => {
    expect(errorsOf(mutate(t => { t.brand.siteName = "a".repeat(61); }))["brand.siteName"]).toBeTruthy();
    expect(errorsOf(mutate(t => { t.brand.tagline = "a".repeat(121); }))["brand.tagline"]).toBeTruthy();
    expect(errorsOf(mutate(t => { t.footer.text = "a".repeat(201); }))["footer.text"]).toBeTruthy();
    expect(errorsOf(mutate(t => { t.navigation[1]!.label = "a".repeat(31); }))["navigation.1.label"]).toBeTruthy();
    expect(validateTheme(mutate(t => { t.brand.siteName = "a".repeat(60); })).ok).toBe(true);
  });
  it("accepts ordinary text and trims; an empty name or tagline means 'use the server default'", () => {
    const r = validateTheme(mutate(t => { t.brand.siteName = "  Smith & Sons Homes  "; t.brand.tagline = ""; }));
    expect(r.ok && r.value.brand.siteName).toBe("Smith & Sons Homes");
    expect(r.ok && r.value.brand.tagline).toBeNull();
  });
  it("text never appears in the generated CSS", () => {
    const css = buildThemeCss(mutate(t => { t.brand.siteName = "UNIQUE-NAME-123"; t.footer.text = "UNIQUE-FOOT-456"; }) as ThemeSettings);
    expect(css).not.toContain("UNIQUE");
  });
});

describe("links", () => {
  it.each(["https://example.com", "https://example.com/a?b=c#d", "/privacy", "/a/b?x=1"])("accepts %s", v => expect(safeLink(v)).toBe(v));
  it.each([
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "http://example.com", "//evil.test/x", "/\\evil.test", "https://user:pw@example.com",
    "vbscript:x", "https://", "", "  ", "url(javascript:alert(1))", "/path with space", "/x\"onmouseover=\"alert(1)", "https://a.test/<x>", "ftp://x.test", "mailto:a@b.test", "https:///x", 5, null
  ])("rejects %j", v => expect(safeLink(v)).toBeNull());
  it("footer links are validated and capped", () => {
    expect(errorsOf(mutate(t => { t.footer.links = [{ label: "Bad", href: "javascript:alert(1)" }]; }))["footer.links.0.href"]).toBeTruthy();
    expect(errorsOf(mutate(t => { t.footer.links = [{ label: "<b>", href: "/x" }]; }))["footer.links.0.label"]).toBeTruthy();
    expect(errorsOf(mutate(t => { t.footer.links = Array.from({ length: 7 }, (_, i) => ({ label: `L${i}`, href: "/x" })); }))["footer.links"]).toBeTruthy();
    expect(validateTheme(mutate(t => { t.footer.links = [{ label: "Privacy", href: "/privacy" }, { label: "Site", href: "https://example.com/a" }]; })).ok).toBe(true);
  });
});

describe("navigation", () => {
  it("must list every item once; ids are fixed; order and visibility are editable", () => {
    expect(errorsOf(mutate(t => { t.navigation.pop(); }))["navigation"]).toBeTruthy();
    expect(errorsOf(mutate(t => { t.navigation[0]!.id = "evil"; }))["navigation.0.id"]).toBeTruthy();
    expect(errorsOf(mutate(t => { t.navigation[1]!.id = t.navigation[0]!.id; }))["navigation.1.id"]).toBeTruthy();
    expect(errorsOf(mutate(t => { (t.navigation[0] as unknown as Record<string, unknown>)["href"] = "https://evil.test"; }))["navigation.0.href"]).toBeTruthy();
    const r = validateTheme(mutate(t => { t.navigation.reverse(); t.navigation[0]!.visible = false; t.navigation[1]!.label = "Home search"; }));
    expect(r.ok).toBe(true);
  });
});

describe("shape", () => {
  it("rejects unknown keys, missing keys and non-objects at every level", () => {
    expect(errorsOf(null)[""]).toBeTruthy();
    expect(errorsOf([])[""]).toBeTruthy();
    expect(errorsOf("body{}")[""]).toBeTruthy();
    expect(errorsOf({ ...clone(), css: "body{display:none}" })["css"]).toBeTruthy();
    expect(errorsOf({ ...clone(), html: "<b>" })["html"]).toBeTruthy();
    expect(errorsOf(mutate(t => { (t.brand as unknown as Record<string, unknown>)["script"] = "x"; }))["brand.script"]).toBeTruthy();
    expect(errorsOf(mutate(t => { delete (t.layout as unknown as Record<string, unknown>)["radius"]; }))["layout.radius"]).toBeTruthy();
    expect(errorsOf(mutate(t => { (t.colours.light as unknown as Record<string, unknown>)["customCss"] = "x"; }))["colours.light.customCss"]).toBeTruthy();
  });
  it("asset ids must be positive integers or null", () => {
    for (const v of [0, -1, 1.5, "1", NaN, 1e300]) expect(errorsOf(mutate(t => { (t.brand as unknown as Record<string, unknown>)["logoLight"] = v; }))["brand.logoLight"], String(v)).toBeTruthy();
    expect(validateTheme(mutate(t => { t.brand.logoLight = 7; t.brand.favicon = 9; })).ok).toBe(true);
  });
  it("prototype pollution keys are just unknown keys", () => {
    const o = JSON.parse('{"__proto__":{"polluted":true},"brand":{},"colours":{},"typography":{},"layout":{},"navigation":[],"footer":{}}');
    expect(validateTheme(o).ok).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
  it("stored settings that no longer validate fall back to the defaults", () => {
    expect(parseStoredTheme({ nonsense: true })).toEqual(DEFAULT_THEME);
    expect(parseStoredTheme(null)).toEqual(DEFAULT_THEME);
  });
});

describe("generated CSS", () => {
  it("has the light variables, a dark media query and forced-mode rules; the defaults reproduce the built-in values", () => {
    const css = buildThemeCss(DEFAULT_THEME);
    expect(css).toContain(":root:root{--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-6:24px;--space-8:32px;--radius:14px;");
    expect(css).toContain("--bg:#fbfaf7;");
    expect(css).toContain('[data-theme-mode="dark"]');
    expect(css).not.toMatch(/[<>]/);
  });
  it("colour mode: light (the default) emits no device-dark media query; system keeps it; anything else is rejected", () => {
    expect(DEFAULT_THEME.layout.colourMode).toBe("light");
    expect(buildThemeCss(DEFAULT_THEME)).not.toContain("prefers-color-scheme");
    const system = buildThemeCss(mutate(t => { t.layout.colourMode = "system"; }) as ThemeSettings);
    expect(system).toContain("@media (prefers-color-scheme: dark){:root:root{--bg:#0b1020;");
    expect(errorsOf(mutate(t => { (t.layout as unknown as Record<string, unknown>)["colourMode"] = "dark"; }))["layout.colourMode"]).toBeTruthy();
  });
  it("followDevice (staff console) emits the device-dark media query even when the theme is fixed to light", () => {
    expect(DEFAULT_THEME.layout.colourMode).toBe("light");
    expect(buildThemeCss(DEFAULT_THEME, { followDevice: true })).toContain("@media (prefers-color-scheme: dark){:root:root{--bg:#0b1020;");
    expect(buildThemeCss(DEFAULT_THEME, { followDevice: false })).not.toContain("prefers-color-scheme");
  });
  it("a stored theme saved before colourMode existed loads as light", () => {
    const old = clone() as unknown as { layout: Record<string, unknown> };
    delete old.layout["colourMode"];
    expect(parseStoredTheme(old).layout.colourMode).toBe("light");
  });
  it("density, radius and button size change the tokens", () => {
    const css = buildThemeCss(mutate(t => { t.layout.density = "spacious"; t.layout.radius = 20; t.layout.buttonSize = "large"; t.typography.bodyFont = "georgia"; }) as ThemeSettings);
    expect(css).toContain("--space-4:22px;");
    expect(css).toContain("--radius:20px;--radius-sm:16px;");
    expect(css).toContain("--btn-h:52px;");
    expect(css).toContain("--font-body:Georgia");
    expect(buildThemeCss(mutate(t => { t.layout.density = "compact"; }) as ThemeSettings)).toContain("--space-4:12px;");
  });
  it("uses only the colour variables of the setting", () => {
    const css = buildThemeCss(mutate(t => { t.colours.light.headerBg = "#102030"; t.colours.light.headerText = "#ffffff"; }) as ThemeSettings);
    expect(css).toContain("--header-bg:#102030;--header-text:#ffffff;");
  });
  it("every key is emitted for both modes", () => {
    const css = buildThemeCss(DEFAULT_THEME);
    for (const k of COLOUR_KEYS) expect(css.split(DEFAULT_THEME.colours.light[k]).length).toBeGreaterThan(1);
  });
  it("asset URLs are same-origin paths with a numeric version", () => {
    expect(assetUrl("logo-light", 12)).toBe("/api/site/asset/logo-light?v=12");
    expect(assetUrl("favicon", 3, "a.b")).toBe("/api/site/asset/favicon?v=3&theme_preview=a.b");
  });
});

describe("changedFields", () => {
  it("lists dotted field names only", () => {
    const b = clone(); b.colours.dark.bg = "#000000"; b.brand.siteName = "X"; b.navigation[0]!.label = "Find";
    expect(changedFields(DEFAULT_THEME, b).sort()).toEqual(["brand.siteName", "colours.dark.bg", "navigation"]);
    expect(changedFields(DEFAULT_THEME, clone())).toEqual([]);
  });
});

// ---- Image uploads ----
const png = (w: number, h: number, size = 100): Uint8Array => {
  const b = new Uint8Array(Math.max(size, 33));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
  return b;
};
const jpeg = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(40);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return b;
};
const webpVp8x = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(40);
  b.set([...Buffer.from("RIFF"), 32, 0, 0, 0, ...Buffer.from("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0, (w - 1) & 255, ((w - 1) >> 8) & 255, 0, (h - 1) & 255, ((h - 1) >> 8) & 255, 0]);
  return b;
};
const ico = (w: number): Uint8Array => {
  const b = new Uint8Array(60);
  b.set([0, 0, 1, 0, 1, 0, w === 256 ? 0 : w, w === 256 ? 0 : w, 0, 0, 1, 0, 32, 0, 30, 0, 0, 0, 22, 0, 0, 0]);
  return b;
};

describe("logo and favicon upload checks", () => {
  it("accepts PNG, JPEG and WebP logos and reads their size from the bytes", () => {
    expect(inspectSiteAsset("logo-light", "image/png", png(300, 80))).toEqual({ ok: true, contentType: "image/png", width: 300, height: 80 });
    expect(inspectSiteAsset("logo-dark", "image/jpeg", jpeg(400, 100))).toEqual({ ok: true, contentType: "image/jpeg", width: 400, height: 100 });
    expect(inspectSiteAsset("logo-light", "image/webp", webpVp8x(200, 60))).toEqual({ ok: true, contentType: "image/webp", width: 200, height: 60 });
  });
  it("accepts an ICO favicon only in the favicon slot", () => {
    expect(inspectSiteAsset("favicon", "image/x-icon", ico(32))).toMatchObject({ ok: true, contentType: "image/x-icon", width: 32 });
    expect(inspectSiteAsset("favicon", "image/vnd.microsoft.icon", ico(256))).toMatchObject({ ok: true, width: 256 });
    expect(inspectSiteAsset("logo-light", "image/x-icon", ico(32))).toMatchObject({ ok: false });
  });
  it("rejects SVG however it is declared or disguised", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>';
    for (const type of ["image/svg+xml", "image/png", "text/html", ""]) {
      const r = inspectSiteAsset("logo-light", type, enc(svg));
      expect(r.ok, type).toBe(false);
    }
    expect(inspectSiteAsset("logo-light", "image/png", enc('<?xml version="1.0"?><svg/>'))).toMatchObject({ ok: false });
    expect(inspectSiteAsset("logo-light", "image/png", enc("   \n<!DOCTYPE svg><svg/>"))).toMatchObject({ ok: false });
    expect(inspectSiteAsset("logo-light", "image/png", enc("<html><body>hi</body></html>"))).toMatchObject({ ok: false });
  });
  it("rejects a spoofed content type (declared type must match the bytes)", () => {
    expect(inspectSiteAsset("logo-light", "image/jpeg", png(100, 100))).toMatchObject({ ok: false, error: expect.stringMatching(/does not match/) });
    expect(inspectSiteAsset("logo-light", "image/png", jpeg(100, 100))).toMatchObject({ ok: false });
    expect(inspectSiteAsset("logo-light", "text/html", png(100, 100))).toMatchObject({ ok: false });
    expect(inspectSiteAsset("logo-light", undefined, png(100, 100))).toMatchObject({ ok: false });
    expect(inspectSiteAsset("logo-light", "image/png", new TextEncoder().encode("not an image at all, just text"))).toMatchObject({ ok: false });
    expect(inspectSiteAsset("logo-light", "application/pdf", new TextEncoder().encode("%PDF-1.7 hello"))).toMatchObject({ ok: false });
  });
  it("enforces the size cap and dimension caps", () => {
    expect(inspectSiteAsset("logo-light", "image/png", png(100, 100, MAX_ASSET_BYTES))).toMatchObject({ ok: true });
    expect(inspectSiteAsset("logo-light", "image/png", png(100, 100, MAX_ASSET_BYTES + 1))).toMatchObject({ ok: false, error: expect.stringMatching(/512 KB/) });
    expect(inspectSiteAsset("logo-light", "image/png", png(2001, 100))).toMatchObject({ ok: false });
    expect(inspectSiteAsset("logo-light", "image/png", png(100, 100000))).toMatchObject({ ok: false });
    expect(inspectSiteAsset("favicon", "image/png", png(513, 513))).toMatchObject({ ok: false });
    expect(inspectSiteAsset("favicon", "image/png", png(512, 512))).toMatchObject({ ok: true });
    expect(inspectSiteAsset("logo-light", "image/png", png(8, 8))).toMatchObject({ ok: false });
    expect(inspectSiteAsset("logo-light", "image/png", new Uint8Array(0))).toMatchObject({ ok: false });
  });
  it("rejects unknown slots and truncated files", () => {
    expect(inspectSiteAsset("../../etc/passwd", "image/png", png(100, 100))).toMatchObject({ ok: false });
    expect(inspectSiteAsset(undefined, "image/png", png(100, 100))).toMatchObject({ ok: false });
    expect(inspectSiteAsset("logo-light", "image/png", png(100, 100).subarray(0, 12))).toMatchObject({ ok: false });
    expect(inspectSiteAsset("logo-light", "image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2]))).toMatchObject({ ok: false });
  });
});

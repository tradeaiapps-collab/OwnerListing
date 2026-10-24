import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME, type ThemeSettings } from "../src/domain/site-theme";

const state = vi.hoisted(() => ({ published: null as unknown, draft: null as unknown, fail: false, reads: 0 }));
vi.mock("../src/server/context", () => ({ getDb: () => { throw new Error("DATABASE_URL is required."); } }));
vi.mock("../src/server/site-theme-db", () => ({
  loadPublished: async () => { state.reads++; if (state.fail) throw new Error("db down"); return state.published; },
  loadDraft: async () => { if (state.fail) throw new Error("db down"); return state.draft; }
}));

import { THEME_CACHE_MS, brandFor, clearThemeCache, getPublishedTheme, resolveTheme } from "../src/server/site-theme";
import { signPreviewToken } from "../src/server/theme-preview";

const SECRET = "s".repeat(40);
const db = () => ({ query: async () => ({ rows: [] }) });
const themed = (name: string): ThemeSettings => ({ ...structuredClone(DEFAULT_THEME), brand: { ...DEFAULT_THEME.brand, siteName: name } });
const NOW = 1_900_000_000_000;

beforeEach(() => { clearThemeCache(); state.published = null; state.draft = null; state.fail = false; state.reads = 0; });

describe("published theme at request time", () => {
  it("is the built-in defaults when nothing was published", async () => {
    expect(await getPublishedTheme(db, NOW)).toEqual({ settings: DEFAULT_THEME, version: null, source: "default", previewToken: null });
  });
  it("falls back to the defaults when the database is unavailable or DATABASE_URL is not set", async () => {
    state.fail = true;
    expect((await getPublishedTheme(db, NOW)).source).toBe("default");
    clearThemeCache();
    // No injected db: the real accessor throws (no DATABASE_URL); the page must still render.
    expect(await getPublishedTheme(undefined, NOW)).toMatchObject({ source: "default", settings: DEFAULT_THEME });
  });
  it("caches for about 45 seconds, then reads again", async () => {
    state.published = { version: 3, settings: themed("One") };
    expect((await getPublishedTheme(db, NOW)).settings.brand.siteName).toBe("One");
    state.published = { version: 4, settings: themed("Two") };
    expect((await getPublishedTheme(db, NOW + THEME_CACHE_MS - 1)).settings.brand.siteName).toBe("One");
    expect((await getPublishedTheme(db, NOW + THEME_CACHE_MS + 1)).settings.brand.siteName).toBe("Two");
    expect(state.reads).toBe(2);
    expect(THEME_CACHE_MS).toBeGreaterThanOrEqual(30_000);
    expect(THEME_CACHE_MS).toBeLessThanOrEqual(60_000);
  });
  it("a failure is remembered briefly (10 s) so a dead database is not hit on every request, then retried", async () => {
    state.fail = true;
    await getPublishedTheme(db, NOW);
    await getPublishedTheme(db, NOW + 5_000);
    expect(state.reads).toBe(1);
    state.fail = false; state.published = { version: 1, settings: themed("Back") };
    expect((await getPublishedTheme(db, NOW + 11_000)).settings.brand.siteName).toBe("Back");
  });
});

describe("preview", () => {
  const env = { THEME_PREVIEW_SECRET: SECRET };
  const tok = (exp: number, secret = SECRET) => signPreviewToken({ uid: "u", exp }, secret);
  beforeEach(() => { state.published = { version: 1, settings: themed("Live") }; state.draft = { version: 2, settings: themed("Draft") }; });

  it("shows the draft only for a valid, unexpired token", async () => {
    const t = tok(Math.floor(NOW / 1000) + 600);
    expect(await resolveTheme(t, env, db, NOW)).toMatchObject({ source: "draft", version: 2, previewToken: t });
    expect((await resolveTheme(t, env, db, NOW)).settings.brand.siteName).toBe("Draft");
  });
  it("shows the published theme for an expired token, a token for another secret, garbage, or no secret configured", async () => {
    const expired = tok(Math.floor(NOW / 1000) - 1);
    for (const [t, e] of [[expired, env], [tok(Math.floor(NOW / 1000) + 600, "z".repeat(40)), env], ["garbage", env], [null, env], [tok(Math.floor(NOW / 1000) + 600), {}], [tok(Math.floor(NOW / 1000) + 600), { THEME_PREVIEW_SECRET: "short" }]] as const) {
      clearThemeCache();
      const r = await resolveTheme(t, e, db, NOW);
      expect(r.source, String(t)).toBe("published");
      expect(r.settings.brand.siteName).toBe("Live");
      expect(r.previewToken).toBeNull();
    }
  });
  it("a preview is never cached into the published cache", async () => {
    const t = tok(Math.floor(NOW / 1000) + 600);
    await resolveTheme(t, env, db, NOW);
    expect((await getPublishedTheme(db, NOW + 1)).settings.brand.siteName).toBe("Live");
  });
  it("a draft read failure falls back to the defaults, not an error page", async () => {
    state.fail = true;
    expect((await resolveTheme(tok(Math.floor(NOW / 1000) + 600), env, db, NOW)).source).toBe("default");
  });
});

describe("brand", () => {
  it("the admin's name and tagline override the environment; empty means the environment default", () => {
    const env = { SITE_NAME: "From Env", SITE_TAGLINE: "Env tagline" };
    expect(brandFor(DEFAULT_THEME, env)).toEqual({ name: "From Env", tagline: "Env tagline" });
    const t = structuredClone(DEFAULT_THEME); t.brand.siteName = "Admin Name";
    expect(brandFor(t, env)).toEqual({ name: "Admin Name", tagline: "Env tagline" });
    expect(brandFor(DEFAULT_THEME, {})).toEqual({ name: "OwnerListing", tagline: "Sell or rent your property yourself" });
  });
});

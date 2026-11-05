import { readBrand, type Brand } from "../config/brand";
import { DEFAULT_THEME, type ThemeSettings } from "../domain/site-theme";
import { getDb } from "./context";
import type { Queryable } from "./db";
import { loadDraft, loadPublished } from "./site-theme-db";
import { PREVIEW_PARAM, verifyPreviewToken } from "./theme-preview";

/** What the layout needs to draw a page: the settings, where they came from, and (for a preview) the token to put on image links. */
export interface ResolvedTheme { settings: ThemeSettings; version: number | null; source: "published" | "draft" | "default" | "tenant"; previewToken: string | null; tenantId?: string }

export const THEME_CACHE_MS = 45_000;
const FAILURE_CACHE_MS = 10_000;
// On globalThis so every route bundle in this server process shares one cache (and a publish can clear it for all of them).
const g = globalThis as unknown as { __olThemeCache?: { at: number; ttl: number; value: ResolvedTheme } | null };

export const clearThemeCache = () => { g.__olThemeCache = null; };
const defaults = (): ResolvedTheme => ({ settings: structuredClone(DEFAULT_THEME), version: null, source: "default", previewToken: null });

type DbSource = () => Queryable;

/**
 * Published settings for the public site, cached for about 45 seconds per server instance. If the database or the settings are
 * unavailable (no DATABASE_URL, outage, bad row) the built-in defaults are used, so the site still renders.
 */
export async function getPublishedTheme(db: DbSource = getDb, now: number = Date.now()): Promise<ResolvedTheme> {
  const cache = g.__olThemeCache;
  if (cache && now - cache.at < cache.ttl) return cache.value;
  let value: ResolvedTheme, ttl = THEME_CACHE_MS;
  try {
    const p = await loadPublished(db());
    value = p ? { settings: p.settings, version: p.version, source: "published", previewToken: null } : defaults();
  } catch {
    value = defaults();
    ttl = FAILURE_CACHE_MS;
  }
  g.__olThemeCache = { at: now, ttl, value };
  return value;
}

/**
 * The theme for one request. A valid, unexpired preview token (signed with THEME_PREVIEW_SECRET, issued only to staff with theme.edit)
 * shows the draft, uncached. Any other token, or an error, shows the published theme.
 */
export async function resolveTheme(previewToken: string | null, env: Record<string, string | undefined> = process.env, db: DbSource = getDb, now: number = Date.now()): Promise<ResolvedTheme> {
  if (previewToken && verifyPreviewToken(previewToken, env["THEME_PREVIEW_SECRET"], Math.floor(now / 1000))) {
    try {
      const d = await loadDraft(db());
      return { settings: d.settings, version: d.version, source: "draft", previewToken };
    } catch {
      return defaults();
    }
  }
  return getPublishedTheme(db, now);
}

export const brandFor = (t: ThemeSettings, env: Record<string, string | undefined> = process.env): Brand => {
  const base = readBrand(env);
  return { name: t.brand.siteName ?? base.name, tagline: t.brand.tagline ?? base.tagline };
};

export { PREVIEW_PARAM };

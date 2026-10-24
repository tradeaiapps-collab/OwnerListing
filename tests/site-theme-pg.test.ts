import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_THEME, type ThemeSettings } from "../src/domain/site-theme";
import type { StaffActor } from "../src/domain/staff-access";
import {
  assetsExist, insertAsset, loadAssetFile, loadDraft, loadPublished, loadView, publishDraft, resetToDefaults, revertTo, saveDraft
} from "../src/server/site-theme-db";
import { getPublishedTheme, clearThemeCache, resolveTheme } from "../src/server/site-theme";
import { signPreviewToken } from "../src/server/theme-preview";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("site theme on Postgres", () => {
  let t: TestDb;
  let staff: StaffActor, other: StaffActor;
  const withName = (name: string): ThemeSettings => ({ ...structuredClone(DEFAULT_THEME), brand: { ...DEFAULT_THEME.brand, siteName: name } });
  const png = Buffer.alloc(64, 1);

  beforeAll(async () => {
    t = await createTestDb();
    staff = { id: await addUser(t.db, "admin"), role: "designer" };
    other = { id: await addUser(t.db, "admin"), role: "super_admin" };
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("starts with nothing published: the built-in defaults apply", async () => {
    expect(await loadPublished(t.db)).toBeNull();
    const v = await loadView(t.db);
    expect(v).toMatchObject({ draftVersion: null, publishedVersion: null, versions: [] });
    expect(v.published).toEqual(DEFAULT_THEME);
    expect((await t.db.query("SELECT count(*)::int AS n FROM site_theme_current")).rows[0]!["n"]).toBe(1);
  });

  it("a save is a draft: not live until published", async () => {
    const a = await saveDraft(t.db, staff, null, withName("Draft One"));
    expect(a).toMatchObject({ ok: true, changed: ["brand.siteName"] });
    expect(await loadPublished(t.db)).toBeNull();
    expect((await loadDraft(t.db)).settings.brand.siteName).toBe("Draft One");
    const pub = await publishDraft(t.db, staff, (a as { version: number }).version);
    expect(pub.ok).toBe(true);
    expect((await loadPublished(t.db))!.settings.brand.siteName).toBe("Draft One");
  });

  it("saving unchanged settings does not create a new version", async () => {
    const before = (await loadView(t.db)).versions.length;
    const cur = (await loadView(t.db)).draftVersion;
    const r = await saveDraft(t.db, staff, cur, withName("Draft One"));
    expect(r).toMatchObject({ ok: true, changed: [] });
    expect((await loadView(t.db)).versions.length).toBe(before);
  });

  it("refuses a stale save and a publish of a draft that is not the current one (no lost updates)", async () => {
    const base = (await loadView(t.db)).draftVersion;
    const first = await saveDraft(t.db, staff, base, withName("Two"));
    expect(first.ok).toBe(true);
    const stale = await saveDraft(t.db, other, base, withName("Three"));
    expect(stale).toMatchObject({ ok: false, code: "conflict" });
    expect((await loadDraft(t.db)).settings.brand.siteName).toBe("Two");
    expect(await publishDraft(t.db, other, base!)).toMatchObject({ ok: false, code: "conflict" });
    expect((await loadPublished(t.db))!.settings.brand.siteName).toBe("Draft One");
    expect((await publishDraft(t.db, other, (first as { version: number }).version)).ok).toBe(true);
    expect((await loadPublished(t.db))!.settings.brand.siteName).toBe("Two");
  });

  it("two concurrent saves from the same base: exactly one wins", async () => {
    const base = (await loadView(t.db)).draftVersion;
    const r = await Promise.all([saveDraft(t.db, staff, base, withName("Race A")), saveDraft(t.db, other, base, withName("Race B"))]);
    expect(r.filter(x => x.ok)).toHaveLength(1);
    expect(r.filter(x => !x.ok)[0]).toMatchObject({ code: "conflict" });
  });

  it("history is insert-only; revert creates a NEW version, goes live, and keeps the old rows", async () => {
    const view = await loadView(t.db);
    const target = view.versions.find(v => v.version === 1)!;
    const count = view.versions.length;
    const r = await revertTo(t.db, other, target.version);
    expect(r.ok).toBe(true);
    const after = await loadView(t.db);
    expect(after.versions.length).toBe(count + 1);
    const top = after.versions[0]!;
    expect(top).toMatchObject({ source: "revert", revertedFrom: 1, live: true, draft: true });
    expect(top.version).toBeGreaterThan(count);
    expect(after.published.brand.siteName).toBe("Draft One");
    expect(after.versions.find(v => v.version === 1)!.live).toBe(false);
    expect((await revertTo(t.db, other, 999999))).toMatchObject({ ok: false, code: "not_found" });
    // who and when
    expect(top.publishedAt).toBeTruthy();
    expect((await t.db.query("SELECT action, published_by FROM site_theme_publish ORDER BY id DESC LIMIT 1")).rows[0]).toEqual({ action: "revert", published_by: other.id });
  });

  it("reset makes a new draft of the defaults that is not live until published", async () => {
    const base = (await loadView(t.db)).draftVersion;
    expect(await resetToDefaults(t.db, staff, 12345)).toMatchObject({ ok: false, code: "conflict" });
    const r = await resetToDefaults(t.db, staff, base);
    expect(r.ok).toBe(true);
    const v = await loadView(t.db);
    expect(v.versions[0]).toMatchObject({ source: "reset", draft: true, live: false });
    expect(v.draft).toEqual(DEFAULT_THEME);
    expect(v.published.brand.siteName).toBe("Draft One");
  });

  it("version, asset and publish rows cannot be updated or deleted; the pointer row cannot be deleted", async () => {
    const id = await insertAsset(t.db, staff, { name: "logo-light", contentType: "image/png", bytes: png, width: 64, height: 64 });
    for (const sql of [
      "UPDATE site_theme_version SET source = 'save'", "DELETE FROM site_theme_version",
      "UPDATE site_theme_asset SET name = 'favicon'", "DELETE FROM site_theme_asset",
      "UPDATE site_theme_publish SET action = 'publish'", "DELETE FROM site_theme_publish", "DELETE FROM site_theme_current"
    ]) await expect(t.db.query(sql), sql).rejects.toThrow();
    expect(id).toBeGreaterThan(0);
  });

  it("settings must be JSON objects and asset rows obey their checks", async () => {
    await expect(t.db.query("INSERT INTO site_theme_version (settings, source, created_by) VALUES ('[]'::jsonb, 'save', $1)", [staff.id])).rejects.toThrow();
    await expect(t.db.query("INSERT INTO site_theme_asset (name, content_type, bytes, sha256, width, height, created_by) VALUES ('logo-light','image/svg+xml', 'x', repeat('a',64), 10, 10, $1)", [staff.id])).rejects.toThrow();
    await expect(t.db.query("INSERT INTO site_theme_asset (name, content_type, bytes, sha256, width, height, created_by) VALUES ('evil','image/png', 'x', repeat('a',64), 10, 10, $1)", [staff.id])).rejects.toThrow();
    await expect(t.db.query("INSERT INTO site_theme_asset (name, content_type, bytes, sha256, width, height, created_by) VALUES ('favicon','image/png', repeat('x', 600000)::bytea, repeat('a',64), 10, 10, $1)", [staff.id])).rejects.toThrow();
  });

  it("assets: settings may only point at uploaded images of the right slot; files are served only once published (or for the draft)", async () => {
    const logo = await insertAsset(t.db, staff, { name: "logo-light", contentType: "image/png", bytes: png, width: 64, height: 64 });
    const fav = await insertAsset(t.db, staff, { name: "favicon", contentType: "image/x-icon", bytes: Buffer.from([0, 0, 1, 0]), width: 32, height: 32 });
    const mk = (b: Partial<ThemeSettings["brand"]>): ThemeSettings => ({ ...structuredClone(DEFAULT_THEME), brand: { ...DEFAULT_THEME.brand, ...b } });
    expect(await assetsExist(t.db, mk({ logoLight: logo }))).toBe(true);
    expect(await assetsExist(t.db, mk({ logoDark: logo }))).toBe(false); // wrong slot
    expect(await assetsExist(t.db, mk({ logoLight: 999999 }))).toBe(false);
    expect(await saveDraft(t.db, staff, (await loadView(t.db)).draftVersion, mk({ logoLight: 999999 }))).toMatchObject({ ok: false, code: "bad_asset" });

    const saved = await saveDraft(t.db, staff, (await loadView(t.db)).draftVersion, mk({ logoLight: logo, favicon: fav }));
    expect(saved.ok).toBe(true);
    // Draft only: the public route (published scope) does not serve it; the preview scope does.
    expect(await loadAssetFile(t.db, "logo-light", logo, "published")).toBeNull();
    expect((await loadAssetFile(t.db, "logo-light", logo, "draft"))!.contentType).toBe("image/png");
    expect(await publishDraft(t.db, staff, (saved as { version: number }).version)).toMatchObject({ ok: true });
    const f = await loadAssetFile(t.db, "logo-light", logo, "published");
    expect(f!.contentType).toBe("image/png");
    expect(f!.bytes.equals(png)).toBe(true);
    expect((await loadAssetFile(t.db, "favicon", fav, "published"))!.contentType).toBe("image/x-icon");
    // Right id, wrong slot name, or an id the published version does not use: nothing.
    expect(await loadAssetFile(t.db, "logo-dark", logo, "published")).toBeNull();
    expect(await loadAssetFile(t.db, "favicon", logo, "published")).toBeNull();
    const unused = await insertAsset(t.db, staff, { name: "logo-light", contentType: "image/png", bytes: png, width: 64, height: 64 });
    expect(await loadAssetFile(t.db, "logo-light", unused, "published")).toBeNull();
    expect(await loadAssetFile(t.db, "logo-light", unused, "draft")).toBeNull();
  });

  it("audits every change with field names and the version, never the values or file bytes", async () => {
    const rows = (await t.db.query("SELECT event_type, actor_id, aggregate_id, payload FROM audit_event WHERE aggregate_type = 'site_theme' ORDER BY occurred_at")).rows;
    const types = rows.map(r => r["event_type"]);
    expect(types).toEqual(expect.arrayContaining(["site.theme_saved", "site.theme_published", "site.theme_reverted", "site.theme_reset", "site.asset_uploaded"]));
    const saved = rows.find(r => r["event_type"] === "site.theme_saved")!;
    expect(saved["actor_id"]).toBe(staff.id);
    expect(saved["payload"]).toMatchObject({ role: "designer", fields: ["brand.siteName"] });
    const json = JSON.stringify(rows);
    expect(json).not.toContain("Draft One");
    expect(json).not.toContain("Race A");
    const up = rows.find(r => r["event_type"] === "site.asset_uploaded")!;
    expect(Object.keys(up["payload"] as object).sort()).toEqual(["bytes", "contentType", "role", "sha256", "slot", "version"]);
  });

  it("loader: published theme is cached, preview needs a valid unexpired token, and a database error falls back to the defaults", async () => {
    clearThemeCache();
    const live = (await loadView(t.db)).published;
    const a = await getPublishedTheme(() => t.db, 1_000_000);
    expect(a).toMatchObject({ source: "published", settings: live });
    // Cached: a broken database within the TTL still returns the same theme.
    const broken = () => ({ query: async () => { throw new Error("down"); } });
    expect((await getPublishedTheme(broken, 1_000_000 + 30_000)).source).toBe("published");
    // After the TTL the failure falls back to the defaults.
    expect(await getPublishedTheme(broken, 1_000_000 + 60_000)).toMatchObject({ source: "default", settings: DEFAULT_THEME });

    const secret = "p".repeat(40);
    const env = { THEME_PREVIEW_SECRET: secret };
    const now = 2_000_000_000_000;
    const good = signPreviewToken({ uid: staff.id, exp: Math.floor(now / 1000) + 600 }, secret);
    clearThemeCache();
    const draft = await resolveTheme(good, env, () => t.db, now);
    expect(draft).toMatchObject({ source: "draft", previewToken: good, settings: (await loadView(t.db)).draft });
    const expired = signPreviewToken({ uid: staff.id, exp: Math.floor(now / 1000) - 1 }, secret);
    expect((await resolveTheme(expired, env, () => t.db, now)).source).toBe("published");
  });
});

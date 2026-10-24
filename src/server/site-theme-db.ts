import { createHash, randomUUID } from "node:crypto";
import { changedFields, DEFAULT_THEME, parseStoredTheme, type ThemeSettings } from "../domain/site-theme";
import type { AssetMime, SiteAssetName } from "../domain/site-asset";
import type { StaffActor } from "../domain/staff-access";
import { appendAuditPg, type Queryable } from "./db";

/** Persistence for the site appearance. All SQL is constant text with bound parameters; settings are validated before they reach this layer. */

export interface VersionRow {
  version: number; source: "save" | "revert" | "reset"; revertedFrom: number | null; createdBy: string; createdAt: string;
  publishedAt: string | null; publishedBy: string | null; live: boolean; draft: boolean;
}
export interface ThemeView {
  draftVersion: number | null; publishedVersion: number | null;
  draft: ThemeSettings; published: ThemeSettings; versions: VersionRow[];
}
export type SaveOutcome = { ok: true; version: number; changed: string[] } | { ok: false; code: "conflict" | "bad_asset" | "not_found" | "no_draft"; error: string };

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const n = (v: unknown) => Number(v);
const settingsOf = (v: unknown): ThemeSettings => parseStoredTheme(typeof v === "string" ? JSON.parse(v) : v);

async function inTx<T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new Error("Transactions are required.");
  return db.transaction(fn);
}

/** The settings the public site shows now, or null when nothing was ever published (then the built-in defaults apply). */
export async function loadPublished(db: Queryable): Promise<{ version: number; settings: ThemeSettings } | null> {
  const r = await db.query(
    `SELECT v.version, v.settings FROM site_theme_current c JOIN site_theme_version v ON v.version = c.published_version`
  );
  const row = r.rows[0];
  return row ? { version: n(row["version"]), settings: settingsOf(row["settings"]) } : null;
}

/** The draft (falls back to the published settings, then the defaults). Used by preview. */
export async function loadDraft(db: Queryable): Promise<{ version: number | null; settings: ThemeSettings }> {
  const r = await db.query(
    `SELECT v.version, v.settings FROM site_theme_current c
       JOIN site_theme_version v ON v.version = COALESCE(c.draft_version, c.published_version)`
  );
  const row = r.rows[0];
  return row ? { version: n(row["version"]), settings: settingsOf(row["settings"]) } : { version: null, settings: structuredClone(DEFAULT_THEME) };
}

export async function loadView(db: Queryable): Promise<ThemeView> {
  const cur = (await db.query(`SELECT draft_version, published_version FROM site_theme_current`)).rows[0];
  const draftVersion = cur?.["draft_version"] == null ? null : n(cur["draft_version"]);
  const publishedVersion = cur?.["published_version"] == null ? null : n(cur["published_version"]);
  const draft = await loadDraft(db);
  const pub = await loadPublished(db);
  const rows = (await db.query(
    `SELECT v.version, v.source, v.reverted_from, COALESCE(u.display_name, u.email, v.created_by::text) AS created_by, v.created_at,
            p.published_at, COALESCE(pu.display_name, pu.email) AS published_by
       FROM site_theme_version v
       LEFT JOIN app_user u ON u.id = v.created_by
       LEFT JOIN LATERAL (SELECT published_at, published_by FROM site_theme_publish WHERE version = v.version ORDER BY id DESC LIMIT 1) p ON true
       LEFT JOIN app_user pu ON pu.id = p.published_by
      ORDER BY v.version DESC LIMIT 50`
  )).rows;
  const versions: VersionRow[] = rows.map(r => ({
    version: n(r["version"]), source: r["source"] as VersionRow["source"], revertedFrom: r["reverted_from"] == null ? null : n(r["reverted_from"]),
    createdBy: String(r["created_by"]), createdAt: iso(r["created_at"]),
    publishedAt: r["published_at"] == null ? null : iso(r["published_at"]), publishedBy: r["published_by"] == null ? null : String(r["published_by"]),
    live: n(r["version"]) === publishedVersion, draft: n(r["version"]) === draftVersion
  }));
  return { draftVersion, publishedVersion, draft: draft.settings, published: pub?.settings ?? structuredClone(DEFAULT_THEME), versions };
}

const lockCurrent = async (tx: Queryable) => {
  const r = await tx.query(`SELECT draft_version, published_version FROM site_theme_current WHERE id FOR UPDATE`);
  const row = r.rows[0]!;
  return { draft: row["draft_version"] == null ? null : n(row["draft_version"]), published: row["published_version"] == null ? null : n(row["published_version"]) };
};

const audit = (tx: Queryable, staff: StaffActor, eventType: string, version: number | string, payload: Record<string, unknown>) =>
  appendAuditPg(tx, {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: staff.id, aggregateType: "site_theme",
    aggregateId: String(version), eventType, correlationId: randomUUID(), payload: { role: staff.role, version, ...payload }
  });

/** True when every asset id in the settings exists and was uploaded for that slot. */
export async function assetsExist(db: Queryable, s: ThemeSettings): Promise<boolean> {
  const wanted: [number | null, SiteAssetName][] = [[s.brand.logoLight, "logo-light"], [s.brand.logoDark, "logo-dark"], [s.brand.favicon, "favicon"]];
  for (const [id, name] of wanted) {
    if (id === null) continue;
    if ((await db.query(`SELECT 1 FROM site_theme_asset WHERE id = $1 AND name = $2`, [id, name])).rows.length === 0) return false;
  }
  return true;
}

/** Saves settings as a new draft version. `baseVersion` is the draft the editor loaded; if someone saved since, nothing is written (conflict). */
export async function saveDraft(db: Queryable, staff: StaffActor, baseVersion: number | null, settings: ThemeSettings): Promise<SaveOutcome> {
  if (!(await assetsExist(db, settings))) return { ok: false, code: "bad_asset", error: "An image in these settings was not uploaded here." };
  return inTx(db, async tx => {
    const cur = await lockCurrent(tx);
    if (cur.draft !== baseVersion) return { ok: false, code: "conflict", error: "The draft changed since you opened it. Reload to see the latest." };
    const before = cur.draft === null ? (await loadPublishedTx(tx))?.settings ?? DEFAULT_THEME : (await versionSettings(tx, cur.draft)) ?? DEFAULT_THEME;
    const changed = changedFields(before, settings);
    if (cur.draft !== null && changed.length === 0) return { ok: true, version: cur.draft, changed };
    const version = await insertVersion(tx, settings, "save", null, staff.id);
    await tx.query(`UPDATE site_theme_current SET draft_version = $1, updated_at = now() WHERE id`, [version]);
    await audit(tx, staff, "site.theme_saved", version, { fields: changed.slice(0, 60), basedOn: cur.draft });
    return { ok: true, version, changed };
  });
}

const loadPublishedTx = (tx: Queryable) => loadPublished(tx);
async function versionSettings(db: Queryable, version: number): Promise<ThemeSettings | null> {
  const r = await db.query(`SELECT settings FROM site_theme_version WHERE version = $1`, [version]);
  return r.rows[0] ? settingsOf(r.rows[0]["settings"]) : null;
}
async function insertVersion(tx: Queryable, s: ThemeSettings, source: "save" | "revert" | "reset", from: number | null, by: string): Promise<number> {
  const r = await tx.query(
    `INSERT INTO site_theme_version (settings, source, reverted_from, created_by) VALUES ($1::jsonb, $2, $3, $4) RETURNING version`,
    [JSON.stringify(s), source, from, by]
  );
  return n(r.rows[0]!["version"]);
}

/** Makes the current draft live. `version` must be the draft the person saw (not a later one). */
export async function publishDraft(db: Queryable, staff: StaffActor, version: number): Promise<SaveOutcome> {
  return inTx(db, async tx => {
    const cur = await lockCurrent(tx);
    if (cur.draft === null) return { ok: false, code: "no_draft", error: "There is no draft to publish." };
    if (cur.draft !== version) return { ok: false, code: "conflict", error: "The draft changed since you opened it. Reload and review it first." };
    const s = await versionSettings(tx, version);
    if (!s || !(await assetsExist(tx, s))) return { ok: false, code: "bad_asset", error: "An image in this draft is missing." };
    await tx.query(`UPDATE site_theme_current SET published_version = $1, updated_at = now() WHERE id`, [version]);
    await tx.query(`INSERT INTO site_theme_publish (version, action, published_by) VALUES ($1, 'publish', $2)`, [version, staff.id]);
    await audit(tx, staff, "site.theme_published", version, { previous: cur.published });
    return { ok: true, version, changed: [] };
  });
}

/** Rollback: copies version N into a new version and makes it live at once (draft too). History stays; N itself is untouched. */
export async function revertTo(db: Queryable, staff: StaffActor, from: number): Promise<SaveOutcome> {
  return inTx(db, async tx => {
    const cur = await lockCurrent(tx);
    const s = await versionSettings(tx, from);
    if (!s) return { ok: false, code: "not_found", error: "That version does not exist." };
    if (!(await assetsExist(tx, s))) return { ok: false, code: "bad_asset", error: "An image in that version is missing." };
    const version = await insertVersion(tx, s, "revert", from, staff.id);
    await tx.query(`UPDATE site_theme_current SET draft_version = $1, published_version = $1, updated_at = now() WHERE id`, [version]);
    await tx.query(`INSERT INTO site_theme_publish (version, action, published_by) VALUES ($1, 'revert', $2)`, [version, staff.id]);
    await audit(tx, staff, "site.theme_reverted", version, { revertedFrom: from, previous: cur.published });
    return { ok: true, version, changed: [] };
  });
}

/** Reset to the built-in defaults: a new draft version (not live until published). */
export async function resetToDefaults(db: Queryable, staff: StaffActor, baseVersion: number | null): Promise<SaveOutcome> {
  return inTx(db, async tx => {
    const cur = await lockCurrent(tx);
    if (cur.draft !== baseVersion) return { ok: false, code: "conflict", error: "The draft changed since you opened it. Reload to see the latest." };
    const version = await insertVersion(tx, structuredClone(DEFAULT_THEME), "reset", null, staff.id);
    await tx.query(`UPDATE site_theme_current SET draft_version = $1, updated_at = now() WHERE id`, [version]);
    await audit(tx, staff, "site.theme_reset", version, { basedOn: cur.draft });
    return { ok: true, version, changed: [] };
  });
}

export async function insertAsset(
  db: Queryable, staff: StaffActor, a: { name: SiteAssetName; contentType: AssetMime; bytes: Buffer; width: number; height: number }
): Promise<number> {
  return inTx(db, async tx => {
    const sha = createHash("sha256").update(a.bytes).digest("hex");
    const r = await tx.query(
      `INSERT INTO site_theme_asset (name, content_type, bytes, sha256, width, height, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [a.name, a.contentType, a.bytes, sha, a.width, a.height, staff.id]
    );
    const id = n(r.rows[0]!["id"]);
    await audit(tx, staff, "site.asset_uploaded", id, { slot: a.name, contentType: a.contentType, bytes: a.bytes.length, sha256: sha });
    return id;
  });
}

export interface AssetFile { contentType: string; bytes: Buffer; sha256: string }

/**
 * An uploaded file for the public asset route. Served only when the published version uses it, or (preview) when the draft does.
 * Anything else is null, so unpublished uploads are not readable by guessing ids.
 */
export async function loadAssetFile(db: Queryable, name: SiteAssetName, id: number, scope: "published" | "draft"): Promise<AssetFile | null> {
  const key = name === "logo-light" ? "logoLight" : name === "logo-dark" ? "logoDark" : "favicon";
  const versionCol = scope === "published" ? "c.published_version" : "COALESCE(c.draft_version, c.published_version)";
  const r = await db.query(
    `SELECT a.content_type, a.bytes, a.sha256
       FROM site_theme_asset a
       JOIN site_theme_current c ON true
       JOIN site_theme_version v ON v.version = ${versionCol}
      WHERE a.id = $1 AND a.name = $2 AND (v.settings #>> ARRAY['brand', $3::text]) = $4::text`,
    [id, name, key, String(id)]
  );
  const row = r.rows[0];
  return row ? { contentType: String(row["content_type"]), bytes: Buffer.from(row["bytes"] as Buffer), sha256: String(row["sha256"]) } : null;
}

import { randomUUID } from "node:crypto";
import { DEFAULT_GUIDE, parseStoredGuide, type GuideContent } from "../domain/guide-assistant";
import type { StaffActor } from "../domain/staff-access";
import { getDb } from "./context";
import { appendAuditPg, type Queryable } from "./db";

/**
 * Guide assistant content. Insert-only: every save is a new version row, every publish a new publish row; the live content is the
 * version named by the latest publish. Constant SQL with bound parameters; content is validated before it reaches this layer.
 */
export interface GuideVersionRow { version: number; createdBy: string; createdAt: string; live: boolean }
export interface GuideView { draftVersion: number | null; liveVersion: number | null; draft: GuideContent; live: GuideContent; versions: GuideVersionRow[] }
export type GuideOutcome = { ok: true; version: number } | { ok: false; code: "conflict" | "not_found"; error: string };

const n = (v: unknown) => Number(v);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
// One lock key for every guide write, so two concurrent saves cannot both pass the "base version" check.
const LOCK = `SELECT pg_advisory_xact_lock(hashtext('guide_assistant_content'))`;

async function inTx<T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new Error("Transactions are required.");
  return db.transaction(fn);
}
const latestVersion = async (db: Queryable): Promise<number | null> => {
  const r = await db.query(`SELECT max(version) AS v FROM guide_assistant_version`);
  return r.rows[0]?.["v"] == null ? null : n(r.rows[0]["v"]);
};
const liveVersion = async (db: Queryable): Promise<number | null> => {
  const r = await db.query(`SELECT version FROM guide_assistant_publish ORDER BY id DESC LIMIT 1`);
  return r.rows[0] ? n(r.rows[0]["version"]) : null;
};
const contentOf = async (db: Queryable, version: number | null): Promise<GuideContent> => {
  if (version === null) return structuredClone(DEFAULT_GUIDE);
  const r = await db.query(`SELECT content FROM guide_assistant_version WHERE version = $1`, [version]);
  return r.rows[0] ? parseStoredGuide(r.rows[0]["content"]) : structuredClone(DEFAULT_GUIDE);
};

/** What visitors see now: the published content, or the built-in defaults when nothing was ever published. */
export async function loadLiveGuide(db: Queryable): Promise<GuideContent> {
  return contentOf(db, await liveVersion(db));
}

export async function loadGuideView(db: Queryable): Promise<GuideView> {
  const draftVersion = await latestVersion(db), live = await liveVersion(db);
  const rows = (await db.query(
    `SELECT v.version, COALESCE(u.display_name, u.email::text, v.created_by::text) AS created_by, v.created_at
       FROM guide_assistant_version v LEFT JOIN app_user u ON u.id = v.created_by
      ORDER BY v.version DESC LIMIT 30`
  )).rows;
  return {
    draftVersion, liveVersion: live, draft: await contentOf(db, draftVersion ?? live), live: await contentOf(db, live),
    versions: rows.map(r => ({ version: n(r["version"]), createdBy: String(r["created_by"]), createdAt: iso(r["created_at"]), live: n(r["version"]) === live }))
  };
}

const audit = (tx: Queryable, staff: StaffActor, eventType: string, version: number, payload: Record<string, unknown>) =>
  appendAuditPg(tx, {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: staff.id, aggregateType: "guide_assistant",
    aggregateId: String(version), eventType, correlationId: randomUUID(), payload: { role: staff.role, version, ...payload }
  });

/** Saves a new draft version. `baseVersion` is the draft the editor loaded; if someone saved since, nothing is written. */
export async function saveGuideDraft(db: Queryable, staff: StaffActor, baseVersion: number | null, content: GuideContent): Promise<GuideOutcome> {
  return inTx(db, async tx => {
    await tx.query(LOCK);
    if ((await latestVersion(tx)) !== baseVersion) return { ok: false, code: "conflict", error: "The content changed since you opened it. Reload to see the latest." };
    const r = await tx.query(`INSERT INTO guide_assistant_version (content, created_by) VALUES ($1::jsonb, $2) RETURNING version`, [JSON.stringify(content), staff.id]);
    const version = n(r.rows[0]!["version"]);
    await audit(tx, staff, "guide.content_saved", version, { basedOn: baseVersion, enabled: content.enabled });
    return { ok: true, version };
  });
}

/** Makes a saved version live. It must be the latest draft the person reviewed. */
export async function publishGuide(db: Queryable, staff: StaffActor, version: number): Promise<GuideOutcome> {
  const out = await inTx(db, async (tx): Promise<GuideOutcome> => {
    await tx.query(LOCK);
    const latest = await latestVersion(tx);
    if (latest === null) return { ok: false, code: "not_found", error: "Save the content first." };
    if (latest !== version) return { ok: false, code: "conflict", error: "The content changed since you opened it. Reload and review it first." };
    const previous = await liveVersion(tx);
    await tx.query(`INSERT INTO guide_assistant_publish (version, published_by) VALUES ($1, $2)`, [version, staff.id]);
    await audit(tx, staff, "guide.content_published", version, { previous });
    return { ok: true, version };
  });
  if (out.ok) clearGuideCache();
  return out;
}

// ---- Cache for the public site (like the theme): about 45 seconds; any failure gives the defaults, shortly cached. ----
const g = globalThis as unknown as { __olGuideCache?: { at: number; ttl: number; value: GuideContent } | null };
export const clearGuideCache = () => { g.__olGuideCache = null; };

export async function getLiveGuide(db: () => Queryable = getDb, now: number = Date.now()): Promise<GuideContent> {
  const c = g.__olGuideCache;
  if (c && now - c.at < c.ttl) return c.value;
  let value: GuideContent, ttl = 45_000;
  try { value = await loadLiveGuide(db()); } catch { value = structuredClone(DEFAULT_GUIDE); ttl = 10_000; }
  g.__olGuideCache = { at: now, ttl, value };
  return value;
}

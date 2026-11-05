import { createHmac, timingSafeEqual } from "node:crypto";
import { CATEGORIES, consentChanges, isCategory, resolvePreferences, type Category, type CategoryStats, type NotificationView, type Preferences } from "../domain/notifications";
import type { Queryable } from "./db";

// Constant SQL; user input only travels as bound parameters. Every query is scoped to one user id taken from the session.
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const isoOrNull = (v: unknown) => (v === null || v === undefined ? null : iso(v));

const view = (x: Record<string, unknown>): NotificationView => ({
  id: String(x["id"]), kind: String(x["kind"]), category: String(x["category"]) as Category, title: String(x["title"]), body: String(x["body"]),
  link: x["link"] === null ? null : String(x["link"]), createdAt: iso(x["created_at"]), readAt: isoOrNull(x["read_at"]), archivedAt: isoOrNull(x["archived_at"])
});

export type InboxStatus = "inbox" | "history";
export interface Page { items: NotificationView[]; nextBefore: string | null }

/** Newest first. "inbox" = not archived, "history" = archived. Cursor `before` is the createdAt|id of the last row seen. */
export async function listNotificationsPg(db: Queryable, userId: string, status: InboxStatus, limit: number, before?: { createdAt: string; id: string }): Promise<Page> {
  const n = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
  const r = await db.query(
    `SELECT id, kind, category, title, body, link, created_at, read_at, archived_at FROM notification
      WHERE user_id = $1::uuid AND (($2 = 'inbox' AND archived_at IS NULL) OR ($2 = 'history' AND archived_at IS NOT NULL))
        AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $5`,
    [userId, status, before?.createdAt ?? null, before?.id ?? "00000000-0000-0000-0000-000000000000", n + 1]);
  const items = r.rows.slice(0, n).map(view);
  const last = items[items.length - 1];
  return { items, nextBefore: r.rows.length > n && last ? `${last.createdAt}|${last.id}` : null };
}

export function parseCursor(v: string | null): { createdAt: string; id: string } | undefined {
  if (!v) return undefined;
  const [createdAt, id] = v.split("|");
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  return { createdAt: new Date(createdAt).toISOString(), id };
}

export async function unreadCountPg(db: Queryable, userId: string): Promise<number> {
  const r = await db.query("SELECT count(*)::int AS n FROM notification WHERE user_id = $1::uuid AND read_at IS NULL AND archived_at IS NULL", [userId]);
  return Number(r.rows[0]?.["n"] ?? 0);
}

export async function createNotificationPg(db: Queryable, userId: string, n: { kind: string; category: Category; title: string; body: string; link: string | null }): Promise<string> {
  const r = await db.query("INSERT INTO notification (user_id, kind, category, title, body, link) VALUES ($1::uuid,$2,$3,$4,$5,$6) RETURNING id", [userId, n.kind, n.category, n.title, n.body, n.link]);
  return String(r.rows[0]!["id"]);
}

/** Marks the given ids (or every unread one) read. Only the user's own rows can change. Returns how many changed. */
export async function markReadPg(db: Queryable, userId: string, ids: readonly string[] | "all"): Promise<number> {
  const r = ids === "all"
    ? await db.query("UPDATE notification SET read_at = now() WHERE user_id = $1::uuid AND read_at IS NULL AND archived_at IS NULL RETURNING id", [userId])
    : await db.query("UPDATE notification SET read_at = now() WHERE user_id = $1::uuid AND id = ANY($2::uuid[]) AND read_at IS NULL RETURNING id", [userId, ids]);
  return r.rows.length;
}

/** Moves to history (and marks read). */
export async function archivePg(db: Queryable, userId: string, ids: readonly string[] | "all_read"): Promise<number> {
  const r = ids === "all_read"
    ? await db.query("UPDATE notification SET archived_at = now() WHERE user_id = $1::uuid AND archived_at IS NULL AND read_at IS NOT NULL RETURNING id", [userId])
    : await db.query("UPDATE notification SET archived_at = now(), read_at = COALESCE(read_at, now()) WHERE user_id = $1::uuid AND id = ANY($2::uuid[]) AND archived_at IS NULL RETURNING id", [userId, ids]);
  return r.rows.length;
}

/** Erases the user's own history (archived notifications). The consent log is kept: it is the evidence of what they agreed to. */
export async function deleteHistoryPg(db: Queryable, userId: string): Promise<number> {
  const r = await db.query("DELETE FROM notification WHERE user_id = $1::uuid AND archived_at IS NOT NULL RETURNING id", [userId]);
  return r.rows.length;
}

export async function getPreferencesPg(db: Queryable, userId: string): Promise<Preferences> {
  const r = await db.query("SELECT category, in_app, email, sms FROM notification_preference WHERE user_id = $1::uuid", [userId]);
  return resolvePreferences(r.rows.map(x => ({ category: String(x["category"]), inApp: Boolean(x["in_app"]), email: Boolean(x["email"]), sms: Boolean(x["sms"]) })));
}

/** Saves the given categories and writes one consent-log row for every channel that flipped, in one transaction when the pool offers one. */
export async function savePreferencesPg(db: Queryable, userId: string, changes: Partial<Preferences>, source: "settings" | "unsubscribe_link" | "suggestion"): Promise<Preferences> {
  const run = async (tx: Queryable) => {
    const before = await getPreferencesPg(tx, userId);
    const after: Preferences = { ...before };
    for (const c of CATEGORIES) if (changes[c]) after[c] = { ...changes[c]! };
    for (const c of CATEGORIES) {
      if (before[c].inApp === after[c].inApp && before[c].email === after[c].email && before[c].sms === after[c].sms) continue;
      await tx.query(
        `INSERT INTO notification_preference (user_id, category, in_app, email, sms) VALUES ($1::uuid,$2,$3,$4,$5)
         ON CONFLICT (user_id, category) DO UPDATE SET in_app = $3, email = $4, sms = $5, updated_at = now()`,
        [userId, c, after[c].inApp, after[c].email, after[c].sms]);
    }
    for (const ch of consentChanges(before, after))
      await tx.query("INSERT INTO notification_consent_log (user_id, channel, category, granted, source) VALUES ($1::uuid,$2,$3,$4,$5)", [userId, ch.channel, ch.category, ch.granted, source]);
    return after;
  };
  return db.transaction ? db.transaction(run) : run(db);
}

/** Per category counts over the last 90 days, for Elena's suggestions. */
export async function categoryStatsPg(db: Queryable, userId: string): Promise<CategoryStats[]> {
  const r = await db.query(
    `SELECT category, count(*)::int AS total, count(read_at)::int AS read FROM notification
      WHERE user_id = $1::uuid AND created_at > now() - interval '90 days' GROUP BY category`, [userId]);
  return r.rows.filter(x => isCategory(x["category"])).map(x => ({ category: x["category"] as Category, total: Number(x["total"]), read: Number(x["read"]) }));
}

export async function recipientPg(db: Queryable, userId: string): Promise<{ email: string | null; phone: string | null }> {
  const r = await db.query(
    `SELECT u.email, bv.phone_e164 FROM app_user u LEFT JOIN buyer_verification bv ON bv.user_id = u.id AND bv.phone_verified_at IS NOT NULL
      WHERE u.id = $1::uuid AND u.status = 'active' AND u.deleted_at IS NULL`, [userId]);
  const x = r.rows[0];
  return { email: x && typeof x["email"] === "string" ? x["email"] : null, phone: x && typeof x["phone_e164"] === "string" ? x["phone_e164"] : null };
}

// ---- Signed unsubscribe link for marketing email ------------------------------------------------------------------------------
const usable = (k: string | undefined): k is string => typeof k === "string" && k.length >= 32;
const sign = (k: string, body: string) => createHmac("sha256", k).update(`notification-unsubscribe.v1.${body}`).digest("base64url");

export function makeNotificationUnsubscribeToken(userId: string, category: Category, key: string | undefined): string | undefined {
  if (!usable(key)) return undefined;
  const body = Buffer.from(`${userId}:${category}`, "utf8").toString("base64url");
  return `n1.${body}.${sign(key, body)}`;
}
export function readNotificationUnsubscribeToken(token: unknown, key: string | undefined): { userId: string; category: Category } | undefined {
  if (!usable(key) || typeof token !== "string" || token.length > 300) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "n1") return undefined;
  const [, body, sig] = parts as [string, string, string];
  const want = Buffer.from(sign(key, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
  const [userId, category, extra] = Buffer.from(body, "base64url").toString("utf8").split(":");
  if (!userId || extra !== undefined || !isCategory(category)) return undefined;
  return { userId, category };
}

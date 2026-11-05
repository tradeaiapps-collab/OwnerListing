import { CATEGORIES, type Category } from "../domain/notifications";
import { pushConsentChanges, resolvePushPreferences, type DeviceInput, type EngagementRow, type Platform, type PushPreferences } from "../domain/push";
import type { Queryable } from "./db";
import type { PushTarget } from "./push-senders";

// Constant SQL; user input only travels as bound parameters. Everything is scoped to one user id taken from the session.
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const MAX_DEVICES = 10;

export interface DeviceView { id: string; platform: Platform; label: string | null; createdAt: string; lastSeenAt: string }

/** Registers or refreshes a device. A token seen before moves to this user (a shared browser or a phone sold on) and is reactivated. At most 10 active devices per user: the oldest are retired. */
export async function registerDevicePg(db: Queryable, userId: string, d: DeviceInput): Promise<string> {
  const run = async (tx: Queryable) => {
    const r = await tx.query(
      `INSERT INTO push_device (user_id, platform, token, p256dh, auth_secret, label) VALUES ($1::uuid,$2,$3,$4,$5,$6)
       ON CONFLICT (token) DO UPDATE SET user_id = $1::uuid, platform = $2, p256dh = $4, auth_secret = $5, label = COALESCE($6, push_device.label), last_seen_at = now(), revoked_at = NULL
       RETURNING id`, [userId, d.platform, d.token, d.p256dh, d.authSecret, d.label]);
    const id = String(r.rows[0]!["id"]);
    await tx.query(
      `UPDATE push_device SET revoked_at = now() WHERE user_id = $1::uuid AND revoked_at IS NULL AND id NOT IN
         (SELECT id FROM push_device WHERE user_id = $1::uuid AND revoked_at IS NULL ORDER BY last_seen_at DESC, id LIMIT ${MAX_DEVICES})`, [userId]);
    return id;
  };
  return db.transaction ? db.transaction(run) : run(db);
}

export async function listDevicesPg(db: Queryable, userId: string): Promise<DeviceView[]> {
  const r = await db.query("SELECT id, platform, label, created_at, last_seen_at FROM push_device WHERE user_id = $1::uuid AND revoked_at IS NULL ORDER BY last_seen_at DESC, id", [userId]);
  return r.rows.map(x => ({ id: String(x["id"]), platform: String(x["platform"]) as Platform, label: x["label"] === null ? null : String(x["label"]), createdAt: iso(x["created_at"]), lastSeenAt: iso(x["last_seen_at"]) }));
}

/** Only the user's own device can be removed. Returns whether one was. */
export async function revokeDevicePg(db: Queryable, userId: string, deviceId: string): Promise<boolean> {
  const r = await db.query("UPDATE push_device SET revoked_at = now() WHERE id = $1::uuid AND user_id = $2::uuid AND revoked_at IS NULL RETURNING id", [deviceId, userId]);
  return r.rows.length > 0;
}

export async function revokeDeviceByIdPg(db: Queryable, deviceId: string): Promise<void> {
  await db.query("UPDATE push_device SET revoked_at = now() WHERE id = $1::uuid AND revoked_at IS NULL", [deviceId]);
}

export async function activeTargetsPg(db: Queryable, userId: string): Promise<PushTarget[]> {
  const r = await db.query("SELECT id, platform, token, p256dh, auth_secret FROM push_device WHERE user_id = $1::uuid AND revoked_at IS NULL", [userId]);
  return r.rows.map(x => ({ id: String(x["id"]), platform: String(x["platform"]) as Platform, token: String(x["token"]), p256dh: x["p256dh"] === null ? null : String(x["p256dh"]), authSecret: x["auth_secret"] === null ? null : String(x["auth_secret"]) }));
}

export async function getPushPreferencesPg(db: Queryable, userId: string): Promise<PushPreferences> {
  const r = await db.query("SELECT category, enabled FROM push_preference WHERE user_id = $1::uuid", [userId]);
  return resolvePushPreferences(r.rows.map(x => ({ category: String(x["category"]), enabled: Boolean(x["enabled"]) })));
}

/** Saves the given topics and writes one consent-log row for each topic that flipped. */
export async function savePushPreferencesPg(db: Queryable, userId: string, changes: Partial<PushPreferences>): Promise<PushPreferences> {
  const run = async (tx: Queryable) => {
    const before = await getPushPreferencesPg(tx, userId);
    const after: PushPreferences = { ...before };
    for (const c of CATEGORIES) if (changes[c] !== undefined) after[c] = changes[c]!;
    for (const c of CATEGORIES) {
      if (before[c] === after[c]) continue;
      await tx.query(
        `INSERT INTO push_preference (user_id, category, enabled) VALUES ($1::uuid,$2,$3)
         ON CONFLICT (user_id, category) DO UPDATE SET enabled = $3, updated_at = now()`, [userId, c, after[c]]);
    }
    for (const ch of pushConsentChanges(before, after))
      await tx.query("INSERT INTO notification_consent_log (user_id, channel, category, granted, source) VALUES ($1::uuid,'push',$2,$3,'settings')", [userId, ch.category, ch.granted]);
    return after;
  };
  return db.transaction ? db.transaction(run) : run(db);
}

export async function createDeliveryPg(db: Queryable, d: { userId: string; deviceId: string; notificationId: string | null; platform: Platform; kind: string; category: Category; personalized: boolean }): Promise<string> {
  const r = await db.query(
    "INSERT INTO push_delivery (user_id, device_id, notification_id, platform, kind, category, personalized) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7) RETURNING id",
    [d.userId, d.deviceId, d.notificationId, d.platform, d.kind, d.category, d.personalized]);
  return String(r.rows[0]!["id"]);
}
export async function setDeliveryStatusPg(db: Queryable, id: string, status: "sent" | "failed" | "gone"): Promise<void> {
  await db.query("UPDATE push_delivery SET status = $2 WHERE id = $1::uuid", [id, status]);
}

/** The device reports that the push was opened or dismissed. The delivery id is an unguessable UUID; only the first report counts. Returns whether a row changed. */
export async function recordPushEventPg(db: Queryable, deliveryId: string, event: "clicked" | "dismissed"): Promise<boolean> {
  const r = event === "clicked"
    ? await db.query("UPDATE push_delivery SET clicked_at = now() WHERE id = $1::uuid AND clicked_at IS NULL AND status = 'sent' RETURNING id", [deliveryId])
    : await db.query("UPDATE push_delivery SET dismissed_at = now() WHERE id = $1::uuid AND dismissed_at IS NULL AND status = 'sent' RETURNING id", [deliveryId]);
  return r.rows.length > 0;
}

/** Share of this user's pushes in the last 90 days that they opened, or null with fewer than 5 sent. */
export async function userClickRatePg(db: Queryable, userId: string): Promise<number | null> {
  const r = await db.query(
    "SELECT count(*)::int AS sent, count(clicked_at)::int AS clicked FROM push_delivery WHERE user_id = $1::uuid AND status = 'sent' AND created_at > now() - interval '90 days'", [userId]);
  const sent = Number(r.rows[0]?.["sent"] ?? 0);
  return sent < 5 ? null : Number(r.rows[0]?.["clicked"] ?? 0) / sent;
}

export async function unreadInCategoryPg(db: Queryable, userId: string, category: Category): Promise<number> {
  const r = await db.query("SELECT count(*)::int AS n FROM notification WHERE user_id = $1::uuid AND category = $2 AND read_at IS NULL AND archived_at IS NULL", [userId, category]);
  return Number(r.rows[0]?.["n"] ?? 0);
}

export async function displayNamePg(db: Queryable, userId: string): Promise<string | null> {
  const r = await db.query("SELECT display_name FROM app_user WHERE id = $1::uuid AND status = 'active' AND deleted_at IS NULL", [userId]);
  const n = r.rows[0]?.["display_name"];
  return typeof n === "string" ? n : null;
}

/** Engagement rows for [from, to): grouped by platform, topic and whether Elena personalised the text. */
export async function engagementPg(db: Queryable, from: string, to: string): Promise<EngagementRow[]> {
  const r = await db.query(
    `SELECT platform, category, personalized,
            count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status = 'gone')::int AS gone,
            count(clicked_at)::int AS clicked, count(dismissed_at)::int AS dismissed
       FROM push_delivery WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz GROUP BY platform, category, personalized`, [from, to]);
  return r.rows.map(x => ({ platform: String(x["platform"]) as Platform, category: String(x["category"]) as Category, personalized: Boolean(x["personalized"]),
    sent: Number(x["sent"]), failed: Number(x["failed"]), gone: Number(x["gone"]), clicked: Number(x["clicked"]), dismissed: Number(x["dismissed"]) }));
}

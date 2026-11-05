import { createHmac, timingSafeEqual } from "node:crypto";
import { readBrand } from "../config/brand";
import { composeDigest, DEFAULT_DIGEST, renderDigestEmail, type DigestSettings } from "../domain/digest";
import { CATEGORIES, type Category } from "../domain/notifications";
import type { Queryable } from "./db";
import { getEmailPort } from "./messaging";
import { categoryStatsPg, getPreferencesPg, recipientPg, view } from "./notifications-db";

type Env = Readonly<Record<string, string | undefined>>;
// Constant SQL; user input only travels as bound parameters. Every query is scoped to one user id.

export async function getDigestSettingsPg(db: Queryable, userId: string): Promise<DigestSettings> {
  const r = await db.query("SELECT enabled, send_hour, timezone FROM notification_digest_setting WHERE user_id = $1::uuid", [userId]);
  const x = r.rows[0];
  return x ? { enabled: Boolean(x["enabled"]), sendHour: Number(x["send_hour"]), timezone: String(x["timezone"]) } : { ...DEFAULT_DIGEST };
}

/** Saves the user's own schedule. last_sent_at is left alone, so changing the hour cannot cause a second digest within 20 hours. */
export async function saveDigestSettingsPg(db: Queryable, userId: string, s: DigestSettings): Promise<DigestSettings> {
  await db.query(
    `INSERT INTO notification_digest_setting (user_id, enabled, send_hour, timezone) VALUES ($1::uuid,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET enabled = $2, send_hour = $3, timezone = $4, updated_at = now()`,
    [userId, s.enabled, s.sendHour, s.timezone]);
  return s;
}

// ---- Signed one-click "stop the digest" link ----------------------------------------------------------------------------------
const usable = (k: string | undefined): k is string => typeof k === "string" && k.length >= 32;
const sign = (k: string, body: string) => createHmac("sha256", k).update(`notification-digest-unsubscribe.v1.${body}`).digest("base64url");

export function makeDigestUnsubscribeToken(userId: string, key: string | undefined): string | undefined {
  if (!usable(key)) return undefined;
  const body = Buffer.from(userId, "utf8").toString("base64url");
  return `d1.${body}.${sign(key, body)}`;
}
export function readDigestUnsubscribeToken(token: unknown, key: string | undefined): { userId: string } | undefined {
  if (!usable(key) || typeof token !== "string" || token.length > 300) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "d1") return undefined;
  const [, body, sig] = parts as [string, string, string];
  const want = Buffer.from(sign(key, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
  const userId = Buffer.from(body, "base64url").toString("utf8");
  return /^[0-9a-f-]{36}$/i.test(userId) ? { userId } : undefined;
}

export async function disableDigestPg(db: Queryable, userId: string): Promise<void> {
  await db.query("UPDATE notification_digest_setting SET enabled = false, updated_at = now() WHERE user_id = $1::uuid", [userId]);
}

export interface DigestRunCounts { due: number; sent: number; empty: number; failed: number }

/**
 * Hourly worker tick. Finds users whose chosen local hour is now and who have not had a digest in the last 20 hours, claims each (so overlapping
 * ticks cannot double send), builds their digest and emails it. Empty digests send nothing. A failed send puts the old last_sent_at back so the
 * next tick in the same local hour retries. Never throws for one user's failure.
 */
export async function runDigests(db: Queryable, env: Env, nowIso: string): Promise<DigestRunCounts> {
  const counts: DigestRunCounts = { due: 0, sent: 0, empty: 0, failed: 0 };
  const now = new Date(nowIso);
  const due = await db.query(
    `SELECT user_id, last_sent_at FROM notification_digest_setting
      WHERE enabled AND EXTRACT(HOUR FROM $1::timestamptz AT TIME ZONE timezone)::int = send_hour
        AND (last_sent_at IS NULL OR last_sent_at < $1::timestamptz - interval '20 hours')
      ORDER BY user_id LIMIT 200`, [nowIso]);
  const base = env["APP_URL"]?.replace(/\/+$/, "");
  for (const row of due.rows) {
    const userId = String(row["user_id"]);
    const before = row["last_sent_at"] ?? null;
    counts.due++;
    try {
      const claim = await db.query(
        `UPDATE notification_digest_setting SET last_sent_at = $2::timestamptz
          WHERE user_id = $1::uuid AND enabled AND (last_sent_at IS NULL OR last_sent_at < $2::timestamptz - interval '20 hours') RETURNING user_id`, [userId, nowIso]);
      if (claim.rows.length === 0) { counts.due--; continue; }
      const [to, prefs, stats, items] = await Promise.all([
        recipientPg(db, userId), getPreferencesPg(db, userId), categoryStatsPg(db, userId),
        db.query(
          `SELECT id, kind, category, title, body, link, created_at, read_at, archived_at FROM notification
            WHERE user_id = $1::uuid AND read_at IS NULL AND archived_at IS NULL AND category <> 'marketing'
              AND created_at > $2::timestamptz - interval '24 hours' ORDER BY created_at DESC, id DESC LIMIT 100`, [userId, nowIso])
      ]);
      const emailOn = new Set<Category>(CATEGORIES.filter(c => prefs[c].email));
      const digest = composeDigest(items.rows.map(view), stats, emailOn, now);
      if (!digest || !to.email) { counts.empty++; continue; }
      const token = makeDigestUnsubscribeToken(userId, env["ALERT_UNSUBSCRIBE_KEY"]);
      const mail = renderDigestEmail({
        brand: readBrand().name, digest, baseUrl: base ?? null,
        settingsUrl: base ? `${base}/notifications?tab=preferences` : null,
        unsubscribeUrl: base && token ? `${base}/api/notifications/unsubscribe?t=${encodeURIComponent(token)}` : null
      });
      const port = await getEmailPort(db, env, "notif_daily_digest");
      if (port.configured && (await port.send({ to: to.email, ...mail })).status === "sent") counts.sent++;
      else throw new Error("not sent");
    } catch {
      counts.failed++;
      await db.query("UPDATE notification_digest_setting SET last_sent_at = $2::timestamptz WHERE user_id = $1::uuid", [userId, before]).catch(() => undefined);
    }
  }
  return counts;
}

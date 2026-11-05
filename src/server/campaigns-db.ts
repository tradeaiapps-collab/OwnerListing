import { randomBytes } from "node:crypto";
import { readBrand } from "../config/brand";
import { campaignStats, canMove, SEND_BATCH, type CampaignInput, type Channel, type Segment, type SegmentConfig, type Stats } from "../domain/campaigns";
import { renderEmail } from "../domain/email-templates";
import { estimateMicros, formatNotificationSms, segmentMicros } from "../domain/sms";
import type { Queryable } from "./db";
import { getEmailPort, getSmsPort, type MessagingDeps } from "./messaging";
import { getPreferencesPg, makeNotificationUnsubscribeToken, recipientPg } from "./notifications-db";
import { recordSmsMessage } from "./sms-log";
import { webhookUrl } from "./sms-webhook";

type Env = Readonly<Record<string, string | undefined>>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : new Date(String(v)).toISOString());

export interface CampaignRow extends CampaignInput { id: string; status: string; startedAt: string | null; finishedAt: string | null; createdAt: string; stats: Stats }
const SELECT = `
  SELECT c.*, (SELECT count(*)::int FROM campaign_recipient r WHERE r.campaign_id = c.id) AS total,
         (SELECT count(*)::int FROM campaign_recipient r WHERE r.campaign_id = c.id AND r.status = 'sent') AS sent,
         (SELECT count(*)::int FROM campaign_recipient r WHERE r.campaign_id = c.id AND r.status = 'failed') AS failed,
         (SELECT count(*)::int FROM campaign_recipient r WHERE r.campaign_id = c.id AND r.status = 'skipped') AS skipped,
         (SELECT count(*)::int FROM campaign_recipient r WHERE r.campaign_id = c.id AND r.status = 'pending') AS pending,
         (SELECT count(*)::int FROM campaign_recipient r WHERE r.campaign_id = c.id AND r.opened_at IS NOT NULL) AS opened,
         (SELECT count(*)::int FROM campaign_recipient r WHERE r.campaign_id = c.id AND r.clicked_at IS NOT NULL) AS clicked
    FROM campaign c`;
const n = (v: unknown) => Number(v ?? 0);
const toCampaign = (x: Record<string, unknown>): CampaignRow => ({
  id: String(x["id"]), name: String(x["name"]), channel: String(x["channel"]) as Channel, segment: String(x["segment"]) as Segment,
  segmentConfig: (x["segment_config"] ?? {}) as SegmentConfig, subject: x["subject"] === null ? null : String(x["subject"]), body: String(x["body"]),
  ctaUrl: x["cta_url"] === null ? null : String(x["cta_url"]), scheduledAt: iso(x["scheduled_at"]), status: String(x["status"]),
  startedAt: iso(x["started_at"]), finishedAt: iso(x["finished_at"]), createdAt: iso(x["created_at"])!,
  stats: campaignStats({ total: n(x["total"]), sent: n(x["sent"]), failed: n(x["failed"]), skipped: n(x["skipped"]), pending: n(x["pending"]), opened: n(x["opened"]), clicked: n(x["clicked"]) })
});

export async function listCampaignsPg(db: Queryable): Promise<CampaignRow[]> {
  return (await db.query(`${SELECT} ORDER BY c.created_at DESC LIMIT 100`)).rows.map(toCampaign);
}
export async function getCampaignPg(db: Queryable, id: string): Promise<CampaignRow | null> {
  const r = (await db.query(`${SELECT} WHERE c.id = $1::uuid`, [id])).rows[0];
  return r ? toCampaign(r) : null;
}
export async function createCampaignPg(db: Queryable, c: CampaignInput, by: string): Promise<string> {
  const x = await db.query(
    `INSERT INTO campaign (name, channel, segment, segment_config, subject, body, cta_url, status, scheduled_at, created_by)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::uuid) RETURNING id`,
    [c.name, c.channel, c.segment, JSON.stringify(c.segmentConfig), c.subject, c.body, c.ctaUrl, c.scheduledAt ? "scheduled" : "draft", c.scheduledAt, by]);
  return String(x.rows[0]!["id"]);
}
/** Only a draft or scheduled campaign can be edited; one that started sending is a record. */
export async function updateCampaignPg(db: Queryable, id: string, c: CampaignInput): Promise<boolean> {
  const x = await db.query(
    `UPDATE campaign SET name=$2, channel=$3, segment=$4, segment_config=$5::jsonb, subject=$6, body=$7, cta_url=$8, status=$9, scheduled_at=$10
      WHERE id = $1::uuid AND status IN ('draft','scheduled') RETURNING id`,
    [id, c.name, c.channel, c.segment, JSON.stringify(c.segmentConfig), c.subject, c.body, c.ctaUrl, c.scheduledAt ? "scheduled" : "draft", c.scheduledAt]);
  return x.rows.length > 0;
}

/**
 * The people a campaign would reach right now. Marketing consent is required on the campaign's channel (email: marketing email on and an address;
 * SMS: marketing SMS on and a verified mobile), so staff cannot text or mail someone who has not opted in.
 */
const AUDIENCE_SQL = (channel: Channel, segment: Segment) => `
  SELECT u.id FROM app_user u
    JOIN notification_preference p ON p.user_id = u.id AND p.category = 'marketing' AND p.${channel === "email" ? "email" : "sms"}
    ${channel === "sms" ? "JOIN buyer_verification bv ON bv.user_id = u.id AND bv.phone_verified_at IS NOT NULL AND bv.phone_e164 IS NOT NULL" : ""}
   WHERE u.status = 'active' AND u.deleted_at IS NULL ${channel === "email" ? "AND u.email IS NOT NULL" : ""}
     AND ${segment === "all_agents" ? "u.user_type = 'agent'" : segment === "all_owners" ? "u.user_type = 'owner'" : segment === "all_buyers" ? "u.user_type = 'buyer'"
       : `u.user_type = 'buyer' AND EXISTS (SELECT 1 FROM saved_search s WHERE s.buyer_user_id = u.id AND s.active AND (
            ($1::text <> '' AND s.criteria->'jurisdictions' ? $1::text)
            OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(s.criteria->'suburbs','[]'::jsonb)) sub WHERE lower(sub) = ANY($2::text[]))))`}`;
const audienceParams = (segment: Segment, cfg: SegmentConfig): unknown[] =>
  segment === "buyers_in_area" ? [cfg.state ?? "", (cfg.suburbs ?? []).map(s => s.toLowerCase())] : [];

export async function audienceCountPg(db: Queryable, channel: Channel, segment: Segment, cfg: SegmentConfig): Promise<number> {
  const r = await db.query(`SELECT count(*)::int AS n FROM (${AUDIENCE_SQL(channel, segment)}) a`, audienceParams(segment, cfg));
  return n(r.rows[0]?.["n"]);
}

/** Moves a draft or scheduled campaign to `to` ("scheduled", "sending" for send now, "draft" to unschedule, "cancelled"). Sending fixes the recipient list. */
export async function moveCampaignPg(db: Queryable, id: string, to: "draft" | "scheduled" | "sending" | "cancelled", scheduledAt: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const c = await getCampaignPg(db, id);
  if (!c) return { ok: false, error: "Campaign not found." };
  if (!canMove(c.status, to)) return { ok: false, error: `A ${c.status} campaign cannot be made ${to}.` };
  if (to === "scheduled") {
    if (!scheduledAt) return { ok: false, error: "Choose a send time." };
    await db.query("UPDATE campaign SET status='scheduled', scheduled_at=$2 WHERE id=$1::uuid AND status IN ('draft','scheduled')", [id, scheduledAt]);
  } else if (to === "draft") {
    await db.query("UPDATE campaign SET status='draft', scheduled_at=NULL WHERE id=$1::uuid AND status='scheduled'", [id]);
  } else if (to === "cancelled") {
    await db.query("UPDATE campaign SET status='cancelled', finished_at=now() WHERE id=$1::uuid AND status IN ('draft','scheduled','sending')", [id]);
    await db.query("UPDATE campaign_recipient SET status='skipped' WHERE campaign_id=$1::uuid AND status='pending'", [id]);
  } else {
    await startCampaign(db, c);
  }
  return { ok: true };
}

async function startCampaign(db: Queryable, c: CampaignRow): Promise<boolean> {
  const run = async (tx: Queryable) => {
    const up = await tx.query("UPDATE campaign SET status='sending', started_at=now() WHERE id=$1::uuid AND status IN ('draft','scheduled') RETURNING id", [c.id]);
    if (up.rows.length === 0) return false; // another tick already started it
    const params = audienceParams(c.segment, c.segmentConfig);
    await tx.query(
      `INSERT INTO campaign_recipient (campaign_id, user_id, token)
       SELECT $${params.length + 1}::uuid, a.id, encode(gen_random_bytes(24), 'hex') FROM (${AUDIENCE_SQL(c.channel, c.segment)}) a
       ON CONFLICT (campaign_id, user_id) DO NOTHING`, [...params, c.id]);
    return true;
  };
  return db.transaction ? db.transaction(run) : run(db);
}

export interface SendCounts { started: number; sent: number; failed: number; skipped: number; finished: number; notConfigured: number }

/**
 * One tick: starts scheduled campaigns whose time has come, then sends up to SEND_BATCH messages for each campaign in progress.
 * A recipient is claimed (marked sent) before the message goes, so overlapping ticks never send twice; consent is checked again at send time.
 */
export async function runDueCampaigns(db: Queryable, nowIso: string, env: Env, deps: MessagingDeps = {}): Promise<SendCounts> {
  const out: SendCounts = { started: 0, sent: 0, failed: 0, skipped: 0, finished: 0, notConfigured: 0 };
  const due = await db.query(`${SELECT} WHERE c.status = 'scheduled' AND c.scheduled_at <= $1::timestamptz ORDER BY c.scheduled_at LIMIT 10`, [nowIso]);
  for (const x of due.rows) if (await startCampaign(db, toCampaign(x))) out.started++;
  const live = await db.query(`${SELECT} WHERE c.status = 'sending' ORDER BY c.started_at LIMIT 5`);
  for (const x of live.rows) {
    const c = toCampaign(x);
    const port = c.channel === "email" ? await getEmailPort(db, env, "campaign", deps) : await getSmsPort(db, env, "campaign", deps);
    if (!port.configured) { out.notConfigured++; continue; }
    const batch = await db.query(
      `UPDATE campaign_recipient SET status = 'sent', sent_at = now() WHERE id IN (
         SELECT id FROM campaign_recipient WHERE campaign_id = $1::uuid AND status = 'pending' ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
       RETURNING id, user_id, token`, [c.id, SEND_BATCH]);
    for (const r of batch.rows) {
      const res = await sendOne(db, c, { id: String(r["id"]), userId: String(r["user_id"]), token: String(r["token"]) }, port, env);
      if (res !== "sent") await db.query("UPDATE campaign_recipient SET status = $2, sent_at = NULL WHERE id = $1::uuid", [String(r["id"]), res]);
      out[res === "sent" ? "sent" : res === "failed" ? "failed" : "skipped"]++;
    }
    const left = n((await db.query("SELECT count(*)::int AS n FROM campaign_recipient WHERE campaign_id = $1::uuid AND status = 'pending'", [c.id])).rows[0]?.["n"]);
    if (left === 0) {
      const done = await db.query("UPDATE campaign SET status = 'sent', finished_at = now() WHERE id = $1::uuid AND status = 'sending' RETURNING id", [c.id]);
      if (done.rows.length > 0) out.finished++;
    }
  }
  return out;
}

async function sendOne(db: Queryable, c: CampaignRow, r: { id: string; userId: string; token: string }, port: Awaited<ReturnType<typeof getEmailPort>> | Awaited<ReturnType<typeof getSmsPort>>, env: Env): Promise<"sent" | "failed" | "skipped"> {
  try {
    const [prefs, to] = await Promise.all([getPreferencesPg(db, r.userId), recipientPg(db, r.userId)]);
    const base = env["APP_URL"]?.replace(/\/+$/, "");
    const link = c.ctaUrl && base ? `${base}/api/campaigns/click/${r.token}` : null;
    if (c.channel === "email") {
      if (!prefs.marketing.email || !to.email || !base) return "skipped";
      const key = env["ALERT_UNSUBSCRIBE_KEY"];
      const t = makeNotificationUnsubscribeToken(r.userId, "marketing", key);
      if (!t) return "skipped"; // marketing mail is never sent without a one-click unsubscribe link
      const mail = renderEmail({
        brand: readBrand().name, title: c.subject ?? c.name, body: c.body, actionUrl: link, actionLabel: "Open",
        reason: `You are receiving this because you opted in to updates from ${readBrand().name}.`, settingsUrl: `${base}/notifications?tab=preferences`,
        unsubscribeUrl: `${base}/api/notifications/unsubscribe?t=${encodeURIComponent(t)}`
      });
      const html = mail.html.replace("</body>", `<img src="${base}/api/campaigns/open/${r.token}" width="1" height="1" alt="" style="display:none"></body>`);
      const res = await (port as Awaited<ReturnType<typeof getEmailPort>>).send({ to: to.email, subject: mail.subject, text: mail.text, html });
      return res.status === "sent" ? "sent" : "failed";
    }
    if (!prefs.marketing.sms || !to.phone) return "skipped";
    const sms = formatNotificationSms(readBrand().name, link ? `${c.body} ${link}` : c.body);
    const statusUrl = webhookUrl(env, "status");
    const res = await (port as Awaited<ReturnType<typeof getSmsPort>>).sendText(to.phone, sms.text, statusUrl ? { statusCallback: statusUrl } : undefined);
    await recordSmsMessage(db, { userId: r.userId, template: "campaign", result: res, segments: Math.max(sms.segments, 1), estMicros: estimateMicros(sms.segments, segmentMicros(env)) });
    return res.status === "sent" ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/** Records an open. The pixel is public, so this only ever sets timestamps and counters for a token that exists. */
export async function recordOpenPg(db: Queryable, token: string): Promise<void> {
  await db.query("UPDATE campaign_recipient SET open_count = open_count + 1, opened_at = COALESCE(opened_at, now()) WHERE token = $1 AND status = 'sent'", [token]);
}
/** Records a click (a click also counts as an open) and returns where to send the reader: the campaign's own stored link, never a value from the request. */
export async function recordClickPg(db: Queryable, token: string): Promise<string | null> {
  const r = await db.query(
    `UPDATE campaign_recipient r SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, now()), opened_at = COALESCE(opened_at, now())
       FROM campaign c WHERE r.token = $1 AND r.status = 'sent' AND c.id = r.campaign_id RETURNING c.cta_url`, [token]);
  const u = r.rows[0]?.["cta_url"];
  return typeof u === "string" ? u : null;
}

import { smsSegments, toGsmFriendly } from "./sms";

/** Bulk email and SMS campaigns. Pure rules; the database side is src/server/campaigns-db.ts. */
export const CHANNELS = ["email", "sms"] as const;
export type Channel = (typeof CHANNELS)[number];
export const SEGMENTS = ["all_agents", "all_owners", "all_buyers", "buyers_in_area"] as const;
export type Segment = (typeof SEGMENTS)[number];
export const SEGMENT_LABEL: Record<Segment, string> = {
  all_agents: "All agents", all_owners: "All owners", all_buyers: "All buyers", buyers_in_area: "Buyers searching in an area"
};
export const STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"] as const;
export interface SegmentConfig { state?: string; suburbs?: string[] }
/** Messages per five-minute tick; keeps one run inside the cron time limit and the provider's rate limits. */
export const SEND_BATCH = 100;
export const MAX_SMS_SEGMENTS = 2;

export interface CampaignInput {
  name: string; channel: Channel; segment: Segment; segmentConfig: SegmentConfig;
  subject: string | null; body: string; ctaUrl: string | null; scheduledAt: string | null;
}
const clean = (v: unknown, lo: number, hi: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, "").trim();
  return t.length >= lo && t.length <= hi ? t : null;
};

export function parseCampaign(input: unknown, nowIso: string): { ok: true; value: CampaignInput } | { ok: false; error: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Send the campaign as an object." };
  const o = input as Record<string, unknown>;
  const name = clean(o["name"], 3, 120);
  if (!name) return { ok: false, error: "Give the campaign a name of 3 to 120 characters." };
  const channel = CHANNELS.find(c => c === o["channel"]);
  if (!channel) return { ok: false, error: "Choose email or SMS." };
  const segment = SEGMENTS.find(s => s === o["segment"]);
  if (!segment) return { ok: false, error: "Choose who receives it." };
  const segmentConfig: SegmentConfig = {};
  if (segment === "buyers_in_area") {
    const c = (o["segmentConfig"] ?? {}) as Record<string, unknown>;
    const state = typeof c["state"] === "string" ? STATES.find(s => s === (c["state"] as string).toUpperCase()) : undefined;
    const list = (v: unknown, re: RegExp, max: number) => (Array.isArray(v) ? v.map(x => String(x).trim()).filter(x => re.test(x)).slice(0, max) : []);
    const suburbs = list(c["suburbs"], /^[A-Za-z][A-Za-z '.-]{1,59}$/, 50);
    if (!state && suburbs.length === 0) return { ok: false, error: "Name a state or some suburbs for the area." };
    if (state) segmentConfig.state = state;
    if (suburbs.length) segmentConfig.suburbs = suburbs;
  }
  const body = clean(o["body"], 1, channel === "sms" ? 320 : 1500);
  if (!body) return { ok: false, error: channel === "sms" ? "Write the text, up to 320 characters." : "Write the message, up to 1500 characters." };
  let subject: string | null = null;
  if (channel === "email") {
    subject = clean(o["subject"], 1, 150);
    if (!subject) return { ok: false, error: "Give the email a subject of up to 150 characters." };
  }
  const rawCta = typeof o["ctaUrl"] === "string" ? o["ctaUrl"].trim() : "";
  if (rawCta && !(/^https:\/\/[^\s]{1,250}$/.test(rawCta) || /^\/(?!\/)[^\s]{0,298}$/.test(rawCta))) return { ok: false, error: "The button link must start with https:// or be a path on this site." };
  if (channel === "sms" && smsSegments(toGsmFriendly(body)) > MAX_SMS_SEGMENTS) return { ok: false, error: `The text is longer than ${MAX_SMS_SEGMENTS} SMS segments.` };
  let scheduledAt: string | null = null;
  if (o["scheduledAt"] !== undefined && o["scheduledAt"] !== null && o["scheduledAt"] !== "") {
    const t = Date.parse(String(o["scheduledAt"]));
    if (Number.isNaN(t)) return { ok: false, error: "That send time is not a date." };
    if (t < Date.parse(nowIso) - 60_000) return { ok: false, error: "Choose a send time in the future." };
    if (t > Date.parse(nowIso) + 366 * 86_400_000) return { ok: false, error: "Choose a send time within a year." };
    scheduledAt = new Date(t).toISOString();
  }
  return { ok: true, value: { name, channel, segment, segmentConfig, subject, body, ctaUrl: rawCta || null, scheduledAt } };
}

export interface Stats { recipients: number; sent: number; failed: number; skipped: number; pending: number; opened: number; clicked: number; openRate: number; clickRate: number }
const rate = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);
export function campaignStats(c: { total: number; sent: number; failed: number; skipped: number; pending: number; opened: number; clicked: number }): Stats {
  return { recipients: c.total, sent: c.sent, failed: c.failed, skipped: c.skipped, pending: c.pending, opened: c.opened, clicked: c.clicked, openRate: rate(c.opened, c.sent), clickRate: rate(c.clicked, c.sent) };
}

/** Whether staff may send now: a draft needs a name, body and (for email) a subject, which parseCampaign already enforced. */
export const STATUS_FLOW: Record<string, readonly string[]> = {
  draft: ["scheduled", "sending", "cancelled"], scheduled: ["draft", "sending", "cancelled"], sending: ["cancelled"], sent: [], cancelled: []
};
export const canMove = (from: string, to: string): boolean => (STATUS_FLOW[from] ?? []).includes(to);

/** 1x1 transparent GIF. */
export const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
export const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

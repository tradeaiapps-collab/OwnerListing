import { escapeHtml, safeHttpUrl, type RenderedEmail } from "./email-templates";
import type { Failure, Result } from "./listing-service";
import { CATEGORIES, CATEGORY_INFO, type Category, type CategoryStats, type ElenaPose, type NotificationView } from "./notifications";

/**
 * Daily digest: a summary of the last 24 hours of a user's own unread notifications, written by Elena (rule based, self-hosted, no external AI),
 * with the urgent items first and one link per item. Pure functions, no I/O. Elena only describes; she changes nothing for the user.
 */
export interface DigestSettings { enabled: boolean; sendHour: number; timezone: string }
export const DEFAULT_DIGEST: DigestSettings = { enabled: false, sendHour: 8, timezone: "Australia/Sydney" };

export const isValidTimezone = (tz: unknown): tz is string => {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-AU", { timeZone: tz }); return true; } catch { return false; }
};

const bad = (message: string): Failure => ({ ok: false, code: "invalid", message });

/** Body: { enabled: boolean, sendHour: 0-23, timezone: IANA name }. Nothing else is accepted. */
export function parseDigestInput(body: unknown): Result<DigestSettings> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("Send a JSON object.");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some(k => k !== "enabled" && k !== "sendHour" && k !== "timezone")) return bad("Unsupported field.");
  if (typeof b["enabled"] !== "boolean") return bad("enabled must be true or false.");
  const h = b["sendHour"];
  if (typeof h !== "number" || !Number.isInteger(h) || h < 0 || h > 23) return bad("sendHour must be a whole number from 0 to 23.");
  if (!isValidTimezone(b["timezone"])) return bad("Choose a valid time zone.");
  return { ok: true, value: { enabled: b["enabled"], sendHour: h, timezone: b["timezone"] } };
}

export interface DigestItem { id: string; title: string; body: string; link: string; urgent: boolean; createdAt: string }
export interface DigestSection { category: Category; label: string; items: DigestItem[]; more: number }
export interface Digest { total: number; urgentCount: number; intro: string; pose: ElenaPose; urgent: DigestItem[]; sections: DigestSection[] }

const URGENT_KINDS: ReadonlySet<string> = new Set(["offer_received", "offer_countered", "appointment_invited", "security_notice"]);
const STALE_MESSAGE_MS = 12 * 3600_000;
const MAX_URGENT = 5;
const MAX_PER_SECTION = 5;

/** Urgent: an offer to answer, an agent invitation, a security notice, or a message that has waited more than 12 hours. */
export const isUrgent = (i: Pick<NotificationView, "kind" | "category" | "createdAt">, nowMs: number): boolean =>
  URGENT_KINDS.has(i.kind) || (i.category === "messages" && nowMs - Date.parse(i.createdAt) > STALE_MESSAGE_MS);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const newest = (a: DigestItem, b: DigestItem) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/**
 * Personalised by what the user does: only unread, unarchived items from the last 24 hours in categories whose email is on (`emailOn`);
 * sections are ordered by how often the user opens that category (from their last 90 days), then the usual order. Marketing is never included.
 * Returns null when there is nothing to say, so no empty email goes out.
 */
export function composeDigest(items: readonly NotificationView[], stats: readonly CategoryStats[], emailOn: ReadonlySet<Category>, now: Date): Digest | null {
  const nowMs = now.getTime();
  const fresh = items.filter(i => i.readAt === null && i.archivedAt === null && i.category !== "marketing" && emailOn.has(i.category) && nowMs - Date.parse(i.createdAt) <= 24 * 3600_000 && Date.parse(i.createdAt) <= nowMs);
  if (fresh.length === 0) return null;
  const all: (DigestItem & { category: Category })[] = fresh.map(i => ({ id: i.id, title: i.title, body: i.body, link: i.link ?? "/notifications", urgent: isUrgent(i, nowMs), createdAt: i.createdAt, category: i.category }));
  const urgentAll = all.filter(i => i.urgent).sort(newest);
  const urgent = urgentAll.slice(0, MAX_URGENT);
  const shown = new Set(urgent.map(i => i.id));
  const rate = (c: Category) => { const s = stats.find(x => x.category === c); return s && s.total >= 5 ? s.read / s.total : 0.5; };
  const order = [...CATEGORIES].sort((a, b) => rate(b) - rate(a) || CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b));
  const sections: DigestSection[] = [];
  for (const c of order) {
    const rest = all.filter(i => i.category === c && !shown.has(i.id)).sort(newest);
    if (rest.length === 0) continue;
    sections.push({ category: c, label: CATEGORY_INFO[c].label, items: rest.slice(0, MAX_PER_SECTION).map(({ category: _c, ...i }) => i), more: Math.max(rest.length - MAX_PER_SECTION, 0) });
  }
  const urgentItems = urgent.map(({ category: _c, ...i }) => i);
  const lead = urgentAll.length > 0
    ? `${plural(urgentAll.length, "item")} need${urgentAll.length === 1 ? "s" : ""} your attention first: ${urgent.slice(0, 3).map(i => `"${i.title}"`).join(", ")}${urgentAll.length > 3 ? " and more" : ""}.`
    : "Nothing here is urgent, so you can read it when you have a moment.";
  const mix = sections.map(s => `${s.label.toLowerCase()} (${s.items.length + s.more})`).join(", ");
  return {
    total: all.length,
    urgentCount: urgentAll.length,
    intro: `Hi, it's Elena. In the last day you got ${plural(all.length, "notification")} you haven't opened. ${lead}${mix ? ` The rest: ${mix}.` : ""}`,
    pose: urgentAll.length > 0 ? "tablet" : "front",
    urgent: urgentItems,
    sections
  };
}

export interface DigestEmailInput { brand: string; digest: Digest; baseUrl?: string | null; settingsUrl?: string | null; unsubscribeUrl?: string | null }

/** Branded HTML plus plain text. Every item links straight to where it can be dealt with; values are escaped and links must be http(s). */
export function renderDigestEmail(i: DigestEmailInput): RenderedEmail {
  const base = i.baseUrl ? i.baseUrl.replace(/\/+$/, "") : null;
  const href = (path: string) => safeHttpUrl(base ? `${base}${path}` : null);
  const settings = safeHttpUrl(i.settingsUrl);
  const unsub = safeHttpUrl(i.unsubscribeUrl);
  const d = i.digest;
  const subject = (d.urgentCount > 0 ? `${i.brand}: ${plural(d.urgentCount, "item")} need${d.urgentCount === 1 ? "s" : ""} your attention` : `${i.brand}: your daily digest, ${plural(d.total, "unread item")}`).slice(0, 150);
  const itemHtml = (it: DigestItem) => {
    const url = href(it.link);
    const title = url ? `<a href="${escapeHtml(url)}" style="color:#0f2744;font-weight:600;text-decoration:none">${escapeHtml(it.title)}</a>` : `<strong>${escapeHtml(it.title)}</strong>`;
    return `<tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:15px;line-height:1.4">${title}<br><span style="color:#4b5563">${escapeHtml(it.body)}</span>${url ? `<br><a href="${escapeHtml(url)}" style="color:#0f2744;font-size:13px">Open</a>` : ""}</td></tr>`;
  };
  const block = (title: string, items: DigestItem[], more = 0) =>
    `<h2 style="margin:20px 0 4px;font-size:16px">${escapeHtml(title)}</h2><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items.map(itemHtml).join("")}</table>${more > 0 ? `<p style="margin:6px 0 0;font-size:13px;color:#6b7280">and ${more} more in your <a href="${escapeHtml(href("/notifications") ?? "#")}" style="color:#6b7280">inbox</a></p>` : ""}`;
  const footerLinks = [settings ? `<a href="${escapeHtml(settings)}" style="color:#6b7280">Digest settings</a>` : "", unsub ? `<a href="${escapeHtml(unsub)}" style="color:#6b7280">Stop the daily digest</a>` : ""].filter(Boolean).join(" · ");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#f3f4f6;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:#0f2744;color:#d4af37;padding:16px 24px;font-size:18px;font-weight:600">${escapeHtml(i.brand)}</td></tr>
<tr><td style="padding:24px"><h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">Your daily digest</h1>
<p style="margin:0;font-size:16px;line-height:1.5">${escapeHtml(d.intro)}</p>
${d.urgent.length ? block("Needs your attention", d.urgent) : ""}${d.sections.map(s => block(s.label, s.items, s.more)).join("")}
</td></tr>
<tr><td style="padding:16px 24px;background:#f9fafb;font-size:12px;line-height:1.5;color:#6b7280">You are getting this because you turned on the daily digest. Elena writes the summary from your own notifications only.${footerLinks ? `<br>${footerLinks}` : ""}</td></tr>
</table></td></tr></table></body></html>`;
  const line = (it: DigestItem) => { const u = href(it.link); return `- ${it.title}: ${it.body}${u ? `\n  ${u}` : ""}`; };
  const text = [
    "Your daily digest", "", d.intro,
    ...(d.urgent.length ? ["", "Needs your attention", ...d.urgent.map(line)] : []),
    ...d.sections.flatMap(s => ["", s.label, ...s.items.map(line), ...(s.more > 0 ? [`  and ${s.more} more in your inbox`] : [])]),
    "", "You are getting this because you turned on the daily digest.",
    settings ? `Digest settings: ${settings}` : "", unsub ? `Stop the daily digest: ${unsub}` : ""
  ].filter((l, idx, a) => !(l === "" && a[idx - 1] === "")).join("\n").trim() + "\n";
  return { subject, text, html };
}

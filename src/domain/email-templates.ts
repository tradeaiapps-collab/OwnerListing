/**
 * Branded email layouts: one for notifications, one for marketing (which always carries an unsubscribe link).
 * Pure. Every value is HTML-escaped, links must be https or http absolute URLs, and a plain-text version is always produced.
 */
export interface EmailLayoutInput {
  brand: string;
  title: string;
  body: string;
  /** Absolute URL for the button, or null. */
  actionUrl?: string | null;
  actionLabel?: string;
  /** Why the person is getting this, shown in the footer. */
  reason: string;
  /** Absolute link to the notification settings. */
  settingsUrl?: string | null;
  /** Marketing only: one-click unsubscribe. */
  unsubscribeUrl?: string | null;
}
export interface RenderedEmail { subject: string; text: string; html: string }

export const escapeHtml = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
export const safeHttpUrl = (v: string | null | undefined): string | null => {
  if (!v) return null;
  try { const u = new URL(v); return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null; } catch { return null; }
};
const oneLine = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

export function renderEmail(i: EmailLayoutInput): RenderedEmail {
  const action = safeHttpUrl(i.actionUrl);
  const settings = safeHttpUrl(i.settingsUrl);
  const unsub = safeHttpUrl(i.unsubscribeUrl);
  const label = i.actionLabel ? oneLine(i.actionLabel).slice(0, 40) : "Open";
  const footerLinks = [settings ? `<a href="${escapeHtml(settings)}" style="color:#6b7280">Notification settings</a>` : "", unsub ? `<a href="${escapeHtml(unsub)}" style="color:#6b7280">Unsubscribe</a>` : ""].filter(Boolean).join(" · ");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(oneLine(i.title))}</title></head>
<body style="margin:0;background:#f3f4f6;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:#0f2744;color:#d4af37;padding:16px 24px;font-size:18px;font-weight:600">${escapeHtml(i.brand)}</td></tr>
<tr><td style="padding:24px"><h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">${escapeHtml(oneLine(i.title))}</h1>
<p style="margin:0 0 20px;font-size:16px;line-height:1.5">${escapeHtml(i.body).replace(/\n/g, "<br>")}</p>
${action ? `<p style="margin:0 0 8px"><a href="${escapeHtml(action)}" style="display:inline-block;background:#0f2744;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600">${escapeHtml(label)}</a></p>` : ""}
</td></tr>
<tr><td style="padding:16px 24px;background:#f9fafb;font-size:12px;line-height:1.5;color:#6b7280">${escapeHtml(i.reason)}${footerLinks ? `<br>${footerLinks}` : ""}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [oneLine(i.title), "", i.body, action ? `\n${label}: ${action}` : "", "", i.reason, settings ? `Notification settings: ${settings}` : "", unsub ? `Unsubscribe: ${unsub}` : ""]
    .filter((l, idx, a) => !(l === "" && a[idx - 1] === "")).join("\n").trim() + "\n";
  return { subject: oneLine(i.title).slice(0, 150), text, html };
}

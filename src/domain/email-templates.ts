/**
 * Email templates. Every message is built once as structured content and rendered twice: plain text (always sent) and HTML
 * (a single-column, table-based layout that renders in Outlook, Gmail and Apple Mail, with no images or remote assets).
 * Every variable is escaped for HTML. Pure functions: no I/O.
 */

export interface EmailContent {
  subject: string;
  /** Shown in the inbox list next to the subject (HTML only). */
  preheader?: string;
  heading: string;
  paragraphs: string[];
  /** The one main link, shown as a button (and as a plain link in the text part). */
  action?: { label: string; url: string };
  /** Small print under the button, such as how long a link lasts. */
  footnote?: string;
}

export interface RenderedEmail { subject: string; text: string; html: string }

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ESC[c]!);

/** Only http(s) links become clickable; anything else is shown as text. */
const safeUrl = (u: string) => (/^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : null);

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g;
const linkify = (escaped: string) => escaped.replace(URL_IN_TEXT, u => `<a href="${u}" style="color:#1f3a5f;text-decoration:underline;word-break:break-all;">${u}</a>`);

const NAVY = "#14243b";
const GOLD = "#b8935a";

function layout(brand: string, body: string, preheader: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${escapeHtml(brand)}</title></head>
<body style="margin:0;padding:0;background:#f4f2ee;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ee;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="background:${NAVY};padding:20px 28px;font-family:Georgia,'Times New Roman',serif;font-size:20px;color:#ffffff;">${escapeHtml(brand)}<div style="height:2px;width:40px;background:${GOLD};margin-top:8px;"></div></td></tr>
<tr><td style="padding:28px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:#22262c;">${body}</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid #ece8e1;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#6b7078;">This email was sent by ${escapeHtml(brand)}. ${escapeHtml(brand)} never asks for your password or bank details by email.</td></tr>
</table></td></tr></table>
</body></html>`;
}

const para = (p: string) => `<p style="margin:0 0 16px;">${linkify(escapeHtml(p)).replace(/\n/g, "<br>")}</p>`;

export function renderEmail(brand: string, c: EmailContent): RenderedEmail {
  const url = c.action ? safeUrl(c.action.url) : null;
  const text = [
    c.heading, "", ...c.paragraphs.flatMap(p => [p, ""]),
    ...(c.action ? [`${c.action.label}: ${c.action.url}`, ""] : []),
    ...(c.footnote ? [c.footnote, ""] : []),
    `${brand}`
  ].join("\n");
  const button = c.action && url
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;"><tr><td style="border-radius:6px;background:${NAVY};">` +
      `<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(c.action.label)}</a></td></tr></table>` +
      `<p style="margin:0 0 16px;font-size:13px;color:#6b7078;">Or copy this link: ${linkify(escapeHtml(url))}</p>`
    : "";
  const body = `<h1 style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:normal;color:${NAVY};">${escapeHtml(c.heading)}</h1>` +
    c.paragraphs.map(para).join("") + button +
    (c.footnote ? `<p style="margin:0;font-size:13px;color:#6b7078;">${linkify(escapeHtml(c.footnote))}</p>` : "");
  return { subject: c.subject, text, html: layout(brand, body, c.preheader ?? c.paragraphs[0] ?? c.heading) };
}

/** HTML for a message that only has a subject and plain text (older notices): the same layout, paragraphs and links kept. */
export function htmlFromText(brand: string, subject: string, text: string): string {
  const paragraphs = text.trim().split(/\n{2,}/).filter(p => p.trim() !== "");
  const body = `<h1 style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:normal;color:${NAVY};">${escapeHtml(subject)}</h1>` + paragraphs.map(para).join("");
  return layout(brand, body, paragraphs[0]?.slice(0, 140) ?? subject);
}

// --- Account emails ---

export function signupVerifyEmail(brand: string, link: string, hours: number): RenderedEmail {
  return renderEmail(brand, {
    subject: `Confirm your email for ${brand}`, heading: "Confirm your email address",
    paragraphs: [`Welcome to ${brand}. Confirm your email address to finish creating your account.`],
    action: { label: "Confirm my email", url: link },
    footnote: `The link works once and expires in ${hours} hours. If you did not sign up, you can ignore this email.`
  });
}

export function signupExistingEmail(brand: string, appUrl: string): RenderedEmail {
  return renderEmail(brand, {
    subject: `Your ${brand} account`, heading: "You already have an account",
    paragraphs: [`Someone (hopefully you) tried to create a ${brand} account with this email address, but it already has one.`,
      `Forgot your password? Reset it here: ${appUrl}/forgot-password`],
    action: { label: "Sign in", url: `${appUrl}/login` },
    footnote: "If this was not you, you can ignore this email."
  });
}

export function passwordResetEmail(brand: string, link: string, minutes: number): RenderedEmail {
  return renderEmail(brand, {
    subject: `Reset your ${brand} password`, heading: "Reset your password",
    paragraphs: ["Use the button below to choose a new password."],
    action: { label: "Choose a new password", url: link },
    footnote: `It works once and expires in ${minutes} minutes. If you did not ask for this, you can ignore this email: your password has not changed.`
  });
}

// --- Offer notifications (the platform records decisions only; no money moves) ---

const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-AU")}`;

export function offerReceivedEmail(brand: string, listingTitle: string, priceCents: number, link: string): RenderedEmail {
  return renderEmail(brand, {
    subject: `New offer on ${listingTitle}`, heading: "You have a new offer",
    paragraphs: [`A buyer has made an offer of ${money(priceCents)} on ${listingTitle}.`,
      "Review the terms and accept, reject or counter. Nothing is binding until contracts are signed."],
    action: { label: "Review the offer", url: link }
  });
}

export type OfferOutcome = "accepted" | "rejected" | "counter_requested" | "countered";

export function offerOutcomeEmail(brand: string, outcome: OfferOutcome, listingTitle: string, link: string): RenderedEmail {
  const t = {
    accepted: { subject: `Your offer on ${listingTitle} was accepted`, heading: "Your offer was accepted",
      paragraphs: [`The owner of ${listingTitle} has accepted your offer.`,
        "Next, the owner's solicitor or conveyancer prepares the contract. Any deposit is paid only into the solicitor's trust account, never to the platform or the owner directly."] },
    rejected: { subject: `Update on your offer for ${listingTitle}`, heading: "Your offer was not accepted",
      paragraphs: [`The owner of ${listingTitle} has decided not to accept your offer.`, "You can still view the listing and ask the owner questions."] },
    counter_requested: { subject: `The owner asked for a new offer on ${listingTitle}`, heading: "The owner would like a new offer",
      paragraphs: [`The owner of ${listingTitle} has asked you to revise your offer.`] },
    countered: { subject: `Counter-offer on ${listingTitle}`, heading: "You have a counter-offer",
      paragraphs: [`The owner of ${listingTitle} has sent you a counter-offer. Review the new terms before it expires.`] }
  }[outcome];
  return renderEmail(brand, { ...t, action: { label: outcome === "rejected" ? "View the listing" : "View the offer", url: link } });
}

// --- Staff and admin ---

export function staffInviteEmail(brand: string, role: string, appUrl: string): RenderedEmail {
  return renderEmail(brand, {
    subject: `You have been invited to ${brand} staff`, heading: "You have been invited to the staff console",
    paragraphs: [`You have been invited to join ${brand} as ${role.replace(/_/g, " ")}.`,
      "Sign in with the Google account for this email address. You will be asked to set up two-step verification."],
    action: { label: "Open the staff console", url: `${appUrl}/staff` },
    footnote: "If you were not expecting this, you can ignore this email; nothing happens until you sign in."
  });
}

export type AdminAlertKind = "sign_in_lockout" | "staff_invite_created";

export function adminAlertEmail(brand: string, kind: AdminAlertKind, detail: string, appUrl: string): RenderedEmail {
  const t = {
    sign_in_lockout: { subject: `[${brand}] Repeated failed sign-ins`, heading: "Repeated failed sign-ins",
      link: { label: "Open the audit log", url: `${appUrl}/staff/audit` } },
    staff_invite_created: { subject: `[${brand}] New staff invite`, heading: "A staff invite was created",
      link: { label: "Review staff invites", url: `${appUrl}/staff/invites` } }
  }[kind];
  return renderEmail(brand, {
    subject: t.subject, heading: t.heading,
    paragraphs: [detail, "You get this because you are a super admin. If this looks wrong, review it now."],
    action: t.link
  });
}

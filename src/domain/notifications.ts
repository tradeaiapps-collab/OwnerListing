import type { Failure, Result } from "./listing-service";

/**
 * Notifications: categories, kinds, per-user channel preferences, message wording and Elena's helpers (summary, answers, suggestions).
 * Pure functions, no I/O. Elena here is rule based and self-hosted: she reads only the signed-in user's own notification data,
 * and every suggestion is advice the user applies themselves; nothing is changed for them.
 */
export const CATEGORIES = ["messages", "appointments", "offers", "listings", "account", "marketing"] as const;
export type Category = (typeof CATEGORIES)[number];
export const CHANNELS = ["inApp", "email", "sms"] as const;
export type Channel = (typeof CHANNELS)[number];
export const isCategory = (v: unknown): v is Category => typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);

export interface CategoryInfo {
  label: string;
  text: string;
  /** Channels that cannot be turned off (account and security notices are required service messages). */
  locked: readonly Channel[];
  /** Whether SMS may ever be offered. SMS is for time-critical events only and always needs an opt-in and a verified phone. */
  smsAllowed: boolean;
  defaults: Record<Channel, boolean>;
}

export const CATEGORY_INFO: Record<Category, CategoryInfo> = {
  messages: { label: "Messages", text: "A new message in a chat or enquiry.", locked: [], smsAllowed: true, defaults: { inApp: true, email: true, sms: false } },
  appointments: { label: "Appointments", text: "Agent invitations and answers.", locked: [], smsAllowed: true, defaults: { inApp: true, email: true, sms: false } },
  offers: { label: "Offers", text: "Offers received, decisions and counter-offers.", locked: [], smsAllowed: true, defaults: { inApp: true, email: true, sms: false } },
  listings: { label: "Listings and saved searches", text: "New properties that match your saved searches.", locked: [], smsAllowed: false, defaults: { inApp: true, email: false, sms: false } },
  account: { label: "Account and security", text: "Sign-in, security and account notices. These are required.", locked: ["inApp", "email"], smsAllowed: false, defaults: { inApp: true, email: true, sms: false } },
  marketing: { label: "News and offers", text: "Product news and promotions. Off until you opt in.", locked: [], smsAllowed: false, defaults: { inApp: false, email: false, sms: false } }
};

export type ChannelPrefs = Record<Channel, boolean>;
export type Preferences = Record<Category, ChannelPrefs>;

export const defaultPreferences = (): Preferences =>
  Object.fromEntries(CATEGORIES.map(c => [c, { ...CATEGORY_INFO[c].defaults }])) as Preferences;

/** Stored rows over the defaults. Locked channels are forced on, and SMS is forced off where it is never allowed. */
export function resolvePreferences(rows: readonly { category: string; inApp: boolean; email: boolean; sms: boolean }[]): Preferences {
  const out = defaultPreferences();
  for (const r of rows) if (isCategory(r.category)) out[r.category] = enforce(r.category, { inApp: r.inApp, email: r.email, sms: r.sms });
  return out;
}

function enforce(c: Category, p: ChannelPrefs): ChannelPrefs {
  const info = CATEGORY_INFO[c];
  const out = { ...p };
  for (const l of info.locked) out[l] = true;
  if (!info.smsAllowed) out.sms = false;
  return out;
}

const bad = (message: string): Failure => ({ ok: false, code: "invalid", message });

/** Body: { preferences: { <category>: { inApp, email, sms } } }. Any subset of categories; unknown keys, non-booleans and locked-off channels are refused. */
export function parsePreferencesInput(body: unknown): Result<Partial<Preferences>> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("Send a JSON object.");
  const root = body as Record<string, unknown>;
  if (Object.keys(root).some(k => k !== "preferences")) return bad("Unsupported field.");
  const prefs = root["preferences"];
  if (typeof prefs !== "object" || prefs === null || Array.isArray(prefs)) return bad("Send preferences as an object.");
  const out: Partial<Preferences> = {};
  for (const [cat, raw] of Object.entries(prefs as Record<string, unknown>)) {
    if (!isCategory(cat)) return bad(`Unknown category: ${cat.slice(0, 30)}.`);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("Each category needs inApp, email and sms.");
    const r = raw as Record<string, unknown>;
    if (Object.keys(r).some(k => !(CHANNELS as readonly string[]).includes(k))) return bad("Unsupported channel.");
    if (!CHANNELS.every(ch => typeof r[ch] === "boolean")) return bad("inApp, email and sms must each be true or false.");
    const p = { inApp: r["inApp"] as boolean, email: r["email"] as boolean, sms: r["sms"] as boolean };
    const info = CATEGORY_INFO[cat];
    const lockedOff = info.locked.find(l => !p[l]);
    if (lockedOff) return bad(`${info.label} notices are required and cannot be turned off.`);
    if (p.sms && !info.smsAllowed) return bad(`SMS is not available for ${info.label.toLowerCase()}.`);
    out[cat] = p;
  }
  return { ok: true, value: out };
}

/** The changes between two sets of preferences, as consent events (one per channel and category that flipped). */
export function consentChanges(before: Preferences, after: Preferences): { category: Category; channel: "in_app" | "email" | "sms"; granted: boolean }[] {
  const wire = { inApp: "in_app", email: "email", sms: "sms" } as const;
  const out: { category: Category; channel: "in_app" | "email" | "sms"; granted: boolean }[] = [];
  for (const c of CATEGORIES) for (const ch of CHANNELS) if (before[c][ch] !== after[c][ch]) out.push({ category: c, channel: wire[ch], granted: after[c][ch] });
  return out;
}

// ---- Kinds and wording --------------------------------------------------------------------------------------------------------

export const KINDS = {
  message_received: "messages",
  appointment_invited: "appointments",
  appointment_accepted: "appointments",
  appointment_declined: "appointments",
  appointment_reminder: "appointments",
  signature_requested: "account",
  signature_reminder: "account",
  booking_received: "appointments",
  booking_conflict: "appointments",
  offer_received: "offers",
  offer_accepted: "offers",
  offer_rejected: "offers",
  offer_countered: "offers",
  saved_search_match: "listings",
  market_shift: "listings",
  security_notice: "account",
  system_notice: "account",
  marketing_news: "marketing"
} as const satisfies Record<string, Category>;
export type Kind = keyof typeof KINDS;
export const isKind = (v: unknown): v is Kind => typeof v === "string" && Object.prototype.hasOwnProperty.call(KINDS, v);

/** Kinds worth a text message when the user has opted in: they are time-critical and short. */
const SMS_KINDS: ReadonlySet<Kind> = new Set<Kind>(["message_received", "appointment_invited", "appointment_reminder", "offer_received", "offer_accepted", "offer_rejected", "offer_countered"]);

export interface NotificationParams { [key: string]: string | undefined }
export interface RenderedNotification { kind: Kind; category: Category; title: string; body: string; link: string | null; smsText: string | null }

const clip = (v: string | undefined, max: number, fallback: string): string => {
  const t = (v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return t === "" ? fallback : t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
/** Only a site-relative path is accepted as a link; anything else (absolute URL, protocol-relative) is dropped. */
export const safeLink = (v: string | undefined): string | null => (typeof v === "string" && /^\/(?!\/)[^\s]{0,298}$/.test(v) ? v : null);

/** Wording for each kind. `p.listing` is a property address, `p.name` a first name or display name, `p.link` a site path. No amounts beyond what the user already sees. */
export function renderNotification(kind: Kind, p: NotificationParams = {}): RenderedNotification {
  const listing = clip(p["listing"], 120, "your property");
  const name = clip(p["name"], 60, "Someone");
  const doc = `"${clip(p["document"], 120, "a document")}"`;
  const link = safeLink(p["link"]);
  const t = (title: string, body: string, sms: boolean = SMS_KINDS.has(kind)): RenderedNotification =>
    ({ kind, category: KINDS[kind], title, body, link, smsText: sms ? `${title}. ${body}` : null });
  switch (kind) {
    case "message_received": return t("New message", `${name} sent you a message about ${listing}.`);
    case "appointment_invited": return t("Agent appointment invitation", `${name} invited you to act as agent for ${listing}.`);
    case "appointment_accepted": return t("Appointment accepted", `${name} accepted the appointment for ${listing}.`);
    case "appointment_declined": return t("Appointment declined", `${name} declined the appointment for ${listing}.`);
    case "appointment_reminder": return t("Reminder: invitation waiting", `${name}'s invitation to act as agent for ${listing} is still waiting for your answer.`);
    case "signature_requested": return t("Signature requested", `${name} has asked you to sign ${doc}. Open it to read the document and sign.`, false);
    case "signature_reminder": return t("Reminder: signature waiting", `${name} is still waiting for your signature on ${doc}. Open it to read the document and sign.`, false);
    case "booking_received": return t("New booking from a portal", `${name} booked ${listing} through a listing portal. The dates are now blocked on your calendar.`);
    case "booking_conflict": return t("Booking clashes with another", `A booking from ${name} for ${listing} overlaps dates that are already booked. Contact the portal or the guest to sort it out.`);
    case "offer_received": return t("New offer received", `A new offer was made on ${listing}. Review it in your offers.`);
    case "offer_accepted": return t("Offer accepted", `Your offer on ${listing} was accepted by the owner.`);
    case "offer_rejected": return t("Offer not accepted", `Your offer on ${listing} was not accepted.`);
    case "offer_countered": return t("Counter-offer", `There is a counter-offer on ${listing}.`);
    case "saved_search_match": return t("New property matches your search", `${listing} matches one of your saved searches.`);
    case "market_shift": return t(clip(p["title"], 80, "Market update"), clip(p["text"], 400, "There is a change in one of your areas."));
    case "security_notice": return t(clip(p["title"], 80, "Security notice"), clip(p["text"], 400, "Please review your account security settings."));
    case "system_notice": return t(clip(p["title"], 80, "Notice"), clip(p["text"], 400, "There is an update about your account."));
    case "marketing_news": return t(clip(p["title"], 80, "News"), clip(p["text"], 400, "There is news from us."));
  }
}

export interface ChannelPlan { inApp: boolean; email: boolean; sms: boolean }
/** Which channels this kind goes out on. SMS needs the category opt-in, a kind that suits a text, and a verified phone number. */
export function planChannels(kind: Kind, prefs: Preferences, hasVerifiedPhone: boolean): ChannelPlan {
  const p = prefs[KINDS[kind]];
  const info = CATEGORY_INFO[KINDS[kind]];
  return {
    inApp: p.inApp || info.locked.includes("inApp"),
    email: p.email || info.locked.includes("email"),
    sms: p.sms && info.smsAllowed && SMS_KINDS.has(kind) && hasVerifiedPhone
  };
}

// ---- Elena -------------------------------------------------------------------------------------------------------------------

export interface NotificationView { id: string; kind: string; category: Category; title: string; body: string; link: string | null; createdAt: string; readAt: string | null; archivedAt: string | null }
export type ElenaPose = "front" | "tablet" | "listening" | "wave";
export interface ElenaReply { text: string; pose: ElenaPose; links: { label: string; href: string }[] }

export const ELENA_NOTE = "General help with notifications only. Not legal, financial or tax advice.";
const SETTINGS_LINK = { label: "Notification settings", href: "/notifications?tab=preferences" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A catch-up: unread items grouped by category, with the newest title in each. Only the user's own unread notifications are passed in. */
export function summarizeNotifications(items: readonly NotificationView[]): ElenaReply {
  const unread = items.filter(i => i.readAt === null && i.archivedAt === null);
  if (unread.length === 0) return { text: "You're all caught up. Nothing new since you last looked.", pose: "wave", links: [] };
  const lines: string[] = [];
  for (const c of CATEGORIES) {
    const group = unread.filter(i => i.category === c).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (group.length === 0) continue;
    lines.push(`${CATEGORY_INFO[c].label}: ${plural(group.length, "new item")}, latest "${group[0]!.title}".`);
  }
  const first = unread.filter(i => i.link).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return {
    text: `You have ${plural(unread.length, "unread notification")}. ${lines.join(" ")}`,
    pose: "tablet",
    links: first?.link ? [{ label: `Open "${first.title}"`, href: first.link }] : []
  };
}

export const APPOINTMENT_KINDS = ["appointment_invited", "appointment_accepted", "appointment_declined", "appointment_reminder"] as const;
export type AppointmentKind = (typeof APPOINTMENT_KINDS)[number];
export const isAppointmentKind = (v: unknown): v is AppointmentKind => typeof v === "string" && (APPOINTMENT_KINDS as readonly string[]).includes(v);

/** Elena explains an appointment notification and what happens next. Uses only the kind, so it reads none of the user's data. */
export function explainAppointment(kind: AppointmentKind): ElenaReply {
  const agentLink = { label: "Your appointments", href: "/agent/appointments" };
  const mine = { label: "Your listings", href: "/listings/mine" };
  switch (kind) {
    case "appointment_invited": return { pose: "tablet", links: [agentLink], text: "An owner has invited you to act as agent for their listing. Nothing changes until you accept: you get no access to the listing, enquiries or offers before then. Accepting needs a verified licence for the listing's state. Open your appointments to see the scope and permissions the owner chose, then accept or decline. Either way the owner is told." };
    case "appointment_reminder": return { pose: "listening", links: [agentLink], text: "This invitation has been waiting for your answer. It stays open until you reply or the owner withdraws it. If you don't want it, declining lets the owner choose someone else quickly. If you accept, you will work within the scope and permissions shown on the invitation." };
    case "appointment_accepted": return { pose: "wave", links: [mine], text: "Your agent accepted, so they can now act on the listing within the scope and permissions you chose. Offer decisions always stay with you. You can change their permissions or revoke the appointment at any time from your listing." };
    case "appointment_declined": return { pose: "front", links: [mine], text: "Your agent declined, so nobody has been appointed and nothing about your listing changed. You can invite another agent, or keep managing the listing yourself." };
  }
}

const ANSWERS: { match: RegExp; text: string; links?: { label: string; href: string }[] }[] = [
  { match: /\b(appointments?|agent invit\w*|invitations?|appoint)\b/i, text: "Agent appointments are by agreement: an owner invites an agent, and nothing is granted until the agent accepts. Both sides are notified when it is accepted or declined, and the agent gets one reminder if an invitation sits unanswered. Choose in-app, email and text for Appointments in your settings.", links: [SETTINGS_LINK] },
  { match: /\b(sms|texts?|text messages?|txt|phone)\b/i, text: "Text messages are only for time-critical events: new messages, appointment invitations and offers. They are off until you turn them on, and you need a verified phone number. Switch SMS off in your notification settings any time.", links: [SETTINGS_LINK, { label: "Verify your phone", href: "/buyer/verification" }] },
  { match: /\b(unsubscribe|stop|opt.?out|marketing|news|promo)/i, text: "Marketing and news emails are off unless you opt in, and every one has an unsubscribe link. Turn them off in your settings or use that link: either takes effect straight away.", links: [SETTINGS_LINK] },
  { match: /\b(required|security|account|can'?t turn|cannot turn|locked)\b/i, text: "Account and security notices are required service messages (for example a sign-in or password notice), so they stay on in the app and by email. You can still choose whether you also want a text.", links: [SETTINGS_LINK] },
  { match: /\b(type|kind|categor|what.*notif|which.*notif|get notified|notified about)/i, text: `You can be notified about: ${CATEGORIES.map(c => CATEGORY_INFO[c].label.toLowerCase()).join(", ")}. For each one you choose in-app, email and text separately.`, links: [SETTINGS_LINK] },
  { match: /\b(history|old|past|archive|delete|erase|remove|privacy|gdpr|data)\b/i, text: "Read notifications can be moved to your history, where they stay until you delete them. You can delete your history any time, and we keep a record of when you opted in or out of each channel, as the law requires.", links: [{ label: "Notification history", href: "/notifications?tab=history" }] },
  { match: /\b(change|turn (on|off)|switch|setting|prefer|how)\b/i, text: "Open Notification settings, then tick the channels you want for each type and press Save. Changes apply to the next notification.", links: [SETTINGS_LINK] }
];

/** Rule-based answer about notification types and settings. Never advice about money, law or whether to accept an offer. */
export function answerNotificationQuestion(question: string): ElenaReply {
  const q = question.trim().slice(0, 300);
  if (q === "") return { text: "Ask me what you can be notified about, how to turn texts on or off, or how to unsubscribe.", pose: "listening", links: [SETTINGS_LINK] };
  if (/\b(should i (accept|reject|buy|sell)|legal advice|tax|worth|valuation)\b/i.test(q))
    return { text: "I can't advise on offers, money or the law. I can help with your notifications and settings, though.", pose: "front", links: [] };
  const hit = ANSWERS.find(a => a.match.test(q));
  return hit ? { text: hit.text, pose: "front", links: hit.links ?? [] }
    : { text: "I'm not sure about that one. I can explain the notification types, texts, unsubscribing, and your history, or show you where to change your settings.", pose: "listening", links: [SETTINGS_LINK] };
}

export interface CategoryStats { category: Category; total: number; read: number }
export interface Suggestion { category: Category; channel: Channel; turnOn: boolean; reason: string }

/**
 * Suggestions from how the user actually uses their notifications (last 90 days), shown for them to accept or ignore:
 * - plenty of notifications that are mostly never opened: suggest switching off email for that category;
 * - offers/messages/appointments nearly always opened quickly, with SMS off and a verified phone: suggest SMS;
 * - never suggests turning on marketing, and never suggests switching off a locked channel.
 */
export function suggestPreferences(stats: readonly CategoryStats[], prefs: Preferences, hasVerifiedPhone: boolean): Suggestion[] {
  const out: Suggestion[] = [];
  for (const s of stats) {
    if (s.total < 5) continue;
    const info = CATEGORY_INFO[s.category];
    const rate = s.read / s.total;
    if (rate < 0.2 && prefs[s.category].email && !info.locked.includes("email"))
      out.push({ category: s.category, channel: "email", turnOn: false, reason: `You opened ${s.read} of ${s.total} ${info.label.toLowerCase()} notifications lately. Turning off email would cut the noise; they would still appear in the app.` });
    else if (rate >= 0.8 && info.smsAllowed && !prefs[s.category].sms && hasVerifiedPhone && s.category !== "listings")
      out.push({ category: s.category, channel: "sms", turnOn: true, reason: `You open most of your ${info.label.toLowerCase()} notifications. A text would reach you faster. It's your choice, and you can turn it off any time.` });
  }
  return out;
}

export function describeSuggestions(list: readonly Suggestion[]): ElenaReply {
  if (list.length === 0) return { text: "Your settings look right for how you use notifications. I'll have more to suggest once you've had a few more.", pose: "front", links: [SETTINGS_LINK] };
  return { text: list.map(s => `${CATEGORY_INFO[s.category].label}: ${s.reason}`).join(" "), pose: "tablet", links: [SETTINGS_LINK] };
}

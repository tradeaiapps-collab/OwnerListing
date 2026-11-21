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
  marketing: { label: "News and offers", text: "Product news and promotions. Off until you opt in.", locked: [], smsAllowed: true, defaults: { inApp: false, email: false, sms: false } }
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
  consultation_booked: "appointments",
  consultation_confirmed: "appointments",
  consultation_cancelled: "appointments",
  review_received: "messages",
  booking_received: "appointments",
  open_inspection_confirmed: "appointments",
  open_inspection_new: "appointments",
  open_inspection_reminder_24h: "appointments",
  open_inspection_reminder_1h: "appointments",
  open_inspection_cancelled: "appointments",
  booking_conflict: "appointments",
  job_new: "appointments",
  job_time_changed: "appointments",
  job_reminder: "appointments",
  offer_received: "offers",
  offer_accepted: "offers",
  offer_rejected: "offers",
  offer_countered: "offers",
  offer_buyer_countered: "offers",
  listing_sold: "listings",
  listing_back_on_market: "listings",
  offer_terms_agreed: "offers",
  fall_through_proposed: "offers",
  fall_through_update: "offers",
  offer_fallen_through: "offers",
  dispute_opened: "offers",
  dispute_update: "offers",
  deposit_held: "offers",
  deposit_payout_pending: "offers",
  deposit_released: "offers",
  deposit_refunded: "offers",
  deposit_split: "offers",
  deposit_dispute_resolved: "offers",
  saved_search_match: "listings",
  document_analysed: "listings",
  market_shift: "listings",
  security_notice: "account",
  system_notice: "account",
  marketing_news: "marketing",
  automation_message: "marketing",
  automation_alert: "messages",
  job_update: "appointments",
  scheduling_message: "messages",
  scheduling_suggestion: "messages",
  lead_followup_due: "messages",
  job_offered: "appointments",
  job_accepted: "appointments",
  job_declined: "appointments",
  job_time_proposed: "appointments",
  job_time_confirmed: "appointments",
  job_done: "appointments",
  job_files_added: "appointments",
  job_reviewed: "messages",
  emergency_request: "messages",
  emergency_accepted: "messages",
  elena_enquiry: "messages",
  open_inspection_owner_reminder: "appointments",
  owner_digest: "messages",
  rental_update: "messages",
  rental_urgent: "messages",
  // Required account notices: a licence or insurance certificate is about to expire or has expired.
  cert_expiring: "account",
  cert_expired: "account"
} as const satisfies Record<string, Category>;
export type Kind = keyof typeof KINDS;
export const isKind = (v: unknown): v is Kind => typeof v === "string" && Object.prototype.hasOwnProperty.call(KINDS, v);

/** Kinds worth a text message when the user has opted in: they are time-critical and short. */
const SMS_KINDS: ReadonlySet<Kind> = new Set<Kind>(["message_received", "appointment_invited", "appointment_reminder", "job_new", "job_time_changed", "job_reminder", "consultation_booked", "consultation_cancelled", "offer_received", "offer_accepted", "offer_rejected", "offer_countered", "offer_buyer_countered", "offer_terms_agreed", "fall_through_proposed", "offer_fallen_through", "automation_alert", "job_update", "rental_urgent"]);

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
  const when = clip(p["when"], 80, "the booked time");
  const job = clip(p["job"], 20, "Job");
  const amount = clip(p["amount"], 20, "the deposit");
  const ref = clip(p["reference"], 30, "on file");
  const payout = p["payout"] === "refund" ? "refund" : "release";
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
    case "consultation_booked": return t("New consultation booked", `${name} booked a consultation with you for ${when}.`);
    case "consultation_confirmed": return t("Consultation confirmed", `Your consultation with ${name} is confirmed for ${when}.`);
    case "consultation_cancelled": return t("Consultation cancelled", `${name} cancelled the consultation planned for ${when}.`);
    case "job_offered": return t(`${job}: new job offer`, `${name} offered you work at ${listing}${p["price"] ? ` (${clip(p["price"], 40, "")})` : ""}. Accept, reject or propose another time. Quote ${job} if you reply by email.`);
    case "job_accepted": return t(`${job}: job accepted`, `${name} accepted the job at ${listing}.`);
    case "job_declined": return t(`${job}: job declined`, `${name} declined the job at ${listing}.${p["reason"] ? ` Reason: ${clip(p["reason"], 200, "")}` : ""}`);
    case "job_time_proposed": return t(`${job}: new time proposed`, `${name} proposed ${when} for the job at ${listing}. Open the job to accept it or choose another time.`);
    case "job_time_confirmed": return t(`${job}: time confirmed`, `${name} confirmed ${when} for the job at ${listing}.`);
    case "job_done": return t(`${job}: job marked done`, `${name} marked the job at ${listing} as done. Check the files and confirm it is complete.`);
    case "job_files_added": return t(`${job}: files added`, `${name} added ${clip(p["count"], 6, "new")} file(s) to ${listing}.`);
    case "job_reviewed": return t(`${job}: new review`, `${name} left you feedback for the job at ${listing}.`);
    case "review_received": return t("New review", `${name} left you a review.`);
    case "open_inspection_confirmed": return t("Inspection booked", `You are booked to inspect ${listing} on ${when}. Contact: ${clip(p["contact"], 120, "the listing agent")}. Bring photo ID, and message the agent from the listing if your plans change.`);
    case "open_inspection_new": return t("New inspection booked", `${name} booked to inspect ${listing} on ${when}.`);
    case "open_inspection_reminder_24h": return t("Inspection tomorrow", `Your inspection of ${listing} is tomorrow: ${when}. Contact: ${clip(p["contact"], 120, "the listing agent")}.`);
    case "open_inspection_reminder_1h": return t("Inspection in 1 hour", `Your inspection of ${listing} starts in about an hour: ${when}. Contact: ${clip(p["contact"], 120, "the listing agent")}.`);
    case "open_inspection_cancelled": return t("Inspection cancelled", `The inspection of ${listing} on ${when} was cancelled. ${clip(p["next"], 200, "Open the listing to book another time.")}`);
    case "booking_received": return t("New booking from a portal", `${name} booked ${listing} through a listing portal. The dates are now blocked on your calendar.`);
    case "booking_conflict": return t("Booking clashes with another", `A booking from ${name} for ${listing} overlaps dates that are already booked. Contact the portal or the guest to sort it out.`);
    case "job_new": return t("New job request", `${name} asked you to do a ${clip(p["job"], 40, "job")} at ${listing}. Open it to accept or decline.`);
    case "job_time_changed": return t("Job time changed", `The time for your ${clip(p["job"], 40, "job")} at ${listing} is now ${when}. Open it to confirm.`);
    case "job_reminder": return t("Job coming up", `Your ${clip(p["job"], 40, "job")} at ${listing} is on ${when}.`);
    case "offer_received": return t("New offer received", `A new offer was made on ${listing}. Review it in your offers.`);
    case "offer_accepted": return t("Offer accepted", `Your offer on ${listing} was accepted by the owner.`);
    case "offer_rejected": return t("Offer not accepted", `Your offer on ${listing} was not accepted.`);
    case "offer_countered": return t("Counter-offer", `There is a counter-offer on ${listing}.`);
    case "offer_buyer_countered": return t("Buyer counter-offer", `The buyer sent a counter-offer on ${listing}. Review it in your offers: you can accept, counter again or decline.`);
    case "listing_sold": return p["rent"] === "1"
      ? t("Property no longer available", `${listing} has been rented and is no longer available.`, false)
      : t("Property sold", `${listing} has been sold and is no longer available.`, false);
    case "offer_terms_agreed": return t("Buyer agreed to your terms", `The buyer agreed to the terms you countered with on ${listing}. Nothing is accepted yet: open the offer to accept it, or counter again.`);
    case "listing_back_on_market": return p["rent"] === "1"
      ? t("Property available again", `${listing} is available to rent again. The earlier arrangement did not go ahead.`, false)
      : t("Back on the market", `${listing} is back on the market. The earlier sale did not go ahead, so you may want another look.`, false);
    case "fall_through_proposed": return t("Sale of your property may have fallen through", `The other side says the contract on ${listing} will not go ahead (${clip(p["reason"], 80, "reason given")}). Open it to see the proposed outcome for the deposit and agree or dispute it.`);
    case "fall_through_update": return t(clip(p["title"], 80, "Update on a sale that fell through"), clip(p["text"], 300, `There is an update on the deposit for ${listing}.`), false);
    case "dispute_opened": return t("A dispute was raised on your sale", `A dispute about ${listing} was raised (${clip(p["title"], 80, "see the settlement")}). Elena will suggest a fair middle ground. Open it to add your side.`, false);
    case "dispute_update": return t(clip(p["title"], 80, "Update on a dispute"), clip(p["text"], 300, `There is an update on the dispute about ${listing}.`), false);
    case "offer_fallen_through": return t("Sale marked as fallen through", `The contract on ${listing} is now marked as fallen through. The deposit is returned or released by the solicitor's trust account once staff approve it. Nothing moves until then.`);
    case "deposit_held": {
      const due = clip(p["due"], 20, "");
      const tail = p["party"] === "buyer" ? `Pay it into the trust account quoting ${ref}${due ? ` by ${due}` : ""}.` : `The buyer has ${due ? `until ${due}` : "the agreed time"} to pay it in.`;
      return t("Deposit recorded in trust", `The ${amount} deposit for ${listing} (reference ${ref}) is recorded against the solicitor's trust account. ${tail} It is only paid out at settlement or by an agreed refund, and two staff approve every payout.`, false);
    }
    case "deposit_payout_pending": return t(`${payout === "refund" ? "Refund" : "Release"} waiting for approval`, `A ${payout === "refund" ? "refund to the buyer" : "release to the seller"} of ${amount} from the deposit for ${listing} (reference ${ref}) has been requested. A second staff member must approve it. Nothing moves until then and you do not need to do anything.`, false);
    case "deposit_released": return t("Deposit released to the seller", `${amount} from the deposit for ${listing} (reference ${ref}) was approved for release to the seller from the solicitor's trust account.`, false);
    case "deposit_refunded": return t("Deposit refunded to the buyer", `${amount} from the deposit for ${listing} (reference ${ref}) was approved for refund to the buyer from the solicitor's trust account.`, false);
    case "deposit_split": return t("Deposit split after a dispute", `For ${listing} (reference ${ref}), staff recorded how the disputed deposit is divided: ${clip(p["text"], 200, "see the offer for the amounts")}. Each payment still needs a second staff approval before it is paid.`, false);
    case "deposit_dispute_resolved": return t("Deposit outcome agreed", `The deposit outcome for ${listing} (reference ${ref}) is agreed: ${clip(p["text"], 200, "see the offer for the amounts")}. Staff will now request the payments and a second staff member approves each one.`, false);
    case "document_analysed": return t("Elena summarised a document", `Elena has read ${doc} for ${listing}. Open it to see the summary, flags and next steps.`, false);
    case "saved_search_match": return t("New property matches your search", `${listing} matches one of your saved searches.`);
    case "market_shift": return t(clip(p["title"], 80, "Market update"), clip(p["text"], 400, "There is a change in one of your areas."));
    case "security_notice": return t(clip(p["title"], 80, "Security notice"), clip(p["text"], 400, "Please review your account security settings."));
    case "system_notice": return t(clip(p["title"], 80, "Notice"), clip(p["text"], 400, "There is an update about your account."));
    case "marketing_news": return t(clip(p["title"], 80, "News"), clip(p["text"], 400, "There is news from us."));
    case "automation_message": return t(clip(p["title"], 80, "A message about a property"), clip(p["text"], 600, "There is an update about a property you asked about."), false);
    case "scheduling_message": return t(clip(p["title"], 80, "A message about your inspection"), clip(p["text"], 1500, "There is an update about your inspection."));
    case "scheduling_suggestion": return t(clip(p["title"], 80, "Elena drafted a message"), clip(p["text"], 400, "Review the draft and send, edit or skip it."));
    case "lead_followup_due": return t("Lead follow-up due", clip(p["text"], 300, `Follow up with ${name} about ${listing}.`), false);
    case "job_update": return t(clip(p["title"], 80, "Job update"), clip(p["text"], 600, "There is an update on your job."));
    case "emergency_request": return t(`Urgent request ${clip(p["reference"], 20, "")}`, clip(p["text"], 300, "An owner needs an emergency contractor. Open it to accept or pass."), false);
    case "emergency_accepted": return t("A contractor accepted your urgent request", clip(p["text"], 300, `${name} accepted your urgent request. Open it for their contact details.`), false);
    case "elena_enquiry": return t(clip(p["title"], 80, "Elena update"), clip(p["text"], 400, "Elena has an update on a buyer enquiry."));
    case "open_inspection_owner_reminder": return t("Inspection coming up", `${name} is booked to inspect ${listing} on ${when}.`);
    case "owner_digest": return t(clip(p["title"], 80, "What needs you today"), clip(p["text"], 1500, "Open your dashboard to see what needs you today."), false);
    case "rental_update": return t(clip(p["title"], 80, "Rental update"), clip(p["text"], 700, "There is an update on your rental."));
    case "rental_urgent": return t(clip(p["title"], 80, "Urgent rental update"), clip(p["text"], 700, "There is an urgent update on your rental."));
    case "cert_expiring": return t(clip(p["title"], 80, "A certificate is expiring"), clip(p["text"], 500, "Upload your renewed certificate and send the new details for verification."), false);
    case "cert_expired": return t(clip(p["title"], 80, "A certificate has expired"), clip(p["text"], 500, "Upload your renewed certificate and send the new details for verification."), false);
    case "automation_alert": return t(clip(p["title"], 80, "Automation update"), clip(p["text"], 400, "One of your automations ran."));
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
    else if (rate >= 0.8 && info.smsAllowed && !prefs[s.category].sms && hasVerifiedPhone && s.category !== "listings" && s.category !== "marketing")
      out.push({ category: s.category, channel: "sms", turnOn: true, reason: `You open most of your ${info.label.toLowerCase()} notifications. A text would reach you faster. It's your choice, and you can turn it off any time.` });
  }
  return out;
}

export function describeSuggestions(list: readonly Suggestion[]): ElenaReply {
  if (list.length === 0) return { text: "Your settings look right for how you use notifications. I'll have more to suggest once you've had a few more.", pose: "front", links: [SETTINGS_LINK] };
  return { text: list.map(s => `${CATEGORY_INFO[s.category].label}: ${s.reason}`).join(" "), pose: "tablet", links: [SETTINGS_LINK] };
}

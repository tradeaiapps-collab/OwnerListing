import { scanContent } from "./content-filter";
import type { Jurisdiction } from "./jurisdiction";
import { JURISDICTION_TIME_ZONE } from "./timezone";

/**
 * Elena handling a contractor job for an owner who switched it on (per listing). Pure: the server layer stores the state and sends the messages.
 * Rules that never bend: she states no price and agrees to no money, invents no facts (messages are fixed templates filled only from stored
 * fields), sends nothing the content filter blocks, never sends more than MAX_PER_PARTY_PER_DAY messages to one person on one job, and
 * answers free-form email only where the owner turned auto-reply on. Anything she cannot settle goes back to the owner.
 */

export const JOB_STATES = ["requested", "negotiating", "scheduled", "awaiting_delivery", "delivered", "needs_owner", "stopped"] as const;
export type JobState = (typeof JOB_STATES)[number];
export type Party = "owner" | "contractor";

export interface JobSettings { handleJobs: boolean; autoReply: boolean; hideNewFiles: boolean }
export interface ElenaJob {
  id: string; assignmentId: string; listingId: string; kind: string; contactRef: string; state: JobState;
  proposedAt?: string; proposedBy?: Party; appointmentAt?: string;
  rounds: number; reminders: number; nextActionAt?: string; createdAt: string; lastInboundAt?: string;
}

export const LIMITS = {
  /** Outbound messages to one person on one job in a rolling 24 hours. */
  maxPerPartyPerDay: 8,
  /** Reminders before Elena stops chasing and hands back to the owner. */
  maxReminders: 3,
  /** Proposals passed back and forth before the owner is asked to step in. */
  maxRounds: 8,
  reminderGapMs: 24 * 3600_000,
  /** After the appointment, how long before she asks for the files, and the gap between follow-ups. */
  deliveryGraceMs: 2 * 3600_000,
  deliveryGapMs: 24 * 3600_000,
  maxBody: 1500
} as const;

// ---- Reading a reply ------------------------------------------------------------------------------------------------------------

export type Intent = "accept" | "reject" | "propose" | "money" | "question" | "other";
export interface ReadReply { intent: Intent; at?: string }

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Local wall-clock time in an IANA zone to a UTC instant. Two passes handle the offset change across daylight saving. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): string | undefined {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (t: number) => {
    const parts = new Intl.DateTimeFormat("en-AU", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(t));
    const g = (k: string) => Number(parts.find(p => p.type === k)?.value);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  const dt = new Date(t);
  if (Number.isNaN(dt.getTime())) return undefined;
  // Reject impossible dates such as 31 February (they roll over).
  const check = new Intl.DateTimeFormat("en-AU", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(dt);
  const cg = (k: string) => Number(check.find(p => p.type === k)?.value);
  return cg("year") === y && cg("month") === mo && cg("day") === d ? dt.toISOString() : undefined;
}

function clock(text: string): { h: number; mi: number } | undefined {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) ?? text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b()/);
  if (!m) return undefined;
  let h = Number(m[1]); const mi = Number(m[2] ?? 0); const ap = m[3]?.toLowerCase();
  if (ap) { if (h < 1 || h > 12) return undefined; if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0; }
  return { h, mi };
}

/**
 * Finds one date and time in a reply, in the property's time zone, day first (Australian). Understands "25/11/2026 10:30", "2026-11-25 14:00",
 * "25 Nov 10am" and "Tuesday 25 November at 2:30pm". Returns undefined when there is no date plus a time, or when it is not in the future.
 */
export function parseProposedTime(text: string, now: string, jurisdiction: Jurisdiction): string | undefined {
  const tz = JURISDICTION_TIME_ZONE[jurisdiction];
  const nowY = new Date(now).getUTCFullYear();
  const t = clock(text);
  if (!t) return undefined;
  let y: number | undefined, mo: number | undefined, d: number | undefined;
  let m = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (m) { y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]); }
  if (d === undefined && (m = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/))) {
    d = Number(m[1]); mo = Number(m[2]); y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
  }
  if (d === undefined && (m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+(20\d{2}))?\b/i))) {
    d = Number(m[1]); mo = MONTHS.indexOf(m[2]!.toLowerCase()) + 1; y = m[3] ? Number(m[3]) : undefined;
  }
  if (d === undefined || mo === undefined || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const nowMs = new Date(now).getTime();
  let at = zonedToUtc(y ?? nowY, mo, d, t.h, t.mi, tz);
  if (!y && at && new Date(at).getTime() <= nowMs) at = zonedToUtc(nowY + 1, mo, d, t.h, t.mi, tz); // "25 Jan" said in December
  return at && new Date(at).getTime() > nowMs && new Date(at).getTime() < nowMs + 180 * 86_400_000 ? at : undefined;
}

const MONEY = /\$\s?\d|\b\d+\s?(?:dollars|bucks|aud)\b|\b(?:price|quote|quoted|fee|fees|cost|costs|invoice|pay(?:ment|able)?|deposit|discount|refund|charge|charges|rate)\b/i;
const NO = /\b(?:no|nope|can'?t|cannot|can not|won'?t|unable|unavailable|not (?:possible|available|suitable|convenient|work)|doesn'?t work|does not work|decline|reject|sorry)\b/i;
const YES = /\b(?:yes|yep|yeah|sure|ok(?:ay)?|confirm(?:ed)?|accept(?:ed)?|agreed?|works? for me|that works|sounds good|fine|perfect|good for me|see you then)\b/i;

/**
 * What a reply means, conservatively. Anything about money is "money" and always goes to the owner. A reply with a future date and time is
 * a proposal. A clear yes or no with nothing else is an answer to the standing proposal. A question mark means a question; the rest is "other".
 */
export function readReply(text: string, now: string, jurisdiction: Jurisdiction): ReadReply {
  const t = text.trim();
  if (MONEY.test(t)) return { intent: "money" };
  const at = parseProposedTime(t, now, jurisdiction);
  if (at && !NO.test(t.split(/[.\n]/)[0] ?? "")) return { intent: "propose", at };
  const first = t.split(/[.!\n]/)[0] ?? t;
  if (t.length <= 80 && !t.includes("?") && !/\b(?:but|however|also|although|unless|if)\b/i.test(t)) {
    if (NO.test(first) && !YES.test(first)) return { intent: "reject", ...(at ? { at } : {}) };
    if (YES.test(first) && !NO.test(first)) return { intent: "accept" };
  }
  if (at) return { intent: "propose", at };
  return { intent: t.includes("?") ? "question" : "other" };
}

// ---- Messages -------------------------------------------------------------------------------------------------------------------

export const MESSAGE_KINDS = [
  "request", "request_reminder", "ask_time", "time_to_confirm", "time_reminder", "time_rejected", "confirmed", "appointment_reminder",
  "delivery_followup", "delivered_owner", "needs_owner", "files_added", "auto_reply_help"
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface MessageVars { address: string; contractor: string; owner: string; kindLabel: string; ref: string; when?: string; reason?: string; count?: number }
export interface Draft { title: string; body: string }

const REPLY_HINT = "Reply with a date and time, for example: 25 Nov 10:30am.";
const YN_HINT = "Reply yes to confirm, or no with a date and time that suits you better, for example: 26 Nov 2pm.";

/** Fixed wording only, filled from stored fields. No prices, no promises about money, no contact details. */
export function draftMessage(kind: MessageKind, v: MessageVars): Draft {
  const job = `${v.kindLabel} job ${v.ref} at ${v.address}`;
  switch (kind) {
    case "request": return { title: `New job request: ${v.kindLabel}`, body: `Hi ${v.contractor}, ${v.owner} would like you for a ${job}. Please open your Jobs page to accept or decline. Pricing is agreed directly between you and the owner. Elena, on behalf of ${v.owner}.` };
    case "request_reminder": return { title: `Reminder: ${v.kindLabel} request`, body: `Hi ${v.contractor}, a reminder that ${v.owner} is waiting to hear if you can take the ${job}. Please accept or decline on your Jobs page.` };
    case "ask_time": return { title: `When can you attend? ${v.ref}`, body: `Thanks for accepting the ${job}. When can you attend? ${REPLY_HINT}` };
    case "time_to_confirm": return { title: `Please confirm a time: ${v.ref}`, body: `A time has been suggested for the ${job}: ${v.when}. ${YN_HINT}` };
    case "time_reminder": return { title: `Reminder: time for ${v.ref}`, body: `Still waiting on a time for the ${job}. ${v.when ? `The suggestion is ${v.when}. ${YN_HINT}` : REPLY_HINT}` };
    case "time_rejected": return { title: `Another time needed: ${v.ref}`, body: `${v.when ? `${v.when} did not suit.` : "That time did not suit."} Please suggest another time for the ${job}. ${REPLY_HINT}` };
    case "confirmed": return { title: `Confirmed: ${v.kindLabel} on ${v.when}`, body: `The ${job} is confirmed for ${v.when}.` };
    case "appointment_reminder": return { title: `Tomorrow: ${v.kindLabel}`, body: `A reminder that the ${job} is booked for ${v.when}.` };
    case "delivery_followup": return { title: `Please upload your work: ${v.ref}`, body: `Hi ${v.contractor}, thanks for attending the ${job}. Please upload your photos and reports to the listing from your Jobs page, or reply to this message with them attached.` };
    case "delivered_owner": return { title: `Work received: ${v.kindLabel}`, body: `${v.contractor} has uploaded ${v.count ?? 0} file${v.count === 1 ? "" : "s"} for the ${job}. Photos are on your listing; open the listing to keep, reorder or hide them, then mark the job complete.` };
    case "files_added": return { title: `Files added to your listing`, body: `${v.count ?? 0} new file${v.count === 1 ? "" : "s"} from ${v.contractor} were added to ${v.address}. Hide any you do not want shown.` };
    case "needs_owner": return { title: `Elena needs you: ${v.kindLabel}`, body: `Elena has stopped on the ${job}. ${v.reason ?? "Please take a look."}` };
    case "auto_reply_help": return { title: `Re: ${v.ref}`, body: `Thanks. I have passed your message to ${v.owner}, who will reply directly. For the ${job}, ${REPLY_HINT.charAt(0).toLowerCase()}${REPLY_HINT.slice(1)}` };
  }
}

export type OutboundCheck = { ok: true } | { ok: false; reason: string };
/** Everything Elena sends is scanned. Contact details, abuse and spam block the send; the owner is told instead. */
export function checkOutbound(d: Draft): OutboundCheck {
  const text = `${d.title}\n${d.body}`;
  if (text.length > LIMITS.maxBody + 200) return { ok: false, reason: "Message too long." };
  const scan = scanContent(text);
  if (scan.action === "block") return { ok: false, reason: "The message was blocked by the content filter." };
  if (MONEY_OUT.test(d.body)) return { ok: false, reason: "Elena does not send amounts or payment terms." };
  return { ok: true };
}
const MONEY_OUT = /\$\s?\d/;

/** True when another message to this person would exceed the daily limit. `sentAt` are times of messages already sent to them on this job. */
export function rateLimited(sentAt: readonly string[], now: string): boolean {
  const since = new Date(now).getTime() - 24 * 3600_000;
  return sentAt.filter(t => new Date(t).getTime() > since).length >= LIMITS.maxPerPartyPerDay;
}

// ---- What happens next ----------------------------------------------------------------------------------------------------------

export type Step =
  | { type: "send"; to: Party; kind: MessageKind }
  | { type: "set"; patch: Partial<Pick<ElenaJob, "state" | "proposedAt" | "proposedBy" | "appointmentAt" | "rounds" | "reminders">> & { nextActionAt?: string | null; reason?: string } };

const plus = (now: string, ms: number) => new Date(new Date(now).getTime() + ms).toISOString();
const other = (p: Party): Party => (p === "owner" ? "contractor" : "owner");

/** The assignment became approved (the contractor accepted): ask them for a time. */
export function onAccepted(now: string): Step[] {
  return [
    { type: "set", patch: { state: "negotiating", nextActionAt: plus(now, LIMITS.reminderGapMs) } },
    { type: "send", to: "contractor", kind: "ask_time" }
  ];
}

/** One party proposed a time (in the app or by email). The other party is asked to confirm it. */
export function onProposal(job: ElenaJob, from: Party, at: string, now: string): Step[] {
  if (job.state !== "negotiating") return [];
  if (job.rounds >= LIMITS.maxRounds) return [{ type: "set", patch: { state: "needs_owner", nextActionAt: null, reason: "You and the contractor have gone back and forth several times. Please agree a time directly." } }];
  return [
    { type: "set", patch: { proposedAt: at, proposedBy: from, rounds: job.rounds + 1, reminders: 0, nextActionAt: plus(now, LIMITS.reminderGapMs) } },
    { type: "send", to: other(from), kind: "time_to_confirm" }
  ];
}

/** The party the proposal was waiting on said yes (or no). */
export function onAnswer(job: ElenaJob, from: Party, accepted: boolean, now: string): Step[] {
  if (job.state !== "negotiating" || !job.proposedAt || !job.proposedBy || from === job.proposedBy) return [];
  if (accepted) {
    const reminderAt = new Date(new Date(job.proposedAt).getTime() - 24 * 3600_000).toISOString();
    return [
      { type: "set", patch: { state: "scheduled", appointmentAt: job.proposedAt, reminders: 0, nextActionAt: new Date(reminderAt) > new Date(now) ? reminderAt : plus(job.proposedAt, LIMITS.deliveryGraceMs) } },
      { type: "send", to: "owner", kind: "confirmed" },
      { type: "send", to: "contractor", kind: "confirmed" }
    ];
  }
  // Rejected: both are asked for another time, and whoever replies first starts the next round.
  return [
    { type: "set", patch: { proposedAt: undefined as never, proposedBy: undefined as never, rounds: job.rounds + 1, reminders: 0, nextActionAt: plus(now, LIMITS.reminderGapMs) } },
    { type: "send", to: "owner", kind: "time_rejected" },
    { type: "send", to: "contractor", kind: "time_rejected" }
  ];
}

export interface TickContext { assignmentStatus: "proposed" | "approved" | "completed" | "cancelled"; deliveredFiles: number }

/** What a due job needs now. Called by the scheduler for jobs whose nextActionAt has passed. */
export function onDue(job: ElenaJob, ctx: TickContext, now: string): Step[] {
  if (job.state === "delivered" || job.state === "stopped" || job.state === "needs_owner") return [];
  if (ctx.assignmentStatus === "cancelled" || ctx.assignmentStatus === "completed") return [{ type: "set", patch: { state: "stopped", nextActionAt: null } }];
  const handBack = (reason: string): Step[] => [{ type: "set", patch: { state: "needs_owner", nextActionAt: null, reason } }];
  const nextGap = plus(now, LIMITS.reminderGapMs);
  const chase = (to: Party, kind: MessageKind, reason: string): Step[] =>
    job.reminders >= LIMITS.maxReminders ? handBack(reason)
      : [{ type: "set", patch: { reminders: job.reminders + 1, nextActionAt: nextGap } }, { type: "send", to, kind }];

  switch (job.state) {
    case "requested":
      if (ctx.assignmentStatus === "approved") return onAccepted(now);
      return chase("contractor", "request_reminder", "The contractor has not answered the request after three reminders. Please choose someone else.");
    case "negotiating": {
      if (!job.proposedAt || !job.proposedBy) return chase("contractor", "time_reminder", "The contractor has not suggested a time after three reminders. Please choose someone else or call them.");
      const waiting = other(job.proposedBy);
      return chase(waiting, "time_reminder", `${waiting === "owner" ? "You have" : "The contractor has"} not answered the suggested time after three reminders. Please agree a time directly.`);
    }
    case "scheduled": {
      const at = job.appointmentAt ? new Date(job.appointmentAt).getTime() : 0;
      const t = new Date(now).getTime();
      if (at - t > LIMITS.deliveryGraceMs) return [{ type: "set", patch: { nextActionAt: plus(job.appointmentAt!, LIMITS.deliveryGraceMs) } }, { type: "send", to: "contractor", kind: "appointment_reminder" }];
      return [{ type: "set", patch: { state: "awaiting_delivery", reminders: 0, nextActionAt: now } }];
    }
    case "awaiting_delivery":
      if (ctx.deliveredFiles > 0) return [{ type: "set", patch: { state: "delivered", nextActionAt: null } }, { type: "send", to: "owner", kind: "delivered_owner" }];
      if (job.reminders >= LIMITS.maxReminders) return handBack("The contractor has not uploaded their work after three follow-ups.");
      return [{ type: "set", patch: { reminders: job.reminders + 1, nextActionAt: plus(now, LIMITS.deliveryGapMs) } }, { type: "send", to: "contractor", kind: "delivery_followup" }];
    default: return [];
  }
}

/**
 * What to do with a free-form email reply. Returns the steps, or "owner" when only the owner can answer (money, questions, anything unclear).
 * Time proposals and plain yes or no answers are part of the job flow and handled whenever the owner chose "let Elena handle it".
 * Anything else, including a polite "thanks" that wants a reply, is only answered when auto-reply is on, and then only with a fixed hand-over note.
 */
export function onReply(job: ElenaJob, from: Party, r: ReadReply, settings: JobSettings, now: string): { steps: Step[]; toOwner: boolean; reply: boolean } {
  if (!settings.handleJobs) return { steps: [], toOwner: true, reply: false };
  if (r.intent === "money") return { steps: [], toOwner: true, reply: false };
  if (job.state === "negotiating") {
    if (r.intent === "propose" && r.at) return { steps: onProposal(job, from, r.at, now), toOwner: false, reply: false };
    if ((r.intent === "accept" || r.intent === "reject") && job.proposedBy && from !== job.proposedBy) return { steps: onAnswer(job, from, r.intent === "accept", now), toOwner: false, reply: false };
    if (r.intent === "reject" && r.at) return { steps: onProposal(job, from, r.at, now), toOwner: false, reply: false };
  }
  // Not part of the flow. With auto-reply on she sends the fixed hand-over note; either way the owner sees it.
  return { steps: settings.autoReply ? [{ type: "send", to: from, kind: "auto_reply_help" }] : [], toOwner: true, reply: settings.autoReply };
}

export const KIND_LABEL: Record<string, string> = { photographer: "photographer", inspector: "building inspection", solicitor: "solicitor", agent: "agent", other: "contractor" };

/** A short, unguessable-enough reference to quote in messages: EJ- and six digits drawn from the job id. */
export function contactRefFor(jobId: string): string {
  const n = parseInt(jobId.replace(/-/g, "").slice(0, 8), 16) % 900000;
  return `EJ-${String(100000 + n)}`;
}
export function findRef(text: string): string | undefined { return text.match(/\bEJ-\d{6}\b/i)?.[0]?.toUpperCase(); }

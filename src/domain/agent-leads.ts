/** Agent lead CRM: pure rules for tone, follow-ups, notes and response time. The database captures leads (see db/20261105270000_agent_leads.sql). */

export const LEAD_STATUSES = ["new_inquiry", "viewing_scheduled", "offer_pending", "lost", "converted"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const LOST_REASONS = ["budget", "location", "other"] as const;
export type LostReason = (typeof LOST_REASONS)[number];
export type LeadTone = "red" | "yellow" | "green" | "closed";

export const STATUS_LABEL: Record<LeadStatus, string> = {
  new_inquiry: "New inquiry", viewing_scheduled: "Viewing scheduled", offer_pending: "Offer pending", lost: "Lost", converted: "Converted"
};
export const LOST_LABEL: Record<LostReason, string> = { budget: "Budget", location: "Location", other: "Other" };

export const isLeadStatus = (v: unknown): v is LeadStatus => typeof v === "string" && (LEAD_STATUSES as readonly string[]).includes(v);
export const isLostReason = (v: unknown): v is LostReason => typeof v === "string" && (LOST_REASONS as readonly string[]).includes(v);
export const isOpen = (s: LeadStatus) => s !== "lost" && s !== "converted";

export const MAX_NOTE_LENGTH = 1000;
export const MAX_NOTES = 200;
/** "Remind me in N days" choices. */
export const FOLLOWUP_DAYS = [1, 2, 3, 7, 14] as const;
const DAY_MS = 86_400_000;

export interface LeadTiming {
  status: LeadStatus;
  firstResponseAt: string | null;
  lastBuyerAt: string;
  lastAgentAt: string | null;
  nextFollowupAt: string | null;
}

/** Follow-up is due once its time has passed and the lead is still open. */
export function followupDue(l: Pick<LeadTiming, "status" | "nextFollowupAt">, now: string): boolean {
  return isOpen(l.status) && l.nextFollowupAt !== null && Date.parse(l.nextFollowupAt) <= Date.parse(now);
}

/**
 * Red: the buyer has never had a reply, or a follow-up is overdue. Yellow: the agent replied before but the buyer has written since.
 * Green: the agent has the last word. Closed leads (lost or converted) are neither.
 */
export function leadTone(l: LeadTiming, now: string): LeadTone {
  if (!isOpen(l.status)) return "closed";
  if (l.firstResponseAt === null || followupDue(l, now)) return "red";
  if (l.lastAgentAt === null || Date.parse(l.lastBuyerAt) > Date.parse(l.lastAgentAt)) return "yellow";
  return "green";
}

const TONE_ORDER: Record<LeadTone, number> = { red: 0, yellow: 1, green: 2, closed: 3 };
/** Most urgent first (red, yellow, green, closed), then the longest-waiting. */
export function compareLeads(a: LeadTiming & { lastInteractionAt: string }, b: LeadTiming & { lastInteractionAt: string }, now: string): number {
  const t = TONE_ORDER[leadTone(a, now)] - TONE_ORDER[leadTone(b, now)];
  return t !== 0 ? t : Date.parse(a.lastInteractionAt) - Date.parse(b.lastInteractionAt);
}

/** Minutes from the lead arriving to the agent's first reply; undefined until the agent has replied. */
export function responseMinutes(createdAt: string, firstResponseAt: string | null): number | undefined {
  if (firstResponseAt === null) return undefined;
  const m = Math.round((Date.parse(firstResponseAt) - Date.parse(createdAt)) / 60_000);
  return m >= 0 ? m : 0;
}

export function formatResponseTime(minutes: number | undefined): string {
  if (minutes === undefined) return "No reply yet";
  if (minutes < 1) return "Under a minute";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} days`;
}

export function followupAt(now: string, days: number): string | undefined {
  if (!(FOLLOWUP_DAYS as readonly number[]).includes(days)) return undefined;
  return new Date(Date.parse(now) + days * DAY_MS).toISOString();
}

export interface LeadNote { id: string; at: string; by: string; text: string }

export function parseNoteText(v: unknown): { ok: true; text: string } | { ok: false; error: string } {
  const text = typeof v === "string" ? v.trim() : "";
  if (text.length === 0) return { ok: false, error: "Write a note first." };
  if (text.length > MAX_NOTE_LENGTH) return { ok: false, error: `Notes can be up to ${MAX_NOTE_LENGTH} characters.` };
  return { ok: true, text };
}

/** Lost needs one of the known reasons; "other" should say what. */
export function parseLost(reason: unknown, note: unknown): { ok: true; reason: LostReason; note: string } | { ok: false; error: string } {
  if (!isLostReason(reason)) return { ok: false, error: "Choose a reason: budget, location or other." };
  const n = typeof note === "string" ? note.trim().slice(0, 500) : "";
  if (reason === "other" && n.length === 0) return { ok: false, error: "Say what the reason was." };
  return { ok: true, reason, note: n };
}

/** Agent-facing text for the reminder notification. */
export function followupText(buyerName: string, listingTitle: string, note: string): string {
  const tail = note.trim() ? ` Your note: ${note.trim().slice(0, 150)}` : "";
  return `Follow up with ${buyerName} about ${listingTitle}.${tail}`;
}

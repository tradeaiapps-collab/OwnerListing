import type { Jurisdiction } from "./inspection-marketplace";

/**
 * Elena's scheduling auto-responder (pure). For an accepted inspection booking Elena drafts a confirmation straight away and a reminder
 * 24 hours before. She only suggests: the inspector sends, edits or skips each draft. Wording comes from templates (an agent's own, else
 * the platform-wide one, else the built-in default) with [variables]. No sending channel lives here; SQL is in src/server/elena-scheduling-db.ts.
 */

export const MESSAGE_KINDS = ["booking_confirmation", "reminder_24h"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const KIND_LABEL: Record<MessageKind, string> = { booking_confirmation: "Booking confirmation", reminder_24h: "24-hour reminder" };
export const VOICES = ["professional", "casual", "friendly", "formal"] as const;
export type Voice = (typeof VOICES)[number];
export const DEFAULT_VOICE: Voice = "friendly";

export const VARIABLES = ["buyer_name", "agent_name", "property_address", "appointment_time", "listing_title", "buyer_notes"] as const;
export type Variable = (typeof VARIABLES)[number];
export type Vars = Record<Variable, string>;

export const TEMPLATE_LIMITS = { minBody: 20, maxBody: 1500, maxFinal: 1500 } as const;
export const REMINDER_LEAD_MS = 24 * 3600_000;

export const isKind = (v: unknown): v is MessageKind => (MESSAGE_KINDS as readonly unknown[]).includes(v);
export const isVoice = (v: unknown): v is Voice => (VOICES as readonly unknown[]).includes(v);

/** Built-in wording, one per kind and voice. A line that holds only an empty variable (for example [buyer_notes]) is dropped when rendering. */
export const DEFAULT_TEMPLATES: Record<MessageKind, Record<Voice, string>> = {
  booking_confirmation: {
    friendly:
      "Hi [buyer_name]! You're booked in for [listing_title] on [appointment_time].\n\nWe'll meet at [property_address]. Please bring photo ID, and your pre-approval letter if you have one. Park on the street and follow local signs.\n[buyer_notes]\nI'm looking forward to it. If you need to change anything, just message me here. Cheers, [agent_name]",
    professional:
      "Hello [buyer_name], your inspection of [listing_title] is confirmed for [appointment_time] at [property_address].\n\nPlease bring photo ID and, if you have one, your finance pre-approval letter.\n[buyer_notes]\nIf you need to reschedule or cancel, please message me through the platform as early as you can. Regards, [agent_name]",
    casual:
      "Hey [buyer_name], you're all set for [listing_title] on [appointment_time]. Meet me at [property_address]. Bring photo ID, plus your pre-approval letter if you've got one.\n[buyer_notes]\nCan't make it? Just message me here. See you there, [agent_name]",
    formal:
      "Dear [buyer_name], this confirms your inspection of [listing_title] at [property_address] on [appointment_time].\n\nPlease bring photo identification and any finance pre-approval documentation.\n[buyer_notes]\nShould you need to alter or cancel the appointment, kindly message me through the platform. Yours sincerely, [agent_name]"
  },
  reminder_24h: {
    friendly:
      "Hi [buyer_name], just a friendly reminder that we're meeting tomorrow for [listing_title] on [appointment_time] at [property_address].\n\nAre you still able to make it? Let me know here if anything has changed. Don't forget your photo ID. See you soon, [agent_name]",
    professional:
      "Hello [buyer_name], a reminder that your inspection of [listing_title] is on [appointment_time] at [property_address].\n\nPlease confirm you are still attending, or message me through the platform if you need to change the time. Regards, [agent_name]",
    casual:
      "Hey [buyer_name], quick reminder: [listing_title] tomorrow, [appointment_time], at [property_address]. Still good to go? Shout if that's changed. [agent_name]",
    formal:
      "Dear [buyer_name], this is a reminder of your inspection of [listing_title] at [property_address] on [appointment_time]. Please confirm your attendance, or notify me through the platform should your plans change. Yours sincerely, [agent_name]"
  }
};

const VAR_RE = /\[([a-z_]+)\]/g;

/** Text with [variables] replaced. Unknown [words] are left as written. A line left empty by an empty variable is removed. */
export function renderTemplate(body: string, vars: Partial<Vars>): string {
  const lines = body.split("\n").flatMap(line => {
    const onlyVar = /^\s*\[([a-z_]+)\]\s*$/.exec(line);
    if (onlyVar && (VARIABLES as readonly string[]).includes(onlyVar[1]!) && !(vars as Record<string, string | undefined>)[onlyVar[1]!]) return [];
    return [line.replace(VAR_RE, (m, name: string) => ((VARIABLES as readonly string[]).includes(name) ? ((vars as Record<string, string | undefined>)[name] ?? "") : m))];
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (s: string) => s.replace(/\r\n?/g, "\n").replace(control, "").trim();

export interface TemplateInput { kind: MessageKind; voice: Voice; body: string }

/** Staff or agent template edit. Unknown [variables] are rejected so a typo never reaches a buyer. */
export function parseTemplateInput(input: unknown): { ok: true; value: TemplateInput } | { ok: false; error: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Send the template as an object." };
  const o = input as Record<string, unknown>;
  if (!isKind(o["kind"])) return { ok: false, error: "Choose which message the template is for." };
  if (!isVoice(o["voice"])) return { ok: false, error: "Choose a voice." };
  if (typeof o["body"] !== "string") return { ok: false, error: "Write the message." };
  const body = clean(o["body"]);
  if (body.length < TEMPLATE_LIMITS.minBody || body.length > TEMPLATE_LIMITS.maxBody) return { ok: false, error: `The message must be ${TEMPLATE_LIMITS.minBody} to ${TEMPLATE_LIMITS.maxBody} characters.` };
  const unknown = [...new Set([...body.matchAll(VAR_RE)].map(m => m[1]!).filter(n => !(VARIABLES as readonly string[]).includes(n)))];
  if (unknown.length > 0) return { ok: false, error: `Unknown variable${unknown.length > 1 ? "s" : ""}: ${unknown.map(u => `[${u}]`).join(", ")}. Use ${VARIABLES.map(v => `[${v}]`).join(", ")}.` };
  return { ok: true, value: { kind: o["kind"], voice: o["voice"], body } };
}

/** Agent's own template, else the platform-wide one, else the built-in text in the friendly voice. */
export function pickTemplate(kind: MessageKind, own?: { voice: Voice; body: string }, global?: { voice: Voice; body: string }): { body: string; voice: Voice; source: "agent" | "platform" | "default" } {
  if (own) return { ...own, source: "agent" };
  if (global) return { ...global, source: "platform" };
  return { body: DEFAULT_TEMPLATES[kind][DEFAULT_VOICE], voice: DEFAULT_VOICE, source: "default" };
}

const TZ: Record<Jurisdiction, string> = {
  NSW: "Australia/Sydney", VIC: "Australia/Melbourne", ACT: "Australia/Sydney", TAS: "Australia/Hobart",
  QLD: "Australia/Brisbane", SA: "Australia/Adelaide", WA: "Australia/Perth", NT: "Australia/Darwin"
};
/** "Saturday 14 November, 10:00 am" in the property's local time. */
export function formatAppointment(iso: string, jurisdiction: Jurisdiction): string {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", timeZone: TZ[jurisdiction] }).format(d);
  const time = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: TZ[jurisdiction] }).format(d).replace(/\s?(am|pm)$/i, (_m, x: string) => ` ${x.toLowerCase()}`);
  return `${date}, ${time}`;
}

export interface PlannedMessage { kind: MessageKind; status: "suggested" | "scheduled"; dueAt: string }
/**
 * What to draft when a booking is accepted. The confirmation is offered at once. The 24-hour reminder is scheduled for 24 hours
 * before the appointment, and skipped when the appointment is already less than 24 hours away (the confirmation covers it).
 */
export function planMessages(scheduledAt: string, now: string): PlannedMessage[] {
  const plan: PlannedMessage[] = [{ kind: "booking_confirmation", status: "suggested", dueAt: now }];
  const remindAt = Date.parse(scheduledAt) - REMINDER_LEAD_MS;
  if (remindAt > Date.parse(now)) plan.push({ kind: "reminder_24h", status: "scheduled", dueAt: new Date(remindAt).toISOString() });
  return plan;
}

export type DecisionResult = { ok: true; action: "send"; body: string; edited: boolean } | { ok: true; action: "skip" } | { ok: false; error: string };
/** The agent's choice for a draft: { action: "send", body? } (body is the edited text) or { action: "skip" }. */
export function parseDecision(input: unknown, draft: string): DecisionResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Send an object with an action." };
  const o = input as Record<string, unknown>;
  if (o["action"] === "skip") return { ok: true, action: "skip" };
  if (o["action"] !== "send") return { ok: false, error: "Choose send or skip." };
  const raw = o["body"] === undefined ? draft : o["body"];
  if (typeof raw !== "string") return { ok: false, error: "The message must be text." };
  const body = clean(raw);
  if (!body) return { ok: false, error: "The message is empty." };
  if (body.length > TEMPLATE_LIMITS.maxFinal) return { ok: false, error: `The message can be up to ${TEMPLATE_LIMITS.maxFinal} characters.` };
  return { ok: true, action: "send", body, edited: body !== clean(draft) };
}

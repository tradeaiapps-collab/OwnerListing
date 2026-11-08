/**
 * Workflow rules: "when X happens, tell Y". Pure validation and wording; the database side is src/server/staff-automation-db.ts.
 * A rule never changes data. It sends a notification through the notification centre, so each person's channel choices and opt-outs still apply.
 */
export const TRIGGERS = ["offer_received", "listing_aging", "listing_viewed_repeat"] as const;
export type Trigger = (typeof TRIGGERS)[number];
export const RECIPIENTS = ["owner", "agent", "buyer", "owner_and_agent"] as const;
export type Recipient = (typeof RECIPIENTS)[number];
/** system_notice: operational, goes to owners and agents. marketing_news: follow-ups to buyers, only if they opted in to marketing. */
export const MESSAGE_KINDS = ["system_notice", "marketing_news"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface TriggerConfig { days?: number; views?: number; windowDays?: number }
export interface RuleInput {
  name: string; enabled: boolean; trigger: Trigger; triggerConfig: TriggerConfig; recipient: Recipient;
  messageKind: MessageKind; title: string; body: string; link: string | null;
}

export const TRIGGER_INFO: Record<Trigger, { label: string; help: string; recipients: readonly Recipient[] }> = {
  offer_received: { label: "An offer is received", help: "Runs when a buyer submits an offer on a listing.", recipients: ["owner", "agent", "owner_and_agent", "buyer"] },
  listing_aging: { label: "A listing has been live for N days", help: "Checked every 15 minutes. Runs once per listing for each rule. Use it to suggest relisting or a price review.", recipients: ["owner", "agent", "owner_and_agent"] },
  listing_viewed_repeat: { label: "A buyer views a listing N times", help: "Runs once per buyer and listing when they reach N views inside the window.", recipients: ["buyer", "owner", "agent", "owner_and_agent"] }
};
export const RECIPIENT_LABEL: Record<Recipient, string> = { owner: "The listing owner", agent: "The appointed agent", buyer: "The buyer", owner_and_agent: "Owner and agent" };

const int = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const text = (v: unknown, lo: number, hi: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, "").trim();
  return t.length >= lo && t.length <= hi ? t : null;
};
export const isSiteLink = (v: string): boolean => /^\/(?!\/)[^\s]{0,298}$/.test(v);

export function parseRule(input: unknown): { ok: true; rule: RuleInput } | { ok: false; error: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Send the rule as an object." };
  const o = input as Record<string, unknown>;
  const name = text(o["name"], 3, 120);
  if (!name) return { ok: false, error: "Give the rule a name of 3 to 120 characters." };
  const trigger = TRIGGERS.find(t => t === o["trigger"]);
  if (!trigger) return { ok: false, error: "Choose what starts the rule." };
  const recipient = RECIPIENTS.find(r => r === o["recipient"]);
  if (!recipient || !TRIGGER_INFO[trigger].recipients.includes(recipient)) return { ok: false, error: "Choose who to tell; this trigger cannot tell that person." };
  const messageKind = MESSAGE_KINDS.find(k => k === o["messageKind"]) ?? "system_notice";
  if (messageKind === "marketing_news" && recipient !== "buyer") return { ok: false, error: "Marketing follow-ups can only go to buyers who opted in." };
  if (recipient === "buyer" && trigger === "offer_received" && messageKind === "marketing_news") return { ok: false, error: "A message about a buyer's own offer is an account notice, not marketing." };
  const title = text(o["title"], 1, 80);
  const body = text(o["body"], 1, 400);
  if (!title) return { ok: false, error: "Give the message a title of up to 80 characters." };
  if (!body) return { ok: false, error: "Write the message, up to 400 characters." };
  const rawLink = typeof o["link"] === "string" ? o["link"].trim() : "";
  if (rawLink && !isSiteLink(rawLink)) return { ok: false, error: "A link must be a path on this site, such as /listings/mine." };
  const cfg = (o["triggerConfig"] ?? {}) as Record<string, unknown>;
  const triggerConfig: TriggerConfig = {};
  if (trigger === "listing_aging") {
    const days = int(cfg["days"], 7, 730);
    if (days === null) return { ok: false, error: "Choose how many days a listing is live before this runs (7 to 730)." };
    triggerConfig.days = days;
  }
  if (trigger === "listing_viewed_repeat") {
    const views = int(cfg["views"], 2, 20), windowDays = int(cfg["windowDays"] ?? 14, 1, 90);
    if (views === null) return { ok: false, error: "Choose how many views start this rule (2 to 20)." };
    if (windowDays === null) return { ok: false, error: "Choose a window of 1 to 90 days." };
    triggerConfig.views = views; triggerConfig.windowDays = windowDays;
  }
  return { ok: true, rule: { name, enabled: o["enabled"] !== false, trigger, triggerConfig, recipient, messageKind, title, body, link: rawLink || null } };
}

/** Replaces {listing}, {count} and {days} in the staff-written wording. Unknown placeholders are left as typed. */
export function fillTemplate(t: string, v: { listing?: string; count?: number; days?: number }): string {
  return t.replace(/\{(listing|count|days)\}/g, (_m, k: string) => (k === "listing" ? (v.listing ?? "your property") : String(k === "count" ? (v.count ?? "") : (v.days ?? ""))));
}

export function describeRule(r: Pick<RuleInput, "trigger" | "triggerConfig" | "recipient">): string {
  const when = r.trigger === "offer_received" ? "When an offer is received"
    : r.trigger === "listing_aging" ? `When a listing has been live ${r.triggerConfig.days ?? "?"} days`
    : `When a buyer views a listing ${r.triggerConfig.views ?? "?"} times in ${r.triggerConfig.windowDays ?? "?"} days`;
  return `${when}, tell ${RECIPIENT_LABEL[r.recipient].toLowerCase()}.`;
}

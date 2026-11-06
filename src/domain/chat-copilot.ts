import type { ChatFacts, ChatRole } from "./chat-assistant";
import { messageWordingError } from "./discrimination-filter";
import { formatAud } from "./listing-details";
import { detectTone } from "./message-moderation";
import { parseOfferText } from "./negotiation-coach";

/**
 * Elena as a drafting partner and conversation analyst inside one enquiry thread. Pure functions, rules only: the same
 * input always gives the same output, with or without any AI service.
 *
 *  draftFromWords      turns what a person said (typed or spoken) into polished messages in three tones.
 *  analyseConversation reads the whole thread and gives verdicts ("this price is likely to stall"), each with a ready draft.
 *
 * Rules that never bend: she only sees what both parties see (listing, asking price, the formal offer and counter, the messages);
 * she never receives the owner's floor or private notes; she suggests and never accepts, rejects or sends anything; every verdict
 * is labelled an estimate. Her output is private to the person who asked and is never stored.
 */

export type Side = "buyer" | "seller";
export interface CopilotMessage { side: Side; body: string; sentAt: string }
export interface CopilotInput { role: ChatRole; messages: readonly CopilotMessage[]; facts: ChatFacts; now: string }

export type DraftTone = "warm" | "direct" | "brief";
export interface DraftVariant { tone: DraftTone; label: string; text: string }
export type DraftResult =
  | { ok: true; intent: DraftIntent; heard: string; variants: DraftVariant[] }
  | { ok: false; reason: string };

export type DraftIntent = "offer" | "viewing" | "question" | "finance" | "thanks" | "decline" | "followup" | "general";
export type InsightTone = "good" | "watch" | "risk" | "tip";
export interface Insight {
  id: string; tone: InsightTone; headline: string; detail: string;
  /** A ready message the person can load into the composer and edit. */
  action?: { label: string; text: string };
}
export interface SuggestedReply { label: string; text: string }
export interface Analysis {
  waitingOn: "you" | "them" | "nobody";
  /** One line for the panel header. */
  summary: string;
  /** Estimated chance the current price position leads to a deal. Only when a price is on the table. */
  outlook?: { level: "low" | "fair" | "good"; percentOfAsking: number };
  insights: Insight[];
  replies: SuggestedReply[];
  disclaimer: string;
}

export const COPILOT_DISCLAIMER = "Elena's estimates come from the asking price and this conversation only. They are not a valuation or legal or financial advice. Only you decide what to send.";
export const MAX_WORDS_LENGTH = 1500;

// ---------------------------------------------------------------- drafting from words

const FILLERS = /\b(um+|uh+|er+|erm|you know|i mean|sort of|kind of|basically|actually|like,|okay so|ok so|so yeah|yeah)\b[,]?\s*/gi;
const REPORTING = /^(tell|ask|say to|let)\s+(him|her|them|the (owner|seller|buyer|agent))\s+(that\s+|if\s+|whether\s+)?/i;

/** Tidies a transcript: removes fillers and stutters, fixes "i", spacing and capitals, and ends sentences. */
export function cleanTranscript(raw: string): string {
  let t = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  t = t.replace(FILLERS, "").replace(/\b(\w+)(\s+\1\b)+/gi, "$1").replace(/\bi\b/g, "I").replace(/\bi'(m|ll|d|ve)\b/g, "I'$1").replace(/\s+([,.?!])/g, "$1");
  t = t.replace(REPORTING, "");
  const sentences = t.split(/(?<=[.?!])\s+/).map(s => s.trim()).filter(Boolean).map(s => s.charAt(0).toUpperCase() + s.slice(1));
  return sentences.map(s => (/[.?!]$/.test(s) ? s : `${s}.`)).join(" ").trim();
}

function intentOf(t: string, hasPrice: boolean): DraftIntent {
  if (/\b(no thanks|not interested|pass on|withdraw|can'?t proceed|decline|not going ahead)\b/i.test(t)) return "decline";
  if (hasPrice && /\b(offer|offering|pay|propose|bid|would take|how about|happy (to|at)|can (do|go|pay|stretch)|go (up )?to|up to|come up to|meet at)\b|\$/i.test(t)) return "offer";
  if (/\b(view|viewing|inspect|inspection|visit|see the (property|house|home|place)|open home)\b/i.test(t)) return "viewing";
  if (/\b(finance|loan|pre[- ]?approv\w*|mortgage|bank|deposit)\b/i.test(t)) return "finance";
  if (/\b(any news|following up|follow up|checking in|heard back|haven'?t heard)\b/i.test(t)) return "followup";
  if (/\b(thanks|thank you|appreciate|cheers)\b/i.test(t)) return "thanks";
  if (/\?|\b(what|when|where|who|how|why|can you|could you|do you|is there|are there)\b/i.test(t)) return "question";
  return "general";
}

const CLOSERS: Record<DraftIntent, Record<DraftTone, string>> = {
  offer: { warm: "This message is not a formal offer. If we are close, I would be glad to continue through a formal offer. Thank you for your time.", direct: "This message is not a formal offer. Please tell me if this is worth taking to a formal offer.", brief: "Not a formal offer. Happy to formalise if you are open to it." },
  viewing: { warm: "Please let me know what suits you. Thank you.", direct: "Please confirm a time that works.", brief: "What time suits you?" },
  question: { warm: "Thank you, I appreciate your help.", direct: "I would appreciate a reply when you can.", brief: "Thanks." },
  finance: { warm: "I am happy to share what is reasonable at the right stage. Thank you.", direct: "Please tell me what you need from my side.", brief: "Tell me what you need from me." },
  thanks: { warm: "Thank you again.", direct: "Thank you.", brief: "Thanks." },
  decline: { warm: "Thank you for your time and for the conversation. I wish you well with the sale.", direct: "Thank you for your time.", brief: "Thanks for your time." },
  followup: { warm: "No rush, and thank you for your time.", direct: "I would appreciate an update when you can.", brief: "Any update?" },
  general: { warm: "Thank you.", direct: "Thank you for considering this.", brief: "Thanks." }
};
const OPENERS: Record<DraftTone, string> = { warm: "Hello, thanks for your message.", direct: "Hello,", brief: "Hi," };
const LABEL: Record<DraftTone, string> = { warm: "Warm and polite", direct: "Clear and direct", brief: "Short" };

function offerCore(price: number, t: string, tone: DraftTone): string {
  const p = parseOfferText(t, {});
  const bits: string[] = [];
  if (p.depositCents) bits.push(`a deposit of ${formatAud(p.depositCents)}`);
  else if (p.depositPercent) bits.push(`a ${p.depositPercent}% deposit`);
  if (p.settlementDays) bits.push(`settlement in ${p.settlementDays} days`);
  const terms = bits.length ? ` with ${bits.join(" and ")}` : "";
  const cond = p.conditions.length ? ` ${p.conditions.map(c => c.replace(/\.$/, "")).join("; ")}.` : "";
  const lead = tone === "warm" ? "I am interested in the property and would like to propose" : tone === "direct" ? "I would like to propose" : "My proposal:";
  return `${lead} ${formatAud(price)}${terms}.${cond}`;
}

/**
 * Turns words into polished messages. `heard` is the cleaned transcript so the person can check what Elena understood.
 * Refuses text that would break the wording rules, so a draft is never worse than what was said.
 */
export function draftFromWords(words: string): DraftResult {
  const raw = words.slice(0, MAX_WORDS_LENGTH);
  const heard = cleanTranscript(raw);
  if (heard.length < 3) return { ok: false, reason: "Tell Elena what you want to say and she will draft it." };
  const wording = messageWordingError(heard);
  if (wording) return { ok: false, reason: wording };
  const price = parseOfferText(heard, {}).priceCents;
  const intent = intentOf(heard, price !== undefined && price >= 100_000);
  const tones: DraftTone[] = ["warm", "direct", "brief"];
  const variants = tones.map((tone): DraftVariant => {
    const core = intent === "offer" && price !== undefined ? offerCore(price, heard, tone) : heard;
    const opener = intent === "thanks" && tone !== "warm" ? "" : `${OPENERS[tone]}\n\n`;
    return { tone, label: LABEL[tone], text: `${opener}${core}\n\n${CLOSERS[intent][tone]}`.slice(0, 3900) };
  });
  return { ok: true, intent, heard, variants };
}

// ---------------------------------------------------------------- reading the conversation

const round1000 = (cents: number) => Math.round(cents / 100_000) * 100_000;
const pct = (a: number, b: number) => Math.round((a / b) * 100);
const DAY = 86_400_000;
const when = (ms: number) => (ms < 3_600_000 ? "under an hour" : ms < DAY ? `${Math.floor(ms / 3_600_000)} hours` : `${Math.floor(ms / DAY)} day${Math.floor(ms / DAY) === 1 ? "" : "s"}`);

const COMPETING = /\b(other (offers?|buyers?|interest|parties)|multiple offers?|another (offer|buyer))\b/i;
const COMMITTED = /\b(keen|love (it|the)|very interested|really like|ready to (proceed|go ahead|move)|happy to (proceed|go ahead)|pre[- ]?approved)\b/i;
const FIRM = /\b(final|non[- ]?negotiable|won'?t (go|budge|move)|not (budging|moving)|firm|last offer|take it or leave it)\b/i;

function latestFigure(messages: readonly CopilotMessage[], side: Side, asking?: number): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.side !== side) continue;
    const p = parseOfferText(m.body, asking ? { askingPriceCents: asking } : {}).priceCents;
    if (p !== undefined && p >= 100_000) return p;
  }
  return undefined;
}

/** What Elena reads from the thread: the latest price each side has put forward and where they stand against the asking price. */
export function priceSituation(input: CopilotInput): { asking?: number; buyer?: number; seller?: number } {
  const { facts, messages } = input;
  const asking = facts.listing.askingCents;
  const o = facts.offer;
  const counter = o?.counter && o.counter.status === "open" ? o.counter : undefined;
  const buyer = counter?.fromParty === "buyer" ? counter.priceCents : (o && OPEN.has(o.status) ? o.priceCents : undefined) ?? latestFigure(messages, "buyer", asking);
  const seller = counter?.fromParty === "owner" ? counter.priceCents : latestFigure(messages, "seller", asking);
  return { ...(asking ? { asking } : {}), ...(buyer ? { buyer } : {}), ...(seller ? { seller } : {}) };
}
const OPEN = new Set(["submitted", "under_review", "countered", "buyer_countered"]);

function draftCounter(role: ChatRole, target: number): string {
  return role === "buyer"
    ? `Hello,\n\nThank you for your reply. I can move to ${formatAud(target)}, which is a real step up from where I started. I would like to keep talking and take it to a formal offer if we are close.\n\nThank you.`
    : `Hello,\n\nThank you for your interest. At ${formatAud(target)} I would be prepared to keep talking, and I would ask for a formal offer at that level. Please let me know if that works for you.\n\nThank you.`;
}

/** Reads the whole thread from the viewer's side and returns verdicts with ready drafts, most important first. */
export function analyseConversation(input: CopilotInput): Analysis {
  const { role, messages, facts, now } = input;
  const me: Side = role === "buyer" ? "buyer" : "seller";
  const them: Side = me === "buyer" ? "seller" : "buyer";
  const sorted = [...messages].sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0));
  const last = sorted[sorted.length - 1];
  const lastIncoming = [...sorted].reverse().find(m => m.side === them);
  const waitingOn: Analysis["waitingOn"] = !last ? "nobody" : last.side === me ? "them" : "you";
  const waited = last ? Math.max(0, Date.parse(now) - Date.parse(last.sentAt)) : 0;
  const insights: Insight[] = [];
  const sit = priceSituation(input);
  const tx = facts.listing.transactionType;
  const money = (c: number) => (tx === "rent" ? `${formatAud(c)} a week` : formatAud(c));
  let outlook: Analysis["outlook"];

  // 1. Where the price stands against the asking price.
  const asking = sit.asking;
  const bid = sit.buyer;
  if (asking && bid) {
    const p = pct(bid, asking);
    const seller = role !== "buyer";
    const level: "low" | "fair" | "good" = p >= 97 ? "good" : p >= 90 ? "fair" : "low";
    outlook = { level, percentOfAsking: p };
    const target = round1000(Math.max(bid + Math.round((asking - bid) * 0.5), bid));
    if (level === "good") {
      insights.push({
        id: "price", tone: "good", headline: seller ? "Strong offer: close to your asking price" : "Your price is competitive",
        detail: seller ? `${money(bid)} is ${p}% of the asking price. Worth a serious look. Ask for a formal offer so the terms are on record.` : `${money(bid)} is ${p}% of the asking price, so the seller is likely to take it seriously. Stay quick and clear on terms.`
      });
    } else if (level === "fair") {
      insights.push({
        id: "price", tone: "watch", headline: seller ? "Below asking, but a deal is realistic" : "Below asking: expect a counter",
        detail: seller ? `${money(bid)} is ${p}% of asking. A counter near ${money(target)} keeps momentum without giving too much.` : `${money(bid)} is ${p}% of asking. Sellers often counter at this gap. A step toward ${money(target)} would likely help.`,
        action: { label: seller ? `Counter at ${money(target)}` : `Move to ${money(target)}`, text: draftCounter(role, target) }
      });
    } else {
      insights.push({
        id: "price", tone: "risk", headline: seller ? "Unlikely to be accepted at this price" : "This offer will likely fail at this price",
        detail: seller ? `${money(bid)} is only ${p}% of asking. Consider a counter near ${money(target)} or tell them it is too far from your expectations.` : `${money(bid)} is only ${p}% of asking. Sellers rarely engage at this gap. To be taken seriously, try ${money(target)} or higher.`,
        action: { label: seller ? `Counter at ${money(target)}` : `Move to ${money(target)}`, text: draftCounter(role, target) }
      });
    }
    if (sit.seller && sit.buyer && sit.seller > sit.buyer) {
      const gap = sit.seller - sit.buyer;
      const mid = round1000(sit.buyer + gap / 2);
      insights.push({
        id: "gap", tone: "tip", headline: `Gap of ${money(gap)} between the last two figures`,
        detail: `Meeting in the middle would be about ${money(mid)}. Pairing a smaller price move with something else, such as a shorter settlement, often closes a gap like this.`,
        action: { label: `Propose ${money(mid)}`, text: draftCounter(role, mid) }
      });
    }
  } else if (!bid && sorted.length > 0) {
    insights.push({ id: "no-price", tone: "tip", headline: "No price has been named yet", detail: role === "buyer" ? "Naming a figure moves the conversation forward. You can say it is not a formal offer." : "Ask what price and terms they have in mind before you reply in detail." });
  }

  // 2. Whose turn it is.
  if (last && waitingOn === "you" && waited > 4 * 3_600_000) {
    insights.push({ id: "slow", tone: "watch", headline: `They have waited ${when(waited)} for your reply`, detail: "A quick reply, even a short one, keeps people engaged. Elena has suggested replies below." });
  }
  if (last && waitingOn === "them" && waited > 2 * DAY) {
    insights.push({
      id: "stalled", tone: "watch", headline: `No reply for ${when(waited)}`,
      detail: "A short, friendly nudge usually works better than a second long message.",
      action: { label: "Draft a follow-up", text: "Hello,\n\nJust checking in on my last message. No rush, and happy to answer anything that would help.\n\nThank you." }
    });
  }

  // 3. What the latest incoming message says.
  if (lastIncoming) {
    const t = lastIncoming.body;
    const parsed = parseOfferText(t, asking ? { askingPriceCents: asking } : {});
    if (parsed.pressure.length > 0) {
      insights.push({ id: "pressure", tone: "risk", headline: role === "buyer" ? "The seller is pushing for a quick answer" : "They are pushing you to decide fast", detail: `${parsed.pressure[0]} You do not have to answer on their clock. Ask for time, and for proof of funds if money is the issue.` });
    }
    if (COMPETING.test(t)) {
      insights.push({ id: "competing", tone: "watch", headline: "They mention other interest", detail: "This may be true or may be a tactic. Ask them, politely, whether they can share where things stand, and keep your own position steady." });
    }
    if (FIRM.test(t)) {
      insights.push({ id: "firm", tone: "risk", headline: "They sound firm on price", detail: "Pushing the same figure again rarely helps. Offer something different, such as settlement timing or fewer conditions, rather than repeating the number." });
    }
    if (COMMITTED.test(t)) {
      insights.push({ id: "committed", tone: "good", headline: "They sound committed", detail: role === "buyer" ? "A good moment to ask for the next step: an inspection or a formal offer link." : "A good moment to propose the next step: an inspection time or issuing the formal offer link." });
    }
    if (parsed.conditions.length > 0) {
      insights.push({ id: "conditions", tone: "tip", headline: `Conditions mentioned: ${parsed.conditions.map(c => c.replace(/^Subject to /, "")).join(", ")}`, detail: role === "buyer" ? "Fewer conditions make an offer stronger. Say which ones you can waive or shorten." : "Each condition is a way the deal can fall over. Ask how long each will take and what evidence they can give." });
    }
    if (detectTone(t) !== "neutral") {
      insights.push({ id: "tone", tone: "watch", headline: "Their last message sounds tense", detail: "Answer calmly and keep to the facts. A softer reply usually brings the temperature down.", action: { label: "Draft a calm reply", text: "Hello,\n\nThank you for being open with me. I would like us to find something that works for both of us. Could you tell me what matters most to you here?\n\nThank you." } });
    }
  }

  // 4. Messages are not offers.
  const o = facts.offer;
  if (!o && bid && sorted.length >= 2) {
    insights.push({ id: "formal", tone: "tip", headline: "Make it formal when you are close", detail: role === "buyer" ? "Messages are not formal offers. Request an offer link when you want to put terms on record." : "Messages are not formal offers. When you are happy with the price, issue the offer link so the terms are recorded." });
  } else if (o?.counter?.status === "open") {
    const mineCounter = (o.counter.fromParty === "buyer") === (role === "buyer");
    insights.push({ id: "counter", tone: "tip", headline: mineCounter ? "Your counter is waiting for a reply" : "A counter is waiting for your decision", detail: mineCounter ? "Nothing more is needed until they answer. A short message can help." : "Review it on the offers page. Elena never accepts or rejects for you." });
  }

  // Replies to the latest incoming message.
  const replies: SuggestedReply[] = waitingOn === "you" && lastIncoming ? suggestReplies(role, lastIncoming.body, input) : [];
  const order: Record<InsightTone, number> = { risk: 0, watch: 1, good: 2, tip: 3 };
  insights.sort((a, b) => order[a.tone] - order[b.tone]);
  const lead = outlook ? `${outlook.percentOfAsking}% of asking` : undefined;
  const summary = [waitingOn === "you" ? "Waiting on you" : waitingOn === "them" ? "Waiting on them" : "No messages yet", lead, outlook ? `${outlook.level} outlook` : undefined].filter(Boolean).join(" · ");
  return { waitingOn, summary, ...(outlook ? { outlook } : {}), insights: insights.slice(0, 6), replies, disclaimer: COPILOT_DISCLAIMER };
}

/** Ready replies to the other side's latest message. None accepts anything: acceptance happens only on the offers page. */
export function suggestReplies(role: ChatRole, incoming: string, input: CopilotInput): SuggestedReply[] {
  const hasPrice = (parseOfferText(incoming, {}).priceCents ?? 0) >= 100_000;
  const intent = intentOf(incoming, hasPrice);
  const sit = priceSituation(input);
  const seller = role !== "buyer";
  const out: SuggestedReply[] = [];
  if (hasPrice && seller) {
    const t = sit.asking && sit.buyer ? round1000(sit.buyer + (sit.asking - sit.buyer) * 0.5) : undefined;
    if (t) out.push({ label: `Counter at ${formatAud(t)}`, text: draftCounter(role, t) });
    out.push({ label: "Ask for a formal offer", text: "Hello,\n\nThank you for your interest. If you would like to proceed, please request the formal offer link so your price and terms are on record, and I will review it.\n\nThank you." });
    out.push({ label: "Politely decline this price", text: "Hello,\n\nThank you for your offer. That price is too far from what I am looking for, so I will not be proceeding at this level. You are welcome to come back with a different proposal.\n\nThank you." });
  } else if (hasPrice) {
    out.push({ label: "Ask what would make it work", text: "Hello,\n\nThank you for the figure. Could you tell me what flexibility there is on price, and whether settlement timing or conditions could help close the gap?\n\nThank you." });
    out.push({ label: "Ask for the formal offer link", text: "Hello,\n\nIf we are close, I would like to take this to a formal offer. Could you issue the offer link?\n\nThank you." });
  } else if (intent === "viewing") {
    out.push({ label: seller ? "Offer inspection times" : "Ask to inspect", text: seller ? "Hello,\n\nYes, I would be happy to arrange an inspection. Which days and times suit you this week?\n\nThank you." : "Hello,\n\nThank you. I would like to inspect the property. Which days and times suit you?\n\nThank you." });
  } else if (intent === "finance") {
    out.push({ label: seller ? "Ask for proof of finance" : "Share pre-approval at the right stage", text: seller ? "Hello,\n\nThank you. Could you let me know where your finance stands, for example whether you have pre-approval? Please do not send ID or bank details here.\n\nThank you." : "Hello,\n\nI have my finance in hand and can show pre-approval at the right stage. Please do not share personal or bank details here.\n\nThank you." });
  } else if (intent === "question" || intent === "general") {
    out.push({ label: "Answer and ask a question back", text: "Hello,\n\nThank you for your message. I will come back to you with a full answer shortly. In the meantime, what matters most to you here?\n\nThank you." });
  } else {
    out.push({ label: "Acknowledge", text: "Hello,\n\nThank you, I appreciate the update.\n\nThank you." });
  }
  return out;
}

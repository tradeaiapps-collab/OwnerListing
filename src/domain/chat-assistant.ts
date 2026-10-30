import { CONTACT_RE } from "./ai-engine";
import type { Persona } from "./assistant-persona";
import type { AuditEvent } from "./audit";
import { messageWordingError } from "./discrimination-filter";
import { participantEnquiry, type EnquiryDeps } from "./enquiry-service";
import { formatAud } from "./listing-details";
import type { Actor, Failure, Result } from "./listing-service";
import { scanInboundMessage } from "./message-safety";
import { withinLimit } from "./rate-limit";

/**
 * The assistant inside a buyer-owner enquiry thread: a third participant both sides can ask. Rule based and deterministic, so every
 * answer is built only from facts both parties can already see (the public listing and the formal offer between them).
 * PRIVACY: she never receives the owner's negotiation mandate or floor, private notes, safety flags, or either party's contact
 * details. Questions and answers are shown to both parties and kept as a permanent record (no edits or deletes, like messages).
 * She suggests and explains; she never accepts, rejects, signs or makes an offer for anyone.
 */

export type ChatRole = "buyer" | "owner" | "agent";
/** Pose shown with an answer. "listening" is the client's state while someone types or waits; answers never carry it. */
export type ChatPose = "wave" | "tablet" | "front" | "three-quarter";
export const CHAT_TOPICS = [
  "welcome", "offer", "compromise", "settlement", "deposit", "conditions", "listing", "next_steps", "privacy", "advice", "chitchat", "unknown"
] as const;
export type ChatTopic = (typeof CHAT_TOPICS)[number];

export interface ChatOfferTerms { priceCents: number; depositCents: number; settlementDays: number; conditions: string[] }
/** The latest counter on the offer, from either side. Both parties see it on their offer pages. */
export interface ChatCounter extends ChatOfferTerms { fromParty: "owner" | "buyer"; status: string }
export interface ChatOffer extends ChatOfferTerms { status: string; counter?: ChatCounter | undefined }

/** Everything she knows. Built by the server from the listing and the buyer's latest formal offer on it; nothing else. */
export interface ChatFacts {
  listing: {
    title: string; address: string; suburb?: string | undefined; transactionType: "sale" | "rent"; propertyType: string;
    askingCents?: number | undefined; bedrooms?: number | undefined; bathrooms?: number | undefined; parking?: number | undefined; verifiedDisclosures: number;
  };
  offer?: ChatOffer | undefined;
}

export interface ChatAnswer { topic: ChatTopic; pose: ChatPose; text: string; suggestions: string[] }

/** One question and her answer. Permanent. `askedByRole` is all that is shown about who asked. */
export interface AssistantTurn {
  id: string; enquiryId: string; askedByUserId: string; askedByRole: ChatRole;
  question: string; topic: ChatTopic; pose: ChatPose; answer: string; createdAt: string;
}

export const MAX_QUESTION_LENGTH = 500;
/** Questions to her per person per hour, on top of the normal message limits. */
export const ASSISTANT_RATE = { windowMs: 60 * 60 * 1000, perUser: 30 } as const;

const POSE: Record<ChatTopic, ChatPose> = {
  welcome: "wave", offer: "tablet", compromise: "tablet", listing: "tablet",
  settlement: "front", deposit: "front", conditions: "front", next_steps: "front", unknown: "front",
  privacy: "three-quarter", advice: "three-quarter", chitchat: "wave"
};

const NOT_BINDING = "Only the two of you can agree terms. I can't accept, reject or sign anything.";
const ASK_PROFESSIONAL = "For advice on your situation, talk to your solicitor or conveyancer.";

const PRIVACY_RE = /\b((phone|mobile|email|address|number|surname|full\s+name|contact|details?)\s+(of|for)\s+(the\s+|this\s+|that\s+|their\s+)?(owner|seller|vendor|buyer|landlord|tenant|person)|(owner|seller|vendor|buyer|landlord)'?s\s+(phone|mobile|email|number|surname|full\s+name|contact|details?|address|employer|job|income|situation)|(where|who)\s+(does|is)\s+(the\s+)?(buyer|owner|seller)\s+(live|work)|what\s+did\s+(the\s+)?(buyer|owner|seller)\s+(say|tell)\s+you|privately)\b/;
const ADVICE_RE = /\b(should\s+(i|we)\s+(buy|sell|accept|reject|decline|counter|sign|offer|walk\s+away|go\s+(up|down|higher|lower))|good\s+(deal|price|offer|investment)|fair\s+price|worth\s+(it|more|less)|is\s+(it|this)\s+legal|legal(ly)?\s+advice|(financial|tax|investment)\s+advice|stamp\s+duty|capital\s+gains|valuation|over\s*priced|under\s*priced)\b/;
const FLOOR_RE = /\b(lowest|minimum|bottom|floor|reserve|walk[- ]?away|least)\b.*\b(price|accept|take|go)\b|\b(what|how\s+low)\s+will\s+(they|the\s+owner|the\s+seller)\s+(take|accept|go)\b/;

const KEYWORDS: readonly [Exclude<ChatTopic, "welcome" | "privacy" | "advice" | "unknown">, RegExp][] = [
  ["compromise", /\b(compromise|middle|meet|halfway|half\s+way|split|gap|apart|close\s+the\s+deal|stuck|deadlock|agree|bridge|suggest\w*|options?|counter\s+at|work\s+something\s+out|find\s+a\s+way)\b/g],
  ["settlement", /\b(settle(ment)?|settling|days\s+to\s+settle|move\s+in|keys|handover|possession)\b/g],
  ["deposit", /\b(deposit|holding\s+fee|trust\s+account|10\s*%|ten\s+per\s*cent)\b/g],
  ["conditions", /\b(conditions?|subject\s+to|finance|loan|approval|building|pest|inspect\w*|report|cooling|unconditional)\b/g],
  ["listing", /\b(bed(room)?s?|bath(room)?s?|parking|car\s*(space|park)s?|garage|property|house|home|unit|townhouse|apartment|listing|features?|disclosures?|pool|land|size|suburb|address)\b/g],
  ["offer", /\b(offers?|price|terms|where\s+(are\s+we|do\s+we\s+stand|do\s+things\s+stand|things\s+stand)|stand\s+now|status|current|latest|counter(ed|s)?|summary|summar\w+)\b/g],
  ["next_steps", /\b(next|what\s+now|what\s+happens|process|how\s+does\s+(this|it)\s+work|steps?|contract|solicitor|conveyancer|exchange)\b/g]
];

/**
 * Places outside the chat she can walk the reader to ("Show me"). Ordered by preference; the page falls back to the next one when a
 * place is not on screen (the phone menu is closed, a link only some roles have).
 */
export type ShowMePlace = "my_offers" | "my_listings" | "offer_link";
export interface ShowMe { label: string; places: ShowMePlace[] }

/** Where the reader acts on what she just described. Only offer, gap and next-step answers send people elsewhere. */
export function showMeFor(topic: ChatTopic, role: ChatRole, f: Pick<ChatFacts, "offer">): ShowMe | undefined {
  if (topic !== "offer" && topic !== "compromise" && topic !== "next_steps") return undefined;
  const open = f.offer ? OPEN.has(f.offer.status) : false;
  if (!f.offer) return role === "buyer" ? { label: "Show me where to ask for an offer link", places: ["offer_link"] } : undefined;
  if (role === "buyer") return { label: open ? "Show me where to reply to the offer" : "Show me my offers", places: ["my_offers", "offer_link"] };
  return { label: open ? "Show me where to review offers" : "Show me my listings", places: ["my_listings", "offer_link"] };
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** Deterministic: privacy, the owner's floor and advice are caught first, then the topic with the most keyword hits (ties: list order). */
export function matchChatTopic(question: string): ChatTopic {
  const t = norm(question.slice(0, MAX_QUESTION_LENGTH));
  if (PRIVACY_RE.test(t) || FLOOR_RE.test(t)) return "privacy";
  if (ADVICE_RE.test(t)) return "advice";
  let best: ChatTopic = "unknown", bestHits = 0;
  for (const [topic, re] of KEYWORDS) {
    const hits = (t.match(re) ?? []).length;
    if (hits > bestHits) { best = topic; bestHits = hits; }
  }
  return best;
}

// ---- Facts into words ----
const money = (cents: number, tx: "sale" | "rent") => (tx === "rent" ? `${formatAud(cents)} a week` : formatAud(cents));
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
const list = (xs: readonly string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const conditionsText = (c: readonly string[]) => (c.length ? `subject to ${list(c.map(x => x.replace(/^subject to /i, "").toLowerCase()))}` : "with no conditions");

const OPEN = new Set(["submitted", "under_review", "countered", "buyer_countered"]);
/** The newest open counter, if any. An answered counter is history; the offer status says where things are. */
const liveCounter = (o: ChatOffer) => (o.counter && o.counter.status === "open" ? o.counter : undefined);

/** Price each side last put forward. The owner's side is their counter or, failing that, the public asking price. Never the floor. */
export function positions(f: ChatFacts): { buyerCents: number; ownerCents?: number; ownerSource: "counter" | "asking" | "none" } | undefined {
  const o = f.offer;
  if (!o) return undefined;
  const c = liveCounter(o);
  const buyerCents = c?.fromParty === "buyer" ? c.priceCents : o.priceCents;
  // An owner counter that has since been countered by the buyer is still the owner's last stated price.
  const ownerCounter = o.counter?.fromParty === "owner" ? o.counter : undefined;
  if (ownerCounter) return { buyerCents, ownerCents: ownerCounter.priceCents, ownerSource: "counter" };
  if (f.listing.askingCents) return { buyerCents, ownerCents: f.listing.askingCents, ownerSource: "asking" };
  return { buyerCents, ownerSource: "none" };
}

/** A round middle figure: nearest $5,000 for a sale (nearest $5 a week for rent), kept strictly between the two positions when it can be. */
export function middleCents(lowCents: number, highCents: number, tx: "sale" | "rent"): number {
  const step = tx === "rent" ? 500 : 500_000;
  const mid = Math.round((lowCents + highCents) / 2 / step) * step;
  return mid > lowCents && mid < highCents ? mid : Math.round((lowCents + highCents) / 2);
}

function offerLine(f: ChatFacts, o: ChatOffer): string {
  const tx = f.listing.transactionType;
  const base = `The buyer's offer is ${money(o.priceCents, tx)} with a ${money(o.depositCents, "sale")} deposit, ${days(o.settlementDays)} to settle, ${conditionsText(o.conditions)}.`;
  const c = liveCounter(o);
  const counter = c ? ` The ${c.fromParty} has countered at ${money(c.priceCents, tx)}, ${days(c.settlementDays)} to settle, ${conditionsText(c.conditions)}, and is waiting for a reply.` : "";
  const asking = f.listing.askingCents ? ` The asking price is ${money(f.listing.askingCents, tx)}.` : "";
  return `${base}${counter}${asking}`;
}

function statusLine(o: ChatOffer): string {
  switch (o.status) {
    case "submitted": case "under_review": return "It's with the owner, who can accept it, counter it or decline it.";
    case "countered": return "The owner has countered. The buyer can agree, counter back or withdraw.";
    case "buyer_countered": return "The buyer has countered back. It's the owner's turn to reply.";
    case "accepted": return "The offer has been accepted. The solicitors now prepare the contract.";
    case "rejected": return "The owner declined this offer. The buyer can make a new one with a fresh offer link.";
    case "withdrawn": return "The buyer withdrew this offer.";
    case "expired": return "This offer expired without a reply.";
    default: return "";
  }
}

const NO_OFFER = "There's no formal offer between you yet. When the buyer is ready, they can ask for a formal offer link here, and the owner approves it.";

function compromise(f: ChatFacts): string {
  const o = f.offer;
  if (!o) return `${NO_OFFER} Once there's an offer on the table I can lay out the gap and some ways to close it.`;
  if (!OPEN.has(o.status)) return `${statusLine(o)} ${NOT_BINDING}`;
  const p = positions(f)!;
  const tx = f.listing.transactionType;
  if (p.ownerCents === undefined) return `The buyer is at ${money(p.buyerCents, tx)}. The listing has no asking price, so the owner could reply with a counter to show where they'd like to be. ${NOT_BINDING}`;
  const gap = p.ownerCents - p.buyerCents;
  if (gap <= 0) return `On price you already meet: the buyer is at ${money(p.buyerCents, tx)} and the owner's ${p.ownerSource === "counter" ? "counter" : "asking price"} is ${money(p.ownerCents, tx)}. What's left is the other terms and the owner's decision. ${NOT_BINDING}`;
  const ownerSide = p.ownerSource === "counter" ? "the owner's counter" : "the asking price";
  const ideas = [
    `meet near the middle, around ${money(middleCents(p.buyerCents, p.ownerCents, tx), tx)}`,
    `keep the price closer to one side and move on other terms, such as the settlement time (now ${days(o.settlementDays)}) or the deposit`
  ];
  if (o.conditions.length) ideas.push(`agree a shorter time for ${o.conditions.length === 1 ? "the condition" : "the conditions"}, which gives the owner more certainty`);
  ideas.push("agree what stays with the home, such as furniture or appliances");
  return `You're ${money(gap, tx)} apart: the buyer is at ${money(p.buyerCents, tx)} and ${ownerSide} is ${money(p.ownerCents, tx)}. Some ways buyers and owners often close a gap like this: ${ideas.map((x, i) => `(${i + 1}) ${x}`).join("; ")}. Either of you can send a counter with new terms from the offer page. ${NOT_BINDING}`;
}

function listingLine(f: ChatFacts): string {
  const l = f.listing;
  const rooms = [l.bedrooms !== undefined && `${l.bedrooms} bedroom${l.bedrooms === 1 ? "" : "s"}`, l.bathrooms !== undefined && `${l.bathrooms} bathroom${l.bathrooms === 1 ? "" : "s"}`, l.parking !== undefined && `${l.parking} car space${l.parking === 1 ? "" : "s"}`].filter(Boolean) as string[];
  const price = l.askingCents ? ` listed at ${money(l.askingCents, l.transactionType)}` : "";
  const what = `${l.title}, ${l.address}: a ${l.propertyType}${rooms.length ? ` with ${list(rooms)}` : ""}${price}.`;
  const disclosures = l.verifiedDisclosures > 0
    ? ` ${l.verifiedDisclosures} disclosure document${l.verifiedDisclosures === 1 ? " has" : "s have"} been checked by our team and ${l.verifiedDisclosures === 1 ? "is" : "are"} listed on the property page.`
    : " No disclosure documents have been checked for this listing yet.";
  return `${what}${disclosures} I only know what's on the listing, so for anything else the owner can answer here.`;
}

function conditionsLine(f: ChatFacts): string {
  const o = f.offer;
  const parts: string[] = [];
  const has = (re: RegExp) => o?.conditions.some(c => re.test(c.toLowerCase())) ?? false;
  if (o) parts.push(o.conditions.length ? `This offer is ${conditionsText(o.conditions)}.` : "This offer has no conditions.");
  if (!o || has(/financ|loan/)) parts.push("Subject to finance means the buyer can end the contract if their loan isn't approved by the finance date in the contract.");
  if (!o || has(/building|pest|inspect/)) parts.push("Subject to building and pest means the buyer can have a licensed inspector check the home. If the report finds problems, the buyer can raise them or end the contract within the inspection period the contract sets.");
  parts.push("The exact dates and rules are in the contract. Your solicitor or conveyancer can explain them.");
  return parts.join(" ");
}

function settlementLine(f: ChatFacts): string {
  const o = f.offer;
  const c = o && liveCounter(o);
  const now = o ? ` The offer says ${days(o.settlementDays)}${c && c.settlementDays !== o.settlementDays ? `, and the ${c.fromParty}'s counter says ${days(c.settlementDays)}` : ""}.` : "";
  return `Settlement is the day the balance is paid and the keys and ownership pass to the buyer. It's counted from when the contract is signed.${now} A longer or shorter settlement is a common thing to trade when you're close on price.`;
}

function depositLine(f: ChatFacts): string {
  const o = f.offer;
  const amount = o ? ` The offer has a ${money(o.depositCents, "sale")} deposit${o.priceCents ? ` (${Math.round((o.depositCents / o.priceCents) * 1000) / 10}% of the price)` : ""}.` : "";
  return `The deposit is paid once the contract is signed, into the solicitor's trust account named on the listing. It is never paid to a person, and never to us.${amount} If anyone sends you different bank details by message, don't pay, and call the solicitor on a number you find yourself.`;
}

function nextLine(f: ChatFacts, role: ChatRole): string {
  const o = f.offer;
  if (!o) return role === "buyer" ? `${NO_OFFER} Use "Request an offer link" below this chat.` : NO_OFFER;
  const s = statusLine(o);
  const after = o.status === "accepted" ? " The deposit goes to the solicitor's trust account, never to a person." : " Replies and counters are made on the offer page.";
  return `${s}${after} ${NOT_BINDING}`;
}

const SUGGEST: Record<ChatTopic, string[]> = {
  welcome: ["Where do things stand?", "How could we close the gap?", "What do the conditions mean?"],
  offer: ["How could we close the gap?", "What happens next?", "What does settlement mean?"],
  compromise: ["What happens next?", "What does the deposit cover?", "What do the conditions mean?"],
  settlement: ["How could we close the gap?", "What happens next?"],
  deposit: ["What happens next?", "Where do things stand?"],
  conditions: ["What does settlement mean?", "How could we close the gap?"],
  listing: ["Where do things stand?", "What do the conditions mean?"],
  next_steps: ["Where do things stand?", "What does the deposit cover?"],
  privacy: ["Where do things stand?", "How could we close the gap?"],
  advice: ["Where do things stand?", "How could we close the gap?"],
  chitchat: ["Where do things stand?", "What can you help with?", "Tell me about the home"],
  unknown: ["Where do things stand?", "How could we close the gap?", "Tell me about the home"]
};

// ---- Small talk ----
// Greetings and pleasantries, answered in kind and always handing the conversation back with "What can I do for you?".
// Deterministic and self-hosted like the rest: no outside AI service sees what people type. Only reached when no topic matched.
const CAN_I_HELP = "What can I do for you?";
const HELP_LINE = "I can explain the offer and its conditions, settlement and the deposit, suggest ways to close a gap on price, and tell you about the home.";
const SMALL_TALK: readonly [RegExp, string][] = [
  [/\b(how\s*(are|r)\s*(you|u|ya|yu)|hru|how'?s\s+it\s+going|how\s+is\s+it\s+going|how\s+do\s+you\s+do|how\s+(you|u|ya)\s+(doing|been)|how\s+have\s+(you|u)\s+been|how'?s\s+(everything|life)|(what|wat|wut)\s*(about|bout)\s+(you|u|ya)|wbu|hbu|and\s+(you|u)|you\s+(ok|okay|well|good)\b)/, `I'm doing well, thank you for asking! ${CAN_I_HELP}`],
  [/\bhow('?s|\s+is|\s+was)\s+(your|ur)\s+(day|morning|afternoon|evening|week|weekend)/, `It's going nicely, thank you for asking. How is yours? ${CAN_I_HELP}`],
  [/\b(who|what)\s+(are|r)\s+(you|u)\b|\b(your|ur)\s+name\b|\bare\s+you\s+(a\s+)?(real|human|robot|bot|ai|person)/, `I'm the AI assistant for this conversation, not a person and not a licensed agent. ${HELP_LINE} ${CAN_I_HELP}`],
  [/\bwhat\s+(can|do)\s+(you|u)\s+(do|help)|\bhow\s+can\s+(you|u)\s+help|^(help|halp|pls\s+help|plz\s+help)\b|\bwhat\s+can\s+i\s+ask/, `${HELP_LINE} ${CAN_I_HELP}`],
  [/\b(thanks|thank\s+you|thank\s+u|thx|thnx|thanx|tnx|tysm|ty|cheers|ta|much\s+appreciated)\b/, "You're welcome! Is there anything else I can help with?"],
  [/\b(bye|goodbye|see\s+you|see\s+ya|cya|gtg|g2g|ttyl|bb|bbl|talk\s+later|gn|have\s+a\s+(good|great|nice)\s+(day|one|night|weekend)|good\s*night)\b/, "Bye for now! I'm right here whenever you need me."],
  [/^(yes|yeah|yea|yep|yup|ya|ye|sure|ok|okay|okie|k|kk|please|pls|plz|go\s+ahead)\b/, `Great. ${CAN_I_HELP} You can ask about the offer, settlement, the deposit or the home.`],
  [/^(no|nope|nah|naw|nothing|no\s+thanks|no\s+thx)\b/, "No problem. I'll be here if anything comes up."],
  [/^(u\s+there|hi+|hel+o+|hell?o|hey+|heya|hiya|howdy|yo+|sup+|wa+s+up+|wa+zz*up+|(what|wat|wut)\s*'?s?\s*up|ayo|hola|g'?day|gm|(good\s+)?(morning|afternoon|evening)|(hey|hi|hello)\s+(there|elena))\b|^u$/, "Hi there! How's your day going?"]
];
const FEEL_GOOD = /^(i'?m|im|i\s+am|it'?s|its|all|pretty|really|very|so|feeling|doing)?\s*(good|great|fine|well|awesome|fantastic|wonderful|excellent|amazing|happy|not\s+bad|pretty\s+good|ok|okay|alright)\b(?!\s+(night|morning|afternoon|evening|deal|price|offer))/;
const FEEL_LOW = /^(i'?m|im|i\s+am|it'?s|its|a\s+bit|pretty|really|very|so|feeling|doing)?\s*(bad|terrible|awful|rough|tired|exhausted|stressed|busy|not\s+great|not\s+good|so\s+so|meh)\b/;

/** A friendly reply when the message is chit-chat, otherwise undefined. Short feelings ("good, thanks") only count as replies to her question. */
export function smallTalk(text: string): string | undefined {
  const t = norm(text).replace(/[!?.,]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  const short = t.split(" ").length <= 6;
  if (short && FEEL_LOW.test(t)) return `Sorry to hear that. I hope it gets easier from here. ${CAN_I_HELP}`;
  if (short && FEEL_GOOD.test(t)) return `Glad to hear it! ${CAN_I_HELP}`;
  for (const [re, reply] of SMALL_TALK) if (re.test(t)) return reply;
  return undefined;
}

/** Her answer to one question. Uses only `facts`; never the asker's identity beyond their role in the thread. */
export function chatAnswer(f: ChatFacts, role: ChatRole, question: string): ChatAnswer {
  const t = norm(question);
  const topic = matchChatTopic(question);
  const done = (text: string): ChatAnswer => ({ topic, pose: POSE[topic], text, suggestions: SUGGEST[topic] });
  switch (topic) {
    case "privacy":
      return done(FLOOR_RE.test(t)
        ? "I don't know the owner's lowest price and couldn't share it if I did. The asking price, the offer and any counters are the figures you both see."
        : "I don't share personal details or anything one of you tells me privately. Everything I say here is seen by both of you, and it's built only from the listing and the offer.");
    case "advice":
      return done(`That's your decision, and I can't tell you what to do. I can lay out the numbers and the usual options. ${ASK_PROFESSIONAL}`);
    case "offer":
      return done(f.offer ? `${offerLine(f, f.offer)} ${statusLine(f.offer)}` : NO_OFFER);
    case "compromise": return done(compromise(f));
    case "settlement": return done(settlementLine(f));
    case "deposit": return done(depositLine(f));
    case "conditions": return done(conditionsLine(f));
    case "listing": return done(listingLine(f));
    case "next_steps": return done(nextLine(f, role));
    default: {
      const talk = smallTalk(question);
      if (talk) return { topic: "chitchat", pose: POSE.chitchat, text: talk, suggestions: SUGGEST.chitchat };
      return done("I'm not sure I can help with that one. I can explain the offer and its conditions, settlement, the deposit and the next steps, or suggest ways to close a gap on price. What would you like to know?");
    }
  }
}

/** Shown at the top of every thread (not stored). Mentions the offer when there is one, so both sides start from the same facts. */
export function chatWelcome(f: ChatFacts, personaName: string): ChatAnswer {
  const where = f.offer ? ` I can see the offer on ${f.listing.title} and can explain it, or suggest ways to close a gap.` : ` I can answer questions about ${f.listing.title} and how offers work here.`;
  return {
    topic: "welcome", pose: "wave", suggestions: SUGGEST.welcome,
    text: `Hi, I'm ${personaName}, the AI assistant for this conversation.${where} Anything you ask me is seen by both of you. I'm not a licensed agent, and I never accept or sign anything. ${CAN_I_HELP}`
  };
}

// ---- Service ----
export interface AssistantTurnRepository {
  /** Insert only; there is no update or delete (db trigger too). */
  add(t: AssistantTurn): Promise<void>;
  list(enquiryId: string): Promise<AssistantTurn[]>;
}

export interface ChatAssistantDeps extends Pick<EnquiryDeps, "enquiries" | "listings" | "termsCurrentFor" | "countHit" | "now" | "newId" | "appointmentFor" | "licences"> {
  turns: AssistantTurnRepository;
  /** The buyer's newest formal offer on the listing, with its newest counter. Undefined when there is none. */
  offerFor: (listingId: string, buyerUserId: string) => Promise<ChatOffer | undefined>;
  /** Count of staff-verified disclosures for the listing. */
  verifiedDisclosures: (listingId: string) => Promise<number>;
  /** The live persona (Elena by default): name and pictures only. */
  persona: () => Promise<ChatPersona>;
  appendAudit: (e: AuditEvent) => Promise<void>;
}

export type ChatPersona = Pick<Persona, "id" | "name" | "icon" | "portrait" | "poses">;
/** `viewerId` is the reader's own id, so the page can mark their messages and questions as theirs. */
export interface AssistantThread { persona: ChatPersona; viewerId: string; role: ChatRole; welcome: ChatAnswer; turns: AssistantTurn[]; facts: ChatFacts }

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });

export function parseQuestion(body: unknown): Result<string> {
  const q = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["question"] : undefined;
  if (typeof q !== "string" || !q.trim()) return fail("invalid", "Type a question for the assistant.");
  const t = q.trim();
  if (t.length > MAX_QUESTION_LENGTH) return fail("invalid", `Questions can be up to ${MAX_QUESTION_LENGTH} characters.`);
  return { ok: true, value: t };
}

async function context(deps: ChatAssistantDeps, actor: Actor, enquiryId: string): Promise<Result<{ enquiry: { id: string; buyerUserId: string; listingId: string }; role: ChatRole; facts: ChatFacts }>> {
  const p = await participantEnquiry(deps as unknown as EnquiryDeps, actor, enquiryId);
  if (!p.ok) return p;
  const e = p.value.enquiry;
  const rec = await deps.listings.get(e.listingId);
  if (!rec) return fail("not_found", "Enquiry not found.");
  const l = rec.listing;
  const role: ChatRole = p.value.asAgent ? "agent" : actor.userId === e.buyerUserId ? "buyer" : "owner";
  const [offer, verifiedDisclosures] = await Promise.all([deps.offerFor(e.listingId, e.buyerUserId), deps.verifiedDisclosures(e.listingId)]);
  const facts: ChatFacts = {
    listing: {
      title: l.title, address: l.address, suburb: l.suburb, transactionType: l.transactionType, propertyType: l.propertyType,
      askingCents: l.priceCents, bedrooms: l.bedrooms, bathrooms: l.bathrooms, parking: l.parking, verifiedDisclosures
    },
    offer
  };
  return { ok: true, value: { enquiry: e, role, facts } };
}

/** The assistant's side of a thread, for its parties only (non-parties get not_found, like the thread itself). */
export async function getAssistantThread(deps: ChatAssistantDeps, actor: Actor, enquiryId: string): Promise<Result<AssistantThread>> {
  const c = await context(deps, actor, enquiryId);
  if (!c.ok) return c;
  const persona = await deps.persona();
  return {
    ok: true,
    value: { persona, viewerId: actor.userId, role: c.value.role, welcome: chatWelcome(c.value.facts, persona.name), turns: await deps.turns.list(enquiryId), facts: c.value.facts }
  };
}

/**
 * A party asks the assistant. The question is checked like a message (terms, rate limit, discrimination wording) and must not
 * carry contact details, because both parties see it and it is permanent. The answer is stored with it.
 */
export async function askAssistant(deps: ChatAssistantDeps, actor: Actor, enquiryId: string, question: string): Promise<Result<AssistantTurn>> {
  const c = await context(deps, actor, enquiryId);
  if (!c.ok) return c;
  if (!(await deps.termsCurrentFor(actor.userId))) return fail("forbidden", "Accept the current terms to keep using messages.");
  let hits: number | undefined;
  try { hits = await deps.countHit(`enq-assistant:${actor.userId}`, ASSISTANT_RATE.windowMs); } catch { hits = undefined; }
  if (!withinLimit(hits, ASSISTANT_RATE.perUser)) return fail("rate_limited", "You've asked a lot of questions this hour. Try again later.");
  const wording = messageWordingError(question);
  if (wording) return fail("invalid", wording);
  if (CONTACT_RE.test(question)) return fail("invalid", "Please leave phone numbers, emails and links out. Both of you see questions to the assistant, and they can't be deleted.");

  const a = chatAnswer(c.value.facts, c.value.role, question);
  const turn: AssistantTurn = {
    id: deps.newId(), enquiryId, askedByUserId: actor.userId, askedByRole: c.value.role,
    question, topic: a.topic, pose: a.pose, answer: a.text, createdAt: deps.now()
  };
  await deps.turns.add(turn);
  // The safety categories are recorded (not the text) so staff can see probing patterns, e.g. a buyer fishing for the floor.
  const flags = scanInboundMessage(question).flags.map(f => f.category);
  await deps.appendAudit({
    id: deps.newId(), occurredAt: turn.createdAt, actorType: "user", actorId: actor.userId,
    aggregateType: "enquiry", aggregateId: enquiryId, eventType: "enquiry.assistant_asked", correlationId: deps.newId(),
    payload: { turnId: turn.id, topic: turn.topic, role: turn.askedByRole, safetyFlags: flags }
  });
  return { ok: true, value: turn };
}

export function createInMemoryTurnRepository(): AssistantTurnRepository & { all: AssistantTurn[] } {
  const all: AssistantTurn[] = [];
  return {
    all,
    async add(t) { all.push({ ...t }); },
    async list(enquiryId) { return all.filter(t => t.enquiryId === enquiryId).map(t => ({ ...t })); }
  };
}

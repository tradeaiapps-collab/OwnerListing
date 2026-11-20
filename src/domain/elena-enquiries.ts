import { scanContent } from "./content-filter";
import { messageWordingError } from "./discrimination-filter";
import { scanInboundMessage } from "./message-safety";
import { looksLikeOffer } from "./offer-intake";
import { AMENITY_LABELS, type Amenity } from "./listing-details";
import { whenText } from "./open-inspection";

/**
 * Elena answers a buyer's enquiry on a listing (pure). Answers come only from the listing facts and the documents the owner published,
 * through fixed sentences: nothing is generated, so nothing can be invented. Anything she cannot answer from those facts goes to the owner.
 * She never states a price, never discusses or agrees terms, and never gives the street address (it is shared when an inspection is booked).
 * Storage and sending live in src/server/elena-enquiries-db.ts.
 */

export const TOPICS = ["address", "offer", "price", "inspection", "bedrooms", "bathrooms", "parking", "type", "location", "features", "documents", "other"] as const;
export type Topic = (typeof TOPICS)[number];

export interface EnquirySettings { enabled: boolean; offerInspections: boolean; autoSend: boolean }
export const DEFAULT_SETTINGS: EnquirySettings = { enabled: false, offerInspections: true, autoSend: false };

export const LIMITS = {
  /** Elena replies on one thread per rolling 24 hours. */
  perEnquiryPerDay: 6,
  /** Elena replies on one listing per rolling hour. */
  perListingPerHour: 20,
  maxReply: 1200,
  offeredSlots: 3
} as const;

export interface DocFact { title: string; kind: string }
/** What Elena may say. Built from the listing row and its public, active documents; the address is deliberately absent. */
export interface ListingFacts {
  transactionType: "sale" | "rent";
  propertyType: string;
  suburb?: string;
  postcode?: string;
  bedrooms?: number;
  bathrooms?: number;
  parking?: number;
  amenities: readonly string[];
  /** True when the listing shows a price on its page. The amount itself is never repeated. */
  priceShown: boolean;
  documents: readonly DocFact[];
}

const FEATURE_WORDS: readonly (readonly [Amenity, RegExp])[] = [
  ["pool", /\bpool\b/], ["air_conditioning", /\b(air ?con(ditioning)?|a\/c)\b/], ["garage", /\bgarage\b/], ["balcony", /\b(balcony|terrace)\b/],
  ["garden", /\b(garden|backyard|yard)\b/], ["solar", /\bsolar\b/], ["pet_friendly", /\b(pets?|dogs?|cats?)\b/], ["furnished", /\bfurnish(ed|ings?)\b/],
  ["ensuite", /\bensuite\b/], ["study", /\b(study|home office)\b/], ["lift", /\b(lift|elevator)\b/], ["security", /\b(security|alarm|intercom)\b/]
];
const DOC_WORDS: readonly (readonly [string, RegExp])[] = [
  ["building_inspection", /\bbuilding (and pest )?(inspection|report)\b/], ["pest_report", /\bpest\b/], ["title_search", /\btitle( search)?\b/],
  ["floorplan", /\bfloor ?plan\b/], ["contract", /\bcontract\b/]
];

const RULES: readonly (readonly [Topic, RegExp])[] = [
  ["address", /\b(address|street (name|number|address)|which street|what street|where exactly|exact location|house number|unit number|lot number)\b/],
  ["offer", /\b(offer|negotiat\w*|lowest|best price|reserve|haggle|bid|discount|cash buyer|would (they|he|she|the owner|the seller) (take|accept)|make an offer)\b/],
  ["price", /\b(price|asking|how much|guide|cost|worth|valuation|rent per week|weekly rent)\b/],
  ["inspection", /\b(inspect\w*|viewing|view it|open home|open house|see (the|it|inside)|visit|come (and )?(look|see|by)|available (time|to)|book(ing)?|tour|walk ?through)\b/],
  ["bedrooms", /\b(bed(room)?s?|br)\b/],
  ["bathrooms", /\b(bath(room)?s?|toilets?)\b/],
  ["parking", /\b(park(ing)?|car ?spaces?|car ?ports?|garage)\b/],
  ["type", /\b(what type|type of property|what kind|is it a (house|unit|townhouse|apartment|land))\b/],
  ["location", /\b(suburb|area|neighbou?rhood|postcode|post code|which part)\b/],
  ["documents", /\b(documents?|reports?|title( search)?|floor ?plan|strata|disclosure|certificate|pest|contract)\b/]
];

/** Which questions a buyer message asks. Several can apply; "other" means none matched. */
export function classify(text: string): Topic[] {
  const t = text.toLowerCase();
  const found = new Set<Topic>();
  for (const [topic, re] of RULES) if (re.test(t)) found.add(topic);
  if (looksLikeOffer(text)) found.add("offer");
  if (FEATURE_WORDS.some(([, re]) => re.test(t))) found.add("features");
  if (found.size === 0) found.add("other");
  return TOPICS.filter(x => found.has(x));
}

export interface SlotOffer { startsAt: string }
export interface PlanInput {
  buyerText: string;
  facts: ListingFacts;
  settings: EnquirySettings;
  /** Free inspection times from the owner's availability, soonest first. Empty when none. */
  slots: readonly SlotOffer[];
  timeZone: string;
}
export interface Plan {
  topics: Topic[];
  /** The text for the buyer, or undefined when nothing can be said and the owner must reply. */
  reply?: string;
  /** Part or all of the question needs the owner personally. */
  needsOwner: boolean;
  reason?: string;
  slots: SlotOffer[];
}

export const SIGNATURE = "Elena, the owner's assistant (AI)";
const HAND_OVER = "I've passed the rest to the owner, who will reply to you personally.";

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const label = (a: string) => (AMENITY_LABELS as Record<string, string>)[a] ?? a;
const asksFor = (text: string) => FEATURE_WORDS.filter(([, re]) => re.test(text.toLowerCase())).map(([a]) => a);

/** Builds the answer. Pure and deterministic: the same message and facts always give the same text. */
export function plan(input: PlanInput): Plan {
  const { buyerText, facts, settings } = input;
  // Messages that look like scams, pressure or off-platform requests are for the owner only, with no reply at all.
  const safety = scanInboundMessage(buyerText);
  if (safety.handoff) return { topics: ["other"], needsOwner: true, reason: "The message needs your personal reply (safety check).", slots: [] };

  const topics = classify(buyerText);
  const lines: string[] = [];
  let needsOwner = false;
  let slots: SlotOffer[] = [];

  for (const topic of topics) {
    switch (topic) {
      case "offer":
        needsOwner = true;
        lines.push("Offers and terms are decided by the owner, and formal offers are made through the offer form on this site. I can't discuss or agree them.");
        break;
      case "price":
        if (facts.priceShown) lines.push(`The ${facts.transactionType === "rent" ? "rent" : "asking price"} is shown on the listing page. I can't confirm any other figure.`);
        else { needsOwner = true; lines.push("The listing doesn't show a price, so I can't give you one."); }
        break;
      case "address":
        lines.push("The exact street address is shared once an inspection is booked." + (facts.suburb ? ` The property is in ${facts.suburb}.` : ""));
        break;
      case "location":
        if (facts.suburb) lines.push(`The property is in ${facts.suburb}${facts.postcode ? ` (${facts.postcode})` : ""}.`);
        else { needsOwner = true; lines.push("The listing doesn't say which suburb it is in."); }
        break;
      case "bedrooms":
        if (facts.bedrooms !== undefined) lines.push(`It has ${count(facts.bedrooms, "bedroom")}.`);
        else { needsOwner = true; lines.push("The listing doesn't state the number of bedrooms."); }
        break;
      case "bathrooms":
        if (facts.bathrooms !== undefined) lines.push(`It has ${count(facts.bathrooms, "bathroom")}.`);
        else { needsOwner = true; lines.push("The listing doesn't state the number of bathrooms."); }
        break;
      case "parking":
        if (facts.parking !== undefined) lines.push(facts.parking === 0 ? "The listing shows no car spaces." : `It has ${count(facts.parking, "car space")}.`);
        else { needsOwner = true; lines.push("The listing doesn't state the parking."); }
        break;
      case "type":
        lines.push(`It is a ${facts.propertyType} ${facts.transactionType === "rent" ? "for rent" : "for sale"}.`);
        break;
      case "features": {
        const asked = asksFor(buyerText);
        const has = asked.filter(a => facts.amenities.includes(a));
        const hasNot = asked.filter(a => !facts.amenities.includes(a));
        if (has.length) lines.push(`The listing includes: ${has.map(label).join(", ")}.`);
        if (hasNot.length) { needsOwner = true; lines.push(`The listing doesn't mention ${hasNot.map(label).join(", ").toLowerCase()}, so I can't confirm it.`); }
        break;
      }
      case "documents": {
        const wanted = DOC_WORDS.filter(([, re]) => re.test(buyerText.toLowerCase())).map(([k]) => k);
        const match = facts.documents.filter(d => wanted.length === 0 || wanted.includes(d.kind));
        if (match.length) lines.push(`The owner has published: ${match.slice(0, 6).map(d => d.title).join("; ")}. You can open them from the listing page.`);
        else { needsOwner = true; lines.push("I can't see a published document that answers that."); }
        break;
      }
      case "inspection":
        if (settings.offerInspections && input.slots.length > 0) {
          slots = input.slots.slice(0, LIMITS.offeredSlots).map(s => ({ startsAt: s.startsAt }));
          lines.push(`I can offer these inspection times: ${slots.map(s => whenText(s.startsAt, input.timeZone)).join("; ")}. Choose one below to book it.`);
        } else { needsOwner = true; lines.push("I don't have inspection times to offer right now."); }
        break;
      case "other":
        needsOwner = true;
        lines.push("I can only answer from the listing details and the documents the owner has published.");
        break;
    }
  }
  if (needsOwner) lines.push(HAND_OVER);
  const reply = `${lines.join(" ")}\n\n${SIGNATURE}`;
  // Nothing at all answered (only unknowns and hand-overs): still send the holding line so the buyer is not left waiting.
  return { topics, reply, needsOwner, slots, ...(needsOwner ? { reason: "Part of the question needs the owner." } : {}) };
}

export type Check = { ok: true } | { ok: false; reason: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
/** True when the text carries the street address: the street part (number and name) of the address, or any "12 Smith" style pair from it. */
export function leaksAddress(text: string, address: string): boolean {
  const body = ` ${norm(text)} `;
  const street = norm(address.split(",")[0] ?? "");
  if (street.length >= 3 && body.includes(` ${street} `)) return true;
  const words = street.split(" ").filter(Boolean);
  for (let i = 0; i + 1 < words.length; i++) {
    if (/^\d+[a-z]?$/.test(words[i]!) && body.includes(` ${words[i]} ${words[i + 1]} `)) return true;
  }
  return false;
}

/** Everything Elena sends is checked: length, contact details, abuse and spam, discriminatory wording, amounts of money, the street address. */
export function checkReply(text: string, address: string): Check {
  if (!text.trim()) return { ok: false, reason: "The reply is empty." };
  if (text.length > LIMITS.maxReply) return { ok: false, reason: "The reply is too long." };
  if (scanContent(text).action === "block") return { ok: false, reason: "The reply was blocked by the content filter." };
  if (messageWordingError(text)) return { ok: false, reason: "The reply was blocked by the wording filter." };
  if (/\$\s?\d/.test(text) || /\b\d[\d,]*\s?(k|m|million|dollars|aud)\b/i.test(text)) return { ok: false, reason: "Elena does not send amounts or payment terms." };
  if (leaksAddress(text, address)) return { ok: false, reason: "The reply would reveal the street address." };
  return { ok: true };
}

/** True when another reply would go over Elena's limits. `forEnquiry` and `forListing` are counts of her sent replies in the last day and hour. */
export const overLimit = (forEnquiry: number, forListing: number): boolean =>
  forEnquiry >= LIMITS.perEnquiryPerDay || forListing >= LIMITS.perListingPerHour;

const TOPIC_LABEL: Record<Topic, string> = {
  address: "the address", offer: "an offer", price: "the price", inspection: "inspection times", bedrooms: "bedrooms", bathrooms: "bathrooms",
  parking: "parking", type: "the property type", location: "the location", features: "features", documents: "documents", other: "a general question"
};
export const topicLabels = (topics: readonly Topic[]): string => topics.map(t => TOPIC_LABEL[t]).join(", ");

/** The short note the owner gets. No buyer contact details, no address, no amounts. */
export function ownerSummary(kind: "drafted" | "answered" | "handed_over" | "booked" | "blocked", buyer: string, topics: readonly Topic[], when?: string): { title: string; text: string } {
  const about = topicLabels(topics);
  switch (kind) {
    case "drafted": return { title: "Elena drafted a reply", text: `${buyer} asked about ${about}. Elena's reply is waiting for your approval.` };
    case "answered": return { title: "Elena answered a buyer", text: `${buyer} asked about ${about}. Elena replied from the listing facts.` };
    case "handed_over": return { title: "A buyer question needs you", text: `${buyer} asked about ${about}. Elena couldn't answer it from the listing, so it is waiting for you.` };
    case "booked": return { title: "Elena booked an inspection", text: `${buyer} is booked to inspect${when ? ` on ${when}` : ""}. Both of you get a confirmation and a reminder.` };
    case "blocked": return { title: "A buyer question needs you", text: `${buyer} asked about ${about}. Elena's reply didn't pass the safety checks, so it was not sent.` };
  }
}

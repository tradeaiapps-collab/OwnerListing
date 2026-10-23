import { canContactSeller, type BuyerVerification } from "./buyer";
import type { OfferContext } from "./offers";

export const AUTOMATED_SENDER_ID = "system:offer-assistant";
export const PROMPT_COOLDOWN_MINUTES = 60;
export const LINK_TTL_MINUTES = 24 * 60;

/** Shown above the form. An offer is not a contract. */
export const OFFER_FORM_NOTICE =
  "This form submits an offer only. No contract exists until contracts are exchanged. " +
  "Speak to your solicitor before you make an offer, and do not send money until they advise you.";

export const OFFER_PROMPT_EN =
  "It looks like you may be making an offer. Is this your formal, final offer? " +
  "If yes, please click this secure link and fill in the form: {url}. " +
  "Offers made only in this chat are not formal offers.";

export function buildOfferPrompt(url: string): string {
  return OFFER_PROMPT_EN.replace("{url}", url);
}

const AMOUNT = /\$\s?\d[\d,]*(\.\d+)?\s?(k|m|million)?\b/i;
const OFFER_WORDS = /\b(offer|offering|bid|i['’]?ll pay|i can pay|will pay|willing to pay|would you take|how about|can do)\b/i;

/** A quick first check. The AI can also flag offers; this is the backstop. */
export function looksLikeOffer(text: string): boolean {
  return AMOUNT.test(text) && OFFER_WORDS.test(text);
}

export interface PromptDecision { send: boolean; reason: string }

export function shouldSendOfferPrompt(
  msg: { senderRole: "buyer" | "owner" | "system" | "other"; text: string },
  verification: BuyerVerification,
  lastPromptAt: string | undefined,
  now: string
): PromptDecision {
  if (msg.senderRole !== "buyer") return { send: false, reason: "Only buyer messages are checked." };
  if (!canContactSeller(verification)) return { send: false, reason: "Buyer is not fully verified." };
  if (!looksLikeOffer(msg.text)) return { send: false, reason: "No offer detected." };
  if (lastPromptAt !== undefined && new Date(now).getTime() - new Date(lastPromptAt).getTime() < PROMPT_COOLDOWN_MINUTES * 60_000) {
    return { send: false, reason: "A prompt was sent recently." };
  }
  return { send: true, reason: "Offer detected." };
}

export interface OfferLinkRecord {
  /** Only the hash is stored, so a database leak does not expose working links. */
  tokenHash: string;
  listingId: string;
  buyerUserId: string;
  expiresAt: string;
  usedAt?: string;
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function hashToken(token: string): Promise<string> { return sha256Hex(token); }

/** The token goes in the link sent to the buyer. Only the record (with the hash) is saved. */
export async function createOfferLink(listingId: string, buyerUserId: string, now: string): Promise<{ token: string; record: OfferLinkRecord }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const expiresAt = new Date(new Date(now).getTime() + LINK_TTL_MINUTES * 60_000).toISOString();
  return { token, record: { tokenHash: await hashToken(token), listingId, buyerUserId, expiresAt } };
}

/** The link works once, for one buyer and one listing, until it expires. */
export function validateOfferLink(r: OfferLinkRecord, buyerUserId: string, listingId: string, now: string): string[] {
  const problems: string[] = [];
  if (r.usedAt !== undefined) problems.push("This link has already been used.");
  if (r.expiresAt < now) problems.push("This link has expired. Ask for a new one in the chat.");
  if (r.buyerUserId !== buyerUserId) problems.push("This link was issued to a different person.");
  if (r.listingId !== listingId) problems.push("This link is for a different property.");
  return problems;
}

export interface FormalOffer {
  listingId: string;
  buyerUserId: string;
  /** Sale price, or rent per period, in cents. */
  priceCents: number;
  conditions: readonly string[];
  settlementDays: number;
  depositCents: number;
  /** The buyer ticked that this is their formal, final offer. */
  confirmedFinal: boolean;
  submittedAt: string;
}

export function validateFormalOffer(o: FormalOffer): string[] {
  const p: string[] = [];
  if (!o.confirmedFinal) p.push("The buyer must confirm this is their formal, final offer.");
  if (!Number.isInteger(o.priceCents) || o.priceCents <= 0) p.push("Offer amount must be greater than zero.");
  if (!Number.isInteger(o.settlementDays) || o.settlementDays < 1 || o.settlementDays > 365) p.push("Settlement period must be between 1 and 365 days.");
  if (!Number.isInteger(o.depositCents) || o.depositCents < 0 || o.depositCents > o.priceCents) p.push("Deposit must be between zero and the offer amount.");
  if (o.conditions.length > 10 || o.conditions.some(c => c.trim().length === 0 || c.length > 200)) p.push("Conditions: up to 10, each 1 to 200 characters.");
  return p;
}

/** Turns a submitted offer into the input for the offer rules. The owner always decides. */
export function toOfferContext(o: FormalOffer, offerId: string, counterRound = 0): OfferContext {
  return { offerId, listingId: o.listingId, priceCents: o.priceCents, counterRound, conditions: [...o.conditions], proposedConcessionBps: 0 };
}

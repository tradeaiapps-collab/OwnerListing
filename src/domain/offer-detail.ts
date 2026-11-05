/** One offer, seen by the listing's owner or appointed agent. Pure shaping; the database read is in src/server/offers-db.ts. */

export type OfferEventType = "submitted" | "viewed" | "countered" | "owner_countered" | "buyer_countered" | "buyer_agreed" | "accepted" | "rejected" | "withdrawn" | "expired" | "superseded" | "handoff" | "fallen_through";
export type ActorKind = "buyer" | "owner" | "agent" | "ai" | "system";

export interface OfferEvent { type: OfferEventType; actor: ActorKind; at: string; priceCents?: number; settlementDays?: number }
export interface OfferTerms { id: string; priceCents: number; depositCents: number; settlementDays: number; conditions: string[]; status: string; submittedAt: string }
export interface OfferMessage { from: "buyer" | "owner" | "agent" | "system"; body: string; at: string }
/** Buyer facts an owner may see: what was verified, never who they are (no id, name, email or phone). */
export interface BuyerSummary { emailVerified: boolean; phoneVerified: boolean; idVerified: boolean }

export interface OfferDetail {
  offer: OfferTerms;
  listing: { id: string; title: string; address: string; transactionType: "sale" | "rent"; askingPriceCents?: number };
  buyer: BuyerSummary;
  events: OfferEvent[];
  /** Every offer this buyer has made on this listing, oldest first, including this one. */
  history: OfferTerms[];
  /** The buyer's enquiry thread for this listing, oldest first (the newest 100). */
  messages: OfferMessage[];
  enquiryId?: string;
  /** Owner only: the AI and agents never accept. */
  canDecide: boolean;
}

export const OPEN_STATUSES = ["submitted", "under_review", "countered", "buyer_countered"] as const;
export const isOpen = (status: string) => (OPEN_STATUSES as readonly string[]).includes(status);

/** Signed difference from the asking price, in cents and basis points. Undefined without an asking price. */
export function versusAsking(priceCents: number, askingCents: number | undefined): { cents: number; bps: number } | undefined {
  if (askingCents === undefined || askingCents <= 0) return undefined;
  const cents = priceCents - askingCents;
  return { cents, bps: Math.round((cents * 10_000) / askingCents) };
}

/** Deposit as a share of the price, whole basis points (10% = 1000). */
export const depositBps = (o: Pick<OfferTerms, "priceCents" | "depositCents">) => (o.priceCents > 0 ? Math.round((o.depositCents * 10_000) / o.priceCents) : 0);

/** "+2.5%", "-1.2%", "0%" from basis points. */
export function formatBps(bps: number): string {
  const pct = Math.round(bps) / 100;
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toLocaleString("en-AU", { maximumFractionDigits: 2 })}%`;
}

/**
 * The timeline shown on the page, oldest first. Events come from offer_event; if an offer somehow has none (made
 * before history existed and not backfilled), a "submitted" entry is made from the offer itself so the timeline
 * always starts somewhere. Events at the same moment keep their stored order.
 */
export function timelineFor(offer: OfferTerms, events: readonly OfferEvent[]): OfferEvent[] {
  const list = events.length > 0 ? [...events] : [{ type: "submitted" as const, actor: "buyer" as const, at: offer.submittedAt, priceCents: offer.priceCents, settlementDays: offer.settlementDays }];
  return list.map((e, i) => ({ e, i })).sort((a, b) => (a.e.at < b.e.at ? -1 : a.e.at > b.e.at ? 1 : a.i - b.i)).map(x => x.e);
}

/** Change in price from the buyer's previous offer on the same listing, for the counter-offer history. */
export function historyWithDeltas(history: readonly OfferTerms[]): (OfferTerms & { deltaCents?: number })[] {
  return history.map((o, i) => (i === 0 ? { ...o } : { ...o, deltaCents: o.priceCents - history[i - 1]!.priceCents }));
}

const EVENT_TEXT: Record<OfferEventType, string> = {
  submitted: "Offer submitted", viewed: "Offer viewed", countered: "Counter requested from the buyer", owner_countered: "Owner sent a counter-offer", buyer_countered: "Buyer sent a counter-offer",
  buyer_agreed: "Buyer agreed to the owner's counter-offer",
  accepted: "Offer accepted", rejected: "Offer rejected", withdrawn: "Buyer withdrew the offer", expired: "Offer expired",
  superseded: "Replaced by a newer offer", handoff: "Handed to the owner for a decision", fallen_through: "Sale fell through"
};
const ACTOR_TEXT: Record<ActorKind, string> = { buyer: "Buyer", owner: "Owner", agent: "Agent", ai: "AI assistant (draft only)", system: "System" };
export const eventText = (t: OfferEventType) => EVENT_TEXT[t];
export const actorText = (a: ActorKind) => ACTOR_TEXT[a];

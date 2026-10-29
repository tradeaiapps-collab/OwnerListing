import type { CounterTerms } from "./offer-counter";

/** One state change of an offer, as shown to the owner or the buyer. */
export interface TimelineEvent {
  id: string;
  type: string;
  actor: "owner" | "buyer" | "system";
  round?: number;
  /** The terms this event put on the table, or the terms accepted. */
  terms?: CounterTerms;
  fromStatus?: string;
  /** Missing on events recorded before the offer history carried statuses. */
  toStatus?: string;
  occurredAt: string;
}

/** A plain sentence for each event, told from the viewer's side. Names roles only, never people. */
export function describeEvent(e: Pick<TimelineEvent, "type" | "actor" | "round">, viewer: "owner" | "buyer"): string {
  const who = (actor: TimelineEvent["actor"]) => (actor === viewer ? "You" : actor === "owner" ? "The owner" : actor === "buyer" ? "The buyer" : "The system");
  const round = e.round ? ` (round ${e.round})` : "";
  switch (e.type) {
    case "submitted": return `${who(e.actor)} made a formal offer`;
    case "countered": return `${who(e.actor)} asked for a better offer`;
    case "owner_countered": return `${who(e.actor)} sent a counter-offer${round}`;
    case "buyer_countered": return `${who(e.actor)} sent a counter-offer${round}`;
    case "buyer_agreed": return `${who(e.actor)} agreed to the owner's counter-offer${round}`;
    case "accepted": return `${who(e.actor)} accepted the offer`;
    case "rejected": return `${who(e.actor)} rejected the offer`;
    case "withdrawn": return e.actor === "system" ? "The offer was cancelled because an account on the other side was closed" : `${who(e.actor)} withdrew the offer`;
    case "expired": return `The counter-offer${round} lapsed without a reply, so the offer expired`;
    default: return `Status changed`;
  }
}

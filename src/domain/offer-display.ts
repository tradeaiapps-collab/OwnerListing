/** Wording for offer and counter-offer screens. Pure, so it is tested without a browser. */
export interface CounterSummary { fromParty: "owner" | "buyer"; status: string }

const OFFER_LABEL: Record<string, string> = {
  submitted: "New", under_review: "Under review", countered: "Countered", buyer_countered: "Buyer countered",
  accepted: "Accepted", rejected: "Rejected", withdrawn: "Withdrawn", expired: "Expired"
};

/** A short status for the offer, told from one side. `latest` is the newest counter, if any. */
export function offerStatusLabel(status: string, viewer: "owner" | "buyer", latest?: CounterSummary): string {
  if (status === "buyer_countered" && latest?.status === "agreed") return viewer === "owner" ? "Buyer agreed to your terms" : "You agreed: waiting for the owner";
  if (status === "buyer_countered") return viewer === "owner" ? "Buyer countered" : "Your counter: waiting for the owner";
  if (status === "countered") {
    if (!latest || latest.fromParty === "buyer" || latest.status !== "open") return viewer === "owner" ? "Counter requested" : "The owner asked you to improve your offer";
    return viewer === "owner" ? "Your counter: waiting for the buyer" : "The owner countered";
  }
  return OFFER_LABEL[status] ?? status;
}

const COUNTER_LABEL: Record<string, string> = {
  open: "Waiting for a reply", agreed: "Agreed by the buyer", countered: "Countered", accepted: "Accepted",
  rejected: "Rejected", withdrawn: "Withdrawn", expired: "Expired"
};
export const counterStatusLabel = (status: string): string => COUNTER_LABEL[status] ?? status;

/** "Owner" or "Buyer", or "You" for the viewer's own side. Never a name. */
export const partyLabel = (party: "owner" | "buyer", viewer: "owner" | "buyer"): string =>
  party === viewer ? "You" : party === "owner" ? "Owner" : "Buyer";

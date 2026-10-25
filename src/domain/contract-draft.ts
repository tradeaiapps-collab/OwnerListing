/** Contract-of-sale / lease DRAFT from a fixed template. Preview only: nothing is stored, signed or sent. */
export const DRAFT_LABEL = "Draft, not legal advice. Solicitor to review before anyone signs.";
export const TEMPLATE_VERSION = "draft-template-1";
const TBC = "[to be completed by the solicitor]";

export interface DraftListing {
  address: string;
  jurisdiction: string;
  transactionType: "sale" | "rent";
  useClass: string;
  propertyType: string;
}
export interface DraftOffer {
  priceCents: number;
  depositCents: number;
  settlementDays: number;
  conditions: readonly string[];
}
export interface ContractDraft {
  label: string;
  templateVersion: string;
  title: string;
  sections: { heading: string; lines: string[] }[];
}

/** Offers in these statuses can be drafted. A rejected offer (or an unknown status) cannot. */
export const DRAFTABLE_STATUSES: readonly string[] = ["submitted", "under_review", "countered", "buyer_countered", "accepted"];
export const canDraftFrom = (status: string): boolean => DRAFTABLE_STATUSES.includes(status);

const aud = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);

export function buildContractDraft(l: DraftListing, o: DraftOffer): ContractDraft {
  const sale = l.transactionType === "sale";
  const conditions = o.conditions.length > 0 ? o.conditions.map((c, i) => `${i + 1}. ${c}`) : ["None stated in the offer."];
  return {
    label: DRAFT_LABEL,
    templateVersion: TEMPLATE_VERSION,
    title: sale ? "Draft contract of sale" : "Draft lease agreement",
    sections: [
      { heading: "Parties", lines: [`${sale ? "Seller" : "Landlord"}: ${TBC}`, `${sale ? "Buyer" : "Tenant"}: ${TBC}`] },
      { heading: "Property", lines: [`Address: ${l.address}`, `State or territory: ${l.jurisdiction}`, `Type: ${l.useClass} ${l.propertyType}`] },
      sale
        ? { heading: "Price and deposit", lines: [`Price offered: ${aud(o.priceCents)}`, `Deposit offered: ${aud(o.depositCents)}, payable to the nominated solicitor's trust account (the platform holds no money)`, `Settlement: ${o.settlementDays} days after the contract date`] }
        : { heading: "Rent and bond", lines: [`Amount offered: ${aud(o.priceCents)} (rent period ${TBC})`, `Bond offered: ${aud(o.depositCents)}, held as the bond rules of the state or territory require`, `Start of lease: ${o.settlementDays} days after signing`] },
      { heading: "Conditions requested in the offer", lines: conditions },
      { heading: "Standard terms", lines: [`Prescribed state or territory terms, disclosures and cooling-off wording: ${TBC}`] },
      { heading: "Next steps", lines: ["This draft is a starting point only. It is not an offer, acceptance or contract. Both parties' solicitors review and settle the final document."] }
    ]
  };
}

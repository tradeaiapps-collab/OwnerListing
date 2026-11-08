/**
 * Elena's real estate knowledge base. Pure and static: general education only, never personal advice, never legal or tax advice.
 * Disclosure rules are NOT restated here: they are Compliance-owned and approved per state at /staff/disclosures, so entries on
 * that topic only name the usual documents and send the person to the approved checklist on the listing.
 * Add an entry by appending to KNOWLEDGE; ids are stable and never renamed.
 */

export const KNOWLEDGE_VERSION = "knowledge-v1";
export const KNOWLEDGE_NOTE = "General information only, not legal, financial or tax advice. Rules differ by state and change; check with a licensed professional.";

export const KNOWLEDGE_TOPICS = ["property_types", "terms", "buying_selling", "negotiation", "disclosure", "investing", "renting", "costs"] as const;
export type KnowledgeTopic = (typeof KNOWLEDGE_TOPICS)[number];

export interface KnowledgeEntry {
  id: string;
  topic: KnowledgeTopic;
  title: string;
  /** Words and phrases a question may use (lowercase). */
  keywords: readonly string[];
  /** Plain-words answer, two to four sentences. */
  answer: string;
  related?: readonly string[];
}

export const KNOWLEDGE: readonly KnowledgeEntry[] = [
  // Property types
  { id: "pt-house", topic: "property_types", title: "House", keywords: ["house", "detached", "freestanding", "free standing"],
    answer: "A house is a stand-alone home on its own title, so you own the building and the land. You usually have more space and privacy, and you pay for all maintenance and insurance yourself. Land value is a large part of the price, which is why houses often hold value in the long run." },
  { id: "pt-unit", topic: "property_types", title: "Unit or apartment", keywords: ["unit", "apartment", "flat", "strata", "body corporate", "owners corporation"],
    answer: "A unit shares a building and land with other owners. Most are strata titled, so you pay regular levies to the body corporate (owners corporation) for shared costs like lifts, insurance and repairs. Check the strata records, sinking fund and any planned special levies before buying.", related: ["cost-strata"] },
  { id: "pt-townhouse", topic: "property_types", title: "Townhouse", keywords: ["townhouse", "town house", "terrace", "semi detached", "semi-detached", "duplex"],
    answer: "A townhouse sits between a house and a unit: usually multi-storey, with shared walls and a small yard. Some are strata or community titled with levies, and some are on their own title with none, so always confirm the title type." },
  { id: "pt-land", topic: "property_types", title: "Vacant land", keywords: ["land", "vacant land", "block", "house and land", "off the plan land"],
    answer: "Vacant land has no building. Check zoning, services (water, power, sewer), slope, flood and bushfire overlays, and building costs before you buy, because those decide what you can build and what it costs." },
  { id: "pt-commercial", topic: "property_types", title: "Commercial property", keywords: ["commercial", "office", "retail", "industrial", "warehouse", "shop"],
    answer: "Commercial property (office, retail, industrial) is valued mainly on the rent it earns and how secure the lease is. Leases are longer, outgoings are often paid by the tenant, and different rules apply from residential. Look at lease term, tenant quality and vacancy risk." },
  { id: "pt-offtheplan", topic: "property_types", title: "Off the plan", keywords: ["off the plan", "off-the-plan", "new build", "new apartment", "developer"],
    answer: "Off the plan means buying before the building is finished. You often pay a deposit early and settle on completion, so the market can move in between and the final property may differ from the brochure. Read the contract, sunset clause and what happens if the valuation comes in low." },

  // Terms
  { id: "term-conveyancer", topic: "terms", title: "Conveyancer", keywords: ["conveyancer", "conveyancing", "solicitor", "lawyer"],
    answer: "A conveyancer (or solicitor) handles the legal side of a sale: reviewing the contract, searches, and settlement. It is wise to get one before you sign a contract, not after." },
  { id: "term-settlement", topic: "terms", title: "Settlement", keywords: ["settlement", "settle", "completion", "exchange"],
    answer: "Settlement is the day ownership transfers: the buyer's lender and the seller's lender swap funds and title, and the buyer gets the keys. It usually happens 30 to 90 days after the contract is signed, as agreed in the contract." },
  { id: "term-deposit", topic: "terms", title: "Deposit", keywords: ["deposit", "holding deposit", "booking deposit"],
    answer: "The deposit is part of the price paid when the contract is exchanged, commonly around ten percent but it varies by state and contract. It is normally held in trust until settlement. A smaller holding deposit may be paid first to reserve a property while the contract is prepared." },
  { id: "term-cooling", topic: "terms", title: "Cooling-off period", keywords: ["cooling off", "cooling-off", "cooling period"],
    answer: "A cooling-off period lets a buyer withdraw after signing, usually by paying a small penalty. Whether one applies, how long it is, and whether it can be waived depends on the state and the type of sale (it generally does not apply at auction). Ask your conveyancer for the rule that applies to your contract." },
  { id: "term-auction", topic: "terms", title: "Auction", keywords: ["auction", "reserve", "reserve price", "bidding", "bid", "under the hammer", "passed in"],
    answer: "At auction the highest bid at or above the reserve wins, and the sale is unconditional on the day: no finance or inspection conditions, and usually no cooling-off. Arrange finance approval, inspections and your conveyancer's review before auction day. A property is 'passed in' when bidding does not reach the reserve." },
  { id: "term-private-treaty", topic: "terms", title: "Private treaty and expressions of interest", keywords: ["private treaty", "expression of interest", "eoi", "offers over", "price guide", "price range"],
    answer: "Under private treaty the seller negotiates with buyers directly at an asking price or price guide. Offers can be conditional (for example on finance or inspections). An expression of interest is a deadline-based variant where buyers submit their best offers by a set date." },
  { id: "term-gross-net-yield", topic: "terms", title: "Gross and net yield", keywords: ["gross yield", "net yield", "rental yield", "yield"],
    answer: "Gross yield is annual rent divided by the purchase price. Net yield subtracts running costs first (rates, insurance, management fees, maintenance, strata, vacancy), so it is lower and a truer picture of what you keep. Compare like with like: yield alone ignores capital growth.", related: ["inv-capital-growth"] },
  { id: "term-lvr", topic: "terms", title: "LVR and mortgage insurance", keywords: ["lvr", "loan to value", "lenders mortgage insurance", "lmi", "deposit size", "80%"],
    answer: "Loan-to-value ratio (LVR) is the loan divided by the property value. Above about 80 percent most lenders charge lenders mortgage insurance, which protects the lender, not you. A bigger deposit lowers your LVR, your repayments and your risk." },
  { id: "term-stamp-duty", topic: "terms", title: "Stamp duty", keywords: ["stamp duty", "transfer duty", "first home buyer", "concession", "grant"],
    answer: "Stamp (transfer) duty is a state tax paid by the buyer on purchase, and the amount and any concessions or first-home-buyer exemptions differ by state and price. Use your state revenue office's calculator for a current figure; it is a major upfront cost." },
  { id: "term-capital-growth", topic: "terms", title: "Capital growth", keywords: ["capital growth", "appreciation", "growth"],
    answer: "Capital growth is the rise in a property's value over time. It tends to come from land scarcity, population growth, infrastructure and local demand. Past growth does not guarantee future growth.", related: ["inv-capital-growth"] },

  // Buying and selling
  { id: "bs-buying-steps", topic: "buying_selling", title: "Steps to buy", keywords: ["steps to buy", "how to buy", "buying process", "buy a house", "first home"],
    answer: "Typical steps: set a budget and get pre-approval, shortlist properties, inspect and review the contract with a conveyancer, make an offer or bid, pay the deposit, complete building and pest inspections, finalise finance, then settle. Allow for stamp duty, legal and moving costs on top of the price." },
  { id: "bs-selling-steps", topic: "buying_selling", title: "Steps to sell privately", keywords: ["sell privately", "sell my house", "selling process", "sell without agent", "private sale", "steps to sell"],
    answer: "Typical steps: price using recent comparable sales, prepare the property and photos, gather the required disclosure documents, list it, hold open homes and inspections, negotiate offers, sign the contract, then settle. Having your disclosures ready early avoids delays when a buyer is keen." },
  { id: "bs-pricing", topic: "buying_selling", title: "Pricing a property", keywords: ["price my", "pricing", "how much is my", "what is it worth", "valuation", "appraisal", "comparable", "comps"],
    answer: "Good pricing starts from recent sales of similar properties nearby (same type, size and condition, ideally within three to six months), then adjusts for differences. Overpricing tends to cost more time on market than it earns. An estimate is not a formal valuation; a bank or registered valuer provides that.", related: ["bs-days-on-market"] },
  { id: "bs-days-on-market", topic: "buying_selling", title: "Days on market", keywords: ["days on market", "dom", "slow to sell", "stale listing"],
    answer: "Days on market is how long listings in an area take to sell. A rising figure often means buyers have more bargaining power; a falling one means demand is strong. A listing far above its area's normal figure usually signals the price or presentation needs a review." },
  { id: "bs-inspections", topic: "buying_selling", title: "Building and pest inspections", keywords: ["building inspection", "pest inspection", "inspection report", "building and pest"],
    answer: "A building and pest inspection by an independent licensed inspector finds structural defects, termites, moisture and safety issues. Buyers use the report to decide, to negotiate price, or to walk away if the contract allows. At auction, do it before the day." },

  // Negotiation
  { id: "neg-offers", topic: "negotiation", title: "Making and responding to offers", keywords: ["make an offer", "offer", "counter offer", "counteroffer", "lowball", "negotiate", "negotiation", "negotiating"],
    answer: "Anchor your offer in evidence such as comparable sales, condition and time on market, and be ready to explain it. Leave room to move, and keep the other side's priorities in view: price is only one lever, settlement length, deposit, inclusions and conditions can matter just as much. Stay polite and keep written records." },
  { id: "neg-buyer-tactics", topic: "negotiation", title: "Negotiation tips for buyers", keywords: ["buyer tactics", "negotiation tips buyer", "get a better price", "bargain", "haggle", "lower price"],
    answer: "Do your homework on recent sales and the seller's situation. Offering a shorter settlement, a clean unconditional offer or a flexible handover can be worth more to a seller than a few extra dollars. Do not reveal your maximum, and be prepared to walk away." },
  { id: "neg-seller-tactics", topic: "negotiation", title: "Negotiation tips for sellers", keywords: ["seller tactics", "negotiation tips seller", "multiple offers", "best offer", "competing offers", "highest offer"],
    answer: "Compare offers on the whole package, not only price: deposit, finance certainty, conditions and settlement date. With several interested buyers, set a clear deadline so everyone puts forward their best offer. Respond to every offer in writing so the record is clear." },
  { id: "neg-conditions", topic: "negotiation", title: "Offer conditions", keywords: ["subject to finance", "conditional offer", "unconditional", "conditions", "finance clause"],
    answer: "A conditional offer depends on something, commonly finance approval or a satisfactory inspection. Conditions reduce the seller's certainty, so they usually weaken an offer unless the price compensates. Unconditional offers are stronger but should only be made once your finance and inspections are done." },

  // Disclosure (pointers only; Compliance owns the specifics)
  { id: "disc-overview", topic: "disclosure", title: "Disclosure requirements", keywords: ["disclosure", "disclose", "seller disclosure", "vendor statement", "section 32", "form 2", "contract of sale", "what must i disclose", "documents required"],
    answer: "Each state requires sellers to give buyers certain documents and facts before a contract is signed, for example title details, zoning, rates, and known defects, and the list differs between sales and rentals. This platform shows the approved checklist for your state on the listing form; complete every item before publishing. For the legal detail, ask your conveyancer." },
  { id: "disc-known-defects", topic: "disclosure", title: "Known defects", keywords: ["known defect", "latent defect", "hidden defect", "must i tell", "asbestos", "termite", "flooding", "structural"],
    answer: "Sellers are generally expected not to hide material problems they know about, such as structural issues, termite damage or flooding. Telling buyers up front is both the honest and the lower-risk approach, since concealment can unwind a sale. Your conveyancer can confirm what applies in your state." },

  // Investing
  { id: "inv-strategies", topic: "investing", title: "Investment strategies", keywords: ["investment strategy", "strategies", "investing", "invest", "investor", "buy and hold", "flip", "renovate", "subdivide", "development"],
    answer: "Common strategies: buy and hold (rent it and wait for growth), yield-focused (higher rent relative to price), growth-focused (lower yield in strong growth areas), renovate for value, and development or subdivision. Each trades off cash flow, growth, effort and risk differently, so match the strategy to your goals and cash buffer." },
  { id: "inv-capital-growth", topic: "investing", title: "Growth versus yield", keywords: ["growth vs yield", "growth or yield", "cash flow", "negative gearing", "positive gearing", "gearing"],
    answer: "Higher-yield properties pay more of their own way but often grow more slowly, while high-growth areas often have lower yields and cost you cash each month. Negatively geared means costs exceed rent; positively geared means rent exceeds costs. Tax treatment depends on your circumstances, so get tax advice." },
  { id: "inv-risk", topic: "investing", title: "Investment risks", keywords: ["risk", "risks", "downside", "vacancy", "interest rate risk", "liquidity"],
    answer: "Main risks: interest rates rising, vacancy periods, unexpected repairs, falling local prices, concentration in one suburb, and low liquidity (property can take months to sell). Keep a cash buffer for several months of costs and test your numbers at a higher rate than today's." },
  { id: "inv-diversification", topic: "investing", title: "Diversification", keywords: ["diversify", "diversification", "portfolio", "spread risk", "multiple properties"],
    answer: "Spreading holdings across different suburbs, property types and tenant bases reduces the chance one local event hurts everything. Avoid putting all your capital into one asset or one street. Diversification across asset classes (shares, cash) matters too." },
  { id: "inv-interest-rates", topic: "investing", title: "Interest rates and property", keywords: ["interest rate", "interest rates", "rate rise", "rate cut", "repayments", "variable", "fixed rate", "serviceability"],
    answer: "Higher rates raise repayments and reduce how much lenders will lend, which tends to cool demand and prices; lower rates do the opposite, with a delay. Lenders test your ability to repay at a buffer above the current rate, so stress-test your own budget the same way." },
  { id: "inv-seasonality", topic: "investing", title: "Seasonal patterns", keywords: ["season", "seasonal", "best time to sell", "best time to buy", "spring", "winter", "time of year"],
    answer: "Many Australian markets see more listings and buyers in spring and early autumn, with a quieter winter and summer holiday period. Fewer listings can mean less competition, so the best time depends on your suburb and goals. Local data beats generic seasonal rules." },
  { id: "inv-tenant-screening", topic: "investing", title: "Tenant screening", keywords: ["tenant screening", "screen tenants", "reference check", "tenancy database", "good tenant", "choosing a tenant"],
    answer: "Check identity, income and employment, previous landlord references, and rental history, and apply the same criteria to every applicant so you stay within anti-discrimination law. A bond held by the state authority and a written condition report protect both sides." },
  { id: "inv-property-management", topic: "investing", title: "Property management", keywords: ["property manager", "property management", "management fee", "manage my rental", "self manage", "self-manage"],
    answer: "A property manager handles advertising, tenant selection, rent collection, inspections and repairs for a fee, usually a percentage of rent plus letting fees. Self-managing saves the fee but takes time and requires you to know your state's tenancy law and respond fast to repairs." },

  // Renting vs selling
  { id: "rent-vs-sell", topic: "renting", title: "Rent or sell", keywords: ["rent or sell", "rent vs sell", "keep or sell", "should i keep", "renting out", "rent it out"],
    answer: "Renting keeps the asset and its growth potential and earns income, but brings costs, vacancy risk and landlord duties. Selling frees capital, ends ongoing risk and costs, but may trigger tax and transaction costs. Compare the net yield after all costs against what the sale proceeds could earn elsewhere, and get tax advice first." },
  { id: "rent-lease", topic: "renting", title: "Leases and bonds", keywords: ["lease", "bond", "tenancy agreement", "residential tenancy", "rental bond", "rent increase", "notice to vacate"],
    answer: "Residential tenancies are governed by state law: a written agreement, a bond lodged with the state authority, and rules on rent increases, inspections and notice periods. Use the state's standard agreement form where one exists, and keep a dated condition report." },

  // Costs
  { id: "cost-buying", topic: "costs", title: "Buying costs", keywords: ["buying costs", "upfront costs", "cost of buying", "hidden costs", "legal fees", "moving costs"],
    answer: "Beyond the price, budget for stamp duty, conveyancing, inspection reports, lender fees, mortgage insurance if your deposit is small, and moving costs. A common rule of thumb is a few percent of the price, but stamp duty varies a lot by state and price." },
  { id: "cost-selling", topic: "costs", title: "Selling costs", keywords: ["selling costs", "cost of selling", "agent fees", "advertising cost", "marketing cost", "sell privately cost"],
    answer: "Selling costs include marketing, photography, legal or conveyancing, and any agent commission. Selling privately removes the commission, but you take on the work of pricing, inspections and negotiation yourself." },
  { id: "cost-strata", topic: "costs", title: "Strata levies and holding costs", keywords: ["strata levy", "levies", "council rates", "water rates", "land tax", "holding costs", "running costs", "outgoings", "insurance"],
    answer: "Ongoing costs include council and water rates, insurance, maintenance, land tax for investors (varies by state), and strata levies for units. Always add these up before judging whether a rental stacks up." }
];

const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9%\s-]/g, " ").replace(/\s+/g, " ").trim();

export interface KnowledgeHit { entry: KnowledgeEntry; score: number }

/** Best matches for a question, highest score first. Longer keyword matches score higher; nothing is returned below a threshold. */
export function searchKnowledge(question: string, limit = 3, entries: readonly KnowledgeEntry[] = KNOWLEDGE): KnowledgeHit[] {
  const t = ` ${norm(question).slice(0, 500)} `;
  if (t.trim() === "") return [];
  const hits: KnowledgeHit[] = [];
  for (const entry of entries) {
    let score = 0;
    for (const k of entry.keywords) {
      if (t.includes(` ${k} `) || (k.length > 4 && t.includes(k))) score += k.split(" ").length * 2 + 1;
    }
    if (norm(entry.title).split(" ").every((w) => w.length > 2 && t.includes(w))) score += 2;
    if (score >= 3) hits.push({ entry, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).slice(0, limit);
}

export const knowledgeById = (id: string): KnowledgeEntry | undefined => KNOWLEDGE.find((e) => e.id === id);
export const knowledgeByTopic = (topic: KnowledgeTopic): KnowledgeEntry[] => KNOWLEDGE.filter((e) => e.topic === topic);

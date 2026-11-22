import { formatPrice } from "./listing-details";
import type { DemandOutlook, DemandUnavailable, Forecast, ForecastUnavailable, InvestmentScore, ScoreUnavailable } from "./market-forecast";
import type { MarketInsights, MarketUnavailable, TrendUnavailable, ValueTrend } from "./property-intelligence";

/**
 * Suburb analyst and investment analyzer. Pure maths and plain words, no advice. Everything is derived from numbers passed in;
 * a figure that is not available is reported as unavailable, never guessed. Outputs are versioned so the learning loop can compare them.
 */

export const ANALYST_VERSION = "analyst-v1";
export const ANALYST_NOTE = "Estimates from the figures shown, before tax. Not financial advice or a valuation; check with a licensed professional.";

// ---- Suburb analyst -----------------------------------------------------------------------------------------------------------

/** Optional neighbourhood facts from a licensed or public feed. The platform has no such feed yet, so these are normally absent. */
export interface SuburbFacts {
  schools?: { name: string; level: "primary" | "secondary" | "combined"; distanceKm: number }[];
  transport?: { kind: "train" | "tram" | "bus" | "ferry"; name: string; distanceKm: number }[];
  amenities?: { kind: string; name: string; distanceKm: number }[];
  crimePer1000?: number;
  medianAge?: number;
  medianHouseholdIncomeCents?: number;
  ownerOccupierPercent?: number;
}

export interface SuburbInputs {
  suburb: string;
  postcode?: string | undefined;
  market: MarketInsights | MarketUnavailable;
  trend: ValueTrend | TrendUnavailable;
  forecast?: Forecast | ForecastUnavailable | undefined;
  score?: InvestmentScore | ScoreUnavailable | undefined;
  demand?: DemandOutlook | DemandUnavailable | undefined;
  facts?: SuburbFacts | undefined;
  activeListings?: number | undefined;
}

export interface SuburbProfile {
  version: string;
  place: string;
  headline: string;
  strengths: string[];
  watchPoints: string[];
  /** What this platform cannot tell you, and where to look. Always present for anything missing. */
  gaps: string[];
  sections: { heading: string; body: string }[];
  note: string;
}

const OFFICIAL_SOURCES: Record<string, string> = {
  schools: "school catchments and results from your state education department and the national My School site",
  transport: "your state transport authority's journey planner",
  crime: "your state police crime statistics",
  demographics: "the Australian Bureau of Statistics census QuickStats for the suburb",
  amenities: "a map search for shops, parks, healthcare and childcare near the address"
};

export function suburbProfile(i: SuburbInputs): SuburbProfile {
  const place = [i.suburb, i.postcode].filter(Boolean).join(" ");
  const strengths: string[] = [], watchPoints: string[] = [], gaps: string[] = [], sections: SuburbProfile["sections"] = [];

  if (i.market.state === "ready") {
    const m = i.market;
    const bits = [`${m.sampleSize} recorded results in the last 12 months`, `median ${formatPrice(m.medianCents, "sale")}`];
    if (m.change12mPercent !== undefined) bits.push(`${m.change12mPercent >= 0 ? "up" : "down"} ${Math.abs(m.change12mPercent)}% on the year before`);
    if (m.medianDaysOnMarket !== undefined) bits.push(`about ${m.medianDaysOnMarket} days to sell`);
    sections.push({ heading: "Prices and sales", body: `${bits.join(", ")}.` });
    if ((m.change12mPercent ?? 0) >= 5) strengths.push("Prices have grown over the last year.");
    if ((m.change12mPercent ?? 0) <= -5) watchPoints.push("Prices have fallen over the last year.");
    if (m.velocity === "heating") strengths.push("Sales pace is picking up.");
    if (m.velocity === "cooling") watchPoints.push("Sales pace is slowing, so buyers may have more room to negotiate.");
    if (m.sampleSize < 15) watchPoints.push("Few recent results, so the figures are less reliable.");
  } else {
    gaps.push("There are not enough recent sales on this platform to describe prices in this suburb.");
  }

  if (i.trend.state === "ready" && i.trend.changePercent !== undefined) {
    sections.push({ heading: "Trend", body: `Median value is ${i.trend.changePercent >= 0 ? "up" : "down"} ${Math.abs(i.trend.changePercent)}% across ${i.trend.points.length} months of history.` });
  }
  if (i.forecast?.state === "ready") sections.push({ heading: "Outlook", body: `The trend, if it continues, points to ${i.forecast.direction} values. This is an extrapolation of past sales, not a prediction.` });
  if (i.score?.state === "ready") {
    sections.push({ heading: "Fundamentals", body: `Fundamentals score ${i.score.score}/100 (${i.score.label}), built from growth, rental yield, time to sell, momentum and consistency.` });
    if (i.score.label === "strong") strengths.push("Area fundamentals score strongly.");
    if (i.score.label === "weak") watchPoints.push("Area fundamentals score weakly.");
  }
  if (i.demand?.state === "ready") {
    sections.push({ heading: "Buyer interest", body: `Buyer interest on this platform is ${i.demand.outlook}.` });
    if (i.demand.outlook === "rising") strengths.push("Buyer interest on the platform is rising.");
    if (i.demand.outlook === "easing") watchPoints.push("Buyer interest on the platform is easing.");
  }

  const f = i.facts;
  if (f?.schools?.length) {
    const near = [...f.schools].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 3);
    sections.push({ heading: "Schools", body: near.map((s) => `${s.name} (${s.level}, ${s.distanceKm} km)`).join("; ") + "." });
    if (near[0]!.distanceKm <= 1.5) strengths.push("A school is within walking distance.");
  } else gaps.push(`Schools are not in this platform's data yet. Check ${OFFICIAL_SOURCES["schools"]}.`);
  if (f?.transport?.length) {
    const near = [...f.transport].sort((a, b) => a.distanceKm - b.distanceKm)[0]!;
    sections.push({ heading: "Transport", body: `Nearest ${near.kind}: ${near.name}, ${near.distanceKm} km.` });
    if (near.distanceKm <= 1) strengths.push(`A ${near.kind} stop is within 1 km.`);
    if (near.distanceKm > 3) watchPoints.push("Public transport is not close.");
  } else gaps.push(`Transport is not in this platform's data yet. Check ${OFFICIAL_SOURCES["transport"]}.`);
  if (f?.amenities?.length) sections.push({ heading: "Amenities", body: f.amenities.slice(0, 5).map((a) => `${a.name} (${a.kind}, ${a.distanceKm} km)`).join("; ") + "." });
  else gaps.push(`Amenities are not in this platform's data yet. Try ${OFFICIAL_SOURCES["amenities"]}.`);
  if (f?.crimePer1000 !== undefined) sections.push({ heading: "Safety", body: `${f.crimePer1000} recorded offences per 1,000 residents. Compare it with nearby suburbs rather than reading it alone.` });
  else gaps.push(`Crime figures are not in this platform's data. See ${OFFICIAL_SOURCES["crime"]}.`);
  if (f && (f.medianAge !== undefined || f.medianHouseholdIncomeCents !== undefined || f.ownerOccupierPercent !== undefined)) {
    const d: string[] = [];
    if (f.medianAge !== undefined) d.push(`median age ${f.medianAge}`);
    if (f.medianHouseholdIncomeCents !== undefined) d.push(`median household income ${formatPrice(f.medianHouseholdIncomeCents, "sale")} a year`);
    if (f.ownerOccupierPercent !== undefined) d.push(`${f.ownerOccupierPercent}% owner-occupiers`);
    sections.push({ heading: "People", body: `${d.join(", ")}.` });
  } else gaps.push(`Demographics are not in this platform's data. See ${OFFICIAL_SOURCES["demographics"]}.`);

  const headline = i.market.state === "ready"
    ? `${place}: ${strengths.length} things going for it, ${watchPoints.length} to watch, based on this platform's recorded sales.`
    : `${place}: there is not enough sales data on this platform to profile this suburb yet.`;
  return { version: ANALYST_VERSION, place, headline, strengths, watchPoints, gaps, sections, note: ANALYST_NOTE };
}

// ---- Investment analyzer ------------------------------------------------------------------------------------------------------

export interface InvestmentInputs {
  priceCents: number;
  weeklyRentCents: number;
  /** Deposit as a share of price (0 to 1). Default 0.2. */
  depositFraction?: number;
  /** Loan interest rate, percent a year. Default 6.5. */
  ratePercent?: number;
  loanYears?: number;
  interestOnly?: boolean;
  /** Annual costs in cents; any left out are estimated from the defaults below and flagged as assumed. */
  annualCosts?: Partial<Record<CostKey, number>>;
  vacancyWeeks?: number;
  /** Assumed yearly price growth, percent. Default 0 so the analysis stands without a growth guess. */
  growthPercent?: number;
}

export type CostKey = "rates" | "insurance" | "maintenance" | "management" | "strata";
export const DEFAULT_COST_FRACTIONS: Record<CostKey, number> = { rates: 0.004, insurance: 0.002, maintenance: 0.005, management: 0.07, strata: 0 };

export interface InvestmentAnalysis {
  version: string;
  grossYieldPercent: number;
  netYieldPercent: number;
  annualRentCents: number;
  annualCostsCents: number;
  annualInterestCents: number;
  annualCashFlowCents: number;
  weeklyCashFlowCents: number;
  breakEvenWeeklyRentCents: number;
  /** Cash flow if the rate were this much higher. */
  rateStress: { addedPercent: number; weeklyCashFlowCents: number }[];
  cashInvestedCents: number;
  cashOnCashPercent: number;
  fiveYear?: { growthPercent: number; endValueCents: number; totalReturnPercent: number } | undefined;
  assumed: string[];
  risks: string[];
  note: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const loanPayment = (loan: number, ratePct: number, years: number): number => {
  const r = ratePct / 100 / 12, n = years * 12;
  if (r === 0) return loan / n * 12;
  return (loan * r / (1 - Math.pow(1 + r, -n))) * 12;
};

/** Returns undefined for inputs that make no sense (non-positive price or rent, deposit outside 0 to 1). */
export function analyseInvestment(i: InvestmentInputs): InvestmentAnalysis | undefined {
  if (!(i.priceCents > 0) || !(i.weeklyRentCents > 0)) return undefined;
  const dep = i.depositFraction ?? 0.2;
  if (!(dep >= 0 && dep <= 1)) return undefined;
  const rate = i.ratePercent ?? 6.5, years = i.loanYears ?? 30, vac = i.vacancyWeeks ?? 2;
  if (!(rate >= 0 && rate <= 25) || !(years > 0 && years <= 40) || !(vac >= 0 && vac <= 52)) return undefined;
  const assumed: string[] = [];
  const costs = {} as Record<CostKey, number>;
  for (const k of Object.keys(DEFAULT_COST_FRACTIONS) as CostKey[]) {
    const given = i.annualCosts?.[k];
    if (given !== undefined) { costs[k] = given; continue; }
    if (k === "management") costs[k] = Math.round(i.weeklyRentCents * (52 - vac) * DEFAULT_COST_FRACTIONS[k]);
    else costs[k] = Math.round(i.priceCents * DEFAULT_COST_FRACTIONS[k]);
    if (DEFAULT_COST_FRACTIONS[k] > 0) assumed.push(k);
  }
  if (i.ratePercent === undefined) assumed.push("interest rate 6.5%");
  if (i.depositFraction === undefined) assumed.push("deposit 20%");
  if (i.vacancyWeeks === undefined) assumed.push("2 weeks vacant a year");
  const annualRent = Math.round(i.weeklyRentCents * (52 - vac));
  const annualCosts = Object.values(costs).reduce((a, b) => a + b, 0);
  const loan = i.priceCents * (1 - dep);
  const interestAt = (r: number) => Math.round(i.interestOnly ? loan * r / 100 : loan === 0 ? 0 : loanPayment(loan, r, years));
  const interest = interestAt(rate);
  const cash = annualRent - annualCosts - interest;
  const invested = Math.round(i.priceCents * dep);
  // Management is a share of rent when assumed, so it grows with rent: solve rent * (weeks * (1 - share)) = fixed costs + interest.
  const mgmtAssumed = i.annualCosts?.management === undefined;
  const fixedCosts = mgmtAssumed ? annualCosts - costs.management : annualCosts;
  const breakEven = Math.ceil((fixedCosts + interest) / ((52 - vac) * (mgmtAssumed ? 1 - DEFAULT_COST_FRACTIONS.management : 1)));
  const rateStress = [1, 2, 3].map((add) => ({ addedPercent: add, weeklyCashFlowCents: Math.round((annualRent - annualCosts - interestAt(rate + add)) / 52) }));
  const gross = i.weeklyRentCents * 52 / i.priceCents * 100;
  const net = (annualRent - annualCosts) / i.priceCents * 100;

  const risks: string[] = [];
  if (cash < 0) risks.push(`Costs exceed rent: about ${formatPrice(Math.abs(Math.round(cash / 52)), "rent")} a week out of your pocket.`);
  if (rateStress[1]!.weeklyCashFlowCents < 0 && cash >= 0) risks.push("A 2 point rate rise would turn cash flow negative.");
  if (dep < 0.2 && dep > 0) risks.push("Deposit under 20% usually means lenders mortgage insurance and a higher repayment.");
  if (dep === 0) risks.push("No deposit leaves no buffer if values fall.");
  if (net < 2.5) risks.push("Net yield is low, so returns depend heavily on capital growth.");
  if (vac >= 6) risks.push("Assumed vacancy is high; make sure it is realistic for the area.");

  const g = i.growthPercent;
  const fiveYear = g === undefined ? undefined : (() => {
    const end = Math.round(i.priceCents * Math.pow(1 + g / 100, 5));
    const gain = end - i.priceCents + cash * 5;
    return { growthPercent: g, endValueCents: end, totalReturnPercent: invested > 0 ? round1(gain / invested * 100) : 0 };
  })();

  return {
    version: ANALYST_VERSION, grossYieldPercent: round1(gross), netYieldPercent: round1(net), annualRentCents: annualRent, annualCostsCents: annualCosts,
    annualInterestCents: interest, annualCashFlowCents: Math.round(cash), weeklyCashFlowCents: Math.round(cash / 52), breakEvenWeeklyRentCents: breakEven,
    rateStress, cashInvestedCents: invested, cashOnCashPercent: invested > 0 ? round1(cash / invested * 100) : 0, fiveYear, assumed, risks, note: ANALYST_NOTE
  };
}

// ---- Portfolio mix ------------------------------------------------------------------------------------------------------------

export interface Holding { valueCents: number; suburb: string; propertyType: string }
export interface PortfolioMix {
  count: number;
  totalCents: number;
  /** Herfindahl index of suburb shares, 0 to 1 (1 = everything in one suburb). */
  suburbConcentration: number;
  largestSuburb: { name: string; sharePercent: number } | undefined;
  typeShares: { type: string; sharePercent: number }[];
  observations: string[];
}

export function portfolioMix(holdings: readonly Holding[]): PortfolioMix | undefined {
  const hs = holdings.filter((h) => h.valueCents > 0);
  if (hs.length === 0) return undefined;
  const total = hs.reduce((a, h) => a + h.valueCents, 0);
  const share = (key: (h: Holding) => string) => {
    const m = new Map<string, number>();
    for (const h of hs) m.set(key(h).trim().toLowerCase(), (m.get(key(h).trim().toLowerCase()) ?? 0) + h.valueCents);
    return [...m.entries()].map(([name, v]) => ({ name, share: v / total })).sort((a, b) => b.share - a.share || a.name.localeCompare(b.name));
  };
  const subs = share((h) => h.suburb), types = share((h) => h.propertyType);
  const hhi = subs.reduce((a, s) => a + s.share * s.share, 0);
  const observations: string[] = [];
  if (hs.length === 1) observations.push("One property means all your results depend on a single suburb and tenant.");
  else if (subs[0]!.share >= 0.6) observations.push(`${Math.round(subs[0]!.share * 100)}% of your value is in one suburb, so a local downturn would hit most of it.`);
  if (types.length === 1 && hs.length > 1) observations.push("All holdings are the same property type.");
  if (hs.length > 1 && subs.length === hs.length) observations.push("Each holding is in a different suburb, which spreads local risk.");
  return {
    count: hs.length, totalCents: total, suburbConcentration: Math.round(hhi * 100) / 100,
    largestSuburb: { name: subs[0]!.name, sharePercent: Math.round(subs[0]!.share * 100) },
    typeShares: types.map((t) => ({ type: t.name, sharePercent: Math.round(t.share * 100) })), observations
  };
}

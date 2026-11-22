import { describe, expect, it } from "vitest";
import { analyseInvestment, portfolioMix, suburbProfile } from "../src/domain/elena-analysts";
import { answerQuestion, needsMarketData, numbersFromText, resolveSuburb, suburbFromText } from "../src/domain/elena-brain";
import { KNOWLEDGE, searchKnowledge } from "../src/domain/elena-knowledge";

describe("knowledge base", () => {
  it("has unique ids, valid related links and non-empty answers", () => {
    const ids = new Set(KNOWLEDGE.map((e) => e.id));
    expect(ids.size).toBe(KNOWLEDGE.length);
    for (const e of KNOWLEDGE) {
      expect(e.answer.length).toBeGreaterThan(40);
      for (const r of e.related ?? []) expect(ids.has(r)).toBe(true);
    }
  });
  it("finds entries by keyword and ranks the best first", () => {
    expect(searchKnowledge("What does gross yield mean?")[0]?.entry.id).toBe("term-gross-net-yield");
    expect(searchKnowledge("how does an auction work and what is a reserve")[0]?.entry.id).toBe("term-auction");
    expect(searchKnowledge("tips to negotiate an offer")[0]?.entry.topic).toBe("negotiation");
  });
  it("returns nothing for unrelated text", () => {
    expect(searchKnowledge("purple elephants tango")).toEqual([]);
    expect(searchKnowledge("")).toEqual([]);
  });
  it("does not restate state disclosure rules, only points to the approved checklist", () => {
    const d = searchKnowledge("what must I disclose when selling")[0]!.entry;
    expect(d.answer).toMatch(/approved checklist/);
  });
});

describe("investment analyzer", () => {
  const base = { priceCents: 800_000_00, weeklyRentCents: 600_00 };
  it("computes yields and flags assumptions", () => {
    const a = analyseInvestment(base)!;
    expect(a.grossYieldPercent).toBe(3.9);
    expect(a.netYieldPercent).toBeLessThan(a.grossYieldPercent);
    expect(a.assumed).toContain("interest rate 6.5%");
    expect(a.rateStress[2]!.weeklyCashFlowCents).toBeLessThan(a.rateStress[0]!.weeklyCashFlowCents);
  });
  it("is negative-geared at these numbers and says so", () => {
    const a = analyseInvestment(base)!;
    expect(a.weeklyCashFlowCents).toBeLessThan(0);
    expect(a.risks.join(" ")).toMatch(/Costs exceed rent/);
  });
  it("breaks even at the break-even rent", () => {
    const a = analyseInvestment(base)!;
    const b = analyseInvestment({ ...base, weeklyRentCents: a.breakEvenWeeklyRentCents })!;
    expect(Math.abs(b.weeklyCashFlowCents)).toBeLessThanOrEqual(10_00);
  });
  it("interest-only costs less than principal and interest", () => {
    expect(analyseInvestment({ ...base, interestOnly: true })!.annualInterestCents).toBeLessThan(analyseInvestment(base)!.annualInterestCents);
  });
  it("refuses nonsense inputs", () => {
    expect(analyseInvestment({ priceCents: 0, weeklyRentCents: 500_00 })).toBeUndefined();
    expect(analyseInvestment({ ...base, depositFraction: 1.5 })).toBeUndefined();
    expect(analyseInvestment({ ...base, ratePercent: 40 })).toBeUndefined();
  });
  it("adds a five-year view only when growth is given", () => {
    expect(analyseInvestment(base)!.fiveYear).toBeUndefined();
    expect(analyseInvestment({ ...base, growthPercent: 4 })!.fiveYear!.endValueCents).toBeGreaterThan(base.priceCents);
  });
});

describe("portfolio mix", () => {
  it("measures concentration", () => {
    const m = portfolioMix([{ valueCents: 900_00, suburb: "Manly", propertyType: "unit" }, { valueCents: 100_00, suburb: "Penrith", propertyType: "house" }])!;
    expect(m.largestSuburb).toEqual({ name: "manly", sharePercent: 90 });
    expect(m.observations.join(" ")).toMatch(/one suburb/);
    expect(m.suburbConcentration).toBeGreaterThan(0.8);
  });
  it("is undefined for no holdings", () => expect(portfolioMix([])).toBeUndefined());
});

describe("suburb analyst", () => {
  it("lists what it cannot cover instead of inventing it", () => {
    const p = suburbProfile({ suburb: "Manly", market: { state: "unavailable", sampleSize: 2, message: "x" }, trend: { state: "unavailable", message: "x" } });
    expect(p.headline).toMatch(/not enough sales data/);
    expect(p.gaps.length).toBeGreaterThanOrEqual(4);
    expect(p.gaps.join(" ")).toMatch(/schools/i);
  });
  it("uses supplied neighbourhood facts when present", () => {
    const p = suburbProfile({
      suburb: "Manly", market: { state: "unavailable", sampleSize: 0, message: "x" }, trend: { state: "unavailable", message: "x" },
      facts: { schools: [{ name: "Manly Public", level: "primary", distanceKm: 0.8 }], transport: [{ kind: "ferry", name: "Manly Wharf", distanceKm: 0.5 }], crimePer1000: 40 }
    });
    expect(p.strengths.join(" ")).toMatch(/school/);
    expect(p.gaps.join(" ")).not.toMatch(/Schools are not/);
  });
});

describe("brain routing", () => {
  it("declines personal advice and offers facts instead", () => {
    const a = answerQuestion("Should I buy now?", {});
    expect(a.intent).toBe("advice_declined");
    expect(a.text).toMatch(/licensed professional/);
  });
  it("answers knowledge questions with the disclaimer", () => {
    const a = answerQuestion("What is a conveyancer?", {});
    expect(a.intent).toBe("knowledge");
    expect(a.text).toMatch(/not legal, financial or tax advice/);
  });
  it("does the yield maths from numbers in the question", () => {
    const a = answerQuestion("What is the yield on $850,000 with rent $600 a week at 6%?", {});
    expect(a.intent).toBe("investment");
    expect(a.investment!.grossYieldPercent).toBe(3.7);
  });
  it("asks for numbers when they are missing", () => {
    expect(answerQuestion("work out my cash flow", {}).intent).toBe("needs_numbers");
  });
  it("uses the open listing for the investment maths", () => {
    const a = answerQuestion("what's the yield?", { listing: { id: "l1", priceCents: 700_000_00, weeklyRentCents: 550_00, transactionType: "sale" } });
    expect(a.intent).toBe("investment");
  });
  it("asks which suburb when none is known", () => {
    expect(answerQuestion("tell me about the suburb", {}).intent).toBe("needs_suburb");
  });
  it("answers plain negotiation questions from knowledge, not the market", () => {
    expect(needsMarketData("how do I negotiate an offer")).toBe(false);
    expect(answerQuestion("how do I negotiate an offer", {}).intent).toBe("knowledge");
  });
  it("handles unknown and empty input", () => {
    expect(answerQuestion("   ", {}).intent).toBe("unknown");
    expect(answerQuestion("purple elephants tango", {}).intent).toBe("unknown");
  });
  it("never answers market questions without loaded data", () => {
    const a = answerQuestion("how are prices in Manly", {});
    expect(a.type).toBe("needs_data");
  });
});

describe("context integration", () => {
  it("prefers the question, then listing, project, search", () => {
    expect(resolveSuburb("prices in Manly", { suburb: "Penrith" })).toMatchObject({ suburb: "Manly", from: "question" });
    expect(resolveSuburb("prices?", { listing: { id: "1", suburb: "Penrith", postcode: "2750" } })).toMatchObject({ suburb: "Penrith", postcode: "2750", from: "context" });
    expect(resolveSuburb("prices?", { project: { id: "p", title: "t", suburb: "Cairns" } })?.suburb).toBe("Cairns");
    expect(resolveSuburb("prices?", { buyerPrefs: { suburbs: ["Hobart"] } })?.suburb).toBe("Hobart");
    expect(resolveSuburb("prices?", {})).toBeUndefined();
  });
  it("parses suburbs and numbers", () => {
    expect(suburbFromText("what is it like living in Surfers Paradise")).toBe("Surfers Paradise");
    expect(numbersFromText("buy at $1.2m rent $750 per week at 5.5%")).toEqual({ priceCents: 120_000_000, weeklyRentCents: 75_000, ratePercent: 5.5 });
  });
});

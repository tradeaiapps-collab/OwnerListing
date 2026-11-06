import { describe, expect, it } from "vitest";
import { ADVISOR_START, advance, widenBudget, type AdvisorState } from "../src/domain/buyer-advisor";

const run = (...answers: string[]) => {
  let s: AdvisorState = ADVISOR_START;
  let reply = "";
  for (const a of answers) { const t = advance(s, a); s = t.state; reply = t.reply; }
  return { s, reply };
};

describe("buyer advisor", () => {
  it("asks buy or rent first, and repeats until it is clear", () => {
    const { s, reply } = run("hello");
    expect(s.step).toBe("intent");
    expect(reply).toMatch(/buy or to rent/);
  });
  it("walks the agent questions in order", () => {
    let r = run("I want to buy");
    expect(r.s.step).toBe("budget");
    r = run("I want to buy", "between 600 and 900k");
    expect(r.s.params).toMatchObject({ transactionType: "sale", minPriceCents: "60000000", maxPriceCents: "90000000" });
    expect(r.s.step).toBe("type");
    r = run("buy", "800k", "apartment", "2", "Paddington", "pool and garage");
    expect(r.s.step).toBe("done");
    expect(r.s.params).toMatchObject({ propertyType: "unit", minBedrooms: "2", suburb: "Paddington", amenities: "pool,garage" });
  });
  it("reads a bare number as thousands for sale and dollars a week for rent", () => {
    expect(run("buy", "800").s.params["maxPriceCents"]).toBe("80000000");
    expect(run("rent", "650").s.params["maxPriceCents"]).toBe("65000");
  });
  it("does not ask again for things already said", () => {
    const r = run("buy a 3 bed house in Brisbane QLD under 900k");
    expect(r.s.params).toMatchObject({ transactionType: "sale", propertyType: "house", minBedrooms: "3", jurisdiction: "QLD", maxPriceCents: "90000000" });
    expect(r.s.step).toBe("extras");
  });
  it("lets the buyer skip a question", () => {
    const r = run("rent", "any", "any", "no preference");
    expect(r.s.params["maxPriceCents"]).toBeUndefined();
    expect(r.s.step).toBe("where");
  });
  it("re-asks when an answer is not understood", () => {
    const r = run("buy", "banana");
    expect(r.s.step).toBe("budget");
    expect(r.reply).toMatch(/didn't catch/);
  });
  it("refines after the questions end", () => {
    const r = run("buy", "any", "any", "any", "anywhere", "no", "under 700k");
    expect(r.s.step).toBe("done");
    expect(r.s.params["maxPriceCents"]).toBe("70000000");
  });
  it("widens a budget by 15% rounded up", () => {
    expect(widenBudget({ transactionType: "sale", maxPriceCents: "90000000" })?.["maxPriceCents"]).toBe("105000000");
    expect(widenBudget({ transactionType: "sale" })).toBeNull();
  });
});

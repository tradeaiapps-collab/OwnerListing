import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG, extractSlots, newLeadState, nextTurn, postcodeJurisdiction, readMoney, sanitiseAiSlots, scoreLead, type LeadState
} from "../src/domain/lead-qualifier";
import { cleanInboundEmailText, isAutomatedSender } from "../src/domain/lead-email";

describe("reading answers", () => {
  it("reads money with units and ignores postcodes and years", () => {
    expect(readMoney("up to $850k").map(m => m.value)).toEqual([850_000]);
    expect(readMoney("between 1.2m and 1.5m").map(m => m.value)).toEqual([1_200_000, 1_500_000]);
    expect(readMoney("$650 per week")).toEqual([{ value: 650, weekly: true }]);
    expect(readMoney("4005")).toEqual([]);
    expect(readMoney("3 bedrooms")).toEqual([]);
  });
  it("maps postcodes to states", () => {
    expect(["4005", "2000", "3000", "6000", "5000", "7000", "0800", "2600"].map(p => postcodeJurisdiction(p))).toEqual(["QLD", "NSW", "VIC", "WA", "SA", "TAS", "NT", "ACT"]);
    expect(postcodeJurisdiction("1234")).toBe("NSW");
    expect(postcodeJurisdiction("abcd")).toBeUndefined();
  });
  it("extracts several slots from one message", () => {
    const s = extractSlots("I want to buy a house in New Farm 4005, budget $1.2m, ASAP, relocating for work. Pre-approved.");
    expect(s).toMatchObject({ goal: "buy", postcode: "4005", suburb: "New Farm", budgetMax: 1_200_000, timeline: "now", urgent: true, propertyType: "house", motivation: "relocating", financeReady: "yes" });
  });
  it("reads a bare answer as the slot that was asked", () => {
    expect(extractSlots("850k", "budget").budgetMax).toBe(850_000);
    expect(extractSlots("yes", "finance").financeReady).toBe("yes");
    expect(extractSlots("Paddington", "location").suburb).toBe("Paddington");
    expect(extractSlots("not yet", "finance").financeReady).toBe("no");
  });
  it("reads contact details to E.164 and lower-case email", () => {
    expect(extractSlots("call 0412 345 678 or Sam@Example.com")).toMatchObject({ phone: "+61412345678", email: "sam@example.com" });
  });
  it("keeps only valid model output", () => {
    expect(sanitiseAiSlots({ goal: "buy", timeline: "soon", budgetMax: -5, postcode: "9999x", propertyType: "castle", suburb: "<script>" })).toEqual({ goal: "buy" });
  });
});

describe("scoring", () => {
  it("scores a ready buyer hot and an empty lead cold, 0 to 100", () => {
    const hot = scoreLead({ goal: "buy", postcode: "4005", suburb: "New Farm", timeline: "now", urgent: true, budgetMax: 900_000, propertyType: "house", motivation: "relocating", financeReady: "yes", phone: "+61412345678", email: "a@b.com" });
    expect(hot.score).toBeGreaterThanOrEqual(95);
    expect(hot.tier).toBe("hot");
    const cold = scoreLead({});
    expect(cold.score).toBe(0);
    expect(cold.tier).toBe("cold");
    expect(cold.missing).toContain("timeline");
  });
  it("does not penalise sellers for finance and never uses a name", () => {
    const seller = scoreLead({ goal: "sell", postcode: "4005", timeline: "1m", budgetMax: 1_000_000, propertyType: "house", motivation: "downsizing", phone: "+61412345678" });
    expect(seller.factors.find(f => f.component === "finance")).toBeUndefined();
    const withName = scoreLead({ goal: "sell", postcode: "4005", timeline: "1m", budgetMax: 1_000_000, propertyType: "house", motivation: "downsizing", phone: "+61412345678", name: "Zed" });
    expect(withName.score).toBe(seller.score);
  });
  it("treats an implausible budget as weak", () => {
    expect(scoreLead({ goal: "buy", budgetMax: 5000 }).factors.find(f => f.component === "budget")?.points).toBeLessThan(scoreLead({ goal: "buy", budgetMax: 800_000 }).factors.find(f => f.component === "budget")?.points ?? 0);
  });
});

const say = (st: LeadState, text: string) => nextTurn(st, text, DEFAULT_CONFIG);

describe("conversation", () => {
  it("asks goal first, then location, and stops when the core is known", () => {
    let t = say(newLeadState(), "hi");
    expect(t.reply).toMatch(/buy, sell, rent/i);
    t = say(t.state, "I want to buy");
    expect(t.state.lastAsked).toBe("location");
    t = say(t.state, "New Farm 4005");
    expect(t.state.lastAsked).toBe("timeline");
    t = say(t.state, "within 3 months");
    expect(t.state.lastAsked).toBe("budget");
    t = say(t.state, "under $900k");
    t = say(t.state, "a house");
    expect(t.state.slots).toMatchObject({ goal: "buy", postcode: "4005", timeline: "3m", budgetMax: 900_000, propertyType: "house" });
  });
  it("skips already-answered questions", () => {
    const t = say(newLeadState(), "I want to sell my house in Paddington 4064 within 3 months for about $1.1m");
    expect(t.state.lastAsked).not.toBe("goal");
    expect(t.state.lastAsked).not.toBe("location");
    expect(t.state.lastAsked).not.toBe("timeline");
  });
  it("rephrases once, then gives up on an optional slot without looping", () => {
    let t = say(newLeadState(), "buy in 4005 house under $900k");
    expect(t.state.lastAsked).toBe("timeline");
    const first = t.reply;
    t = say(t.state, "umm");
    expect(t.reply).not.toBe(first);
    expect(t.state.asked.timeline).toBe(2);
    t = say(t.state, "dunno");
    expect(t.state.skipped).toContain("timeline");
  });
  it("hands over at once when asked for a person, asking only for the area if missing", () => {
    let t = say(newLeadState(), "Can I talk to a real person?");
    expect(t.readyToRoute).toBe(false);
    expect(t.reply).toMatch(/suburb or postcode/i);
    t = say(t.state, "4005");
    expect(t.state.status === "handoff_requested" || t.readyToRoute).toBe(true);
    expect(say(newLeadState({ postcode: "4005" }), "please call me").readyToRoute).toBe(true);
  });
  it("opts out on STOP and says no more", () => {
    const t = say(newLeadState(), "STOP");
    expect(t.state.status).toBe("opted_out");
    expect(t.readyToRoute).toBe(false);
  });
  it("never skips the area: offers a human after repeated misses", () => {
    let t = say(newLeadState({ goal: "buy" }), "hello");
    for (let i = 0; i < 4; i++) t = say(t.state, "no idea");
    expect(t.state.status).toBe("complete");
    expect(t.readyToRoute).toBe(false);
    expect(t.reply).toMatch(/team member/i);
  });
  it("ends by the turn cap", () => {
    let st = newLeadState({ goal: "buy", postcode: "4005" });
    st = { ...st, turns: 15 };
    expect(say(st, "ok").state.status).toBe("complete");
  });
  it("asks finance of buyers only", () => {
    let t = say(newLeadState(), "sell in 4005, 1m, $1m, house, downsizing");
    for (let i = 0; i < 4; i++) t = say(t.state, "skip");
    expect(t.state.asked.finance).toBeUndefined();
  });
});

describe("inbound email", () => {
  it("drops quoted text and signatures", () => {
    expect(cleanInboundEmailText("Looking in 4005\n\n> old\nOn Mon, 3 Nov 2026 at 9:00, Elena wrote:\n> hi")).toBe("Looking in 4005");
  });
  it("ignores robots", () => {
    expect(isAutomatedSender("no-reply@x.com", {})).toBe(true);
    expect(isAutomatedSender("a@x.com", { "Auto-Submitted": "auto-replied" })).toBe(true);
    expect(isAutomatedSender("a@x.com", { Precedence: "bulk" })).toBe(true);
    expect(isAutomatedSender("sam@x.com", {})).toBe(false);
  });
});

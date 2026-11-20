import { describe, expect, it } from "vitest";
import { LIMITS, checkReply, classify, leaksAddress, overLimit, ownerSummary, plan, type ListingFacts } from "../src/domain/elena-enquiries";
import { digestDay, digestText, rank, type TodayItem } from "../src/domain/owner-today";

const facts: ListingFacts = {
  transactionType: "sale", propertyType: "house", suburb: "Newtown", postcode: "2042", bedrooms: 3, bathrooms: 2, parking: 1,
  amenities: ["pool", "solar"], priceShown: true, documents: [{ title: "Building and pest report", kind: "building_inspection" }]
};
const ADDRESS = "12 Smith St, Newtown";
const base = { facts, settings: { enabled: true, offerInspections: true, autoSend: false }, slots: [] as { startsAt: string }[], timeZone: "Australia/Sydney" };
const ask = (buyerText: string, over: Partial<typeof base> = {}) => plan({ ...base, ...over, buyerText });

describe("classify", () => {
  it("finds every question in a message", () => {
    expect(classify("How many bedrooms and is there parking?")).toEqual(["bedrooms", "parking"]);
    expect(classify("Can I see it on Saturday?")).toContain("inspection");
    expect(classify("what is the street address?")).toContain("address");
    expect(classify("hello")).toEqual(["other"]);
    // "street" on its own is not an address question
    expect(classify("How noisy is the street and what are the council rates?")).toEqual(["other"]);
    expect(classify("I'll offer $850,000 cash")).toContain("offer");
  });
});

describe("plan: answers only from the listing", () => {
  it("answers from facts and signs as the assistant", () => {
    const p = ask("How many bedrooms and bathrooms?");
    expect(p.reply).toContain("3 bedrooms");
    expect(p.reply).toContain("2 bathrooms");
    expect(p.reply).toContain("(AI)");
    expect(p.needsOwner).toBe(false);
  });
  it("hands over what the listing does not say, and never guesses", () => {
    const { bathrooms: _omit, ...noBaths } = facts;
    const p = ask("How many bathrooms?", { facts: noBaths });
    expect(p.needsOwner).toBe(true);
    expect(p.reply).toContain("doesn't state the number of bathrooms");
    expect(p.reply).toContain("passed the rest to the owner");
    expect(p.reply).not.toMatch(/\d bathroom/);
  });
  it("does not confirm a feature the listing omits", () => {
    const p = ask("Is there a garden and a pool?");
    expect(p.reply).toContain("Pool");
    expect(p.reply).toContain("doesn't mention garden");
    expect(p.needsOwner).toBe(true);
  });
  it("points to the listing page for price and never states an amount", () => {
    const p = ask("What is the price?");
    expect(p.reply).toContain("shown on the listing page");
    expect(p.reply).not.toMatch(/\$|\d{3}/);
    expect(ask("what's the price", { facts: { ...facts, priceShown: false } }).needsOwner).toBe(true);
  });
  it("sends offers and negotiation to the owner", () => {
    for (const t of ["Would the owner take 800k?", "I want to make an offer"]) {
      const p = ask(t);
      expect(p.needsOwner).toBe(true);
      expect(p.reply).toContain("I can't discuss or agree them");
    }
    // Probing for the lowest price is a safety hand-over: no reply at all, the owner decides what to say.
    const probe = ask("What's the lowest price they'd accept");
    expect(probe.reply).toBeUndefined();
    expect(probe.needsOwner).toBe(true);
  });
  it("never gives the street address", () => {
    for (const t of ["What's the address?", "which street is it on", "exact location please, where is it?"]) {
      const p = ask(t);
      expect(p.reply).toContain("shared once an inspection is booked");
      expect(leaksAddress(p.reply!, ADDRESS)).toBe(false);
    }
  });
  it("lists published documents, else hands over", () => {
    expect(ask("Is there a building report?").reply).toContain("Building and pest report");
    expect(ask("Is there a strata report?", { facts: { ...facts, documents: [] } }).needsOwner).toBe(true);
  });
  it("offers up to three inspection times and only when allowed", () => {
    const slots = [1, 2, 3, 4].map(d => ({ startsAt: new Date(Date.UTC(2026, 11, 10 + d, 0)).toISOString() }));
    const p = ask("Can I inspect this weekend?", { slots });
    expect(p.slots).toHaveLength(LIMITS.offeredSlots);
    expect(p.reply).toContain("Choose one below to book it");
    const off = ask("Can I inspect this weekend?", { slots, settings: { enabled: true, offerInspections: false, autoSend: false } });
    expect(off.slots).toHaveLength(0);
    expect(off.needsOwner).toBe(true);
    expect(ask("Can I inspect?").needsOwner).toBe(true);
  });
  it("gives no reply at all to a message that looks like a scam", () => {
    const p = ask("Please pay the deposit to my account urgently, send your bank details on WhatsApp");
    expect(p.reply).toBeUndefined();
    expect(p.needsOwner).toBe(true);
  });
  it("its own text always passes its own outbound checks", () => {
    for (const t of ["bedrooms?", "price?", "address?", "documents?", "pool?", "inspect?", "something else entirely"]) {
      const p = ask(t);
      expect(checkReply(p.reply!, ADDRESS)).toEqual({ ok: true });
    }
  });
});

describe("outbound checks", () => {
  it("blocks amounts, contact details, the address and over-long text", () => {
    expect(checkReply("It sold for $900,000.", ADDRESS).ok).toBe(false);
    expect(checkReply("Call me on 0412 345 678", ADDRESS).ok).toBe(false);
    expect(checkReply("It is at 12 Smith St.", ADDRESS).ok).toBe(false);
    expect(checkReply("Number 12 Smith is lovely", ADDRESS).ok).toBe(false);
    expect(checkReply("x".repeat(LIMITS.maxReply + 1), ADDRESS).ok).toBe(false);
    expect(checkReply("   ", ADDRESS).ok).toBe(false);
    expect(checkReply("It has 3 bedrooms.", ADDRESS)).toEqual({ ok: true });
  });
  it("limits replies per conversation and per listing", () => {
    expect(overLimit(LIMITS.perEnquiryPerDay - 1, 0)).toBe(false);
    expect(overLimit(LIMITS.perEnquiryPerDay, 0)).toBe(true);
    expect(overLimit(0, LIMITS.perListingPerHour)).toBe(true);
  });
  it("writes owner notes without contact details", () => {
    const n = ownerSummary("handed_over", "Sam", ["price", "inspection"]);
    expect(n.text).toContain("Sam");
    expect(n.text).toContain("the price, inspection times");
    expect(n.text).not.toMatch(/@|\d{6}/);
  });
});

describe("owner list and digest", () => {
  const item = (id: string, urgency: 1 | 2 | 3, at: string): TodayItem => ({ id, kind: "approval", title: id, detail: "", at, urgency, action: { type: "link", href: "/x", label: "Go" } });
  it("puts urgent items first, oldest first within an urgency, and caps the list", () => {
    const r = rank([item("c", 3, "2026-11-01"), item("b", 1, "2026-11-03"), item("a", 1, "2026-11-02"), item("d", 2, "2026-11-01")]);
    expect(r.map(i => i.id)).toEqual(["a", "b", "d", "c"]);
    expect(rank(Array.from({ length: 40 }, (_, i) => item(`i${i}`, 2, "2026-11-01")))).toHaveLength(25);
  });
  it("writes a short digest", () => {
    expect(digestText([item("a", 1, "2026-11-02")]).title).toBe("1 thing needs you today");
    const d = digestText(Array.from({ length: 10 }, (_, i) => item(`i${i}`, 2, "2026-11-01")));
    expect(d.title).toBe("10 things need you today");
    expect(d.text).toContain("and 2 more");
  });
  it("sends once per local day, from 7 am local", () => {
    const tz = "Australia/Sydney";
    expect(digestDay(undefined, "2026-11-19T19:00:00Z", tz)).toBeUndefined(); // 6 am in Sydney: too early
    expect(digestDay(undefined, "2026-11-19T20:30:00Z", tz)).toBe("2026-11-20"); // 7:30 am
    expect(digestDay("2026-11-20", "2026-11-20T05:00:00Z", tz)).toBeUndefined(); // already sent for that local day
    expect(digestDay("2026-11-20", "2026-11-20T20:30:00Z", tz)).toBe("2026-11-21");
  });
});

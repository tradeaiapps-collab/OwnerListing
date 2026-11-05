import { describe, expect, it } from "vitest";
import type { AgentLicence } from "../src/domain/licence";
import { evaluateAccuracy, getBuyerConversion, makeCalibrator, rankBuyers, scoreBuyer, tierFor, type BuyerFacts, type ConversionDeps } from "../src/domain/buyer-conversion";

const NOW = new Date("2026-11-05T00:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const base = (o: Partial<BuyerFacts> = {}): BuyerFacts => ({
  enquiryId: "e1", listingId: "l1", listingTitle: "Home", buyerId: "b1", buyerName: "Sam", enquiredAt: ago(3), listingPriceCents: 100_000_000,
  views: 0, saved: false, buyerMessages: 0, agentMessages: 0, viewingsRequested: 0, viewingsConfirmed: 0, viewingsCancelled: 0,
  inspectionsRequested: 0, inspectionsScheduled: 0, inspectionsCancelled: 0, offers: 0, counterRounds: 0, otherEnquiries: 0, priorOffersElsewhere: 0, lastActivityAt: ago(3), ...o
});
const firm = (o: Partial<BuyerFacts> = {}) => base({ views: 7, saved: true, buyerMessages: 4, viewingsConfirmed: 1, viewingsRequested: 1, inspectionsScheduled: 1, inspectionsRequested: 1, idVerified: true, lastActivityAt: ago(1), ...o });

describe("conversion score", () => {
  it("scores a browsing buyer low and a firm buyer high", () => {
    const cold = scoreBuyer(base({ enquiredAt: ago(20), lastActivityAt: ago(20) }), NOW);
    const hot = scoreBuyer(firm(), NOW);
    expect(cold.tier).toBe("green");
    expect(hot.tier).toBe("red");
    expect(hot.probability).toBeGreaterThan(cold.probability + 40);
    expect(hot.signals.map(s => s.label)).toEqual(expect.arrayContaining(["Building inspection scheduled", "Identity verified"]));
  });
  it("rewards a pre-approval that covers the asking price and an offer at asking, and stays within 1-98", () => {
    const covered = scoreBuyer(firm({ preApprovalCents: 110_000_000 }), NOW);
    const without = scoreBuyer(firm(), NOW);
    expect(covered.probability).toBeGreaterThan(without.probability);
    const offer = scoreBuyer(firm({ offers: 1, latestOfferStatus: "submitted", latestOfferCents: 100_000_000, preApprovalCents: 110_000_000 }), NOW);
    expect(offer.probability).toBeLessThanOrEqual(98);
    expect(scoreBuyer(base({ enquiredAt: ago(60), lastActivityAt: ago(60), otherEnquiries: 5, viewingsCancelled: 3 }), NOW).probability).toBeGreaterThanOrEqual(1);
  });
  it("counts risk signals: reschedules, negotiation, shopping around", () => {
    const clean = scoreBuyer(firm(), NOW).probability;
    expect(scoreBuyer(firm({ viewingsCancelled: 2 }), NOW).probability).toBeLessThan(clean);
    expect(scoreBuyer(firm({ otherEnquiries: 4 }), NOW).probability).toBeLessThan(scoreBuyer(firm({ otherEnquiries: 1 }), NOW).probability);
    const low = scoreBuyer(firm({ offers: 1, latestOfferStatus: "submitted", latestOfferCents: 85_000_000, counterRounds: 2 }), NOW);
    expect(low.signals.some(s => s.kind === "risk" && /under asking/.test(s.label))).toBe(true);
  });
  it("caps engagement so a very active browser is not treated as firm", () => {
    const eng = scoreBuyer(firm(), NOW).signals.filter(s => s.kind === "engagement").reduce((s, x) => s + x.points, 0);
    expect(eng).toBeLessThanOrEqual(35);
  });
  it("a lead that has gone quiet loses points", () => {
    expect(scoreBuyer(firm({ lastActivityAt: ago(40) }), NOW).probability).toBeLessThan(scoreBuyer(firm({ lastActivityAt: ago(1) }), NOW).probability);
  });
  it("tiers sit on the documented thresholds", () => {
    expect([64, 65, 34, 35].map(tierFor)).toEqual(["yellow", "red", "green", "yellow"]);
  });
  it("closed leads are flagged and need no contact", () => {
    const won = scoreBuyer(firm({ offers: 1, latestOfferStatus: "accepted", latestOfferCents: 100_000_000 }), NOW);
    expect(won).toMatchObject({ closed: true, probability: 99, followUp: { window: "none" } });
    expect(scoreBuyer(base({ stage: "lost" }), NOW).closed).toBe(true);
  });
});

describe("confidence", () => {
  it("rises with the amount of behavioural data", () => {
    expect(scoreBuyer(base({ enquiredAt: ago(0.2), lastActivityAt: ago(0.2) }), NOW).confidence).toBe("low");
    expect(scoreBuyer(base({ views: 2, buyerMessages: 1 }), NOW).confidence).toBe("medium");
    expect(scoreBuyer(firm(), NOW).confidence).toBe("high");
  });
});

describe("buyer profile", () => {
  it("separates motivated from exploring, focused from shopping, returning from new", () => {
    expect(scoreBuyer(firm(), NOW).profile).toMatchObject({ intent: "motivated", focus: "focused", experience: "new" });
    const p = scoreBuyer(base({ views: 1, otherEnquiries: 4, priorOffersElsewhere: 1 }), NOW).profile;
    expect(p).toMatchObject({ intent: "exploratory", focus: "shopping", experience: "returning", speed: "not_yet" });
  });
  it("reads speed from how soon the buyer took a firm step", () => {
    expect(scoreBuyer(firm({ enquiredAt: ago(5), lastViewingAt: ago(3) }), NOW).profile.speed).toBe("fast");
    expect(scoreBuyer(firm({ enquiredAt: ago(30), lastViewingAt: ago(5) }), NOW).profile.speed).toBe("slow");
  });
});

describe("follow-up advice", () => {
  it("answers a waiting buyer within 24 hours", () => {
    const f = scoreBuyer(base({ buyerMessages: 1, lastBuyerMessageAt: ago(1), views: 1 }), NOW).followUp;
    expect(f).toMatchObject({ window: "24h", topic: "reply", inDays: 0 });
  });
  it("talks price on an open low offer and finance on a clean one", () => {
    expect(scoreBuyer(firm({ offers: 1, latestOfferStatus: "submitted", latestOfferCents: 90_000_000, lastAgentContactAt: ago(1) }), NOW).followUp.topic).toBe("negotiate_price");
    expect(scoreBuyer(firm({ offers: 1, latestOfferStatus: "submitted", latestOfferCents: 100_000_000, lastAgentContactAt: ago(1) }), NOW).followUp.topic).toBe("confirm_financing");
  });
  it("asks how a viewing went the day after", () => {
    expect(scoreBuyer(base({ views: 2, buyerMessages: 1, agentMessages: 1, lastAgentContactAt: ago(1), lastBuyerMessageAt: ago(2), viewingsConfirmed: 1, viewingsRequested: 1, lastViewingAt: ago(1) }), NOW).followUp.topic).toBe("viewing_feedback");
  });
  it("suggests an inspection or a viewing when that step is missing", () => {
    expect(scoreBuyer(base({ views: 4, buyerMessages: 2, agentMessages: 2, lastAgentContactAt: ago(1), lastBuyerMessageAt: ago(2), viewingsConfirmed: 1, viewingsRequested: 1, preApprovalCents: 120_000_000, lastActivityAt: ago(1) }), NOW).followUp.topic).toBe("schedule_inspection");
    expect(scoreBuyer(base({ views: 4, saved: true, agentMessages: 1, lastAgentContactAt: ago(3) }), NOW).followUp.topic).toBe("book_viewing");
  });
  it("spaces contact by tier and does not chase someone just called", () => {
    const yellowNever = scoreBuyer(base({ views: 4, saved: true, buyerMessages: 1, agentMessages: 1, lastBuyerMessageAt: ago(6), lastActivityAt: ago(2) }), NOW);
    expect(yellowNever.tier).toBe("yellow");
    const recent = scoreBuyer(base({ views: 4, saved: true, buyerMessages: 1, agentMessages: 1, lastBuyerMessageAt: ago(6), lastAgentContactAt: ago(1), lastActivityAt: ago(2) }), NOW);
    expect(recent.tier).toBe("yellow");
    expect(recent.followUp.window).toBe("this_week");
    expect(recent.followUp.inDays).toBe(3);
    expect(recent.followUp.text).toMatch(/^Contact in 3 days/);
    const cold = scoreBuyer(base({ enquiredAt: ago(20), lastActivityAt: ago(20) }), NOW);
    expect(cold.followUp.window).toBe("two_weeks");
  });
  it("an overdue follow-up date pulls contact forward", () => {
    expect(scoreBuyer(base({ enquiredAt: ago(20), lastActivityAt: ago(20), followUpAt: "2026-11-01" }), NOW)).toMatchObject({ overdue: true, followUp: { window: "24h", inDays: 0 } });
  });
});

describe("ranking", () => {
  it("pins hot leads first, orders by probability, and puts closed leads last", () => {
    const r = rankBuyers([
      base({ enquiryId: "closed", stage: "lost" }),
      base({ enquiryId: "cold", enquiredAt: ago(20), lastActivityAt: ago(20) }),
      firm({ enquiryId: "hot" }),
      base({ enquiryId: "warm", views: 4, saved: true, buyerMessages: 2, lastActivityAt: ago(1) })
    ], NOW);
    expect(r.map(x => x.enquiryId)).toEqual(["hot", "warm", "cold", "closed"]);
  });
});

describe("accuracy and calibration", () => {
  it("reports Brier, hit rate and conversion by band", () => {
    const a = evaluateAccuracy([{ probability: 90, converted: true }, { probability: 80, converted: true }, { probability: 20, converted: false }, { probability: 70, converted: false }]);
    expect(a).toMatchObject({ resolved: 4, enough: false, hitRate: 75 });
    expect(a.byTier.find(t => t.tier === "red")).toEqual({ tier: "red", n: 3, conversionRate: 67 });
    expect(a.brier).toBeCloseTo((0.01 + 0.04 + 0.04 + 0.49) / 4, 3);
    expect(evaluateAccuracy([])).toMatchObject({ resolved: 0, enough: false });
  });
  it("only adjusts a band once it has enough results, and moves toward what happened", () => {
    expect(makeCalibrator([{ lo: 70, n: 10, converted: 0 }])(75)).toBe(75);
    const adj = makeCalibrator([{ lo: 70, n: 90, converted: 18 }])(75);
    expect(adj).toBeLessThan(75);
    expect(adj).toBeGreaterThan(20);
    expect(makeCalibrator([])(40)).toBe(40);
  });
});

describe("getBuyerConversion", () => {
  const licence: AgentLicence = { userId: "a1", jurisdiction: "QLD", status: "verified" };
  const mk = (facts: BuyerFacts[]) => {
    const snaps: string[] = [];
    const d = {
      licences: async () => [licence], today: () => "2026-11-05", now: () => NOW,
      facts: async () => facts, buckets: async () => [], accuracy: async () => [],
      snapshot: async (_a: string, rows: readonly { enquiryId: string }[], day: string) => { snaps.push(`${day}:${rows.length}`); }
    } as unknown as ConversionDeps;
    return { d, snaps };
  };
  it("is for verified agents only", async () => {
    const { d } = mk([]);
    expect(await getBuyerConversion(d, { userId: "b", userType: "buyer" })).toMatchObject({ ok: false, code: "forbidden" });
  });
  it("returns ranked leads, a tier summary, and saves a snapshot", async () => {
    const { d, snaps } = mk([firm({ enquiryId: "h" }), base({ enquiryId: "c", enquiredAt: ago(20), lastActivityAt: ago(20) }), base({ enquiryId: "x", stage: "won" })]);
    const r = await getBuyerConversion(d, { userId: "a1", userType: "agent" });
    expect(r.ok && r.value.summary).toEqual({ red: 1, yellow: 0, green: 1, closed: 1 });
    expect(r.ok && r.value.leads[0]?.enquiryId).toBe("h");
    expect(snaps).toEqual(["2026-11-05:3"]);
  });
});

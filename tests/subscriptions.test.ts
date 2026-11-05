import { describe, expect, it } from "vitest";
import { createSubscriptionInvoice } from "../src/domain/billing";
import { ALL_PLAN_IDS, DEFAULT_PLANS, SUBSCRIPTION_PLANS, periodPriceCents, withinListingLimit } from "../src/domain/plans";
import {
  GRACE_DAYS, RENEWAL_LEAD_DAYS, addMonths, afterPeriodPaid, isEntitled, periodQuote, planAllowedFor, subscriptionAction, type SubscriptionRow
} from "../src/domain/subscriptions";

const day = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString();
const NOW = "2026-11-10T00:00:00.000Z";
const sub = (o: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  id: "s1", ownerUserId: "u1", planId: "agent_pro", interval: "monthly", status: "active", startsAt: "2026-10-10T00:00:00.000Z",
  endsAt: "2026-11-10T00:00:00.000Z", cancelAtPeriodEnd: false, priceSnapshotCents: 10_000, ...o
});

describe("subscription plans", () => {
  it("ships unpriced so an admin must set every price, and ids do not clash with listing packages", () => {
    expect(SUBSCRIPTION_PLANS.every(p => p.priceCents === null)).toBe(true);
    expect(new Set(ALL_PLAN_IDS).size).toBe(DEFAULT_PLANS.length + SUBSCRIPTION_PLANS.length);
  });
  it("lets owners buy owner plans and agents buy agent plans only", () => {
    expect(planAllowedFor("owner", "owner_plus")).toBe(true);
    expect(planAllowedFor("agent", "owner_plus")).toBe(false);
    expect(planAllowedFor("agent", "agent_team")).toBe(true);
    expect(planAllowedFor("buyer", "agent_pro")).toBe(false);
    expect(planAllowedFor("owner", "premium")).toBe(false);
  });
  it("prices a period from the admin's monthly price, yearly being 10 months, and refuses an unpriced plan", () => {
    expect(periodPriceCents(9_900, "monthly")).toBe(9_900);
    expect(periodPriceCents(9_900, "yearly")).toBe(99_000);
    expect(periodQuote("agent_pro", "yearly", { agent_pro: 10_000 })).toBe(100_000);
    expect(periodQuote("agent_pro", "monthly", {})).toBeNull();
    expect(periodQuote("nope", "monthly", { nope: 1 })).toBeNull();
  });
  it("applies listing limits, with null meaning unlimited", () => {
    expect(withinListingLimit({ maxActiveListings: 3 }, 2)).toBe(true);
    expect(withinListingLimit({ maxActiveListings: 3 }, 3)).toBe(false);
    expect(withinListingLimit({ maxActiveListings: null }, 10_000)).toBe(true);
  });
});

describe("dates", () => {
  it("adds calendar months and keeps month ends sensible", () => {
    expect(addMonths("2026-01-31T00:00:00.000Z", 1)).toBe("2026-02-28T00:00:00.000Z");
    expect(addMonths("2028-01-31T00:00:00.000Z", 1)).toBe("2028-02-29T00:00:00.000Z");
    expect(addMonths("2026-12-15T00:00:00.000Z", 1)).toBe("2027-01-15T00:00:00.000Z");
    expect(addMonths("2026-11-10T00:00:00.000Z", 12)).toBe("2027-11-10T00:00:00.000Z");
  });
});

describe("paying a period", () => {
  it("starts a pending plan at the payment time", () => {
    const next = afterPeriodPaid(sub({ status: "pending", endsAt: NOW, startsAt: NOW }), NOW);
    expect(next).toMatchObject({ status: "active", startsAt: NOW, endsAt: "2026-12-10T00:00:00.000Z" });
  });
  it("continues from the old end when a renewal is paid early, so no days are lost", () => {
    const next = afterPeriodPaid(sub(), day(NOW, -5));
    expect(next?.endsAt).toBe("2026-12-10T00:00:00.000Z");
  });
  it("restarts from the payment time when paid late, and reactivates a past-due plan", () => {
    const next = afterPeriodPaid(sub({ status: "past_due" }), day(NOW, 3));
    expect(next).toMatchObject({ status: "active", endsAt: "2026-12-13T00:00:00.000Z" });
  });
  it("adds a year for yearly plans", () => {
    expect(afterPeriodPaid(sub({ interval: "yearly" }), NOW)?.endsAt).toBe("2027-11-10T00:00:00.000Z");
  });
  it("never brings an expired or cancelled plan back", () => {
    expect(afterPeriodPaid(sub({ status: "expired" }), NOW)).toBeNull();
    expect(afterPeriodPaid(sub({ status: "cancelled" }), NOW)).toBeNull();
  });
});

describe("what the daily run does", () => {
  it("issues one renewal invoice inside the lead window and not before", () => {
    const s = sub({ endsAt: day(NOW, RENEWAL_LEAD_DAYS) });
    expect(subscriptionAction(s, NOW, false)).toBe("issue_renewal_invoice");
    expect(subscriptionAction(s, NOW, true)).toBe("none");
    expect(subscriptionAction(sub({ endsAt: day(NOW, RENEWAL_LEAD_DAYS + 1) }), NOW, false)).toBe("none");
  });
  it("moves an unpaid plan to past due when the period ends, then expires it after the grace days", () => {
    expect(subscriptionAction(sub({ endsAt: day(NOW, -1) }), NOW, true)).toBe("mark_past_due");
    expect(subscriptionAction(sub({ status: "past_due", endsAt: day(NOW, -1) }), NOW, true)).toBe("none");
    expect(subscriptionAction(sub({ status: "past_due", endsAt: day(NOW, -1) }), NOW, false)).toBe("issue_renewal_invoice");
    expect(subscriptionAction(sub({ status: "past_due", endsAt: day(NOW, -GRACE_DAYS) }), NOW, true)).toBe("expire");
  });
  it("ends a plan set to cancel when its period ends and never invoices it", () => {
    expect(subscriptionAction(sub({ cancelAtPeriodEnd: true, endsAt: day(NOW, 3) }), NOW, false)).toBe("none");
    expect(subscriptionAction(sub({ cancelAtPeriodEnd: true, endsAt: day(NOW, -1) }), NOW, false)).toBe("end_cancelled");
  });
  it("ignores plans that are not live", () => {
    for (const status of ["pending", "expired", "cancelled"] as const) expect(subscriptionAction(sub({ status, endsAt: day(NOW, -30) }), NOW, false)).toBe("none");
  });
  it("gives features while active or inside the grace period only", () => {
    expect(isEntitled(sub({ endsAt: day(NOW, 5) }), NOW)).toBe(true);
    expect(isEntitled(sub({ status: "past_due", endsAt: day(NOW, -2) }), NOW)).toBe(true);
    expect(isEntitled(sub({ status: "past_due", endsAt: day(NOW, -GRACE_DAYS - 1) }), NOW)).toBe(false);
    expect(isEntitled(sub({ status: "pending" }), NOW)).toBe(false);
    expect(isEntitled(undefined, NOW)).toBe(false);
  });
});

describe("subscription invoices", () => {
  it("add GST on top of the period price and link to the subscription", () => {
    const i = createSubscriptionInvoice("i1", "u1", "s1", "agent_pro", 10_000, "Agent Pro plan", NOW);
    expect(i).toMatchObject({ amountExGstCents: 10_000, gstCents: 1_000, totalCents: 11_000, kind: "subscription", subscriptionId: "s1", status: "pending" });
  });
});

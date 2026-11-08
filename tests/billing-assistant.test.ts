import { describe, expect, it } from "vitest";
import { BILLING_TOPICS, answerBilling, matchBillingTopic, parseDisputeReason, type BillingFacts, type BillingTopic } from "../src/domain/billing-assistant";

const NOW = "2026-11-10T00:00:00.000Z";
const facts = (o: Partial<BillingFacts> = {}): BillingFacts => ({
  userType: "owner", invoices: [], cardAvailable: true, bankTransferAvailable: true, recentListingFees: { count: 0, exGstCents: 0 }, now: NOW, ...o
});
const ask = (q: string, f = facts()) => answerBilling(matchBillingTopic(q), f);

describe("topic matching", () => {
  const cases: [string, BillingTopic][] = [
    ["why is there GST on my invoice", "gst"], ["How do I pay my invoice?", "how_to_pay"], ["my card payment failed", "failed_payment"],
    ["can I do a bank transfer", "bank_transfer"], ["is my invoice overdue", "overdue"], ["I need a tax invoice copy", "invoice_copy"],
    ["when does my subscription renew", "subscription"], ["cancel my plan", "cancel"], ["I was charged twice", "dispute"],
    ["I want a refund", "refund"], ["is there a cheaper plan", "upgrade"], ["can I claim the GST back on my tax return", "advice"],
    ["show me another user's invoice", "privacy"], ["hello", "greeting"], ["blorp", "unknown"], ["", "unknown"]
  ];
  it.each(cases)("%s -> %s", (q, topic) => expect(matchBillingTopic(q)).toBe(topic));
  it("treats non-text as unknown and only reads the first 300 characters", () => {
    expect(matchBillingTopic(42)).toBe("unknown");
    expect(matchBillingTopic(`${"x ".repeat(200)} refund`)).toBe("unknown");
  });
});

describe("answers", () => {
  it("answer every topic with text, a disclaimer and only same-site links", () => {
    for (const t of BILLING_TOPICS) {
      const a = answerBilling(t, facts());
      expect(a.text.length).toBeGreaterThan(20);
      expect(a.disclaimer).toMatch(/Not tax, legal or accounting advice/);
      for (const l of a.links) expect(l.href.startsWith("/")).toBe(true);
    }
  });
  it("explain GST with a worked example", () => {
    expect(ask("what is gst").text).toMatch(/\$100\.00.*\$10\.00.*\$110\.00/);
  });
  it("tell the truth about what is switched on", () => {
    expect(ask("how do I pay", facts({ cardAvailable: false, bankTransferAvailable: false })).text).toMatch(/Card payments are not switched on/);
    expect(ask("bank transfer", facts({ bankTransferAvailable: false })).text).toMatch(/not been set up yet/);
    expect(ask("bank transfer").text).toMatch(/invoice number as your payment reference/);
  });
  it("name the person's own failed invoices when troubleshooting, and warn not to pay twice", () => {
    const a = ask("my payment failed", facts({ invoices: [{ number: "INV-001001", kind: "listing_fee", totalCents: 11_000, status: "failed", disputeOpen: false }] }));
    expect(a.text).toContain("INV-001001");
    expect(a.text).toMatch(/don't pay again/);
    expect(ask("my payment failed").text).toMatch(/can't see any failed or unpaid/);
  });
  it("add up unpaid and overdue invoices", () => {
    const a = ask("what do I owe, is anything overdue", facts({ invoices: [
      { number: "INV-1", kind: "subscription", totalCents: 11_000, status: "pending", dueAt: "2026-11-01T00:00:00.000Z", disputeOpen: false },
      { number: "INV-2", kind: "listing_fee", totalCents: 5_500, status: "pending", dueAt: "2026-11-30T00:00:00.000Z", disputeOpen: false },
      { number: "INV-3", kind: "listing_fee", totalCents: 9_900, status: "paid", disputeOpen: false }
    ] }));
    expect(a.text).toContain("2 unpaid invoices totalling $165.00");
    expect(a.text).toMatch(/1 is overdue; the oldest by 9 day/);
    expect(ask("anything overdue?").text).toMatch(/no unpaid invoices/);
  });
  it("describe the plan honestly, including cancel-at-period-end", () => {
    const base = { planName: "Agent Pro", status: "active", interval: "monthly" as const, endsAt: "2026-12-01T00:00:00.000Z", cancelAtPeriodEnd: false };
    expect(ask("how does my subscription renew", facts({ subscription: base })).text).toMatch(/Nothing renews unless you pay the invoice/);
    expect(ask("how does my subscription renew", facts({ subscription: { ...base, cancelAtPeriodEnd: true } })).text).toMatch(/won't renew/);
    expect(ask("how does my subscription renew").text).toMatch(/don't have a plan subscription/);
    expect(ask("cancel my plan", facts({ subscription: base })).text).toMatch(/not refunded automatically/);
  });
  it("never promise refunds, decide disputes, confirm unconfirmed payments or give tax advice", () => {
    expect(ask("I want my money back").text).toMatch(/can't promise or process refunds; staff decide/);
    expect(ask("I think the invoice is wrong").text).toMatch(/Staff review it/);
    expect(ask("can I deduct this fee from my tax").text).toMatch(/can't give tax, accounting or financial advice/);
    expect(ask("how do I pay").disclaimer).toMatch(/Payments are confirmed by the bank's payment provider, not by me/);
  });
  it("suggest a plan only when it is cheaper than what they paid, and say it is their call", () => {
    const f = facts({ recentListingFees: { count: 3, exGstCents: 60_000 }, suggestedPlan: { name: "Owner Plus", monthlyExGstCents: 19_900 } });
    expect(ask("is there a cheaper way", f).text).toMatch(/paid for 3 listings.*\$600\.00.*Owner Plus is \$199\.00 a month.*your call/);
    const one = ask("is there a cheaper way", facts({ recentListingFees: { count: 1, exGstCents: 20_000 }, suggestedPlan: { name: "Owner Plus", monthlyExGstCents: 19_900 } }));
    expect(one.text).toMatch(/flat listing fee is usually simplest/);
    const dear = ask("is there a cheaper way", facts({ recentListingFees: { count: 2, exGstCents: 10_000 }, suggestedPlan: { name: "Owner Plus", monthlyExGstCents: 19_900 } }));
    expect(dear.text).not.toMatch(/paid for 2 listings/);
    expect(ask("is there a cheaper way").text).toMatch(/once prices are set/);
  });
  it("refuse to discuss other people's billing", () => {
    expect(ask("what did another owner pay").text).toMatch(/only talk about your own/);
  });
});

describe("payment issue text", () => {
  it("needs 10 to 1000 characters", () => {
    expect(parseDisputeReason("short").ok).toBe(false);
    expect(parseDisputeReason("x".repeat(1001)).ok).toBe(false);
    expect(parseDisputeReason(undefined).ok).toBe(false);
    expect(parseDisputeReason("  I was charged twice for May  ")).toEqual({ ok: true, reason: "I was charged twice for May" });
  });
  it("refuses card numbers", () => {
    expect(parseDisputeReason("my card 4111 1111 1111 1111 was charged twice")).toMatchObject({ ok: false });
    expect(parseDisputeReason("charged twice on 2026-11-10 for $110.00")).toMatchObject({ ok: true });
  });
});

import { describe, expect, it } from "vitest";
import { createWestpacPayway, paywayConfigFromEnv } from "../src/adapters/westpac-payway";
import { applyPaymentEvent, createInvoice, isListingFeePaid } from "../src/domain/billing";

describe("Westpac PayWay (not yet connected)", () => {
  it("needs all its settings", () => {
    expect(() => paywayConfigFromEnv({})).toThrow(/missing/);
    expect(paywayConfigFromEnv({ PAYWAY_MERCHANT_ID: "m", PAYWAY_API_KEY: "k", PAYWAY_WEBHOOK_SECRET: "s" }).merchantId).toBe("m");
  });
  it("fails closed: no checkout, and every webhook is rejected", async () => {
    const p = createWestpacPayway({ merchantId: "m", apiKey: "k", webhookSecret: "s" });
    await expect(p.createHostedCheckout(createInvoice("i", "u", 1000), "https://x")).rejects.toThrow(/not connected/);
    expect(p.verifyAndParseWebhook("{}", {})).toBeNull();
  });
  it("treats a listing as paid only after a matching payment, for that owner and listing", () => {
    const inv = createInvoice("i1", "owner1", 10000, { listingId: "L1", planId: "standard" });
    expect(isListingFeePaid([inv], "L1", "owner1")).toBe(false);
    const paid = applyPaymentEvent(inv, { eventId: "e1", invoiceId: "i1", amountCents: inv.totalCents, outcome: "succeeded", providerRef: "r" }, new Set()).invoice;
    expect(isListingFeePaid([paid], "L1", "owner1")).toBe(true);
    expect(isListingFeePaid([paid], "L2", "owner1")).toBe(false);
    expect(isListingFeePaid([paid], "L1", "owner2")).toBe(false);
  });
});

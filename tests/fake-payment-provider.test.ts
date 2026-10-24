import { describe, expect, it } from "vitest";
import { createFakePaymentProvider } from "../src/adapters/fake-payment-provider";
import { createInvoice } from "../src/domain/billing";

const body = JSON.stringify({ eventId: "e1", invoiceId: "i1", amountCents: 1100, outcome: "succeeded", providerRef: "r1" });

describe("fake payment provider (tests only)", () => {
  const p = createFakePaymentProvider("secret", { NODE_ENV: "test" });

  it("is refused in production and without a secret", () => {
    expect(() => createFakePaymentProvider("secret", { NODE_ENV: "production" })).toThrow(/production/);
    expect(() => createFakePaymentProvider("", { NODE_ENV: "test" })).toThrow(/secret/);
  });
  it("returns a hosted checkout link and never asks for card details", async () => {
    const r = await p.createHostedCheckout(createInvoice("i1", "u1", 1000), "https://x");
    expect(r.redirectUrl).toContain("/checkout/i1");
  });
  it("accepts a correctly signed webhook", () => {
    expect(p.verifyAndParseWebhook(body, p.sign(body))?.eventId).toBe("e1");
  });
  it("rejects unsigned, wrongly signed and tampered webhooks", () => {
    expect(p.verifyAndParseWebhook(body, {})).toBeNull();
    expect(p.verifyAndParseWebhook(body, { "x-payway-signature": "0".repeat(64) })).toBeNull();
    expect(p.verifyAndParseWebhook(body.replace("1100", "1"), p.sign(body))).toBeNull();
    const other = createFakePaymentProvider("different", { NODE_ENV: "test" });
    expect(p.verifyAndParseWebhook(body, other.sign(body))).toBeNull();
  });
});

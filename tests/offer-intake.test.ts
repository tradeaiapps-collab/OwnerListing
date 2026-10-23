import { describe, expect, it } from "vitest";
import {
  buildOfferPrompt, createOfferLink, hashToken, looksLikeOffer, shouldSendOfferPrompt,
  toOfferContext, validateFormalOffer, validateOfferLink, type FormalOffer
} from "../src/domain/offer-intake";

const verified = { emailVerified: true, phoneVerified: true, idVerified: true };
const now = "2026-10-23T00:00:00.000Z";

describe("offer detection and prompt", () => {
  it("spots offers in chat and ignores ordinary messages", () => {
    expect(looksLikeOffer("I would like to offer $1,150,000")).toBe(true);
    expect(looksLikeOffer("Would you take $1.1m?")).toBe(true);
    expect(looksLikeOffer("What time is the inspection?")).toBe(false);
    expect(looksLikeOffer("The land is 600sqm")).toBe(false);
  });
  it("prompts only for buyer messages, and not repeatedly", () => {
    const m = { senderRole: "buyer" as const, text: "I offer $900,000" };
    expect(shouldSendOfferPrompt(m, verified, undefined, now).send).toBe(true);
    expect(shouldSendOfferPrompt({ ...m, senderRole: "owner" }, verified, undefined, now).send).toBe(false);
    expect(shouldSendOfferPrompt(m, verified, "2026-10-22T23:30:00.000Z", now).send).toBe(false);
    expect(shouldSendOfferPrompt(m, { ...verified, idVerified: false }, undefined, now).send).toBe(false);
  });
  it("tells the buyer an offer in chat is not formal", () => {
    expect(buildOfferPrompt("https://x/o/1")).toContain("not formal offers");
    expect(buildOfferPrompt("https://x/o/1")).toContain("https://x/o/1");
  });
});

describe("offer link and form", () => {
  it("creates a one-time, expiring, buyer-bound link and stores only a hash", async () => {
    const { token, record } = await createOfferLink("l1", "b1", now);
    expect(record.tokenHash).toBe(await hashToken(token));
    expect(record.tokenHash).not.toContain(token);
    expect(validateOfferLink(record, "b1", "l1", now)).toEqual([]);
    expect(validateOfferLink(record, "b2", "l1", now).length).toBe(1);
    expect(validateOfferLink({ ...record, usedAt: now }, "b1", "l1", now).length).toBe(1);
    expect(validateOfferLink(record, "b1", "l1", "2026-10-25T00:00:00.000Z").length).toBe(1);
  });
  const offer: FormalOffer = { listingId: "l1", buyerUserId: "b1", priceCents: 120000000, conditions: ["finance_14_days"], settlementDays: 30, depositCents: 12000000, confirmedFinal: true, submittedAt: now };
  it("validates the form and maps it to the offer rules", () => {
    expect(validateFormalOffer(offer)).toEqual([]);
    expect(validateFormalOffer({ ...offer, confirmedFinal: false }).length).toBe(1);
    expect(validateFormalOffer({ ...offer, depositCents: offer.priceCents + 1 }).length).toBe(1);
    expect(validateFormalOffer({ ...offer, priceCents: 0, settlementDays: 0 }).length).toBe(3);
    expect(toOfferContext(offer, "off-1").priceCents).toBe(120000000);
  });
});

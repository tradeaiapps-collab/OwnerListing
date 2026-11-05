import { describe, expect, it } from "vitest";
import * as local from "../../src/domain/chat-assistant";
import * as svc from "../src/engine.ts";
import { answerChat } from "../src/chat.ts";
import { parseChatRequest } from "../src/schema.ts";

// Regression: the extracted engine must answer exactly like the one OwnerListing runs today.
const base = { title: "Banksia home", address: "14 Banksia St, Paddington QLD", transactionType: "sale" as const, propertyType: "house", askingCents: 115_000_000, bedrooms: 4, bathrooms: 2, parking: 2, verifiedDisclosures: 2 };
const terms = { priceCents: 108_000_000, depositCents: 10_800_000, settlementDays: 30, conditions: ["Subject to finance", "Subject to building and pest inspection"] };
const FACTS: local.ChatFacts[] = [
  { listing: base },
  { listing: { ...base, askingCents: undefined, bedrooms: undefined, verifiedDisclosures: 0 } },
  { listing: { ...base, transactionType: "rent", askingCents: 65_000 }, offer: { ...terms, priceCents: 60_000, depositCents: 120_000, conditions: [], status: "submitted" } },
  ...["submitted", "under_review", "countered", "buyer_countered", "accepted", "rejected", "withdrawn", "expired"].map(status => ({ listing: base, offer: { ...terms, status } })),
  { listing: base, offer: { ...terms, status: "countered", counter: { ...terms, fromParty: "owner" as const, priceCents: 112_000_000, settlementDays: 45, status: "open" } } },
  { listing: base, offer: { ...terms, status: "buyer_countered", counter: { ...terms, fromParty: "buyer" as const, priceCents: 110_000_000, status: "open" } } },
  { listing: base, offer: { ...terms, priceCents: 120_000_000, status: "submitted" } }
];
const QUESTIONS = [
  "How could we close the gap?", "Can we meet in the middle?", "Where do things stand with the offer?", "What does settlement mean?",
  "Where does the deposit go?", "What does subject to finance mean?", "How many bedrooms does it have?", "What happens next?",
  "What's the lowest price the owner will accept?", "What is the owner's phone number?", "Should I accept this offer?", "Is it a good deal?",
  "banana", "", "Tell me about the home", "We're stuck, any options?", "how long to settle and what about the deposit"
];
const ROLES: local.ChatRole[] = ["buyer", "owner", "agent"];

describe("extracted engine matches OwnerListing's chat-assistant", () => {
  it("gives identical answers for every question, role and fact set", () => {
    let n = 0;
    for (const f of FACTS) for (const r of ROLES) for (const q of QUESTIONS) {
      expect(svc.chatAnswer(f, r, q)).toEqual(local.chatAnswer(f, r, q));
      expect(svc.showMeFor(local.chatAnswer(f, r, q).topic, r, f)).toEqual(local.showMeFor(local.chatAnswer(f, r, q).topic, r, f));
      n++;
    }
    for (const f of FACTS) expect(svc.chatWelcome(f, "Elena")).toEqual(local.chatWelcome(f, "Elena"));
    expect(n).toBeGreaterThan(500);
  });
  it("produces the same text through the HTTP request shape", () => {
    const body = {
      user_role: "seller", question: "How could we close the gap?",
      listing_context: { title: base.title, address: base.address, transaction_type: "sale", property_type: "house", asking_cents: base.askingCents, bedrooms: 4, bathrooms: 2, parking: 2, verified_disclosures: 2 },
      offer_context: { price_cents: terms.priceCents, deposit_cents: terms.depositCents, settlement_days: 30, conditions: terms.conditions, status: "submitted" }
    };
    expect(answerChat(parseChatRequest(body)).text).toBe(local.chatAnswer({ listing: base, offer: { ...terms, status: "submitted" } }, "owner", body.question).text);
  });
});

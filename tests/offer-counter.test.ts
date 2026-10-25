import { describe, expect, it } from "vitest";
import { awaiting, counterExpiry, parseAgree, parseCounterInput, sameTerms } from "../src/domain/offer-counter";
import { nextStatus } from "../src/domain/offer-decision";

describe("offer-counter rules", () => {
  it("knows whose turn it is", () => {
    expect(["submitted", "under_review", "buyer_countered"].map(awaiting)).toEqual(["owner", "owner", "owner"]);
    expect(awaiting("countered")).toBe("buyer");
    expect(["accepted", "rejected", "withdrawn", "expired"].map(awaiting)).toEqual([null, null, null, null]);
  });
  it("parses counter terms with a default reply time of 3 days", () => {
    const r = parseCounterInput({ priceCents: 100, depositCents: 10, settlementDays: 30, conditions: [" Finance "] });
    expect(r).toEqual({ ok: true, value: { priceCents: 100, depositCents: 10, settlementDays: 30, conditions: ["Finance"], expiresInDays: 3 } });
    expect(parseCounterInput(null).ok).toBe(false);
    expect(parseCounterInput({ priceCents: 100, depositCents: 10, settlementDays: 30, conditions: [""] }).ok).toBe(false);
    expect(parseCounterInput({ priceCents: 100, depositCents: 10, settlementDays: 30, expiresInDays: 0 }).ok).toBe(false);
    expect(parseCounterInput({ priceCents: 1.5, depositCents: 0, settlementDays: 30 }).ok).toBe(false);
  });
  it("computes expiry and compares terms", () => {
    expect(counterExpiry("2026-10-25T00:00:00.000Z", 3)).toBe("2026-10-28T00:00:00.000Z");
    const a = { priceCents: 1, depositCents: 0, settlementDays: 30, conditions: ["x"] };
    expect(sameTerms(a, { ...a })).toBe(true);
    expect(sameTerms(a, { ...a, conditions: ["y"] })).toBe(false);
    expect(parseAgree({ counterId: "c" })).toBe("c");
    expect(parseAgree({})).toBeUndefined();
  });
  it("lets the owner accept or reject after a buyer counter, but not request another counter", () => {
    expect(nextStatus("buyer_countered", "accept")).toBe("accepted");
    expect(nextStatus("buyer_countered", "reject")).toBe("rejected");
    expect(nextStatus("buyer_countered", "counter_request")).toBeUndefined();
    expect(nextStatus("expired", "accept")).toBeUndefined();
  });
});

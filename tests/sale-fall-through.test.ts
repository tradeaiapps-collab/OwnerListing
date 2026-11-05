import { describe, expect, it } from "vitest";
import {
  allPaid, businessDaysAfter, nextPayout, parseFallThrough, parseResolution, partyMayRaise, planRespond, planWithdraw, proposeOutcome, reasonsFor, RULES_CONFIRMED,
  type OutcomeInput
} from "../src/domain/sale-fall-through";

// 2026-11-02 is a Monday.
const base: OutcomeInput = { reason: "cooling_off", party: "buyer", state: "NSW", priceCents: 80_000_000, heldCents: 4_000_000, acceptedOn: "2026-11-02", raisedOn: "2026-11-04" };
const out = (o: Partial<OutcomeInput>) => proposeOutcome({ ...base, ...o });
const value = (o: Partial<OutcomeInput>) => { const r = out(o); if (!r.ok) throw new Error(r.error); return r.value; };

describe("business days", () => {
  it("counts weekdays after the contract day, up to the day it is raised", () => {
    expect(businessDaysAfter("2026-11-02", "2026-11-02")).toBe(0);
    expect(businessDaysAfter("2026-11-02", "2026-11-04")).toBe(2);
    expect(businessDaysAfter("2026-11-06", "2026-11-09")).toBe(1); // Fri to Mon: the weekend does not count
    expect(businessDaysAfter("2026-11-09", "2026-11-02")).toBe(0);
  });
});

describe("state rules for cooling-off", () => {
  it("QLD, NSW and ACT: 5 business days, 0.25% of the price is kept by the seller, the rest refunded", () => {
    for (const state of ["QLD", "NSW", "ACT"]) {
      const v = value({ state });
      expect(v).toMatchObject({ penaltyCents: 200_000, releaseCents: 200_000, refundCents: 3_800_000, penaltyUnconfirmed: false });
    }
  });
  it("is marked as not confirmed by counsel", () => {
    expect(RULES_CONFIRMED).toBe(false);
    expect(value({}).rulesConfirmed).toBe(false);
  });
  it("VIC: 3 business days, 0.2% or $100 whichever is greater", () => {
    expect(value({ state: "VIC" })).toMatchObject({ penaltyCents: 160_000, refundCents: 3_840_000 });
    expect(value({ state: "VIC", priceCents: 2_000_000, heldCents: 100_000 })).toMatchObject({ penaltyCents: 10_000, refundCents: 90_000 });
    expect(out({ state: "VIC", raisedOn: "2026-11-06" })).toMatchObject({ ok: false }); // 4th business day
    expect(out({ state: "VIC", raisedOn: "2026-11-05" }).ok).toBe(true); // 3rd
  });
  it("never takes more than is held", () => {
    expect(value({ heldCents: 50_000 })).toMatchObject({ penaltyCents: 50_000, refundCents: 0, releaseCents: 50_000 });
  });
  it("SA 2 days and NT 4 days: the penalty is not known yet, so none is taken and the estimate says so", () => {
    expect(value({ state: "SA" })).toMatchObject({ penaltyCents: 0, refundCents: 4_000_000, penaltyUnconfirmed: true });
    expect(out({ state: "SA", raisedOn: "2026-11-05" })).toMatchObject({ ok: false });
    expect(out({ state: "NT", raisedOn: "2026-11-06" }).ok).toBe(true);
    expect(out({ state: "NT", raisedOn: "2026-11-09" })).toMatchObject({ ok: false });
  });
  it("WA and TAS have no cooling-off right; an unknown state is refused", () => {
    expect(out({ state: "WA" })).toMatchObject({ ok: false, error: expect.stringContaining("no statutory cooling-off") });
    expect(out({ state: "TAS" })).toMatchObject({ ok: false });
    expect(out({ state: "" })).toMatchObject({ ok: false });
  });
  it("is refused after the period has ended, saying by how much", () => {
    const r = out({ raisedOn: "2026-11-10" }); // 6 business days
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("ended 1 business day ago") });
  });
});

describe("other reasons", () => {
  it("a condition not met, a seller default and a mutual end refund the whole deposit", () => {
    for (const reason of ["finance_condition", "building_pest_condition", "other_condition", "seller_default", "mutual_termination"] as const) {
      expect(value({ reason, state: "WA", raisedOn: "2027-03-01" })).toMatchObject({ refundCents: 4_000_000, releaseCents: 0, penaltyCents: 0 });
    }
  });
  it("a buyer default lets the seller keep the whole deposit", () => {
    expect(value({ reason: "buyer_default", party: "owner" })).toMatchObject({ refundCents: 0, releaseCents: 4_000_000 });
  });
  it("only the right side may raise a reason", () => {
    expect(partyMayRaise("owner", "cooling_off")).toBe(false);
    expect(partyMayRaise("owner", "seller_default")).toBe(false);
    expect(partyMayRaise("buyer", "buyer_default")).toBe(false);
    expect(out({ reason: "buyer_default", party: "buyer" })).toMatchObject({ ok: false });
    expect(reasonsFor("owner")).toEqual(["finance_condition", "building_pest_condition", "other_condition", "buyer_default", "mutual_termination"]);
    expect(reasonsFor("buyer")).toContain("cooling_off");
  });
  it("nothing held means nothing to refund", () => {
    expect(value({ heldCents: 0 })).toMatchObject({ refundCents: 0, releaseCents: 0, penaltyCents: 0 });
  });
});

describe("answers and payouts", () => {
  it("only the other side answers, only while proposed; only the raiser withdraws", () => {
    expect(planRespond({ status: "proposed", raisedByParty: "buyer" }, "owner")).toEqual({ allow: true });
    expect(planRespond({ status: "proposed", raisedByParty: "buyer" }, "buyer")).toMatchObject({ allow: false, status: 403 });
    expect(planRespond({ status: "disputed", raisedByParty: "buyer" }, "owner")).toMatchObject({ allow: false, status: 409 });
    expect(planWithdraw({ status: "proposed", raisedByParty: "buyer" }, "buyer")).toEqual({ allow: true });
    expect(planWithdraw({ status: "proposed", raisedByParty: "buyer" }, "owner")).toMatchObject({ allow: false, status: 403 });
    expect(planWithdraw({ status: "disputed", raisedByParty: "buyer" }, "buyer")).toMatchObject({ allow: false, status: 409 });
  });
  it("parses the actions, and a dispute needs a reason", () => {
    expect(parseFallThrough({ action: "raise", reason: "cooling_off", note: " hi " })).toEqual({ ok: true, value: { action: "raise", reason: "cooling_off", note: "hi" } });
    expect(parseFallThrough({ action: "raise", reason: "nope" }).ok).toBe(false);
    expect(parseFallThrough({ action: "respond", decision: "dispute", note: "short" }).ok).toBe(false);
    expect(parseFallThrough({ action: "respond", decision: "dispute", note: "The condition was waived in writing" }).ok).toBe(true);
    expect(parseFallThrough({ action: "respond", decision: "agree" }).ok).toBe(true);
    expect(parseFallThrough(null).ok).toBe(false);
  });
  it("staff resolutions: a court order needs a reference and the amounts cannot exceed what is held", () => {
    const body = { source: "court_order", reference: "NSWSC 123", refundCents: 1_000_000, releaseCents: 3_000_000, reason: "Order made on 4 Nov" };
    expect(parseResolution(body, 4_000_000).ok).toBe(true);
    expect(parseResolution({ ...body, reference: "" }, 4_000_000).ok).toBe(false);
    expect(parseResolution({ ...body, releaseCents: 3_000_001 }, 4_000_000).ok).toBe(false);
    expect(parseResolution({ ...body, reason: "short" }, 4_000_000).ok).toBe(false);
    expect(parseResolution({ source: "sale_continues", reason: "Parties settled their dispute" }, 0)).toMatchObject({ ok: true, value: { refundCents: 0, releaseCents: 0 } });
  });
  it("asks for the refund first, then the release, and finishes when both are approved", () => {
    const c = { status: "agreed" as const, raisedByParty: "buyer" as const, refundCents: 3_800_000, releaseCents: 200_000 };
    expect(nextPayout(c, [])).toEqual({ kind: "refund", amountCents: 3_800_000 });
    expect(nextPayout(c, [{ kind: "refund", status: "pending" }])).toEqual({ kind: "release", amountCents: 200_000 });
    expect(nextPayout(c, [{ kind: "refund", status: "rejected" }])).toEqual({ kind: "refund", amountCents: 3_800_000 });
    expect(nextPayout(c, [{ kind: "refund", status: "approved" }, { kind: "release", status: "pending" }])).toBeNull();
    expect(allPaid(c, [{ kind: "refund", status: "approved" }])).toBe(false);
    expect(allPaid(c, [{ kind: "refund", status: "approved" }, { kind: "release", status: "approved" }])).toBe(true);
    expect(allPaid({ ...c, releaseCents: 0 }, [{ kind: "refund", status: "approved" }])).toBe(true);
  });
});

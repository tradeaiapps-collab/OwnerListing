import { describe, expect, it } from "vitest";
import { trustAccountDecisionPg, type Queryable } from "../src/server/db";
import { decidePublish } from "../src/domain/publish";
import type { PropertyListing } from "../src/domain/listing";

// Regression (found by scripts/smoke.mjs): the app never passed trustAccountFor to the publish gate, so an approved trust account
// could never allow a publish. This pins the lookup: only the latest check, approved, with details a person last approved.
const LID = "11111111-1111-4111-8111-111111111111";
const dbReturning = (row?: Record<string, unknown>): Queryable => ({ query: async () => ({ rows: row ? [row] : [] }) });

describe("trustAccountDecisionPg", () => {
  it("returns approved only for an approved latest check with current human-approved details", async () => {
    expect(await trustAccountDecisionPg(dbReturning({ decision: "approved", reasons: ["ok"], current: true }), LID)).toEqual({ kind: "approved", reasons: ["ok"] });
  });
  it("does not approve when the account details changed since a person approved them", async () => {
    const r = await trustAccountDecisionPg(dbReturning({ decision: "approved", reasons: [], current: false }), LID);
    expect(r?.kind).toBe("awaiting_human_approval");
  });
  it("passes through non-approved decisions", async () => {
    expect((await trustAccountDecisionPg(dbReturning({ decision: "rejected", reasons: ["bad"], current: true }), LID))?.kind).toBe("rejected");
  });
  it("fails closed with no check, an unknown decision or a bad id", async () => {
    expect(await trustAccountDecisionPg(dbReturning(), LID)).toBeUndefined();
    expect(await trustAccountDecisionPg(dbReturning({ decision: "bogus", reasons: [], current: true }), LID)).toBeUndefined();
    expect(await trustAccountDecisionPg(dbReturning({ decision: "approved", reasons: [], current: true }), "not-a-uuid")).toBeUndefined();
  });
  it("an approved result clears only the trust-account reason in the publish gate", async () => {
    const listing = { id: LID, ownerUserId: "u", ownerUserType: "owner", jurisdiction: "QLD", transactionType: "sale", useClass: "residential", propertyType: "house", title: "t", address: "a", status: "draft", disclosures: [] } as unknown as PropertyListing;
    const trustAccount = await trustAccountDecisionPg(dbReturning({ decision: "approved", reasons: [], current: true }), LID);
    const d = decidePublish(listing, [], [], "2026-10-24T00:00:00Z", { termsAccepted: true, listingFeePaid: true, ...(trustAccount ? { trustAccount } : {}) });
    expect(d.reasons.join(" ")).not.toContain("Trust account");
  });
});

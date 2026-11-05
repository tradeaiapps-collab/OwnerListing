import { describe, expect, it } from "vitest";
import {
  BULK_ASYNC_ABOVE, BULK_MAX, csvCell, newPriceCents, parseBulkParams, planBulkItem, type BulkParams, type ListingFacts
} from "../src/domain/listing-bulk";
import { effectivePermissions, type StaffActor } from "../src/domain/staff-access";

const STAFF = "00000000-0000-4000-8000-000000000001";
const AGENT = "11111111-1111-4111-8111-111111111111";
const base: ListingFacts = {
  id: "l1", ownerUserId: "owner", status: "published", transactionType: "sale", useClass: "residential", propertyType: "house", priceCents: 100_000_000,
  outcome: null, deleted: false, activeOffers: 0, activeBookings: 0, agentUserId: AGENT, hasTag: false
};
const params = (raw: unknown, action: string) => {
  const r = parseBulkParams(action, raw);
  if (!r.ok) throw new Error(r.error);
  return r.params;
};
const plan = (f: Partial<ListingFacts>, p: BulkParams) => planBulkItem(STAFF, { ...base, ...f }, p);

describe("bulk listing parameters", () => {
  it("limits are the agreed ones", () => { expect(BULK_MAX).toBe(500); expect(BULK_ASYNC_ABOVE).toBe(100); });
  it("rejects unknown actions and bad parameters", () => {
    expect(parseBulkParams("explode", {}).ok).toBe(false);
    expect(parseBulkParams("set_status", { status: "gone" }).ok).toBe(false);
    expect(parseBulkParams("add_tag", { tag: "x" }).ok).toBe(false);
    expect(parseBulkParams("add_tag", { tag: "<script>" }).ok).toBe(false);
    expect(parseBulkParams("set_property_type", { propertyType: "castle" }).ok).toBe(false);
    expect(parseBulkParams("adjust_price", { mode: "percent", value: 0 }).ok).toBe(false);
    expect(parseBulkParams("adjust_price", { mode: "percent", value: -95 }).ok).toBe(false);
    expect(parseBulkParams("adjust_price", { mode: "percent", value: "10" }).ok).toBe(false);
    expect(parseBulkParams("assign_agent", { agentId: "nope" }).ok).toBe(false);
  });
  it("normalises tags", () => { expect(params({ tag: "  Spring-Campaign " }, "add_tag")).toEqual({ action: "add_tag", tag: "spring-campaign" }); });
});

describe("bulk listing rules", () => {
  it("never plans a change on a deleted listing", () => { expect(plan({ deleted: true }, params({}, "archive")).kind).toBe("skip"); });
  it("publishes only listings under review or suspended (the server then runs the publish checks)", () => {
    expect(plan({ status: "pending_review" }, params({}, "publish")).kind).toBe("apply");
    expect(plan({ status: "suspended" }, params({}, "publish")).kind).toBe("apply");
    expect(plan({ status: "draft" }, params({}, "publish")).kind).toBe("skip");
    expect(plan({ status: "archived" }, params({}, "publish")).kind).toBe("skip");
  });
  it("blocks delete while offers or inspection bookings are open", () => {
    expect(plan({ activeOffers: 2 }, params({}, "delete"))).toEqual({ kind: "skip", reason: "2 open offers." });
    expect(plan({ activeBookings: 1 }, params({}, "delete")).kind).toBe("skip");
    expect(plan({}, params({}, "delete")).kind).toBe("apply");
  });
  it("marks sold only for sales and rented only for rentals, and available only after an outcome", () => {
    expect(plan({}, params({ status: "sold" }, "set_status")).kind).toBe("apply");
    expect(plan({ transactionType: "rent" }, params({ status: "sold" }, "set_status")).kind).toBe("skip");
    expect(plan({ transactionType: "rent" }, params({ status: "rented" }, "set_status")).kind).toBe("apply");
    expect(plan({ status: "draft" }, params({ status: "sold" }, "set_status")).kind).toBe("skip");
    expect(plan({}, params({ status: "available" }, "set_status")).kind).toBe("skip");
    expect(plan({ status: "archived", outcome: "sold" }, params({ status: "available" }, "set_status")).kind).toBe("apply");
  });
  it("keeps property type consistent with residential or commercial use", () => {
    expect(plan({}, params({ propertyType: "office" }, "set_property_type")).kind).toBe("skip");
    expect(plan({}, params({ propertyType: "unit" }, "set_property_type")).kind).toBe("apply");
    expect(plan({ useClass: "commercial", propertyType: "office" }, params({ propertyType: "house" }, "set_property_type")).kind).toBe("skip");
    expect(plan({}, params({ propertyType: "land" }, "set_property_type")).kind).toBe("apply");
  });
  it("adjusts prices by percent or dollars, rounded to whole dollars, within limits", () => {
    const pct = params({ mode: "percent", value: 10 }, "adjust_price") as Extract<BulkParams, { action: "adjust_price" }>;
    expect(newPriceCents(base, pct)).toBe(110_000_000);
    expect(newPriceCents(base, params({ mode: "amount", value: -50_000 }, "adjust_price") as typeof pct)).toBe(95_000_000);
    expect(newPriceCents({ ...base, priceCents: 12_345 }, { ...pct, value: 1 })).toBe(12_500);
    expect(newPriceCents({ ...base, priceCents: null }, pct)).toBe("No price set.");
    expect(typeof newPriceCents({ ...base, priceCents: 150 }, params({ mode: "amount", value: -5 }, "adjust_price") as typeof pct)).toBe("string");
    expect(typeof newPriceCents({ ...base, transactionType: "rent", priceCents: 9_500_000 }, pct)).toBe("string");
    expect(plan({ status: "archived" }, pct).kind).toBe("skip");
  });
  it("assigns agents only where the owner already appointed one, never your own listing, never to yourself", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const a = params({ agentId: other }, "assign_agent");
    expect(plan({}, a).kind).toBe("apply");
    expect(plan({ ownerUserId: STAFF }, a)).toEqual({ kind: "skip", reason: "You own this listing; ask another staff member." });
    expect(plan({}, params({ agentId: STAFF }, "assign_agent")).kind).toBe("skip");
    expect(plan({ agentUserId: null }, a).kind).toBe("skip");
    expect(plan({ agentUserId: other }, a).kind).toBe("skip");
    expect(plan({ ownerUserId: other }, a).kind).toBe("skip");
  });
  it("skips a tag the listing already has", () => { expect(plan({ hasTag: true }, params({ tag: "spring" }, "add_tag")).kind).toBe("skip"); });
});

describe("bulk permission and export", () => {
  const actor = (role: StaffActor["role"]) => ({ id: STAFF, role }) as StaffActor;
  it("is held by super admin and compliance only", () => {
    expect(effectivePermissions(actor("super_admin"))).toContain("listing.bulk");
    expect(effectivePermissions(actor("compliance"))).toContain("listing.bulk");
    for (const r of ["support", "accountant", "technical", "reporting", "designer"] as const) expect(effectivePermissions(actor(r))).not.toContain("listing.bulk");
  });
  it("neutralises spreadsheet formulas and quotes awkward cells", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("a,b")).toBe("\"a,b\"");
    expect(csvCell(null)).toBe("");
    expect(csvCell("12 Main St")).toBe("12 Main St");
  });
});

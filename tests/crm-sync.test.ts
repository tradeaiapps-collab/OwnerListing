import { describe, expect, it } from "vitest";
import { crmEventId, currentStatus, planSync } from "../src/domain/crm-sync";

const L = { transactionType: "sale", updatedAt: "2026-11-05T01:00:00Z" };
describe("current status", () => {
  it("sold or rented wins, then delisted, then active", () => {
    expect(currentStatus({ ...L, status: "published", saleType: "sold", saleAt: "2026-11-05T03:00:00Z" })).toEqual({ status: "sold", since: "2026-11-05T03:00:00Z" });
    expect(currentStatus({ ...L, status: "withdrawn", saleType: "rented" })?.status).toBe("rented");
    expect(currentStatus({ ...L, status: "archived" })).toEqual({ status: "delisted", since: L.updatedAt });
    expect(currentStatus({ ...L, status: "published" })?.status).toBe("active");
  });
  it("does not sync drafts, reviews or suspended listings", () => {
    for (const status of ["draft", "pending_review", "suspended"]) expect(currentStatus({ ...L, status })).toBeUndefined();
  });
});

describe("sync plan", () => {
  const ON = "2026-11-05T00:00:00Z";
  it("baselines a first sighting quietly", () => {
    expect(planSync(undefined, { status: "active", since: "2026-11-06T00:00:00Z" }, ON)).toEqual({ kind: "baseline" });
    expect(planSync(undefined, { status: "sold", since: "2026-10-01T00:00:00Z" }, ON)).toEqual({ kind: "baseline" });
  });
  it("sends a first sighting that changed after sync was switched on", () => {
    expect(planSync(undefined, { status: "sold", since: "2026-11-05T02:00:00Z" }, ON)).toEqual({ kind: "event", event: "listing.sold" });
  });
  it("sends one event per change and nothing for no change", () => {
    const at = { since: "2026-11-05T02:00:00Z" };
    expect(planSync("active", { status: "active", ...at }, ON)).toEqual({ kind: "none" });
    expect(planSync("active", { status: "sold", ...at }, ON)).toEqual({ kind: "event", event: "listing.sold" });
    expect(planSync("active", { status: "rented", ...at }, ON)).toEqual({ kind: "event", event: "listing.rented" });
    expect(planSync("active", { status: "delisted", ...at }, ON)).toEqual({ kind: "event", event: "listing.delisted" });
    expect(planSync("delisted", { status: "active", ...at }, ON)).toEqual({ kind: "event", event: "listing.reactivated" });
    expect(planSync("sold", { status: "sold", ...at }, ON)).toEqual({ kind: "none" });
  });
});

describe("event id", () => {
  it("is stable for the same change and differs otherwise", () => {
    const a = crmEventId("c", "l", "listing.sold", "2026-11-05T02:00:00Z");
    expect(a).toBe(crmEventId("c", "l", "listing.sold", "2026-11-05T02:00:00.000Z"));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(crmEventId("c", "l", "listing.delisted", "2026-11-05T02:00:00Z"));
    expect(a).not.toBe(crmEventId("c2", "l", "listing.sold", "2026-11-05T02:00:00Z"));
  });
});

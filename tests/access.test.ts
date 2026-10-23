import { describe, expect, it } from "vitest";
import { can, canActOnListing } from "../src/domain/access";
import type { PropertyListing } from "../src/domain/listing";

const listing = { id: "l", ownerUserId: "u1" } as PropertyListing;
const appt = { listingId: "l", agentUserId: "ag1", scope: "enquiries_and_offers" as const, revoked: false };

describe("access", () => {
  it("only admins verify licences", () => {
    expect(can({ id: "a", role: "admin" }, "licence.verify")).toBe(true);
    expect(can({ id: "u1", role: "agent" }, "licence.verify")).toBe(false);
  });
  it("blocks other users from a listing", () => {
    expect(canActOnListing({ id: "u2", role: "owner" }, listing, "listing.publish")).toBe(false);
    expect(canActOnListing({ id: "u1", role: "owner" }, listing, "listing.publish")).toBe(true);
  });
  it("lets an appointed agent analyse offers but never approve them", () => {
    const agent = { id: "ag1", role: "agent" as const };
    expect(canActOnListing(agent, listing, "offer.analyse", appt)).toBe(true);
    expect(canActOnListing(agent, listing, "offer.approve", appt)).toBe(false);
  });
  it("needs full scope to publish, and an active appointment", () => {
    const agent = { id: "ag1", role: "agent" as const };
    expect(canActOnListing(agent, listing, "listing.publish", appt)).toBe(false);
    expect(canActOnListing(agent, listing, "listing.publish", { ...appt, scope: "full" })).toBe(true);
    expect(canActOnListing(agent, listing, "listing.publish", { ...appt, scope: "full", revoked: true })).toBe(false);
  });
});

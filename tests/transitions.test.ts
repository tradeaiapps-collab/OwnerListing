import { describe, expect, it } from "vitest";
import { transitionListing } from "../src/domain/listing-transitions";
import type { PropertyListing } from "../src/domain/listing";

const listing: PropertyListing = {
  id: "lst-1", ownerUserId: "u1", ownerUserType: "owner", jurisdiction: "QLD", status: "pending_review",
  title: "T", propertyType: "house", useClass: "residential", transactionType: "sale", address: "A",
  disclosures: [], createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z"
};
const ctx = { eventId: "e1", correlationId: "c1", actorType: "user" as const, actorId: "u1", now: "2026-10-22T01:00:00.000Z" };

describe("transitionListing", () => {
  it("blocks publishing without an allowed decision", () => {
    expect(() => transitionListing(listing, "published", ctx)).toThrow(/allowed publish decision/);
    expect(() => transitionListing(listing, "published", ctx, { allowed: false, reasons: ["x"] })).toThrow();
  });
  it("publishes with an allowed decision and returns an audit event", () => {
    const r = transitionListing(listing, "published", ctx, { allowed: true, reasons: [] });
    expect(r.listing.status).toBe("published");
    expect(r.event.eventType).toBe("listing.published");
  });
  it("rejects invalid transitions", () => {
    expect(() => transitionListing({ ...listing, status: "withdrawn" }, "draft", ctx)).toThrow(/Invalid/);
  });
});

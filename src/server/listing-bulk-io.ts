import { randomUUID } from "node:crypto";
import { evaluateListingPublish } from "../domain/listing-service";
import { transitionListing } from "../domain/listing-transitions";
import { moderateListing } from "./admin-moderation-db";
import { getDb, getDeps } from "./context";
import type { BulkIo } from "./listing-bulk-db";

/**
 * Bulk publish, one listing: the same publish checks as the single "reinstate" action, run for the listing's owner. A listing that
 * fails them is skipped with the first reasons; nothing is published past the gate.
 */
export const bulkIo = (): BulkIo => ({
  async publish(listingId, actor, jobId, reason) {
    const deps = getDeps();
    const rec = await deps.repo.get(listingId);
    if (!rec) return "Listing not found.";
    const from = rec.listing.status;
    if (from !== "pending_review" && from !== "suspended") return "Only a listing under review or suspended can be published.";
    const now = deps.now();
    const decision = await evaluateListingPublish(deps, rec, now, rec.listing.ownerUserId);
    if (!decision.allowed) return `Fails the publish checks: ${decision.reasons.slice(0, 2).join(" ")}`;
    const { event } = transitionListing(rec.listing, "published", { eventId: randomUUID(), correlationId: jobId, actorType: "user", actorId: actor.id, now }, decision);
    const ok = await moderateListing(getDb(), listingId, from, "published", {
      ...event, payload: { ...event.payload, role: actor.role, action: "bulk_publish", reason, bulkJobId: jobId, moderation: true }
    });
    return ok ? null : "Changed in the meantime.";
  }
});

import type { AuditEvent } from "./audit";
import type { ListingStatus, PropertyListing, PublishDecision } from "./listing";

const ALLOWED: Record<ListingStatus, readonly ListingStatus[]> = {
  draft: ["pending_review", "withdrawn"],
  pending_review: ["draft", "published", "withdrawn"],
  published: ["withdrawn"],
  withdrawn: []
};

export interface TransitionContext {
  eventId: string;
  correlationId: string;
  actorType: AuditEvent["actorType"];
  actorId: string;
  now: string;
}

/**
 * Moves a listing to a new status and returns the matching audit event.
 * Publishing requires an allowed PublishDecision from decidePublish; there is no other path to "published".
 */
export function transitionListing(
  listing: PropertyListing,
  to: ListingStatus,
  ctx: TransitionContext,
  publishDecision?: PublishDecision
): { listing: PropertyListing; event: AuditEvent } {
  if (!ALLOWED[listing.status].includes(to)) {
    throw new Error(`Invalid listing transition: ${listing.status} -> ${to}.`);
  }
  if (to === "published" && !(publishDecision && publishDecision.allowed)) {
    throw new Error("Publishing requires an allowed publish decision.");
  }
  return {
    listing: { ...listing, status: to, updatedAt: ctx.now },
    event: {
      id: ctx.eventId,
      occurredAt: ctx.now,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      aggregateType: "listing",
      aggregateId: listing.id,
      eventType: `listing.${to}`,
      correlationId: ctx.correlationId,
      payload: { from: listing.status, to }
    }
  };
}

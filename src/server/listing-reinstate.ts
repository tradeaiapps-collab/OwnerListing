import { randomUUID } from "node:crypto";
import { evaluateListingPublish } from "../domain/listing-service";
import { transitionListing } from "../domain/listing-transitions";
import type { StaffActor } from "../domain/staff-access";
import { moderateListing } from "./admin-moderation-db";
import { getDb, getDeps } from "./context";

export interface NotRestored { id: string; title: string; reasons: string[] }

/**
 * Puts suspended listings back live, each only through the publish gate as it stands today, one at a time. A listing that fails the
 * gate (or changed in the meantime) stays suspended and is returned with the reasons. `payload` is added to each audit event.
 */
export async function republishSuspended(
  staff: StaffActor, listingIds: readonly string[], payload: Record<string, unknown>
): Promise<{ restored: number; notRestored: NotRestored[] }> {
  const deps = getDeps();
  const db = getDb();
  let restored = 0;
  const notRestored: NotRestored[] = [];
  for (const listingId of listingIds) {
    const rec = await deps.repo.get(listingId);
    if (!rec || rec.listing.status !== "suspended") continue;
    const now = deps.now();
    const decision = await evaluateListingPublish(deps, rec, now, rec.listing.ownerUserId);
    if (!decision.allowed) { notRestored.push({ id: listingId, title: rec.listing.title, reasons: decision.reasons }); continue; }
    const { event } = transitionListing(rec.listing, "published", { eventId: randomUUID(), correlationId: randomUUID(), actorType: "user", actorId: staff.id, now }, decision);
    const ok = await moderateListing(db, listingId, "suspended", "published", { ...event, payload: { ...event.payload, role: staff.role, ...payload } });
    if (ok) restored++;
  }
  return { restored, notRestored };
}

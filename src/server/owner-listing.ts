import type { NextResponse } from "next/server";
import type { AgentPermission } from "../domain/access";
import { isAppointedAgent } from "../domain/appointed-agent";
import type { Actor, ListingRecord } from "../domain/listing-service";
import { getActor, getDeps } from "./context";
import { failure, unauthenticated } from "./http";

const notFound = { ok: false, code: "not_found", message: "Listing not found." } as const;

/** Signed-in owner of this listing, or a 401/404 response. Everyone else (other owners, agents, buyers) gets 404. */
export async function requireListingOwner(req: Request, id: string): Promise<{ actor: Actor; rec: ListingRecord } | NextResponse> {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const rec = await getDeps().repo.get(id);
  if (actor.userType !== "owner" || !rec || rec.listing.ownerUserId !== actor.userId) {
    return failure(notFound);
  }
  return { actor, rec };
}

/**
 * The listing's owner, or its appointed agent (active appointment and a current licence for the listing's state), or a 401/404.
 * The agent's appointment must grant `permission`. For handling enquiries, offer links and viewing offers only. Deciding on an offer is owner-only and does not use this.
 * Everyone else (other agents, a revoked or unlicensed agent, other owners, buyers) gets 404.
 */
export async function requireListingHandler(
  req: Request, id: string, permission: AgentPermission
): Promise<{ actor: Actor; rec: ListingRecord; asAgent: boolean } | NextResponse> {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const deps = getDeps();
  const rec = await deps.repo.get(id);
  if (!rec) return failure(notFound);
  if (actor.userType === "owner" && rec.listing.ownerUserId === actor.userId) return { actor, rec, asAgent: false };
  if (await isAppointedAgent(deps, actor, rec.listing, permission)) return { actor, rec, asAgent: true };
  return failure(notFound);
}

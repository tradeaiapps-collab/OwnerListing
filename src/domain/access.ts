import type { PropertyListing } from "./listing";

export type Role = PropertyListing["ownerUserType"];

export type Action =
  | "listing.create"
  | "listing.publish"
  | "enquiry.handle"
  | "offer.analyse"
  | "offer.approve"
  | "licence.verify"
  | "audit.read";

const PERMISSIONS: Record<Action, readonly Role[]> = {
  "listing.create": ["owner", "admin"],
  "listing.publish": ["owner", "agent"],
  "enquiry.handle": ["owner", "agent"],
  "offer.analyse": ["owner", "agent"],
  "offer.approve": ["owner"],
  "licence.verify": ["admin"],
  "audit.read": ["admin"]
};

export interface Actor { id: string; role: Role }

/** An owner's appointment of an agent to one listing. `scope: "full"` also allows publishing. */
export interface AgentAppointment {
  listingId: string;
  agentUserId: string;
  scope: "enquiries_and_offers" | "full";
  revoked: boolean;
}

/** Role check only. Record-level access is checked separately. */
export function can(actor: Actor, action: Action): boolean {
  return PERMISSIONS[action].includes(actor.role);
}

/**
 * Record-level check. The owner can do everything permitted for their role.
 * An appointed agent can handle enquiries and analyse offers; publishing needs scope "full".
 * Approving offers is never available to an agent. Admins only get actions their role allows.
 */
export function canActOnListing(
  actor: Actor,
  listing: PropertyListing,
  action: Action,
  appointment?: AgentAppointment
): boolean {
  if (!can(actor, action)) return false;
  if (actor.role === "admin") return true;
  if (actor.id === listing.ownerUserId) return true;
  if (actor.role !== "agent" || !appointment) return false;
  if (appointment.revoked || appointment.listingId !== listing.id || appointment.agentUserId !== actor.id) return false;
  return action !== "listing.publish" || appointment.scope === "full";
}

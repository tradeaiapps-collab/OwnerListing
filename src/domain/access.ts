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

/**
 * What an appointed agent may do on a listing. Deciding on offers, contract drafts and auto-reply settings are never
 * in this list: they stay with the owner whatever the appointment says.
 */
export const AGENT_PERMISSIONS = ["enquiries.handle", "offer_links.issue", "offers.view", "listing.describe", "listing.publish"] as const;
export type AgentPermission = typeof AGENT_PERMISSIONS[number];

export const AGENT_PERMISSION_LABELS: Record<AgentPermission, string> = {
  "enquiries.handle": "Read and reply to buyer enquiries",
  "offer_links.issue": "Send or decline formal offer links",
  "offers.view": "View offers and the offer comparison",
  "listing.describe": "Get AI listing description suggestions",
  "listing.publish": "Publish the listing"
};

/** Each scope is a role: the most the agent can be given. The owner may untick permissions inside it, never add more. */
export const SCOPE_PERMISSIONS: Record<AgentAppointment["scope"], readonly AgentPermission[]> = {
  enquiries_and_offers: ["enquiries.handle", "offer_links.issue", "offers.view", "listing.describe"],
  full: AGENT_PERMISSIONS
};

/** An owner's appointment of an agent to one listing. `scope: "full"` also allows publishing. */
export interface AgentAppointment {
  listingId: string;
  agentUserId: string;
  scope: "enquiries_and_offers" | "full";
  revoked: boolean;
  /** The owner's narrower choice inside the scope. Absent means everything the scope allows. */
  permissions?: readonly AgentPermission[];
}

export const isAgentPermission = (v: unknown): v is AgentPermission =>
  typeof v === "string" && (AGENT_PERMISSIONS as readonly string[]).includes(v);

/** The permissions an appointment actually grants: the owner's list, never more than its scope allows. */
export function agentPermissions(a: Pick<AgentAppointment, "scope" | "permissions">): readonly AgentPermission[] {
  const ceiling = SCOPE_PERMISSIONS[a.scope] ?? [];
  return a.permissions ? ceiling.filter(p => a.permissions!.includes(p)) : ceiling;
}

/** True when an active appointment of this agent to this listing grants the permission. Revoked always means no. */
export function agentMay(a: AgentAppointment, listingId: string, agentUserId: string, permission: AgentPermission): boolean {
  return !a.revoked && a.listingId === listingId && a.agentUserId === agentUserId && agentPermissions(a).includes(permission);
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
  return action !== "listing.publish" || agentPermissions(appointment).includes("listing.publish");
}

/** Returns a forbidden failure when the actor's role may not perform the action; null when allowed. */
export function forbiddenFor(actor: Actor, action: Action): { ok: false; code: "forbidden"; message: string } | null {
  return can(actor, action) ? null : { ok: false, code: "forbidden", message: "Your account cannot do this." };
}

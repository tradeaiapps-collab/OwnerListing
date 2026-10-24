import { canActOnListing, type AgentAppointment } from "./access";
import type { PropertyListing } from "./listing";
import { hasVerifiedLicence, type AgentLicence } from "./licence";
import type { Actor } from "./listing-service";
import { licenceLocalDate } from "./timezone";

export interface AppointedAgentDeps {
  appointmentFor?: (listingId: string, agentUserId: string) => Promise<AgentAppointment | undefined>;
  licences?: () => Promise<readonly AgentLicence[]>;
  now: () => string;
}

/**
 * True only for an agent account with an active (not revoked) appointment to this listing AND a verified, unexpired
 * licence for the listing's state (expiry judged on the state's local date, as in the publish gate). Either scope may
 * handle enquiries, offer links and offers. This never lets anyone decide an offer: that stays with the owner.
 * Fails closed: a missing dependency, a lookup error or an unknown time zone all mean no.
 */
export async function isAppointedAgent(deps: AppointedAgentDeps, actor: Actor, listing: PropertyListing): Promise<boolean> {
  if (actor.userType !== "agent" || actor.userId === listing.ownerUserId || !deps.appointmentFor || !deps.licences) return false;
  try {
    const appointment = await deps.appointmentFor(listing.id, actor.userId);
    if (!appointment || !canActOnListing({ id: actor.userId, role: actor.userType }, listing, "enquiry.handle", appointment)) return false;
    const today = licenceLocalDate(deps.now(), listing.jurisdiction);
    return today !== undefined && hasVerifiedLicence(await deps.licences(), actor.userId, listing.jurisdiction, today);
  } catch {
    return false;
  }
}

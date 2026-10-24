import type { Jurisdiction } from "./jurisdiction";
import { hasVerifiedLicence, type AgentLicence } from "./licence";
import type { Actor, Failure, Result } from "./listing-service";

/** One listing the agent is appointed to, with its enquiry threads and the messages the agent has not read yet. */
export interface AgentListingItem {
  listingId: string;
  title: string;
  jurisdiction: Jurisdiction;
  status: string;
  appointedAt: string;
  enquiries: number;
  unread: number;
}

export interface AgentInboxDeps {
  /** Listings with an active (not revoked) appointment for this agent. */
  appointedListings(agentUserId: string): Promise<AgentListingItem[]>;
  licences(): Promise<readonly AgentLicence[]>;
  /** ISO date (YYYY-MM-DD) used to judge licence expiry. */
  today(): string;
}

const deny = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });

/**
 * The agent's inbox of appointed listings. Only agents with a verified, unexpired licence get anything, and each listing
 * needs a licence for its own state: a listing whose state the agent is not licensed in is left out.
 * Unread-first, then newest appointment.
 */
export async function agentInbox(deps: AgentInboxDeps, actor: Actor): Promise<Result<AgentListingItem[]>> {
  if (actor.userType !== "agent") return deny("forbidden", "Only appointed agents can use the agent inbox.");
  const licences = await deps.licences();
  const today = deps.today();
  if (!licences.some(l => hasVerifiedLicence(licences, actor.userId, l.jurisdiction, today))) {
    return deny("forbidden", "A verified licence is required to use the agent inbox.");
  }
  const rows = await deps.appointedListings(actor.userId);
  const items = rows.filter(r => hasVerifiedLicence(licences, actor.userId, r.jurisdiction, today));
  items.sort((a, b) => b.unread - a.unread || (a.appointedAt < b.appointedAt ? 1 : a.appointedAt > b.appointedAt ? -1 : 0));
  return { ok: true, value: items };
}

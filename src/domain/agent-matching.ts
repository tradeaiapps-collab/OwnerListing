import type { AppointmentIds, AgentAppointmentRepository, AppointmentInvite } from "./agent-appointment-service";
import { inviteAgent } from "./agent-appointment-service";
import type { AuditEvent } from "./audit";
import type { Jurisdiction } from "./jurisdiction";
import { hasVerifiedLicence, type AgentLicence } from "./licence";
import { PROPERTY_TYPES, TRANSACTION_TYPES, USE_CLASSES, type Actor, type Result } from "./listing-service";
import { licenceLocalDate } from "./timezone";

/** The agent's own description of where they work, what they sell or lease, and how much they can take on. */
export interface AgentProfile {
  acceptingNew: boolean;
  maxActiveListings: number;
  servicePostcodes: string[];
  /** Lower case. */
  serviceSuburbs: string[];
  transactionTypes: string[];
  useClasses: string[];
  propertyTypes: string[];
  bio: string;
}

export const DEFAULT_AGENT_PROFILE: AgentProfile = {
  acceptingNew: true, maxActiveListings: 20, servicePostcodes: [], serviceSuburbs: [], transactionTypes: [], useClasses: [], propertyTypes: [], bio: ""
};

export interface ListingFacts {
  ownerUserId: string;
  jurisdiction: Jurisdiction;
  postcode?: string;
  suburb?: string;
  transactionType: string;
  useClass: string;
  propertyType: string;
}

export interface AgentCandidate {
  userId: string;
  displayName: string;
  profile: AgentProfile;
  /** Active appointments the agent holds now, across all listings. */
  activeListings: number;
}

export type MatchReason = "postcode" | "suburb" | "transaction_type" | "use_class" | "property_type" | "capacity";

export interface AgentSuggestion {
  agentUserId: string;
  displayName: string;
  score: number;
  reasons: MatchReason[];
  activeListings: number;
  maxActiveListings: number;
  bio: string;
}

export interface AgentMatchingRepository {
  getListingFacts(listingId: string): Promise<ListingFacts | undefined>;
  /** Active, non-suspended agent accounts with a verified licence row for the state, a profile, and their active appointment count. */
  candidates(jurisdiction: Jurisdiction): Promise<AgentCandidate[]>;
  getProfile(userId: string): Promise<AgentProfile | undefined>;
  saveProfile(userId: string, profile: AgentProfile, audit: AuditEvent): Promise<void>;
  verifiedLicences(): Promise<AgentLicence[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSTCODE = /^[0-9]{4}$/;
const notFound = { ok: false, code: "not_found", message: "Not found." } as const;
export const MAX_SUGGESTIONS = 5;

// Points: area matters most (an area match outranks any mix of expertise), then the kind of property, then spare capacity.
const POINTS = { postcode: 60, suburb: 50, transaction_type: 20, use_class: 10, property_type: 10, capacity: 10 } as const;

const invalid = (message: string) => ({ ok: false as const, code: "invalid" as const, message });

function stringList(v: unknown, max: number, each: (s: string) => string | undefined): string[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) return undefined;
  const out: string[] = [];
  for (const x of v) {
    const s = typeof x === "string" ? each(x.trim()) : undefined;
    if (s === undefined) return undefined;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}
const oneOf = (allowed: readonly string[]) => (s: string) => (allowed.includes(s) ? s : undefined);

/** Validates the agent's profile form. Every list is optional; an empty list means "not stated". */
export function parseAgentProfile(input: unknown): Result<AgentProfile> {
  if (typeof input !== "object" || input === null) return invalid("Send a JSON object.");
  const o = input as Record<string, unknown>;
  const acceptingNew = o["acceptingNew"] ?? true;
  if (typeof acceptingNew !== "boolean") return invalid("acceptingNew must be true or false.");
  const max = o["maxActiveListings"] ?? DEFAULT_AGENT_PROFILE.maxActiveListings;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > 500) return invalid("Maximum listings must be a whole number from 1 to 500.");
  const servicePostcodes = stringList(o["servicePostcodes"], 200, s => (POSTCODE.test(s) ? s : undefined));
  if (!servicePostcodes) return invalid("Postcodes must be 4 digits (up to 200).");
  const serviceSuburbs = stringList(o["serviceSuburbs"], 200, s => (s.length >= 1 && s.length <= 80 ? s.toLowerCase() : undefined));
  if (!serviceSuburbs) return invalid("Suburbs must be 1 to 80 characters (up to 200).");
  const transactionTypes = stringList(o["transactionTypes"], 2, oneOf(TRANSACTION_TYPES));
  if (!transactionTypes) return invalid("Transaction types must be sale or rent.");
  const useClasses = stringList(o["useClasses"], 2, oneOf(USE_CLASSES));
  if (!useClasses) return invalid("Use classes must be residential or commercial.");
  const propertyTypes = stringList(o["propertyTypes"], PROPERTY_TYPES.length, oneOf(PROPERTY_TYPES));
  if (!propertyTypes) return invalid("Unknown property type.");
  const bio = o["bio"] ?? "";
  if (typeof bio !== "string" || bio.length > 1000) return invalid("About you must be at most 1000 characters.");
  return { ok: true, value: { acceptingNew, maxActiveListings: max, servicePostcodes, serviceSuburbs, transactionTypes, useClasses, propertyTypes, bio: bio.trim() } };
}

/**
 * Ranks agents for a listing. Only agents who are accepting new listings, under their own capacity and hold a verified,
 * unexpired licence for the listing's state (state-local date) are eligible; the listing's owner never is.
 * Ties go to the agent with more spare capacity, then by user id so the order is stable.
 */
export function rankAgents(listing: ListingFacts, candidates: readonly AgentCandidate[], licences: readonly AgentLicence[], now: string): AgentSuggestion[] {
  const today = licenceLocalDate(now, listing.jurisdiction);
  if (today === undefined) return [];
  const suburb = listing.suburb?.trim().toLowerCase();
  const out: (AgentSuggestion & { spare: number })[] = [];
  for (const c of candidates) {
    const p = c.profile;
    if (c.userId === listing.ownerUserId || !p.acceptingNew || c.activeListings >= p.maxActiveListings) continue;
    if (!hasVerifiedLicence(licences, c.userId, listing.jurisdiction, today)) continue;
    const reasons: MatchReason[] = [];
    if (listing.postcode && p.servicePostcodes.includes(listing.postcode)) reasons.push("postcode");
    if (suburb && p.serviceSuburbs.includes(suburb)) reasons.push("suburb");
    if (p.transactionTypes.includes(listing.transactionType)) reasons.push("transaction_type");
    if (p.useClasses.includes(listing.useClass)) reasons.push("use_class");
    if (p.propertyTypes.includes(listing.propertyType)) reasons.push("property_type");
    const spare = 1 - c.activeListings / p.maxActiveListings;
    if (spare >= 0.5) reasons.push("capacity");
    const score = reasons.reduce((s, r) => s + (r === "capacity" ? Math.round(POINTS.capacity * spare) : POINTS[r]), 0);
    out.push({ agentUserId: c.userId, displayName: c.displayName, score, reasons, activeListings: c.activeListings,
      maxActiveListings: p.maxActiveListings, bio: p.bio, spare });
  }
  out.sort((a, b) => b.score - a.score || b.spare - a.spare || (a.agentUserId < b.agentUserId ? -1 : 1));
  return out.map(({ spare: _spare, ...s }) => s);
}

/** The owner's suggested agents for their listing, best first. Anyone else gets 404. */
export async function suggestAgents(repo: AgentMatchingRepository, actor: Actor, listingId: string, now: string): Promise<Result<AgentSuggestion[]>> {
  if (!UUID.test(listingId)) return notFound;
  const facts = await repo.getListingFacts(listingId);
  if (!facts || facts.ownerUserId !== actor.userId) return notFound;
  const ranked = rankAgents(facts, await repo.candidates(facts.jurisdiction), await repo.verifiedLicences(), now);
  return { ok: true, value: ranked.slice(0, MAX_SUGGESTIONS) };
}

/**
 * Automatic assignment: the owner asks the platform to pick, and the best-ranked agent is invited with the scope and
 * permissions the owner chose. It is still only an invitation: the agent must accept, and the owner can withdraw it.
 */
export async function inviteBestAgent(
  matching: AgentMatchingRepository, appointments: AgentAppointmentRepository, actor: Actor, listingId: string, input: unknown, ids: AppointmentIds
): Promise<Result<{ invite: AppointmentInvite; suggestion: AgentSuggestion }>> {
  const s = await suggestAgents(matching, actor, listingId, ids.now());
  if (!s.ok) return s;
  const o = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const open = await appointments.ownerView(listingId);
  const alreadyInvited = new Set(open.invites.map(i => i.agentUserId));
  const best = s.value.find(x => !alreadyInvited.has(x.agentUserId));
  if (!best) return { ok: false, code: "conflict", message: "No available licensed agent matches this listing yet." };
  const r = await inviteAgent(appointments, actor, listingId,
    { agentUserId: best.agentUserId, ...(o["scope"] !== undefined ? { scope: o["scope"] } : {}), ...(o["permissions"] !== undefined ? { permissions: o["permissions"] } : {}) }, ids);
  return r.ok ? { ok: true, value: { invite: r.value, suggestion: best } } : r;
}

export async function getAgentProfile(repo: AgentMatchingRepository, actor: Actor): Promise<Result<AgentProfile>> {
  if (actor.userType !== "agent") return { ok: false, code: "forbidden", message: "Only agent accounts have an agent profile." };
  return { ok: true, value: (await repo.getProfile(actor.userId)) ?? DEFAULT_AGENT_PROFILE };
}

export async function saveAgentProfile(
  repo: AgentMatchingRepository, actor: Actor, input: unknown, ids: { newId: () => string; now: () => string }
): Promise<Result<AgentProfile>> {
  if (actor.userType !== "agent") return { ok: false, code: "forbidden", message: "Only agent accounts have an agent profile." };
  const p = parseAgentProfile(input);
  if (!p.ok) return p;
  await repo.saveProfile(actor.userId, p.value, {
    id: ids.newId(), occurredAt: ids.now(), actorType: "user", actorId: actor.userId, aggregateType: "agent_profile",
    aggregateId: actor.userId, eventType: "agent_profile.saved", correlationId: ids.newId(),
    payload: { acceptingNew: p.value.acceptingNew, maxActiveListings: p.value.maxActiveListings, postcodes: p.value.servicePostcodes.length, suburbs: p.value.serviceSuburbs.length }
  });
  return p;
}

export function createInMemoryAgentMatchingRepository(seed: {
  listings?: (ListingFacts & { id: string })[];
  agents?: { userId: string; displayName: string; status?: string; profile?: AgentProfile; activeListings?: number }[];
  licences?: AgentLicence[];
} = {}): AgentMatchingRepository & { audits: AuditEvent[] } {
  const agents = seed.agents ?? [];
  const audits: AuditEvent[] = [];
  return {
    audits,
    async getListingFacts(id) { const l = seed.listings?.find(x => x.id === id); if (!l) return undefined; const { id: _id, ...f } = l; return f; },
    async candidates(jurisdiction) {
      const lic = seed.licences ?? [];
      return agents
        .filter(a => a.profile && (a.status ?? "active") === "active" && lic.some(l => l.userId === a.userId && l.jurisdiction === jurisdiction && l.status === "verified"))
        .map(a => ({ userId: a.userId, displayName: a.displayName, profile: a.profile!, activeListings: a.activeListings ?? 0 }));
    },
    async getProfile(userId) { return agents.find(a => a.userId === userId)?.profile; },
    async saveProfile(userId, profile, a) {
      const x = agents.find(y => y.userId === userId);
      if (x) x.profile = profile; else agents.push({ userId, displayName: "Agent", profile });
      audits.push(a);
    },
    async verifiedLicences() { return seed.licences ?? []; }
  };
}

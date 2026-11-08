import { AGENT_PERMISSIONS, agentPermissions, isAgentPermission, SCOPE_PERMISSIONS, type AgentPermission } from "./access";
import type { AuditEvent } from "./audit";
import type { Jurisdiction } from "./jurisdiction";
import { hasVerifiedLicence, type AgentLicence } from "./licence";
import type { Actor, Result } from "./listing-service";
import { licenceLocalDate } from "./timezone";

export const APPOINTMENT_SCOPES = ["enquiries_and_offers", "full"] as const;
export type AppointmentScope = typeof APPOINTMENT_SCOPES[number];
export type InviteStatus = "proposed" | "accepted" | "declined" | "withdrawn";

/** The owner's request that an agent manage one listing. Becomes an appointment only when the agent accepts. */
export interface AppointmentInvite {
  id: string;
  listingId: string;
  ownerUserId: string;
  agentUserId: string;
  scope: AppointmentScope;
  /** The owner's narrower choice inside the scope. Absent means everything the scope allows. */
  permissions?: AgentPermission[];
  status: InviteStatus;
  createdAt: string;
}

/** A row of listing_agent_appointment (db/004). Active while revokedAt is absent. */
export interface AppointmentRecord {
  id: string;
  listingId: string;
  ownerUserId: string;
  agentUserId: string;
  scope: AppointmentScope;
  permissions?: AgentPermission[];
  appointedAt: string;
  revokedAt?: string;
}

export interface AgentAccount { id: string; userType: string; status: string }

export type AgentRef = { by: "id"; userId: string } | { by: "email"; email: string };

/** What the owner sees for one listing. Agent email addresses are never returned. */
export interface OwnerAgentView {
  active: (AppointmentRecord & { agentName: string; licensed: boolean; granted: readonly AgentPermission[] }) | null;
  invites: (AppointmentInvite & { agentName: string; licensed: boolean; granted: readonly AgentPermission[] })[];
}

/** One line in the agent's list: an open invitation or an active appointment. */
export interface AgentAppointmentItem {
  kind: "invite" | "appointment";
  id: string;
  listingId: string;
  listingTitle: string;
  jurisdiction: Jurisdiction;
  ownerName: string;
  scope: AppointmentScope;
  permissions?: AgentPermission[];
  since: string;
  /** What the agent may do on this listing (their responsibilities), after the owner's choices. */
  granted: readonly AgentPermission[];
  /** Whether this agent holds a verified, unexpired licence for the listing's state today. */
  licensed: boolean;
}

export type AcceptOutcome = "accepted" | "stale" | "listing_taken";

/**
 * Storage for agent appointments. Every write carries its audit event and must store both atomically.
 * Nothing here deletes an invite or an appointment: revoking sets revoked_at.
 */
export interface AgentAppointmentRepository {
  getListing(id: string): Promise<{ ownerUserId: string; jurisdiction: Jurisdiction; title: string } | undefined>;
  findAgent(ref: AgentRef): Promise<AgentAccount | undefined>;
  getInvite(id: string): Promise<AppointmentInvite | undefined>;
  getAppointment(id: string): Promise<AppointmentRecord | undefined>;
  /** Active appointment for a listing, if any. */
  activeForListing(listingId: string): Promise<AppointmentRecord | undefined>;
  /** Inserts a proposed invite. False when the listing is not the owner's or the agent already has an open invite. */
  insertInvite(invite: AppointmentInvite, audit: AuditEvent): Promise<boolean>;
  /**
   * Marks the invite accepted and inserts the appointment in one transaction, withdrawing the listing's other open
   * invites. "stale" when the invite is no longer proposed for this agent; "listing_taken" when an active appointment exists.
   */
  acceptInvite(inviteId: string, agentUserId: string, appointment: AppointmentRecord, audit: AuditEvent): Promise<AcceptOutcome>;
  /** Guarded proposed -> declined (by the agent) or proposed -> withdrawn (by the owner). */
  closeInvite(inviteId: string, side: "owner" | "agent", actorId: string, to: "declined" | "withdrawn", audit: AuditEvent): Promise<boolean>;
  /** Sets revoked_at and revoked_by when the appointment is active and on a listing the owner owns. */
  revoke(appointmentId: string, ownerUserId: string, at: string, audit: AuditEvent): Promise<boolean>;
  ownerView(listingId: string): Promise<{ active: (AppointmentRecord & { agentName: string }) | null; invites: (AppointmentInvite & { agentName: string })[] }>;
  agentItems(agentUserId: string): Promise<Omit<AgentAppointmentItem, "licensed" | "granted">[]>;
  /** Replaces the permission list of an active appointment on a listing the owner owns. */
  setPermissions(appointmentId: string, ownerUserId: string, permissions: AgentPermission[], audit: AuditEvent): Promise<boolean>;
  verifiedLicences(): Promise<AgentLicence[]>;
}

export type AppointmentIds = { newId: () => string; now: () => string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL = 254;

const notFound = { ok: false, code: "not_found", message: "Not found." } as const;
// One message for unknown, non-agent, suspended and self-invites, so an owner cannot probe which accounts exist.
const cannotInvite = { ok: false, code: "invalid", message: "We could not send that invitation. Check the agent's details and try again." } as const;

export const isScope = (v: unknown): v is AppointmentScope => typeof v === "string" && (APPOINTMENT_SCOPES as readonly string[]).includes(v);

export function parseAgentRef(o: Record<string, unknown>): AgentRef | undefined {
  const id = o["agentUserId"];
  const email = o["email"];
  if ((id === undefined) === (email === undefined)) return undefined; // exactly one
  if (typeof id === "string") return UUID.test(id) ? { by: "id", userId: id.toLowerCase() } : undefined;
  if (typeof email === "string") {
    const e = email.trim().toLowerCase();
    return e.length <= MAX_EMAIL && EMAIL.test(e) ? { by: "email", email: e } : undefined;
  }
  return undefined;
}

/**
 * Optional owner choice of permissions inside the scope. Undefined keeps the whole scope. Unknown names, permissions
 * the scope does not allow (publishing needs "full") and an empty list are refused. Returned in canonical order.
 */
export function parsePermissions(raw: unknown, scope: AppointmentScope): Result<AgentPermission[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > AGENT_PERMISSIONS.length * 2 || !raw.every(isAgentPermission)) {
    return { ok: false, code: "invalid", message: "Choose at least one permission from the list." };
  }
  const ceiling = SCOPE_PERMISSIONS[scope];
  if (raw.some(p => !ceiling.includes(p))) {
    return { ok: false, code: "invalid", message: "That permission needs the full scope." };
  }
  return { ok: true, value: AGENT_PERMISSIONS.filter(p => raw.includes(p)) };
}

function audit(ids: AppointmentIds, actor: Actor, aggregateId: string, eventType: string, payload: Record<string, unknown>): AuditEvent {
  return {
    id: ids.newId(), occurredAt: ids.now(), actorType: "user", actorId: actor.userId,
    aggregateType: "agent_appointment", aggregateId, eventType, correlationId: ids.newId(), payload
  };
}

async function licensedFor(repo: AgentAppointmentRepository, now: string) {
  const licences = await repo.verifiedLicences();
  return (agentUserId: string, jurisdiction: Jurisdiction) => {
    const today = licenceLocalDate(now, jurisdiction);
    return today !== undefined && hasVerifiedLicence(licences, agentUserId, jurisdiction, today);
  };
}

/**
 * The listing's owner invites a registered agent account, choosing the scope. The agent must accept before they get
 * any access. An unlicensed agent can be invited (the owner sees them as blocked) but cannot accept.
 */
export async function inviteAgent(
  repo: AgentAppointmentRepository, actor: Actor, listingId: string, input: unknown, ids: AppointmentIds
): Promise<Result<AppointmentInvite>> {
  if (!UUID.test(listingId)) return notFound;
  const listing = await repo.getListing(listingId);
  if (!listing || listing.ownerUserId !== actor.userId) return notFound;

  if (typeof input !== "object" || input === null) return { ok: false, code: "invalid", message: "Send a JSON object." };
  const o = input as Record<string, unknown>;
  const scope = o["scope"] ?? "enquiries_and_offers";
  if (!isScope(scope)) return { ok: false, code: "invalid", message: "Scope must be enquiries_and_offers or full." };
  const ref = parseAgentRef(o);
  if (!ref) return { ok: false, code: "invalid", message: "Give the agent's user id or email address." };
  const perms = parsePermissions(o["permissions"], scope);
  if (!perms.ok) return perms;

  if (await repo.activeForListing(listingId)) {
    return { ok: false, code: "conflict", message: "This listing already has an agent. Revoke the current appointment first." };
  }
  const agent = await repo.findAgent(ref);
  if (!agent || agent.id === actor.userId || agent.userType !== "agent" || agent.status === "suspended" || agent.status === "closed") {
    return cannotInvite;
  }

  const invite: AppointmentInvite = {
    id: ids.newId(), listingId, ownerUserId: actor.userId, agentUserId: agent.id, scope,
    ...(perms.value ? { permissions: perms.value } : {}), status: "proposed", createdAt: ids.now()
  };
  const stored = await repo.insertInvite(invite, audit(ids, actor, invite.id, "agent_appointment.invited",
    { listingId, agentUserId: agent.id, scope, permissions: perms.value ?? null }));
  return stored ? { ok: true, value: invite } : { ok: false, code: "conflict", message: "This agent already has an open invitation for this listing." };
}

type InviteAction = "accept" | "decline" | "withdraw";
const isInviteAction = (v: unknown): v is InviteAction => v === "accept" || v === "decline" || v === "withdraw";

/**
 * Agent: accept or decline. Owner: withdraw. Accepting needs a verified, unexpired licence for the listing's state
 * (fail-closed) and creates the appointment; only one agent can be active on a listing.
 */
export async function respondToInvite(
  repo: AgentAppointmentRepository, actor: Actor, inviteId: string, input: unknown, ids: AppointmentIds
): Promise<Result<{ invite: AppointmentInvite; appointment?: AppointmentRecord }>> {
  if (!UUID.test(inviteId)) return notFound;
  const invite = await repo.getInvite(inviteId);
  const isOwner = !!invite && invite.ownerUserId === actor.userId;
  const isAgent = !!invite && invite.agentUserId === actor.userId;
  if (!invite || (!isOwner && !isAgent)) return notFound;

  const action = typeof input === "object" && input !== null ? (input as Record<string, unknown>)["action"] : undefined;
  if (!isInviteAction(action)) return { ok: false, code: "invalid", message: "Action must be accept, decline or withdraw." };
  if ((action === "withdraw" && !isOwner) || (action !== "withdraw" && !isAgent)) {
    return { ok: false, code: "forbidden", message: "You cannot do that on this invitation." };
  }
  if (invite.status !== "proposed") return { ok: false, code: "conflict", message: `This invitation is ${invite.status}.` };

  if (action === "accept") {
    if (actor.userType !== "agent") return { ok: false, code: "forbidden", message: "Only agent accounts can accept an appointment." };
    const listing = await repo.getListing(invite.listingId);
    const licensed = !!listing && (await licensedFor(repo, ids.now()))(actor.userId, listing.jurisdiction);
    if (!listing || !licensed) {
      return { ok: false, code: "forbidden", message: "A verified licence for this state is needed before you can accept." };
    }
    const appointment: AppointmentRecord = {
      id: ids.newId(), listingId: invite.listingId, ownerUserId: invite.ownerUserId, agentUserId: actor.userId,
      scope: invite.scope, ...(invite.permissions ? { permissions: invite.permissions } : {}), appointedAt: ids.now()
    };
    const outcome = await repo.acceptInvite(invite.id, actor.userId, appointment,
      audit(ids, actor, appointment.id, "agent_appointment.accepted", { listingId: invite.listingId, inviteId: invite.id, scope: invite.scope }));
    if (outcome === "listing_taken") return { ok: false, code: "conflict", message: "This listing already has an active agent." };
    if (outcome === "stale") return { ok: false, code: "conflict", message: "This invitation changed. Refresh and try again." };
    return { ok: true, value: { invite: { ...invite, status: "accepted" }, appointment } };
  }

  const to = action === "decline" ? "declined" : "withdrawn";
  const closed = await repo.closeInvite(invite.id, isOwner && action === "withdraw" ? "owner" : "agent", actor.userId, to,
    audit(ids, actor, invite.id, `agent_appointment.${to}`, { listingId: invite.listingId }));
  return closed
    ? { ok: true, value: { invite: { ...invite, status: to } } }
    : { ok: false, code: "conflict", message: "This invitation changed. Refresh and try again." };
}

/** The owner revokes an active appointment. The agent loses access at once; the revocation is audited. */
export async function revokeAppointment(
  repo: AgentAppointmentRepository, actor: Actor, appointmentId: string, ids: AppointmentIds
): Promise<Result<AppointmentRecord>> {
  if (!UUID.test(appointmentId)) return notFound;
  const a = await repo.getAppointment(appointmentId);
  if (!a || a.ownerUserId !== actor.userId) return notFound;
  if (a.revokedAt) return { ok: false, code: "conflict", message: "This appointment is already revoked." };
  const at = ids.now();
  const done = await repo.revoke(a.id, actor.userId, at,
    audit(ids, actor, a.id, "agent_appointment.revoked", { listingId: a.listingId, agentUserId: a.agentUserId }));
  return done ? { ok: true, value: { ...a, revokedAt: at } } : { ok: false, code: "conflict", message: "This appointment changed. Refresh and try again." };
}

/**
 * The owner changes what the active agent may do, within the appointment's scope. Takes effect on the agent's next
 * request (every agent check reads the stored list). Audited with the old and new lists.
 */
export async function setAgentPermissions(
  repo: AgentAppointmentRepository, actor: Actor, appointmentId: string, input: unknown, ids: AppointmentIds
): Promise<Result<AppointmentRecord>> {
  if (!UUID.test(appointmentId)) return notFound;
  const a = await repo.getAppointment(appointmentId);
  if (!a || a.ownerUserId !== actor.userId) return notFound;
  if (a.revokedAt) return { ok: false, code: "conflict", message: "This appointment is revoked." };
  const raw = typeof input === "object" && input !== null ? (input as Record<string, unknown>)["permissions"] : undefined;
  const perms = parsePermissions(raw, a.scope);
  if (!perms.ok) return perms;
  if (!perms.value) return { ok: false, code: "invalid", message: "Choose at least one permission from the list." };
  const done = await repo.setPermissions(a.id, actor.userId, perms.value, audit(ids, actor, a.id, "agent_appointment.permissions_changed",
    { listingId: a.listingId, from: agentPermissions(a), to: perms.value }));
  return done ? { ok: true, value: { ...a, permissions: perms.value } } : { ok: false, code: "conflict", message: "This appointment changed. Refresh and try again." };
}

/** The owner's view of a listing's agent: the active appointment and open invitations, each with licence status. */
export async function ownerAgentView(
  repo: AgentAppointmentRepository, actor: Actor, listingId: string, now: string
): Promise<Result<OwnerAgentView>> {
  if (!UUID.test(listingId)) return notFound;
  const listing = await repo.getListing(listingId);
  if (!listing || listing.ownerUserId !== actor.userId) return notFound;
  const view = await repo.ownerView(listingId);
  const licensed = await licensedFor(repo, now);
  return {
    ok: true,
    value: {
      active: view.active
        ? { ...view.active, licensed: licensed(view.active.agentUserId, listing.jurisdiction), granted: agentPermissions(view.active) }
        : null,
      invites: view.invites.map(i => ({ ...i, licensed: licensed(i.agentUserId, listing.jurisdiction), granted: agentPermissions(i) }))
    }
  };
}

/** The signed-in agent's open invitations and active appointments, invitations first. */
export async function agentAppointments(
  repo: AgentAppointmentRepository, actor: Actor, now: string
): Promise<Result<AgentAppointmentItem[]>> {
  if (actor.userType !== "agent") return { ok: false, code: "forbidden", message: "Only agent accounts have appointments." };
  const licensed = await licensedFor(repo, now);
  const items = (await repo.agentItems(actor.userId))
    .map(i => ({ ...i, granted: agentPermissions(i), licensed: licensed(actor.userId, i.jurisdiction) }));
  items.sort((a, b) => (a.kind === b.kind ? (a.since < b.since ? 1 : a.since > b.since ? -1 : 0) : a.kind === "invite" ? -1 : 1));
  return { ok: true, value: items };
}

export function createInMemoryAgentAppointmentRepository(seed: {
  listings?: { id: string; ownerUserId: string; jurisdiction: Jurisdiction; title?: string }[];
  users?: (AgentAccount & { email?: string; displayName?: string })[];
  invites?: AppointmentInvite[];
  appointments?: AppointmentRecord[];
  licences?: AgentLicence[];
} = {}): AgentAppointmentRepository & { invites: AppointmentInvite[]; appointments: AppointmentRecord[]; audits: AuditEvent[] } {
  const listings = seed.listings ?? [];
  const users = seed.users ?? [];
  const invites = seed.invites ?? [];
  const appointments = seed.appointments ?? [];
  const audits: AuditEvent[] = [];
  const nameOf = (id: string) => users.find(u => u.id === id)?.displayName ?? "User";
  const active = (listingId: string) => appointments.find(a => a.listingId === listingId && !a.revokedAt);
  return {
    invites, appointments, audits,
    async getListing(id) {
      const l = listings.find(x => x.id === id);
      return l ? { ownerUserId: l.ownerUserId, jurisdiction: l.jurisdiction, title: l.title ?? "Listing" } : undefined;
    },
    async findAgent(ref) {
      const u = ref.by === "id" ? users.find(x => x.id === ref.userId) : users.find(x => x.email?.toLowerCase() === ref.email);
      return u ? { id: u.id, userType: u.userType, status: u.status } : undefined;
    },
    async getInvite(id) { const i = invites.find(x => x.id === id); return i ? { ...i } : undefined; },
    async getAppointment(id) { const a = appointments.find(x => x.id === id); return a ? { ...a } : undefined; },
    async activeForListing(listingId) { const a = active(listingId); return a ? { ...a } : undefined; },
    async insertInvite(invite, a) {
      const l = listings.find(x => x.id === invite.listingId);
      const dup = invites.some(x => x.listingId === invite.listingId && x.agentUserId === invite.agentUserId && x.status === "proposed");
      if (!l || l.ownerUserId !== invite.ownerUserId || dup) return false;
      invites.push({ ...invite });
      audits.push(a);
      return true;
    },
    async acceptInvite(inviteId, agentUserId, appointment, a) {
      const i = invites.find(x => x.id === inviteId);
      if (!i || i.status !== "proposed" || i.agentUserId !== agentUserId) return "stale";
      if (active(i.listingId)) return "listing_taken";
      i.status = "accepted";
      for (const other of invites) if (other.listingId === i.listingId && other.status === "proposed") other.status = "withdrawn";
      appointments.push({ ...appointment });
      audits.push(a);
      return "accepted";
    },
    async closeInvite(inviteId, side, actorId, to, a) {
      const i = invites.find(x => x.id === inviteId);
      if (!i || i.status !== "proposed" || (side === "owner" ? i.ownerUserId : i.agentUserId) !== actorId) return false;
      i.status = to;
      audits.push(a);
      return true;
    },
    async revoke(appointmentId, ownerUserId, at, a) {
      const x = appointments.find(y => y.id === appointmentId);
      if (!x || x.revokedAt || x.ownerUserId !== ownerUserId) return false;
      x.revokedAt = at;
      audits.push(a);
      return true;
    },
    async ownerView(listingId) {
      const act = active(listingId);
      return {
        active: act ? { ...act, agentName: nameOf(act.agentUserId) } : null,
        invites: invites.filter(i => i.listingId === listingId && i.status === "proposed").map(i => ({ ...i, agentName: nameOf(i.agentUserId) }))
      };
    },
    async agentItems(agentUserId) {
      const listing = (id: string) => listings.find(l => l.id === id);
      const open = invites.filter(i => i.agentUserId === agentUserId && i.status === "proposed").flatMap(i => {
        const l = listing(i.listingId);
        return l ? [{ kind: "invite" as const, id: i.id, listingId: i.listingId, listingTitle: l.title ?? "Listing", jurisdiction: l.jurisdiction,
          ownerName: nameOf(i.ownerUserId), scope: i.scope, ...(i.permissions ? { permissions: i.permissions } : {}), since: i.createdAt }] : [];
      });
      const live = appointments.filter(a => a.agentUserId === agentUserId && !a.revokedAt).flatMap(a => {
        const l = listing(a.listingId);
        return l ? [{ kind: "appointment" as const, id: a.id, listingId: a.listingId, listingTitle: l.title ?? "Listing", jurisdiction: l.jurisdiction,
          ownerName: nameOf(a.ownerUserId), scope: a.scope, ...(a.permissions ? { permissions: a.permissions } : {}), since: a.appointedAt }] : [];
      });
      return [...open, ...live];
    },
    async setPermissions(appointmentId, ownerUserId, permissions, a) {
      const x = appointments.find(y => y.id === appointmentId);
      if (!x || x.revokedAt || x.ownerUserId !== ownerUserId) return false;
      x.permissions = [...permissions];
      audits.push(a);
      return true;
    },
    async verifiedLicences() { return seed.licences ?? []; }
  };
}

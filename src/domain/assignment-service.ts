import type { AuditEvent } from "./audit";
import type { AssignmentStatus, JobAssignment } from "./job-chat";
import { hasVerifiedLicence, type AgentLicence } from "./licence";
import type { Jurisdiction } from "./jurisdiction";
import type { Actor, Result } from "./listing-service";
import { licenceLocalDate } from "./timezone";

export const ASSIGNMENT_KINDS = ["photographer", "solicitor", "inspector", "agent"] as const;
export type AssignmentKind = typeof ASSIGNMENT_KINDS[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL = 254;

export type ContractorRef = { by: "id"; userId: string } | { by: "email"; email: string };

/** A registered account a contractor invitation could go to. Never created by this code. */
export interface ContractorAccount { id: string; userType: string; status: string }

export interface AssignmentSummary {
  id: string;
  listingId: string;
  listingTitle: string;
  kind: AssignmentKind;
  status: AssignmentStatus;
  /** The signed-in user's side of this assignment. */
  role: "owner" | "contractor";
  /** Display name of the other party. Email addresses are never returned. */
  counterpartName: string;
}

export interface Transition {
  id: string;
  actorId: string;
  /** Which column must equal actorId: the owner or the contractor on the assignment row. */
  side: "owner" | "contractor";
  from: readonly AssignmentStatus[];
  to: AssignmentStatus;
}

/**
 * Storage for contractor assignment. Writes carry their audit event so the implementation can store both
 * in one statement: a transition never exists without its audit record. Nothing here deletes anything.
 */
export interface AssignmentRepository {
  getListing(id: string): Promise<{ ownerUserId: string; jurisdiction: Jurisdiction } | undefined>;
  findContractor(ref: ContractorRef): Promise<ContractorAccount | undefined>;
  getAssignment(id: string): Promise<JobAssignment | undefined>;
  /** Inserts a 'proposed' assignment only if the listing is owned by a.ownerUserId and no live duplicate exists. */
  insertProposed(a: JobAssignment, audit: AuditEvent): Promise<boolean>;
  /** Guarded single-statement status change. False when the row no longer matches (raced or not a party). */
  transition(t: Transition, audit: AuditEvent): Promise<boolean>;
  /** Assignments where userId is the owner or the contractor, optionally for one listing. */
  listForUser(userId: string, listingId?: string): Promise<AssignmentSummary[]>;
  verifiedLicences(): Promise<AgentLicence[]>;
}

export type AssignmentIds = { newId: () => string; now: () => string };

const notFound = { ok: false, code: "not_found", message: "Not found." } as const;
// One message for unknown, ineligible and self-invites, so an owner cannot probe which accounts exist.
const cannotInvite = { ok: false, code: "invalid", message: "We could not send that invitation. Check the details and try again." } as const;

const isKind = (v: unknown): v is AssignmentKind => typeof v === "string" && (ASSIGNMENT_KINDS as readonly string[]).includes(v);

function parseContractorRef(o: Record<string, unknown>): ContractorRef | undefined {
  const id = o["contractorUserId"];
  const email = o["email"];
  if ((id === undefined) === (email === undefined)) return undefined; // exactly one
  if (typeof id === "string") return UUID.test(id) ? { by: "id", userId: id.toLowerCase() } : undefined;
  if (typeof email === "string") {
    const e = email.trim().toLowerCase();
    return e.length <= MAX_EMAIL && EMAIL.test(e) ? { by: "email", email: e } : undefined;
  }
  return undefined;
}

/** Contractor accounts that can be invited. Suspended or closed accounts never can. */
function eligible(kind: AssignmentKind, c: ContractorAccount): boolean {
  if (c.status === "suspended" || c.status === "closed") return false;
  return kind === "agent" ? c.userType === "agent" : c.userType === "vendor" || c.userType === "agent";
}

function auditEvent(ids: AssignmentIds, actor: Actor, a: JobAssignment, eventType: string, from: string | null): AuditEvent {
  return {
    id: ids.newId(), occurredAt: ids.now(), actorType: "user", actorId: actor.userId,
    aggregateType: "job_assignment", aggregateId: a.id, eventType, correlationId: ids.newId(),
    payload: { listingId: a.listingId, kind: a.kind, from, to: eventType === "assignment.invited" ? "proposed" : a.status }
  };
}

/** The owner invites a registered contractor. The owner id comes from the session, never the body. */
export async function inviteContractor(
  repo: AssignmentRepository, actor: Actor, listingId: string, input: unknown, ids: AssignmentIds
): Promise<Result<JobAssignment>> {
  if (!UUID.test(listingId)) return notFound;
  const listing = await repo.getListing(listingId);
  if (!listing || listing.ownerUserId !== actor.userId) return notFound;

  if (typeof input !== "object" || input === null) return { ok: false, code: "invalid", message: "Send a JSON object." };
  const o = input as Record<string, unknown>;
  const kind = o["kind"];
  if (!isKind(kind)) return { ok: false, code: "invalid", message: "Choose photographer, solicitor, inspector or agent." };
  const ref = parseContractorRef(o);
  if (!ref) return { ok: false, code: "invalid", message: "Give the contractor's user id or email address." };

  const contractor = await repo.findContractor(ref);
  if (!contractor || contractor.id === actor.userId || !eligible(kind, contractor)) return cannotInvite;

  const a: JobAssignment = {
    id: ids.newId(), listingId, ownerUserId: actor.userId, contractorUserId: contractor.id, kind, status: "proposed"
  };
  const stored = await repo.insertProposed(a, auditEvent(ids, actor, a, "assignment.invited", null));
  return stored
    ? { ok: true, value: a }
    : { ok: false, code: "conflict", message: "This contractor already has a live job of that kind on this listing." };
}

type Action = "accept" | "decline" | "cancel" | "complete";
const RULES: Record<Action, { side: "owner" | "contractor"; from: readonly AssignmentStatus[]; to: AssignmentStatus; event: string }> = {
  accept: { side: "contractor", from: ["proposed"], to: "approved", event: "assignment.accepted" },
  decline: { side: "contractor", from: ["proposed"], to: "cancelled", event: "assignment.declined" },
  cancel: { side: "owner", from: ["proposed", "approved"], to: "cancelled", event: "assignment.cancelled" },
  complete: { side: "owner", from: ["approved"], to: "completed", event: "assignment.completed" }
};
const isAction = (v: unknown): v is Action => typeof v === "string" && Object.prototype.hasOwnProperty.call(RULES, v);

/**
 * Moves an assignment along proposed -> approved -> completed, or to cancelled. Only the named party may act.
 * Accepting an 'agent' assignment still needs a verified, unexpired licence in the listing's state (same
 * check as publishing); it is fail-closed.
 */
export async function respondToAssignment(
  repo: AssignmentRepository, actor: Actor, assignmentId: string, input: unknown, ids: AssignmentIds
): Promise<Result<JobAssignment>> {
  if (!UUID.test(assignmentId)) return notFound;
  const a = await repo.getAssignment(assignmentId);
  const isOwner = !!a && a.ownerUserId === actor.userId;
  const isContractor = !!a && a.contractorUserId === actor.userId;
  if (!a || (!isOwner && !isContractor)) return notFound;

  const action = typeof input === "object" && input !== null ? (input as Record<string, unknown>)["action"] : undefined;
  if (!isAction(action)) return { ok: false, code: "invalid", message: "Action must be accept, decline, cancel or complete." };
  const rule = RULES[action];
  if ((rule.side === "owner" && !isOwner) || (rule.side === "contractor" && !isContractor)) {
    return { ok: false, code: "forbidden", message: "You cannot do that on this job." };
  }
  if (!rule.from.includes(a.status)) {
    return { ok: false, code: "conflict", message: `This job is ${a.status}, so it cannot be changed that way.` };
  }

  if (action === "accept" && a.kind === "agent") {
    const listing = await repo.getListing(a.listingId);
    const today = listing ? licenceLocalDate(ids.now(), listing.jurisdiction) : undefined; // undefined fails closed
    const licensed = !!listing && today !== undefined && hasVerifiedLicence(await repo.verifiedLicences(), a.contractorUserId, listing.jurisdiction, today);
    if (!licensed) return { ok: false, code: "forbidden", message: "A verified licence for this state is needed before accepting an agent job." };
  }

  const next: JobAssignment = { ...a, status: rule.to };
  const moved = await repo.transition(
    { id: a.id, actorId: actor.userId, side: rule.side, from: rule.from, to: rule.to },
    auditEvent(ids, actor, next, rule.event, a.status)
  );
  return moved ? { ok: true, value: next } : { ok: false, code: "conflict", message: "This job changed. Refresh and try again." };
}

/** Lists the signed-in user's own assignments (as owner or as contractor). Owner-only when scoped to a listing. */
export async function listAssignments(
  repo: AssignmentRepository, actor: Actor, listingId?: string
): Promise<Result<AssignmentSummary[]>> {
  if (listingId !== undefined) {
    if (!UUID.test(listingId)) return notFound;
    const listing = await repo.getListing(listingId);
    if (!listing || listing.ownerUserId !== actor.userId) return notFound;
  }
  return { ok: true, value: await repo.listForUser(actor.userId, listingId) };
}

export function createInMemoryAssignmentRepository(seed: {
  listings?: { id: string; ownerUserId: string; jurisdiction: Jurisdiction; title?: string }[];
  users?: (ContractorAccount & { email?: string; displayName?: string })[];
  assignments?: JobAssignment[];
  licences?: AgentLicence[];
} = {}): AssignmentRepository & { assignments: JobAssignment[]; audits: AuditEvent[] } {
  const listings = seed.listings ?? [];
  const users = seed.users ?? [];
  const assignments = seed.assignments ?? [];
  const audits: AuditEvent[] = [];
  const nameOf = (id: string) => users.find(u => u.id === id)?.displayName ?? "User";
  return {
    assignments, audits,
    async getListing(id) { return listings.find(l => l.id === id); },
    async findContractor(ref) {
      const u = ref.by === "id" ? users.find(x => x.id === ref.userId) : users.find(x => x.email?.toLowerCase() === ref.email);
      return u ? { id: u.id, userType: u.userType, status: u.status } : undefined;
    },
    async getAssignment(id) { const a = assignments.find(x => x.id === id); return a ? { ...a } : undefined; },
    async insertProposed(a, audit) {
      const l = listings.find(x => x.id === a.listingId);
      const dup = assignments.some(x => x.listingId === a.listingId && x.contractorUserId === a.contractorUserId &&
        x.kind === a.kind && (x.status === "proposed" || x.status === "approved"));
      if (!l || l.ownerUserId !== a.ownerUserId || dup) return false;
      assignments.push({ ...a });
      audits.push(audit);
      return true;
    },
    async transition(t, audit) {
      const a = assignments.find(x => x.id === t.id);
      if (!a || !t.from.includes(a.status)) return false;
      if ((t.side === "owner" ? a.ownerUserId : a.contractorUserId) !== t.actorId) return false;
      a.status = t.to;
      audits.push(audit);
      return true;
    },
    async listForUser(userId, listingId) {
      return assignments
        .filter(a => (a.ownerUserId === userId || a.contractorUserId === userId) && (listingId === undefined || a.listingId === listingId))
        .map(a => {
          const role = a.ownerUserId === userId ? "owner" as const : "contractor" as const;
          return {
            id: a.id, listingId: a.listingId, listingTitle: listings.find(l => l.id === a.listingId)?.title ?? "Listing",
            kind: a.kind as AssignmentKind, status: a.status, role,
            counterpartName: nameOf(role === "owner" ? a.contractorUserId : a.ownerUserId)
          };
        });
    },
    async verifiedLicences() { return seed.licences ?? []; }
  };
}

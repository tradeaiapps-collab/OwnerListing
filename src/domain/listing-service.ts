import type { AuditEvent } from "./audit";
import { isJurisdiction, type Jurisdiction } from "./jurisdiction";
import type { PropertyListing, PropertyType, PublishDecision, UseClass } from "./listing";
import { decidePublish, type BondPathway } from "./publish";
import { canActOnListing, type AgentAppointment } from "./access";
import { transitionListing } from "./listing-transitions";
import type { TrustAccountDecision } from "./trust-account";
import type { AgentLicence } from "./licence";

export const PROPERTY_TYPES = [
  "house", "unit", "townhouse", "land",
  "office", "retail", "industrial", "warehouse", "hospitality", "other"
] as const satisfies readonly PropertyType[];
export const USE_CLASSES = ["residential", "commercial"] as const satisfies readonly UseClass[];
export const TRANSACTION_TYPES = ["sale", "rent"] as const;
export const BOND_PATHWAYS = ["state_bond_authority", "solicitor_trust", "bank_guarantee", "no_bond"] as const;

export interface Actor {
  userId: string;
  userType: "owner" | "agent" | "buyer";
}

/** A listing plus the platform facts that gate publishing. Fee and terms come from billing and terms modules. */
export interface ListingRecord {
  listing: PropertyListing;
  listingFeePaid: boolean;
  termsAccepted: boolean;
  /** Rentals only. Undefined until confirmed; publish stays blocked for rentals until set. */
  rentalBondPathway?: BondPathway;
}

export interface ListingRepository {
  insert(record: ListingRecord): Promise<void>;
  save(record: ListingRecord): Promise<void>;
  get(id: string): Promise<ListingRecord | undefined>;
  list(): Promise<ListingRecord[]>;
  /** One owner's listings, newest first. The owner id always comes from the signed-in actor. */
  listByOwner(ownerUserId: string): Promise<ListingRecord[]>;
}

export interface ListingServiceDeps {
  repo: ListingRepository;
  appendAudit: (event: AuditEvent) => Promise<void>;
  now: () => string;
  newId: () => string;
  /** Compliance-owned. Null means no approved configuration, so publishing is blocked. */
  requiredDisclosures: (
    j: Jurisdiction, tx: "sale" | "rent", use: UseClass
  ) => readonly string[] | null;
  /** Trust account decision for the listing. Undefined means none yet, so publishing is blocked. */
  trustAccountFor?: (listingId: string) => Promise<TrustAccountDecision | undefined>;
  licences?: () => Promise<readonly AgentLicence[]>;
  /** The active appointment of an agent to a listing, if any. */
  appointmentFor?: (listingId: string, agentUserId: string) => Promise<AgentAppointment | undefined>;
  /** True when the user accepted the terms version in force now. When set, publishing needs it for the owner and the actor. */
  termsCurrentFor?: (userId: string) => Promise<boolean>;
}

export interface DraftInput {
  title: string;
  address: string;
  jurisdiction: Jurisdiction;
  transactionType: "sale" | "rent";
  useClass: UseClass;
  propertyType: PropertyType;
}

/** rentalBondPathway is stored on the record, not the listing; see updateDraft. */
export type DraftPatch = Partial<DraftInput> & { rentalBondPathway?: BondPathway };

export type Failure = { ok: false; code: "invalid" | "not_found" | "forbidden" | "conflict" | "rate_limited"; message: string };
export type Result<T> = { ok: true; value: T } | Failure;

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : undefined;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === "string" ? allowed.find(a => a === v) : undefined;
}

/** Validates a full draft. Every field is required. */
export function parseDraftInput(body: unknown): Result<DraftInput> {
  if (typeof body !== "object" || body === null) return fail("invalid", "Invalid input.");
  const b = body as Record<string, unknown>;
  const title = str(b["title"], 200);
  const address = str(b["address"], 300);
  const jurisdiction = typeof b["jurisdiction"] === "string" && isJurisdiction(b["jurisdiction"]) ? b["jurisdiction"] : undefined;
  const transactionType = oneOf(b["transactionType"], TRANSACTION_TYPES);
  const useClass = oneOf(b["useClass"], USE_CLASSES);
  const propertyType = oneOf(b["propertyType"], PROPERTY_TYPES);
  if (!title || !address || !jurisdiction || !transactionType || !useClass || !propertyType) {
    return fail("invalid", "Title, address, state, sale or rent, use and property type are all required.");
  }
  return { ok: true, value: { title, address, jurisdiction, transactionType, useClass, propertyType } };
}

/** Validates a partial update. Only known fields are kept; unknown fields are ignored. */
export function parseDraftPatch(body: unknown): Result<DraftPatch> {
  if (typeof body !== "object" || body === null) return fail("invalid", "Invalid input.");
  const b = body as Record<string, unknown>;
  const patch: DraftPatch = {};
  if ("title" in b) { const v = str(b["title"], 200); if (!v) return fail("invalid", "Invalid title."); patch.title = v; }
  if ("address" in b) { const v = str(b["address"], 300); if (!v) return fail("invalid", "Invalid address."); patch.address = v; }
  if ("jurisdiction" in b) {
    const v = b["jurisdiction"];
    if (typeof v !== "string" || !isJurisdiction(v)) return fail("invalid", "Invalid state.");
    patch.jurisdiction = v;
  }
  if ("transactionType" in b) { const v = oneOf(b["transactionType"], TRANSACTION_TYPES); if (!v) return fail("invalid", "Invalid transaction type."); patch.transactionType = v; }
  if ("useClass" in b) { const v = oneOf(b["useClass"], USE_CLASSES); if (!v) return fail("invalid", "Invalid use."); patch.useClass = v; }
  if ("propertyType" in b) { const v = oneOf(b["propertyType"], PROPERTY_TYPES); if (!v) return fail("invalid", "Invalid property type."); patch.propertyType = v; }
  if ("rentalBondPathway" in b) { const v = oneOf(b["rentalBondPathway"], BOND_PATHWAYS); if (!v) return fail("invalid", "Invalid bond pathway."); patch.rentalBondPathway = v; }
  if (Object.keys(patch).length === 0) return fail("invalid", "Nothing to update.");
  return { ok: true, value: patch };
}

export async function createDraft(deps: ListingServiceDeps, actor: Actor, input: DraftInput): Promise<PropertyListing> {
  const now = deps.now();
  const listing: PropertyListing = {
    id: deps.newId(),
    ownerUserId: actor.userId,
    ownerUserType: actor.userType,
    jurisdiction: input.jurisdiction,
    status: "draft",
    title: input.title,
    propertyType: input.propertyType,
    useClass: input.useClass,
    transactionType: input.transactionType,
    address: input.address,
    disclosures: [],
    createdAt: now,
    updatedAt: now
  };
  await deps.repo.insert({ listing, listingFeePaid: false, termsAccepted: false });
  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: actor.userId,
    aggregateType: "listing", aggregateId: listing.id, eventType: "listing.created",
    correlationId: deps.newId(), payload: {}
  });
  return listing;
}

/** Visible to anyone once published; otherwise only to its owner. */
export async function getListing(deps: ListingServiceDeps, actor: Actor | null, id: string): Promise<Result<PropertyListing>> {
  const rec = await deps.repo.get(id);
  if (!rec) return fail("not_found", "Listing not found.");
  const l = rec.listing;
  if (l.status !== "published" && l.ownerUserId !== actor?.userId) return fail("not_found", "Listing not found.");
  return { ok: true, value: l };
}

export async function updateDraft(deps: ListingServiceDeps, actor: Actor, id: string, patch: DraftPatch): Promise<Result<PropertyListing>> {
  const rec = await deps.repo.get(id);
  if (!rec || rec.listing.ownerUserId !== actor.userId) return fail("not_found", "Listing not found.");
  if (rec.listing.status !== "draft") return fail("conflict", "Only a draft can be edited.");
  const { rentalBondPathway, ...listingPatch } = patch;
  const listing: PropertyListing = { ...rec.listing, ...listingPatch, updatedAt: deps.now() };
  await deps.repo.save({ ...rec, listing, ...(rentalBondPathway !== undefined ? { rentalBondPathway } : {}) });
  return { ok: true, value: listing };
}

export interface SearchFilters {
  jurisdiction?: Jurisdiction;
  transactionType?: "sale" | "rent";
  useClass?: UseClass;
}

/** Published listings only, newest first. */
/** The signed-in user's own listings (drafts and published), newest first. */
export async function listMyListings(deps: ListingServiceDeps, actor: Actor): Promise<PropertyListing[]> {
  return (await deps.repo.listByOwner(actor.userId)).map(r => r.listing);
}

/** What a public viewer may see. Internal ownership fields never leave the server. */
export type PublicListing = Omit<PropertyListing, "ownerUserId" | "ownerUserType">;

export function toPublicListing(l: PropertyListing): PublicListing {
  const { ownerUserId: _ownerUserId, ownerUserType: _ownerUserType, ...pub } = l;
  return pub;
}

export async function searchPublished(deps: ListingServiceDeps, f: SearchFilters): Promise<PropertyListing[]> {
  const all = await deps.repo.list();
  return all
    .map(r => r.listing)
    .filter(l =>
      l.status === "published" &&
      (f.jurisdiction === undefined || l.jurisdiction === f.jurisdiction) &&
      (f.transactionType === undefined || l.transactionType === f.transactionType) &&
      (f.useClass === undefined || l.useClass === f.useClass))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/**
 * Runs the publish gate for the owner's listing. With dryRun nothing changes. Otherwise an allowed decision moves
 * the listing draft -> pending_review -> published, with an audit event for each step.
 */
export async function publishListing(
  deps: ListingServiceDeps, actor: Actor, id: string, dryRun: boolean
): Promise<Result<{ decision: PublishDecision; listing: PropertyListing }>> {
  const rec = await deps.repo.get(id);
  if (!rec) return fail("not_found", "Listing not found.");
  const l = rec.listing;
  // The owner publishes. An agent may publish only with an active appointment of scope "full".
  // Anyone else gets not_found, the same as an unknown listing.
  const isOwner = l.ownerUserId === actor.userId;
  let actingAgent: string | undefined;
  if (!isOwner) {
    const appointment = deps.appointmentFor ? await deps.appointmentFor(l.id, actor.userId) : undefined;
    if (!appointment || !canActOnListing({ id: actor.userId, role: actor.userType }, l, "listing.publish", appointment)) {
      return fail("not_found", "Listing not found.");
    }
    actingAgent = actor.userId;
  }

  const now = deps.now();
  const required = deps.requiredDisclosures(l.jurisdiction, l.transactionType, l.useClass);
  let decision: PublishDecision;
  if (required === null) {
    decision = {
      allowed: false,
      reasons: [`No compliance-approved disclosure configuration for ${l.jurisdiction} ${l.transactionType} (${l.useClass}) yet.`]
    };
  } else {
    const trustAccount = deps.trustAccountFor ? await deps.trustAccountFor(l.id) : undefined;
    const licences = deps.licences ? await deps.licences() : [];
    // With the terms check wired, the accepted-version log decides (owner and actor); the stored flag is the fallback.
    const termsAccepted = deps.termsCurrentFor
      ? (await Promise.all([...new Set([l.ownerUserId, actor.userId])].map(deps.termsCurrentFor))).every(Boolean)
      : rec.termsAccepted;
    decision = decidePublish(l, required, licences, now, {
      termsAccepted,
      listingFeePaid: rec.listingFeePaid,
      ...(rec.rentalBondPathway ? { rentalBondPathway: rec.rentalBondPathway } : {}),
      ...(actingAgent ? { actingAgentId: actingAgent } : {}),
      ...(trustAccount ? { trustAccount } : {})
    });
  }

  if (dryRun || !decision.allowed) return { ok: true, value: { decision, listing: l } };

  const ctx = { correlationId: deps.newId(), actorType: "user" as const, actorId: actor.userId, now };
  let current = l;
  if (current.status === "draft") {
    const step = transitionListing(current, "pending_review", { ...ctx, eventId: deps.newId() });
    current = step.listing;
    await deps.appendAudit(step.event);
  }
  const done = transitionListing(current, "published", { ...ctx, eventId: deps.newId() }, decision);
  await deps.appendAudit(done.event);
  await deps.repo.save({ ...rec, listing: done.listing });
  return { ok: true, value: { decision, listing: done.listing } };
}

export function createInMemoryListingRepository(): ListingRepository & { clear(): void } {
  const rows = new Map<string, ListingRecord>();
  return {
    async insert(r) { rows.set(r.listing.id, r); },
    async save(r) { rows.set(r.listing.id, r); },
    async get(id) { return rows.get(id); },
    async list() { return [...rows.values()]; },
    async listByOwner(ownerUserId) {
      return [...rows.values()].filter(r => r.listing.ownerUserId === ownerUserId).sort((x, y) => y.listing.createdAt.localeCompare(x.listing.createdAt));
    },
    clear() { rows.clear(); }
  };
}

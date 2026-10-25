import type { AuditEvent } from "./audit";
import { isJurisdiction, type Jurisdiction } from "./jurisdiction";
import type { PropertyListing, PropertyType, PublishDecision, UseClass } from "./listing";
import { decidePublish, type BondPathway } from "./publish";
import { canActOnListing, type AgentAppointment } from "./access";
import { applyDetails, DETAIL_KEYS, parseDetails, priceError, type DetailsPatch, type ListingDetails } from "./listing-details";
import { searchInMemory, type SearchPage, type SearchQuery } from "./listing-search";
import { transitionListing } from "./listing-transitions";
import type { TrustAccountDecision } from "./trust-account";
import type { AgentLicence } from "./licence";
import { scanFields, wordingBlockReasons, type FieldFlags } from "./discrimination-filter";

export const PROPERTY_TYPES = [
  "house", "unit", "townhouse", "land",
  "office", "retail", "industrial", "warehouse", "hospitality", "other"
] as const satisfies readonly PropertyType[];
export const USE_CLASSES = ["residential", "commercial"] as const satisfies readonly UseClass[];
export const TRANSACTION_TYPES = ["sale", "rent"] as const;
export const BOND_PATHWAYS = ["state_bond_authority", "solicitor_trust", "bank_guarantee", "no_bond"] as const;
export const MAX_DESCRIPTION_LENGTH = 5000;

export interface Actor {
  userId: string;
  userType: "owner" | "agent" | "buyer" | "vendor";
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
  /** Published listings only: filtered, sorted and paged. */
  search(q: SearchQuery): Promise<SearchPage<ListingRecord>>;
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
  /** Post-publish hook (saved-search alerts). Runs after the listing is saved as published; it can never block or fail publishing. */
  afterPublish?: (listing: PropertyListing) => Promise<unknown>;
  /** Wording matches staff cleared for this listing (flagKey values). Unreadable = none cleared (fails closed). */
  clearedWordingFlags?: (listingId: string) => Promise<ReadonlySet<string>>;
  /** Records blocking wording flags from a real publish attempt so staff can review them. Best effort; never unblocks. */
  recordWordingFlags?: (listingId: string, actorUserId: string, fields: readonly FieldFlags[]) => Promise<void>;
  /**
   * Versioned, Compliance-approved requirements (spec 6.1). When wired it replaces `requiredDisclosures`: the approved version's id
   * and the keys for the listing's property type, or null when that combination has no approved version (publishing blocked).
   * A failure to read it blocks publishing too.
   */
  disclosureRequirements?: (listing: PropertyListing) => Promise<{ versionId: string; keys: readonly string[] } | null>;
  /** Stores the requirements version a listing passed when it was published, so later versions never unpublish it. */
  markDisclosureVersion?: (listingId: string, versionId: string) => Promise<void>;
}

/** Hook budget: a slow hook is abandoned (not awaited further) so publishing returns promptly. */
export const AFTER_PUBLISH_TIMEOUT_MS = 3000;

async function runAfterPublish(hook: (l: PropertyListing) => Promise<unknown>, listing: PropertyListing): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = Promise.resolve().then(() => hook(listing));
    run.catch(() => undefined);
    await Promise.race([run, new Promise<void>(resolve => { timer = setTimeout(resolve, AFTER_PUBLISH_TIMEOUT_MS); })]);
  } catch {
    // Alerts are best effort; a failing hook must not undo or fail a publish.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface DraftInput {
  title: string;
  address: string;
  jurisdiction: Jurisdiction;
  transactionType: "sale" | "rent";
  useClass: UseClass;
  propertyType: PropertyType;
}
export type DraftCreate = DraftInput & ListingDetails & { description?: string };

/** rentalBondPathway is stored on the record, not the listing; see updateDraft. A null detail clears it. */
export type DraftPatch = Partial<DraftInput> & DetailsPatch & { rentalBondPathway?: BondPathway; description?: string | null };

export type Failure = { ok: false; code: "invalid" | "not_found" | "forbidden" | "conflict" | "rate_limited" | "unavailable"; message: string };
export type Result<T> = { ok: true; value: T } | Failure;

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : undefined;
}

/** Optional description: blank clears it (null), otherwise trimmed text up to MAX_DESCRIPTION_LENGTH. */
function description(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  const t = v.trim();
  if (t.length > MAX_DESCRIPTION_LENGTH) return { ok: false };
  return { ok: true, value: t.length > 0 ? t : null };
}

const DESCRIPTION_ERROR = `Description must be text of up to ${MAX_DESCRIPTION_LENGTH} characters.`;

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === "string" ? allowed.find(a => a === v) : undefined;
}

/** Validates a full draft. Every field is required. */
export function parseDraftInput(body: unknown): Result<DraftCreate> {
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
  const details = parseDetails(b, transactionType);
  if (!details.ok) return fail("invalid", details.message);
  const desc = b["description"] === undefined ? { ok: true as const, value: null } : description(b["description"]);
  if (!desc.ok) return fail("invalid", DESCRIPTION_ERROR);
  const value = applyDetails<DraftCreate>({ title, address, jurisdiction, transactionType, useClass, propertyType }, details.value);
  return { ok: true, value: desc.value !== null ? { ...value, description: desc.value } : value };
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
  if (DETAIL_KEYS.some(k => k in b)) {
    // The price limit depends on sale or rent; updateDraft re-checks it against the stored type when the type is not in this patch.
    const details = parseDetails(b, patch.transactionType ?? "sale");
    if (!details.ok) return fail("invalid", details.message);
    Object.assign(patch, details.value);
  }
  if ("description" in b) { const v = description(b["description"]); if (!v.ok) return fail("invalid", DESCRIPTION_ERROR); patch.description = v.value; }
  if ("rentalBondPathway" in b) { const v = oneOf(b["rentalBondPathway"], BOND_PATHWAYS); if (!v) return fail("invalid", "Invalid bond pathway."); patch.rentalBondPathway = v; }
  if (Object.keys(patch).length === 0) return fail("invalid", "Nothing to update.");
  return { ok: true, value: patch };
}

export async function createDraft(deps: ListingServiceDeps, actor: Actor, input: DraftCreate): Promise<PropertyListing> {
  const now = deps.now();
  const { title, address, jurisdiction, transactionType, useClass, propertyType, description: desc, ...details } = input;
  const listing: PropertyListing = applyDetails<PropertyListing>({
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
    ...(desc ? { description: desc } : {}),
    disclosures: [],
    createdAt: now,
    updatedAt: now
  }, details);
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
  const { rentalBondPathway, description: desc, ...listingPatch } = patch;
  const plain = Object.fromEntries(Object.entries(listingPatch).filter(([k]) => !(DETAIL_KEYS as readonly string[]).includes(k)));
  const listing: PropertyListing = { ...applyDetails({ ...rec.listing, ...plain }, listingPatch), updatedAt: deps.now() };
  if (desc === null) delete listing.description;
  else if (desc !== undefined) listing.description = desc;
  // The price limit depends on sale or rent, so check the result, not just the patch.
  if (listing.priceCents !== undefined) {
    const e = priceError(listing.priceCents, listing.transactionType);
    if (e) return fail("invalid", e);
  }
  await deps.repo.save({ ...rec, listing, ...(rentalBondPathway !== undefined ? { rentalBondPathway } : {}) });
  return { ok: true, value: listing };
}

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

/** Published listings only: filtered, sorted and paged by the repository. */
export async function searchPublished(deps: ListingServiceDeps, q: SearchQuery): Promise<SearchPage<PropertyListing>> {
  const r = await deps.repo.search(q);
  return { ...r, items: r.items.map(rec => rec.listing) };
}

/**
 * Runs the publish gate for the owner's listing. With dryRun nothing changes. Otherwise an allowed decision moves
 * the listing draft -> pending_review -> published, with an audit event for each step.
 */
export async function publishListing(
  deps: ListingServiceDeps, actor: Actor, id: string, dryRun: boolean
): Promise<Result<{ decision: PublishDecision; listing: PropertyListing; wordingFlags: FieldFlags[] }>> {
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
  const requirements = deps.disclosureRequirements ? await deps.disclosureRequirements(l).catch(() => null) : undefined;
  const required = requirements !== undefined ? (requirements?.keys ?? null) : deps.requiredDisclosures(l.jurisdiction, l.transactionType, l.useClass);
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

  // Anti-discrimination wording (spec 6.4): blocking matches stop publishing unless staff cleared that exact match for this listing.
  const wordingFlags = listingWordingFlags(l);
  const cleared = deps.clearedWordingFlags ? await deps.clearedWordingFlags(l.id).catch(() => new Set<string>()) : new Set<string>();
  const wordingReasons = wordingBlockReasons(wordingFlags, cleared);
  if (wordingReasons.length > 0) {
    decision = { allowed: false, reasons: [...decision.reasons, ...wordingReasons] };
    if (!dryRun && deps.recordWordingFlags) await deps.recordWordingFlags(l.id, actor.userId, wordingFlags).catch(() => undefined);
  }

  if (dryRun || !decision.allowed) return { ok: true, value: { decision, listing: l, wordingFlags } };

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
  if (requirements && deps.markDisclosureVersion) await deps.markDisclosureVersion(l.id, requirements.versionId);
  if (deps.afterPublish) await runAfterPublish(deps.afterPublish, done.listing);
  return { ok: true, value: { decision, listing: done.listing, wordingFlags } };
}

/** Wording flags (block and warn) for the listing's owner-written text. */
export function listingWordingFlags(l: Pick<PropertyListing, "title" | "description">): FieldFlags[] {
  return scanFields({ title: l.title, description: l.description });
}

export function createInMemoryListingRepository(): ListingRepository & { clear(): void } {
  const rows = new Map<string, ListingRecord>();
  return {
    async insert(r) { rows.set(r.listing.id, r); },
    async save(r) { rows.set(r.listing.id, r); },
    async get(id) { return rows.get(id); },
    async search(q) {
      const byId = new Map([...rows.values()].map(r => [r.listing.id, r]));
      const page = searchInMemory([...rows.values()].map(r => r.listing), q);
      return { ...page, items: page.items.map(l => byId.get(l.id)!) };
    },
    async listByOwner(ownerUserId) {
      return [...rows.values()].filter(r => r.listing.ownerUserId === ownerUserId).sort((x, y) => y.listing.createdAt.localeCompare(x.listing.createdAt));
    },
    clear() { rows.clear(); }
  };
}

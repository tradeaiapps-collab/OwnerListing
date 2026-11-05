import { createHash } from "node:crypto";
import type { ObjectStoragePort } from "../adapters/object-storage";
import { analyseDocument, compareAnalyses, ENGINE_VERSION, type Analysis, type Comparison } from "./doc-analyst";
import { canViewDocument, type DocumentRecord } from "./documents";
import type { DocumentStore } from "./document-service";
import type { Actor, ListingServiceDeps, Result } from "./listing-service";

/** Stored reading of one document. Insert only. */
export interface StoredAnalysis { id: string; documentId: string; listingId: string; createdAt: string; analysis: Analysis }

export interface AnalysisStore {
  latest(documentId: string, engine: string): Promise<StoredAnalysis | undefined>;
  byId(id: string): Promise<StoredAnalysis | undefined>;
  insert(a: { id: string; documentId: string; listingId: string; requestedBy: string; textSha256: string; analysis: Analysis }): Promise<void>;
  countRecent(userId: string, sinceIso: string): Promise<number>;
  addShares(analysisId: string, sharedBy: string, userIds: readonly string[]): Promise<string[]>;
}

export type Extractor = (bytes: Uint8Array, contentType: string) => Promise<
  { ok: true; text: string } | { ok: false; reason: "needs_ocr" | "unsupported" | "too_large" | "empty"; message: string }>;

export interface AnalystDeps {
  deps: ListingServiceDeps;
  docs: DocumentStore;
  store: AnalysisStore;
  storage: ObjectStoragePort;
  extract: Extractor;
  /** Tells a user their document was read. Must never throw. */
  notify: (userId: string, params: { listing: string; document: string; link: string }) => Promise<void>;
}

export const ANALYSES_PER_HOUR = 30;
export const MAX_COMPARE = 6;
export const MAX_SHARE_RECIPIENTS = 10;
const HOUR_MS = 3_600_000;
const KIND_NAME: Record<string, string> = { building_inspection: "Building inspection", pest_report: "Pest report", contract: "Contract", title_search: "Title search", other: "Document", floorplan: "Floorplan" };
const READABLE: ReadonlySet<string> = new Set(["building_inspection", "pest_report", "contract", "title_search", "other", "floorplan"]);

const fail = (code: "invalid" | "not_found" | "forbidden" | "rate_limited" | "unavailable", message: string): Result<never> => ({ ok: false, code, message });

/** Same rule as downloading the file: owner, assigned contractor, or public file of a published listing. Anything else is not_found. */
async function visibleDocument(d: AnalystDeps, actor: Actor, documentId: string): Promise<{ doc: DocumentRecord; published: boolean } | undefined> {
  const doc = await d.docs.documentById(documentId);
  const rec = doc ? await d.deps.repo.get(doc.listingId) : undefined;
  if (!doc || !rec) return undefined;
  const published = rec.listing.status === "published";
  const isOwner = actor.userId === doc.ownerUserId;
  const assignments = isOwner ? [] : await d.docs.assignmentsFor(doc.listingId, actor.userId);
  if (!canViewDocument(actor.userId, doc, published, assignments) || (!isOwner && doc.status !== "active")) return undefined;
  return { doc, published };
}

export interface AnalysisView { id: string; documentId: string; documentKind: string; createdAt: string; analysis: Analysis; cached: boolean }

/** Reads a document Elena may see and returns her analysis. A repeat request for an unchanged document returns the stored reading. */
export async function analyseStoredDocument(d: AnalystDeps, actor: Actor, documentId: string): Promise<Result<AnalysisView>> {
  const vis = await visibleDocument(d, actor, documentId);
  if (!vis) return fail("not_found", "Document not found.");
  const { doc } = vis;
  if (!READABLE.has(doc.kind)) return fail("invalid", "Elena reads inspection reports, contracts, title searches and other documents, not photos or video.");
  const cached = await d.store.latest(doc.id, ENGINE_VERSION);
  if (cached) return { ok: true, value: view(cached, doc.kind, true) };
  const since = new Date(Date.parse(d.deps.now()) - HOUR_MS).toISOString();
  if (await d.store.countRecent(actor.userId, since) >= ANALYSES_PER_HOUR) return fail("rate_limited", "You have asked Elena to read a lot of documents this hour. Try again later.");
  const stored = await d.docs.storedFileFor(doc.id);
  if (!stored) return fail("not_found", "Document not found.");
  if (!d.storage.configured) return fail("unavailable", "File storage is not configured.");
  let bytes: Uint8Array;
  try { bytes = await d.storage.get(stored.storageKey); } catch { return fail("unavailable", "The file could not be read right now."); }
  const ex = await d.extract(bytes, stored.contentType);
  if (!ex.ok) return fail("invalid", ex.message);
  const analysis = analyseDocument(ex.text, { hintKind: doc.kind });
  const id = d.deps.newId();
  await d.store.insert({ id, documentId: doc.id, listingId: doc.listingId, requestedBy: actor.userId, textSha256: createHash("sha256").update(ex.text).digest("hex"), analysis });
  await d.deps.appendAudit({
    id: d.deps.newId(), occurredAt: d.deps.now(), actorType: "user", actorId: actor.userId, aggregateType: "document", aggregateId: doc.id,
    eventType: "document.analysed", correlationId: d.deps.newId(), payload: { listingId: doc.listingId, kind: doc.kind, docClass: analysis.docClass, rating: analysis.rating, engine: analysis.engine }
  });
  if (doc.ownerUserId !== actor.userId) await d.notify(doc.ownerUserId, { listing: "your listing", document: KIND_NAME[doc.kind] ?? "a document", link: `/listings/${doc.listingId}/documents` });
  return { ok: true, value: view({ id, documentId: doc.id, listingId: doc.listingId, createdAt: d.deps.now(), analysis }, doc.kind, false) };
}

const view = (s: StoredAnalysis, kind: string, cached: boolean): AnalysisView =>
  ({ id: s.id, documentId: s.documentId, documentKind: kind, createdAt: s.createdAt, analysis: s.analysis, cached });

/** Latest stored reading, if the actor may view the document. Never runs the analysis. */
export async function latestAnalysis(d: AnalystDeps, actor: Actor, documentId: string): Promise<Result<AnalysisView>> {
  const vis = await visibleDocument(d, actor, documentId);
  if (!vis) return fail("not_found", "Document not found.");
  const s = await d.store.latest(documentId, ENGINE_VERSION);
  return s ? { ok: true, value: view(s, vis.doc.kind, true) } : fail("not_found", "Elena has not read this document yet.");
}

/** 2 to 6 documents side by side. Each is read (or its stored reading used) under the actor's own access; one inaccessible id fails the whole request. */
export async function compareDocuments(d: AnalystDeps, actor: Actor, documentIds: readonly string[]): Promise<Result<Comparison>> {
  const ids = [...new Set(documentIds)];
  if (ids.length < 2 || ids.length > MAX_COMPARE) return fail("invalid", `Choose between 2 and ${MAX_COMPARE} documents to compare.`);
  const inputs = [];
  for (const id of ids) {
    const r = await analyseStoredDocument(d, actor, id);
    if (!r.ok) return r;
    inputs.push({ id, name: `${KIND_NAME[r.value.documentKind] ?? "Document"} ${inputs.length + 1}`, analysis: r.value.analysis });
  }
  return { ok: true, value: compareAnalyses(inputs) };
}

/** Owner tells chosen people about a reading. Each must already be able to view the source document, so sharing never widens access. */
export async function shareAnalysis(d: AnalystDeps, actor: Actor, analysisId: string, userIds: readonly string[]): Promise<Result<{ notified: number; skipped: number }>> {
  const a = await d.store.byId(analysisId);
  const vis = a ? await visibleDocument(d, actor, a.documentId) : undefined;
  if (!a || !vis) return fail("not_found", "Reading not found.");
  if (vis.doc.ownerUserId !== actor.userId) return fail("forbidden", "Only the owner can share a reading.");
  const wanted = [...new Set(userIds)].filter(u => u !== actor.userId);
  if (wanted.length === 0 || wanted.length > MAX_SHARE_RECIPIENTS) return fail("invalid", `Choose between 1 and ${MAX_SHARE_RECIPIENTS} people.`);
  const allowed: string[] = [];
  for (const u of wanted) {
    const assignments = await d.docs.assignmentsFor(vis.doc.listingId, u);
    if (canViewDocument(u, vis.doc, vis.published, assignments)) allowed.push(u);
  }
  const added = allowed.length ? await d.store.addShares(analysisId, actor.userId, allowed) : [];
  for (const u of added) await d.notify(u, { listing: "the listing", document: KIND_NAME[vis.doc.kind] ?? "a document", link: `/listings/${vis.doc.listingId}/documents` });
  if (added.length) await d.deps.appendAudit({
    id: d.deps.newId(), occurredAt: d.deps.now(), actorType: "user", actorId: actor.userId, aggregateType: "document", aggregateId: vis.doc.id,
    eventType: "document.analysis_shared", correlationId: d.deps.newId(), payload: { analysisId, recipients: added.length }
  });
  return { ok: true, value: { notified: added.length, skipped: wanted.length - added.length } };
}

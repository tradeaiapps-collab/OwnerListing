import { canViewDocument, evaluateDeletionRequest, uploadableKinds, type DeletionOutcome, type DocumentKind, type DocumentRecord, type Visibility, type DocumentStatus } from "./documents";
import type { ObjectStoragePort } from "../adapters/object-storage";
import type { JobAssignment } from "./job-chat";
import type { Actor, ListingServiceDeps, Result } from "./listing-service";

/** Metadata only. Storage keys, fingerprints and uploader ids are never returned. */
export interface DocumentSummary {
  id: string;
  kind: DocumentKind;
  visibility: Visibility;
  status: DocumentStatus;
  supersedesId?: string;
}

export interface DeletionRequestRecord {
  documentId: string;
  requestedBy: string;
  outcome: DeletionOutcome["kind"];
  reason: string;
}

/** What the document service needs from storage. Insert-only for deletion requests; nothing here deletes a file. */
export interface DocumentStore {
  documentsForListing(listingId: string): Promise<DocumentRecord[]>;
  documentById(documentId: string): Promise<DocumentRecord | undefined>;
  assignmentsFor(listingId: string, contractorUserId: string): Promise<JobAssignment[]>;
  recordDeletionRequest(r: DeletionRequestRecord): Promise<void>;
  /** Storage key and the stored (sniffed) content type. Used only by readDocumentFile, after the access check. */
  storedFileFor(documentId: string): Promise<{ storageKey: string; contentType: string } | undefined>;
}

const notFound = (message: string): Result<never> => ({ ok: false, code: "not_found", message });

const summary = (d: DocumentRecord): DocumentSummary => ({
  id: d.id, kind: d.kind, visibility: d.visibility, status: d.status,
  ...(d.supersedesId ? { supersedesId: d.supersedesId } : {})
});

/**
 * Lists the documents the actor may see. The owner sees every version; everyone else sees active files only.
 * A listing that is not published, and has nothing visible to the actor, answers not_found.
 */
export async function listDocuments(
  deps: ListingServiceDeps, store: DocumentStore, actor: Actor | null, listingId: string
): Promise<Result<DocumentSummary[]>> {
  const rec = await deps.repo.get(listingId);
  if (!rec) return notFound("Listing not found.");
  const published = rec.listing.status === "published";
  const isOwner = actor !== null && actor.userId === rec.listing.ownerUserId;
  const assignments = actor && !isOwner ? await store.assignmentsFor(listingId, actor.userId) : [];
  const docs = await store.documentsForListing(listingId);
  const visible = docs.filter(d =>
    canViewDocument(actor?.userId, d, published, assignments) && (isOwner || d.status === "active"));
  if (!published && !isOwner && visible.length === 0) return notFound("Listing not found.");
  return { ok: true, value: visible.map(summary) };
}

/** Who may add what on this listing (drives the upload form; the upload route checks again). */
export async function uploadAccess(
  deps: ListingServiceDeps, store: DocumentStore, actor: Actor | null, listingId: string
): Promise<{ isOwner: boolean; kinds: DocumentKind[] }> {
  const rec = await deps.repo.get(listingId);
  if (!rec || !actor) return { isOwner: false, kinds: [] };
  const isOwner = actor.userId === rec.listing.ownerUserId;
  const assignments = isOwner ? [] : await store.assignmentsFor(listingId, actor.userId);
  return { isOwner, kinds: uploadableKinds(actor.userId, rec.listing.ownerUserId, listingId, assignments) };
}

export type ReadResult = Result<{ bytes: Uint8Array; contentType: string }> | { ok: false; code: "unavailable"; message: string };

/**
 * Reads a file's bytes if the actor may view it. The signed-out actor (null) can only get public files of published listings.
 * Same visibility rules as listDocuments: superseded versions are owner-only. Any denial answers not_found so existence is not revealed.
 * Storage is only touched after the access check; unconfigured or failing storage answers unavailable (fail closed).
 * Every download of a non-public file is written to the audit log.
 */
export async function readDocumentFile(
  deps: ListingServiceDeps, store: DocumentStore, storage: ObjectStoragePort, actor: Actor | null, documentId: string
): Promise<ReadResult> {
  const doc = await store.documentById(documentId);
  const rec = doc ? await deps.repo.get(doc.listingId) : undefined;
  if (!doc || !rec) return notFound("File not found.");
  const published = rec.listing.status === "published";
  const isOwner = actor !== null && actor.userId === doc.ownerUserId;
  const assignments = actor && !isOwner ? await store.assignmentsFor(doc.listingId, actor.userId) : [];
  if (!canViewDocument(actor?.userId, doc, published, assignments) || (!isOwner && doc.status !== "active")) return notFound("File not found.");
  const stored = await store.storedFileFor(doc.id);
  if (!stored) return notFound("File not found.");
  if (!storage.configured) return { ok: false, code: "unavailable", message: "File storage is not configured." };
  let bytes: Uint8Array;
  try {
    bytes = await storage.get(stored.storageKey);
  } catch {
    return { ok: false, code: "unavailable", message: "The file could not be read right now." };
  }
  if (doc.visibility !== "public" && actor) {
    await deps.appendAudit({
      id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId: actor.userId,
      aggregateType: "document", aggregateId: doc.id, eventType: "document.downloaded",
      correlationId: deps.newId(), payload: { listingId: doc.listingId, kind: doc.kind, visibility: doc.visibility }
    });
  }
  return { ok: true, value: { bytes, contentType: stored.contentType } };
}

/**
 * Records a deletion request and its outcome (insert only). It never removes a file.
 * Once a listing has been published or withdrawn its files can be replaced but not deleted.
 * Non-owners get not_found so a document's existence is not revealed.
 */
export async function requestDocumentDeletion(
  deps: ListingServiceDeps, store: DocumentStore, actor: Actor, documentId: string
): Promise<Result<{ outcome: DeletionOutcome["kind"]; reason: string }>> {
  const doc = await store.documentById(documentId);
  if (!doc || doc.ownerUserId !== actor.userId) return notFound("Document not found.");
  const rec = await deps.repo.get(doc.listingId);
  if (!rec) return notFound("Document not found.");
  // Withdrawn counts as published: a withdrawn listing may have been live, so its files stay on record.
  const everPublished = rec.listing.status === "published" || rec.listing.status === "withdrawn";
  const outcome = evaluateDeletionRequest(actor.userId, doc, { everPublished, saleCompleted: false });
  await store.recordDeletionRequest({
    documentId: doc.id, requestedBy: actor.userId, outcome: outcome.kind, reason: outcome.reason
  });
  return { ok: true, value: { outcome: outcome.kind, reason: outcome.reason } };
}

/** In-memory store for tests. */
export function createInMemoryDocumentStore(
  seed: { documents?: DocumentRecord[]; assignments?: JobAssignment[]; files?: Record<string, { storageKey: string; contentType: string }> } = {}
) {
  const documents = [...(seed.documents ?? [])];
  const assignments = [...(seed.assignments ?? [])];
  const requests: DeletionRequestRecord[] = [];
  const store: DocumentStore = {
    async documentsForListing(listingId) { return documents.filter(d => d.listingId === listingId); },
    async documentById(id) { return documents.find(d => d.id === id); },
    async assignmentsFor(listingId, contractorUserId) {
      return assignments.filter(a => a.listingId === listingId && a.contractorUserId === contractorUserId);
    },
    async recordDeletionRequest(r) { requests.push(r); },
    async storedFileFor(id) { return seed.files?.[id]; }
  };
  return { store, documents, requests };
}

import { createHash } from "node:crypto";
import type { MalwareScanPort } from "../adapters/malware-scan";
import type { ObjectStoragePort } from "../adapters/object-storage";
import type { DocumentStore } from "./document-service";
import { amendDocument, canUploadAnyDocument, canUploadDocument, validateUpload, type DocumentKind, type DocumentRecord, type Visibility } from "./documents";
import { sniffMime } from "./file-sniff";
import type { Actor, ListingServiceDeps, Result } from "./listing-service";

export type UploadResult = Result<{ id: string }> | { ok: false; code: "unavailable"; message: string };

export interface UploadInput {
  kind: DocumentKind;
  declaredMime: string;
  visibility: Visibility;
  bytes: Uint8Array;
  /** Replace an earlier version. The earlier version is kept as superseded. */
  supersedesId?: string;
}

/** Stored with the record: key and fingerprint only. No filename, no bytes. */
export interface NewDocument { record: DocumentRecord; storageKey: string; sha256: string; declaredMime: string; sizeBytes: number }

/** Insert and supersede only. There is no delete here. */
export type UploadStore = DocumentStore & {
  addDocument(d: NewDocument, supersede?: DocumentRecord): Promise<void>;
  /** False when the listing has no property record (property_document.property_id is required). */
  listingHasProperty(listingId: string): Promise<boolean>;
};

const VISIBILITIES: readonly Visibility[] = ["public", "parties", "owner_only"];
const bad = (message: string): UploadResult => ({ ok: false, code: "invalid", message });
const unavailable = (message = "File upload is not available right now."): UploadResult => ({ ok: false, code: "unavailable", message });

/**
 * Cheap checks that run BEFORE the request body is read: providers configured, listing exists, actor has an upload role on it.
 * Returns undefined when the upload may proceed to reading the body.
 */
export async function precheckUpload(
  deps: ListingServiceDeps, store: UploadStore,
  ports: { storage: ObjectStoragePort; scanner: MalwareScanPort },
  actor: Actor, listingId: string
): Promise<UploadResult | undefined> {
  if (!ports.storage.configured || !ports.scanner.configured) return unavailable("File upload is not available yet.");
  const rec = await deps.repo.get(listingId);
  if (!rec) return { ok: false, code: "not_found", message: "Listing not found." };
  const ownerUserId = rec.listing.ownerUserId;
  const assignments = actor.userId === ownerUserId ? [] : await store.assignmentsFor(listingId, actor.userId);
  if (!canUploadAnyDocument(actor.userId, ownerUserId, listingId, assignments)) {
    return { ok: false, code: "forbidden", message: "You cannot add files to this listing." };
  }
  return undefined;
}

/**
 * Order: role, provider readiness, content checks, malware scan, store bytes, record.
 * Fails closed: unconfigured storage or scanner refuses the upload, and so does a scanner or storage error.
 * An amendment keeps the earlier version as superseded; nothing here removes a file.
 */
export async function uploadDocument(
  deps: ListingServiceDeps, store: UploadStore,
  ports: { storage: ObjectStoragePort; scanner: MalwareScanPort },
  actor: Actor, listingId: string, input: UploadInput
): Promise<UploadResult> {
  const rec = await deps.repo.get(listingId);
  if (!rec) return { ok: false, code: "not_found", message: "Listing not found." };
  const ownerUserId = rec.listing.ownerUserId;
  const assignments = actor.userId === ownerUserId ? [] : await store.assignmentsFor(listingId, actor.userId);
  if (!canUploadDocument(actor.userId, ownerUserId, listingId, input.kind, assignments)) {
    return { ok: false, code: "forbidden", message: "You cannot add this kind of file to this listing." };
  }
  if (!ports.storage.configured || !ports.scanner.configured) return unavailable("File upload is not available yet.");
  if (!(await store.listingHasProperty(listingId))) return { ok: false, code: "conflict", message: "This listing has no property record." };
  if (!VISIBILITIES.includes(input.visibility)) return bad("Unknown visibility.");
  if (actor.userId !== ownerUserId && input.visibility !== "parties") return bad("Files added by contractors are shared with the parties only.");

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const problems = validateUpload({ kind: input.kind, declaredMime: input.declaredMime, sizeBytes: input.bytes.length, sha256 });
  if (problems.length) return bad(problems.join(" "));
  // The real type comes from the bytes. It must match the declared type, which validateUpload checked against the kind.
  const real = sniffMime(input.bytes);
  if (real !== input.declaredMime) return bad("The file's contents do not match its declared type.");

  let previous: DocumentRecord | undefined;
  if (input.supersedesId) {
    previous = await store.documentById(input.supersedesId);
    if (!previous || previous.listingId !== listingId) return { ok: false, code: "not_found", message: "Earlier version not found." };
    if (previous.kind !== input.kind) return bad("A new version must be the same kind of file.");
    if (actor.userId !== ownerUserId && previous.uploadedBy !== actor.userId) {
      return { ok: false, code: "forbidden", message: "You can only replace files you added." };
    }
    if (previous.status !== "active") return { ok: false, code: "conflict", message: "Only the current version can be replaced." };
  }

  try {
    if ((await ports.scanner.scan(input.bytes)) !== "clean") return bad("The file did not pass the security scan.");
  } catch {
    return unavailable();
  }

  const id = deps.newId();
  // Random key: the user's filename never reaches storage and there is no extension to spoof.
  const storageKey = `listings/${listingId}/${deps.newId()}`;
  try {
    await ports.storage.put(storageKey, input.bytes, real);
  } catch {
    return unavailable();
  }
  const amended = previous ? amendDocument(previous, id, actor.userId) : undefined;
  const record: DocumentRecord = amended
    ? { ...amended.next, visibility: input.visibility }
    : { id, listingId, ownerUserId, kind: input.kind, uploadedBy: actor.userId, visibility: input.visibility, status: "active" };
  try {
    await store.addDocument({ record, storageKey, sha256, declaredMime: real, sizeBytes: input.bytes.length }, amended?.previous);
  } catch {
    // The storage port has no delete (and must not gain one for published files), so the written object is left in place.
    // Log the key only so the orphan can be reviewed; it is not referenced by any record and is never served.
    console.error(`document upload: record insert failed, orphaned storage key ${storageKey}`);
    return unavailable();
  }
  return { ok: true, value: { id } };
}

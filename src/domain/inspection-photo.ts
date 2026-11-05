import { createHash } from "node:crypto";
import type { ObjectStoragePort } from "../adapters/object-storage";
import type { MalwareScanPort } from "../adapters/malware-scan";
import type { Actor, Result } from "./listing-service";
import { sniffMime } from "./file-sniff";
import { stripImageMetadata, type PhotoMime } from "./image-meta";
import { PHOTO_LIMITS, PHOTO_MIMES, checkImage } from "./listing-photos";
import { INSPECTION_LIMITS, isUuid, type InspectionIds, type InspectionRepository } from "./inspection";
import type { AuditEvent } from "./audit";

/**
 * Inspection photos. They are evidence for the report, not marketing: they never join a listing gallery and are served only to people who
 * can see the report. Same intake rules as listing photos: type from the bytes, metadata (EXIF/GPS) stripped, malware scan, no filename kept.
 */

export interface StoredInspectionPhoto { storageKey: string; contentType: PhotoMime }

export interface InspectionPhotoStore {
  /** One statement: inserts the photo only if the inspection is accepted and the actor is its inspector, within the limits. */
  addPhoto(p: {
    id: string; inspectionId: string; findingId?: string; uploadedBy: string; contentType: PhotoMime; width: number; height: number;
    sizeBytes: number; sha256: string; storageKey: string; maxTotal: number; maxPerFinding: number
  }, audit: AuditEvent): Promise<boolean>;
  stored(photoId: string, inspectionId: string): Promise<StoredInspectionPhoto | undefined>;
  findingBelongs(findingId: string, inspectionId: string): Promise<boolean>;
}

export interface InspectionPhotoPorts { storage: ObjectStoragePort; scanner: MalwareScanPort }

const notFound = { ok: false, code: "not_found", message: "Not found." } as const;
const fail = (code: "invalid" | "conflict" | "unavailable" | "forbidden", message: string) => ({ ok: false, code, message }) as const;

export async function uploadInspectionPhoto(
  repo: InspectionRepository, store: InspectionPhotoStore, ports: InspectionPhotoPorts, actor: Actor, inspectionId: string,
  input: { declaredMime: string; bytes: Uint8Array; findingId?: string }, ids: InspectionIds
): Promise<Result<{ id: string }>> {
  const i = isUuid(inspectionId) ? await repo.get(inspectionId) : undefined;
  const role = i ? await repo.roleOf(i, actor.userId) : undefined;
  if (!i || !role) return notFound;
  if (role !== "inspector") return fail("forbidden", "Only the inspector can add photos.");
  if (i.status !== "accepted") return fail("conflict", "Photos can be added only while the inspection is accepted and not yet completed.");
  if (!ports.storage.configured || !ports.scanner.configured) return fail("unavailable", "Photo upload is not available right now.");
  if (!(PHOTO_MIMES as readonly string[]).includes(input.declaredMime)) return fail("invalid", "Only JPEG, PNG and WebP images can be added.");
  if (input.bytes.length > PHOTO_LIMITS.maxBytes) return fail("invalid", "Each photo must be 10 MB or smaller.");
  const real = sniffMime(input.bytes);
  if (real !== input.declaredMime) return fail("invalid", "The file's contents do not match its type.");
  const stripped = stripImageMetadata(input.bytes, real as PhotoMime);
  if (!stripped.ok) return fail("invalid", stripped.reason);
  const problem = checkImage(stripped.info, stripped.bytes.length);
  if (problem) return fail("invalid", problem);
  if (input.findingId !== undefined && (!isUuid(input.findingId) || !(await store.findingBelongs(input.findingId, i.id)))) return fail("invalid", "Choose a finding from this report.");
  try {
    if ((await ports.scanner.scan(input.bytes)) !== "clean") return fail("invalid", "The file did not pass the security scan.");
  } catch {
    return fail("unavailable", "Photo upload is not available right now.");
  }
  const id = ids.newId();
  const storageKey = `inspections/${i.id}/${ids.newId()}`;
  try { await ports.storage.put(storageKey, stripped.bytes, stripped.info.mime); } catch { return fail("unavailable", "Photo upload is not available right now."); }
  const audit: AuditEvent = {
    id: ids.newId(), occurredAt: ids.now(), actorType: "user", actorId: actor.userId, aggregateType: "inspection", aggregateId: i.id,
    eventType: "inspection.photo_added", correlationId: ids.newId(),
    payload: { listingId: i.listingId, photoId: id, ...(input.findingId ? { findingId: input.findingId } : {}), sizeBytes: stripped.bytes.length }
  };
  const saved = await store.addPhoto({
    id, inspectionId: i.id, ...(input.findingId ? { findingId: input.findingId } : {}), uploadedBy: actor.userId, contentType: stripped.info.mime,
    width: stripped.info.width, height: stripped.info.height, sizeBytes: stripped.bytes.length,
    sha256: createHash("sha256").update(stripped.bytes).digest("hex"), storageKey,
    maxTotal: INSPECTION_LIMITS.maxPhotosPerInspection, maxPerFinding: INSPECTION_LIMITS.maxPhotosPerFinding
  }, audit);
  // Storage has no delete for these files, so a refused row leaves an unreferenced object that is never served.
  return saved ? { ok: true, value: { id } } : fail("conflict", "This report has reached its photo limit, or the inspection has changed.");
}

/** Bytes of one photo, for anyone who can see the report (a viewer only once it is completed). */
export async function readInspectionPhoto(
  repo: InspectionRepository, store: InspectionPhotoStore, storage: ObjectStoragePort, actor: Actor, inspectionId: string, photoId: string
): Promise<Result<{ bytes: Uint8Array; contentType: PhotoMime }>> {
  const i = isUuid(inspectionId) && isUuid(photoId) ? await repo.get(inspectionId) : undefined;
  const role = i ? await repo.roleOf(i, actor.userId) : undefined;
  if (!i || !role || (role === "viewer" && i.status !== "completed")) return notFound;
  const file = await store.stored(photoId, i.id);
  if (!file) return notFound;
  if (!storage.configured) return fail("unavailable", "File storage is not configured.");
  try { return { ok: true, value: { bytes: await storage.get(file.storageKey), contentType: file.contentType } }; } catch { return fail("unavailable", "The photo could not be read right now."); }
}

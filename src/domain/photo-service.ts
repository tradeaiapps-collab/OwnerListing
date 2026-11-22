import { createHash } from "node:crypto";
import type { ImageSanitiserPort } from "../adapters/image-sanitiser";
import type { ImageVariantPort } from "../adapters/image-variants";
import type { MalwareScanPort } from "../adapters/malware-scan";
import type { ObjectStoragePort } from "../adapters/object-storage";
import { sniffMime } from "./file-sniff";
import { looks360, type TourKind } from "./virtual-tour";
import { stripImageMetadata, type PhotoMime } from "./image-meta";
import type { JobAssignment } from "./job-chat";
import {
  EMPTY_LAYOUT, PHOTO_KINDS, PHOTO_LIMITS, PHOTO_MIMES, canUploadPhotos, canViewDraftPhotos, checkImage, checkLayoutChange,
  coverOf, everPublished, galleryEditable, layoutWithUpload, roomFor, viewsFor,
  type Layout, type LayoutEntry, type PhotoKind, type PhotoRecord, type PhotoSize, type PhotoView
} from "./listing-photos";
import type { Actor, Failure, ListingServiceDeps, Result } from "./listing-service";

/** Where each stored size lives. Never leaves the server. */
export type StoredSizes = Partial<Record<PhotoSize, { storageKey: string; contentType: PhotoMime }>>;
export interface NewPhoto { record: PhotoRecord; files: StoredSizes; sha256: string; sizeBytes: number }

export type GalleryPlan =
  | { ok: true; addPhoto?: NewPhoto; entries: LayoutEntry[]; tourUrl: string | null; expectVersion?: number }
  | Failure;

/** Insert only. Nothing here updates or deletes a photo or an earlier layout. */
export interface PhotoStore {
  photosForListing(listingId: string): Promise<PhotoRecord[]>;
  photoById(photoId: string): Promise<PhotoRecord | undefined>;
  currentLayout(listingId: string): Promise<Layout>;
  assignmentsFor(listingId: string, userId: string): Promise<JobAssignment[]>;
  storedSizes(photoId: string): Promise<StoredSizes>;
  bytesUploadedSince(userId: string, sinceIso: string): Promise<number | undefined>;
  /**
   * Runs `plan` against the current layout under a per-listing lock, then inserts the new photo (if any) and the new
   * layout row together. A stale expectVersion answers conflict and writes nothing.
   */
  updateGallery(listingId: string, actorId: string, plan: (current: Layout, photos: ReadonlyMap<string, PhotoRecord>) => GalleryPlan): Promise<Result<{ version: number }>>;
  /** Cover and visible photo count per published listing (browse cards). */
  coversFor(listingIds: readonly string[]): Promise<Map<string, { cover: PhotoView | null; photoCount: number; tour?: TourKind }>>;
}

export interface GalleryAccess { staffCanView?: boolean }
export interface GalleryView {
  photos: PhotoView[]; tourUrl: string | null; version: number;
  canManage: boolean; canUpload: boolean; everPublished: boolean; editable: boolean;
}

const notFound = (message = "Listing not found."): Failure => ({ ok: false, code: "not_found", message });
const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const byId = (photos: readonly PhotoRecord[]) => new Map(photos.map(p => [p.id, p]));

/**
 * The gallery as the viewer may see it. Published: everyone sees visible photos. Draft or in review: the owner, an
 * approved photographer or agent on the listing, and staff with case access. The owner also sees hidden photos.
 */
export async function listPhotos(
  deps: ListingServiceDeps, store: PhotoStore, actor: Actor | null, listingId: string, access: GalleryAccess = {}
): Promise<Result<GalleryView>> {
  const rec = await deps.repo.get(listingId);
  if (!rec) return notFound();
  const owner = rec.listing.ownerUserId;
  const isOwner = actor !== null && actor.userId === owner;
  const assignments = actor && !isOwner ? await store.assignmentsFor(listingId, actor.userId) : [];
  const published = rec.listing.status === "published";
  if (!published && !isOwner && !access.staffCanView && !canViewDraftPhotos(actor?.userId, owner, listingId, assignments)) return notFound();
  const [layout, photos] = await Promise.all([store.currentLayout(listingId), store.photosForListing(listingId)]);
  const editable = galleryEditable(rec.listing.status);
  return {
    ok: true,
    value: {
      photos: viewsFor(layout, byId(photos), isOwner), tourUrl: layout.tourUrl, version: layout.version,
      canManage: isOwner && editable, canUpload: actor !== null && editable && canUploadPhotos(actor.userId, owner, listingId, assignments),
      everPublished: everPublished(rec.listing.status), editable
    }
  };
}

export interface PhotoUploadInput { kind: string; declaredMime: string; bytes: Uint8Array; replacesId?: string }
/** Images are cleared by a malware scanner (ClamAV) and/or by the sanitiser that re-encodes them. At least one must be on. */
export type PhotoPorts = { storage: ObjectStoragePort; scanner: MalwareScanPort; variants: ImageVariantPort; sanitiser?: ImageSanitiserPort };

/** Cheap checks before the request body is read: providers ready, listing exists, role, listing editable. */
export async function precheckPhotoUpload(
  deps: ListingServiceDeps, store: PhotoStore, ports: PhotoPorts, actor: Actor, listingId: string
): Promise<Failure | undefined> {
  if (!ports.storage.configured || !(ports.scanner.configured || ports.sanitiser?.available)) return fail("unavailable", "Photo upload is not available yet.");
  const rec = await deps.repo.get(listingId);
  if (!rec) return notFound();
  const owner = rec.listing.ownerUserId;
  const assignments = actor.userId === owner ? [] : await store.assignmentsFor(listingId, actor.userId);
  if (!canUploadPhotos(actor.userId, owner, listingId, assignments)) return fail("forbidden", "You cannot add photos to this listing.");
  if (!galleryEditable(rec.listing.status)) return fail("conflict", "Photos of a withdrawn listing cannot be changed.");
  return undefined;
}

/**
 * Order: role, providers, type from the bytes, metadata strip, size and pixel checks, re-encode (sanitiser) and recheck, room, malware scan (fail closed),
 * resized copies (optional), store bytes under random keys, then the photo row and new layout in one locked write.
 * The user's filename is discarded. A replacement keeps the earlier photo on record, hidden.
 */
export async function uploadPhoto(
  deps: ListingServiceDeps, store: PhotoStore, ports: PhotoPorts, actor: Actor, listingId: string, input: PhotoUploadInput
): Promise<Result<{ id: string }>> {
  const early = await precheckPhotoUpload(deps, store, ports, actor, listingId);
  if (early) return early;
  const rec = (await deps.repo.get(listingId))!;
  const owner = rec.listing.ownerUserId;
  if (!(PHOTO_KINDS as readonly string[]).includes(input.kind)) return fail("invalid", "Choose photo, floor plan or 360 photo.");
  const kind = input.kind as PhotoKind;
  if (!(PHOTO_MIMES as readonly string[]).includes(input.declaredMime)) return fail("invalid", "Only JPEG, PNG and WebP images can be added.");
  if (input.bytes.length > PHOTO_LIMITS.maxBytes) return fail("invalid", "Each photo must be 10 MB or smaller.");
  const real = sniffMime(input.bytes);
  if (real !== input.declaredMime) return fail("invalid", "The file's contents do not match its type.");
  // Cheap header checks on the original first (type, size, pixel count), so a huge image never reaches the decoder.
  let stripped = stripImageMetadata(input.bytes, real as PhotoMime);
  if (!stripped.ok) return fail("invalid", stripped.reason);
  let problem = checkImage(stripped.info, stripped.bytes.length);
  if (problem) return fail("invalid", problem);
  // Then re-encode when the sanitiser is on: only decoded pixels go into storage. The result is checked again.
  if (ports.sanitiser?.available) {
    let clean: Uint8Array;
    try { clean = await ports.sanitiser.sanitise(stripped.bytes, real as PhotoMime); } catch { return fail("invalid", "This image could not be read. Try saving it again as a JPEG or PNG."); }
    const again = stripImageMetadata(clean, real as PhotoMime);
    if (!again.ok) return fail("invalid", again.reason);
    stripped = again;
    problem = checkImage(stripped.info, stripped.bytes.length);
    if (problem) return fail("invalid", problem);
  }
  if (kind === "photo360" && !looks360(stripped.info.width, stripped.info.height)) return fail("invalid", "A 360 photo must be a full panorama twice as wide as it is tall (2:1).");

  const [layout, existing] = await Promise.all([store.currentLayout(listingId), store.photosForListing(listingId)]);
  const photos = byId(existing);
  const replaceCheck = (current: Layout, map: ReadonlyMap<string, PhotoRecord>): Failure | null => {
    if (!input.replacesId) return null;
    const old = map.get(input.replacesId);
    const entry = current.entries.find(e => e.photoId === input.replacesId);
    if (!old || !entry) return notFound("Photo not found.");
    if (old.kind !== kind) return fail("invalid", "A replacement must be the same kind (photo, floor plan or 360 photo).");
    if (entry.hidden) return fail("conflict", "Only a photo that is showing can be replaced.");
    if (actor.userId !== owner && old.uploadedBy !== actor.userId) return fail("forbidden", "You can only replace photos you added.");
    return null;
  };
  const pre = replaceCheck(layout, photos) ?? (() => { const r = roomFor(layout, photos, kind, !!input.replacesId); return r ? fail("conflict", r) : null; })();
  if (pre) return pre;

  if (ports.scanner.configured) {
    try {
      if ((await ports.scanner.scan(input.bytes)) !== "clean") return fail("invalid", "The file did not pass the security scan.");
    } catch {
      return fail("unavailable", "Photo upload is not available right now.");
    }
  }

  const id = deps.newId();
  const files: StoredSizes = { full: { storageKey: `listings/${listingId}/${deps.newId()}`, contentType: stripped.info.mime } };
  let variants: Awaited<ReturnType<ImageVariantPort["make"]>> = {};
  if (ports.variants.available) {
    try { variants = await ports.variants.make(stripped.bytes, stripped.info.width); } catch { variants = {}; }
  }
  const blobs: [PhotoSize, Uint8Array][] = [["full", stripped.bytes]];
  for (const size of ["thumb", "medium"] as const) {
    const v = variants[size];
    if (v && v.length > 0 && sniffMime(v) === "image/webp") {
      files[size] = { storageKey: `listings/${listingId}/${deps.newId()}`, contentType: "image/webp" };
      blobs.push([size, v]);
    }
  }
  try {
    for (const [size, bytes] of blobs) await ports.storage.put(files[size]!.storageKey, bytes, files[size]!.contentType);
  } catch {
    return fail("unavailable", "Photo upload is not available right now.");
  }
  const record: PhotoRecord = {
    id, listingId, kind, uploadedBy: actor.userId, contentType: stripped.info.mime, width: stripped.info.width, height: stripped.info.height,
    variants: (["thumb", "medium"] as const).filter(s => files[s])
  };
  const sha256 = createHash("sha256").update(stripped.bytes).digest("hex");
  let saved: Result<{ version: number }>;
  try {
    saved = await store.updateGallery(listingId, actor.userId, (current, map) => {
      const again = replaceCheck(current, map);
      if (again) return again;
      const room = roomFor(current, map, kind, !!input.replacesId);
      if (room) return fail("conflict", room);
      return { ok: true, addPhoto: { record, files, sha256, sizeBytes: stripped.bytes.length }, entries: layoutWithUpload(current, id, input.replacesId), tourUrl: current.tourUrl };
    });
  } catch {
    saved = fail("unavailable", "Photo upload is not available right now.");
  }
  if (!saved.ok) {
    // Storage has no delete for listing files, so the written objects stay; they are unreferenced and never served.
    console.error(`photo upload: not recorded, orphaned storage keys ${Object.values(files).map(f => f!.storageKey).join(",")}`);
    return saved;
  }
  await deps.appendAudit({
    id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId: actor.userId, aggregateType: "listing", aggregateId: listingId,
    eventType: input.replacesId ? "photo.replaced" : "photo.uploaded", correlationId: deps.newId(),
    payload: { photoId: id, kind, ...(input.replacesId ? { replacesId: input.replacesId } : {}), sizeBytes: stripped.bytes.length, layoutVersion: saved.value.version }
  });
  return { ok: true, value: { id } };
}

/** Owner only: saves a whole new order, captions, alt text, hidden flags and tour link. */
export async function updateLayout(
  deps: ListingServiceDeps, store: PhotoStore, actor: Actor, listingId: string, body: unknown
): Promise<Result<{ version: number }>> {
  const rec = await deps.repo.get(listingId);
  if (!rec || rec.listing.ownerUserId !== actor.userId) return notFound();
  if (!galleryEditable(rec.listing.status)) return fail("conflict", "Photos of a withdrawn listing cannot be changed.");
  const version = (body as Record<string, unknown> | null)?.["version"];
  if (!Number.isInteger(version) || (version as number) < 0) return fail("invalid", "Invalid gallery version.");
  const published = everPublished(rec.listing.status);
  let before: Layout = EMPTY_LAYOUT;
  let after: LayoutEntry[] = [];
  let r: Result<{ version: number }>;
  try {
    r = await store.updateGallery(listingId, actor.userId, (current, photos) => {
      const c = checkLayoutChange(current, photos, body, { everPublished: published });
      if (!c.ok) return fail("invalid", c.message);
      before = current; after = c.entries;
      return { ok: true, entries: c.entries, tourUrl: c.tourUrl, expectVersion: version as number };
    });
  } catch {
    return fail("unavailable", "The gallery could not be saved right now.");
  }
  if (!r.ok) return r;
  const kept = new Set(after.map(e => e.photoId));
  await deps.appendAudit({
    id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId: actor.userId, aggregateType: "listing", aggregateId: listingId,
    eventType: "photo.layout_changed", correlationId: deps.newId(),
    payload: { layoutVersion: r.value.version, removed: before.entries.filter(e => !kept.has(e.photoId)).map(e => e.photoId), hidden: after.filter(e => e.hidden).map(e => e.photoId), count: after.length }
  });
  return r;
}

export type PhotoRead = Result<{ bytes: Uint8Array; contentType: PhotoMime; isPublic: boolean }>;

/**
 * Bytes of one size of a photo. Public only while the listing is published and the photo is showing in the current
 * layout. Otherwise the owner (also hidden photos), an approved photographer/agent, or staff with case access.
 * A photo dropped from a draft's gallery is never served. Denials answer not_found. Storage is read only after the check.
 */
export async function readPhoto(
  deps: ListingServiceDeps, store: PhotoStore, storage: ObjectStoragePort, actor: Actor | null, photoId: string, size: PhotoSize,
  access: GalleryAccess & { staffId?: string } = {}
): Promise<PhotoRead> {
  const photo = await store.photoById(photoId);
  const rec = photo ? await deps.repo.get(photo.listingId) : undefined;
  if (!photo || !rec) return notFound("Photo not found.");
  const layout = await store.currentLayout(photo.listingId);
  const entry = layout.entries.find(e => e.photoId === photoId);
  if (!entry) return notFound("Photo not found.");
  const owner = rec.listing.ownerUserId;
  const isOwner = actor !== null && actor.userId === owner;
  const isPublic = rec.listing.status === "published" && !entry.hidden;
  let viaStaff = false;
  if (!isPublic && !isOwner) {
    const assignments = actor ? await store.assignmentsFor(photo.listingId, actor.userId) : [];
    const contractor = !entry.hidden && canViewDraftPhotos(actor?.userId, owner, photo.listingId, assignments);
    viaStaff = !contractor && access.staffCanView === true;
    if (!contractor && !viaStaff) return notFound("Photo not found.");
  }
  const sizes = await store.storedSizes(photoId);
  const file = sizes[size] ?? sizes.full;
  if (!file) return notFound("Photo not found.");
  if (!storage.configured) return fail("unavailable", "File storage is not configured.");
  let bytes: Uint8Array;
  try { bytes = await storage.get(file.storageKey); } catch { return fail("unavailable", "The photo could not be read right now."); }
  if (viaStaff && access.staffId) {
    await deps.appendAudit({
      id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId: access.staffId, aggregateType: "listing", aggregateId: photo.listingId,
      eventType: "photo.viewed_by_staff", correlationId: deps.newId(), payload: { photoId }
    });
  }
  return { ok: true, value: { bytes, contentType: file.contentType, isPublic } };
}

/** In-memory store for tests (same rules as the SQL store, minus real locking). */
export function createInMemoryPhotoStore(seed: { assignments?: JobAssignment[] } = {}) {
  const photos: (PhotoRecord & { files: StoredSizes; sizeBytes: number })[] = [];
  const layouts: (Layout & { listingId: string; changedBy: string })[] = [];
  const assignments = [...(seed.assignments ?? [])];
  const current = (listingId: string): Layout => {
    const l = layouts.filter(x => x.listingId === listingId).at(-1);
    return l ? { version: l.version, entries: l.entries.map(e => ({ ...e })), tourUrl: l.tourUrl } : EMPTY_LAYOUT;
  };
  const strip = ({ files: _f, sizeBytes: _s, ...p }: (typeof photos)[number]): PhotoRecord => p;
  const store: PhotoStore = {
    async photosForListing(id) { return photos.filter(p => p.listingId === id).map(strip); },
    async photoById(id) { const p = photos.find(x => x.id === id); return p ? strip(p) : undefined; },
    async currentLayout(id) { return current(id); },
    async assignmentsFor(listingId, userId) { return assignments.filter(a => a.listingId === listingId && a.contractorUserId === userId); },
    async storedSizes(id) { return photos.find(p => p.id === id)?.files ?? {}; },
    async bytesUploadedSince(userId) { return photos.filter(p => p.uploadedBy === userId).reduce((n, p) => n + p.sizeBytes, 0); },
    async updateGallery(listingId, actorId, plan) {
      const cur = current(listingId);
      const p = plan(cur, byId(photos.filter(x => x.listingId === listingId).map(strip)));
      if (!p.ok) return p;
      if (p.expectVersion !== undefined && p.expectVersion !== cur.version) return fail("conflict", "The gallery was changed elsewhere. Reload and try again.");
      if (p.addPhoto) photos.push({ ...p.addPhoto.record, files: p.addPhoto.files, sizeBytes: p.addPhoto.sizeBytes });
      layouts.push({ listingId, changedBy: actorId, version: cur.version + 1, entries: p.entries, tourUrl: p.tourUrl });
      return { ok: true, value: { version: cur.version + 1 } };
    },
    async coversFor(ids) {
      const out = new Map<string, { cover: PhotoView | null; photoCount: number; tour?: TourKind }>();
      for (const id of ids) out.set(id, coverOf(current(id), byId(photos.filter(p => p.listingId === id).map(strip))));
      return out;
    }
  };
  return { store, photos, layouts, assignments };
}

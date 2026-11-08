import { createHash } from "node:crypto";
import type { ImageVariantPort } from "../adapters/image-variants";
import type { ObjectStoragePort } from "../adapters/object-storage";
import { sniffMime } from "./file-sniff";
import { stripImageMetadata, type PhotoMime } from "./image-meta";
import { viewProject, type InvestmentDeps } from "./investment-service";
import { ownerMayEdit, type InvestmentProject } from "./investor-projects";
import {
  EMPTY_LAYOUT, PHOTO_LIMITS, PHOTO_MIMES, PROJECT_PHOTO_MAX, checkImage, checkLayoutChange, coverOf, layoutWithUpload, roomFor, viewsFor,
  type Layout, type LayoutEntry, type PhotoRecord, type PhotoSize, type PhotoView
} from "./listing-photos";
import type { Actor, Failure, Result } from "./listing-service";
import type { GalleryPlan, PhotoPorts, StoredSizes } from "./photo-service";

/**
 * Investor project gallery. Same file pipeline and layout rules as listing photos (listing-photos.ts), photos only (no
 * floor plans, no tour link). Records reuse PhotoRecord; its `listingId` holds the project id.
 * Who sees what: the owner and reviewing staff see every photo, hidden ones too; an investor sees the showing photos only
 * when viewProject lets them see the project. Nobody else, so photos are never public and never on the public cards.
 * Files are never deleted: a photo can be hidden or replaced. Any change other than hiding sends an approved project back
 * to staff review, the same as an edit of its text.
 */
export { PROJECT_PHOTO_MAX };

/** Insert only. Nothing here updates or deletes a photo or an earlier layout. */
export interface ProjectPhotoStore {
  photosFor(projectId: string): Promise<PhotoRecord[]>;
  photoById(photoId: string): Promise<PhotoRecord | undefined>;
  currentLayout(projectId: string): Promise<Layout>;
  storedSizes(photoId: string): Promise<StoredSizes>;
  bytesUploadedSince(userId: string, sinceIso: string): Promise<number | undefined>;
  /** Same contract as PhotoStore.updateGallery: locked per project, photo and layout inserted together, stale version = conflict. */
  updateGallery(projectId: string, actorId: string, plan: (current: Layout, photos: ReadonlyMap<string, PhotoRecord>) => GalleryPlan): Promise<Result<{ version: number }>>;
  /** Cover and showing photo count per project (cards). */
  coversFor(projectIds: readonly string[]): Promise<Map<string, { cover: PhotoView | null; photoCount: number }>>;
}

export interface ProjectGallery { photos: PhotoView[]; version: number; canManage: boolean }
/** Staff with investment.review, already checked by the route. */
export interface StaffView { staffId: string }

const notFound = (message = "Project not found."): Failure => ({ ok: false, code: "not_found", message });
const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const byId = (photos: readonly PhotoRecord[]) => new Map(photos.map(p => [p.id, p]));

/** Showing photos of a project are capped lower than a listing's. */
function projectRoom(layout: Layout, photos: ReadonlyMap<string, PhotoRecord>, replacing: boolean): string | null {
  const r = roomFor(layout, photos, "photo", replacing);
  if (r) return r === "This gallery is full." ? r : `A project can show up to ${PROJECT_PHOTO_MAX} photos.`;
  if (!replacing && layout.entries.filter(e => !e.hidden).length >= PROJECT_PHOTO_MAX) return `A project can show up to ${PROJECT_PHOTO_MAX} photos.`;
  return null;
}

/** True when `next` only hides photos that were showing: same order, same text, nothing new. Such a change needs no review. */
export function onlyHides(current: readonly LayoutEntry[], next: readonly LayoutEntry[]): boolean {
  if (current.length !== next.length) return false;
  return current.every((c, i) => {
    const n = next[i]!;
    return n.photoId === c.photoId && n.caption === c.caption && n.alt === c.alt && (n.hidden === c.hidden || (n.hidden && !c.hidden));
  });
}

/** Moves an approved project back to staff review (version + 1). False when the project changed meanwhile. */
async function backToReview(deps: InvestmentDeps, p: InvestmentProject, actor: Actor): Promise<boolean> {
  if (p.status !== "approved") return true;
  const now = deps.now();
  const { reviewReason: _r, ...base } = p;
  const next: InvestmentProject = { ...base, status: "pending_review", version: p.version + 1, updatedAt: now };
  return deps.repo.updateProject(next, p.version, {
    id: deps.newId(), projectId: p.id, fromStatus: p.status, toStatus: "pending_review", actorType: "owner", actorId: actor.userId, reason: null, projectVersion: next.version, at: now
  });
}

async function audit(deps: InvestmentDeps, actorId: string, projectId: string, eventType: string, payload: Record<string, unknown>) {
  await deps.appendAudit({ id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId, aggregateType: "investment_project", aggregateId: projectId, eventType, correlationId: deps.newId(), payload });
}

/** The gallery as this viewer may see it (see the file comment). Denials are not_found. */
export async function listProjectPhotos(
  deps: InvestmentDeps, store: ProjectPhotoStore, actor: Actor | null, projectId: string, staff?: StaffView
): Promise<Result<ProjectGallery>> {
  const p = await deps.repo.getProject(projectId);
  if (!p) return notFound();
  const isOwner = actor !== null && actor.userId === p.ownerUserId;
  if (!isOwner && !staff) {
    if (!actor || !(await viewProject(deps, actor, projectId)).ok) return notFound();
  }
  const [layout, photos] = await Promise.all([store.currentLayout(projectId), store.photosFor(projectId)]);
  return { ok: true, value: { photos: viewsFor(layout, byId(photos), isOwner || !!staff), version: layout.version, canManage: isOwner && ownerMayEdit(p) } };
}

/** Cheap checks before the request body is read: providers ready, project exists, caller is its owner, project editable. */
export async function precheckProjectPhoto(deps: InvestmentDeps, ports: PhotoPorts, actor: Actor, projectId: string): Promise<Failure | undefined> {
  if (!ports.storage.configured || !ports.scanner.configured) return fail("unavailable", "Photo upload is not available yet.");
  const p = await deps.repo.getProject(projectId);
  if (!p || p.ownerUserId !== actor.userId) return notFound();
  if (!ownerMayEdit(p)) return fail("conflict", "Photos of a rejected project cannot be changed.");
  return undefined;
}

/**
 * Same order as listing photos: owner, providers, type from the bytes, metadata strip, size and pixel checks, room, malware
 * scan (fail closed), resized copies (optional), bytes under random keys, then the photo row and new layout in one locked
 * write. The filename is discarded. A replacement keeps the earlier photo on record, hidden.
 */
export async function uploadProjectPhoto(
  deps: InvestmentDeps, store: ProjectPhotoStore, ports: PhotoPorts, actor: Actor, projectId: string,
  input: { declaredMime: string; bytes: Uint8Array; replacesId?: string }
): Promise<Result<{ id: string }>> {
  const early = await precheckProjectPhoto(deps, ports, actor, projectId);
  if (early) return early;
  const p = (await deps.repo.getProject(projectId))!;
  if (!(PHOTO_MIMES as readonly string[]).includes(input.declaredMime)) return fail("invalid", "Only JPEG, PNG and WebP images can be added.");
  if (input.bytes.length > PHOTO_LIMITS.maxBytes) return fail("invalid", "Each photo must be 10 MB or smaller.");
  const real = sniffMime(input.bytes);
  if (real !== input.declaredMime) return fail("invalid", "The file's contents do not match its type.");
  const stripped = stripImageMetadata(input.bytes, real as PhotoMime);
  if (!stripped.ok) return fail("invalid", stripped.reason);
  const problem = checkImage(stripped.info, stripped.bytes.length);
  if (problem) return fail("invalid", problem);

  const replaceCheck = (current: Layout): Failure | null => {
    if (!input.replacesId) return null;
    const entry = current.entries.find(e => e.photoId === input.replacesId);
    if (!entry) return notFound("Photo not found.");
    if (entry.hidden) return fail("conflict", "Only a photo that is showing can be replaced.");
    return null;
  };
  const roomCheck = (current: Layout, map: ReadonlyMap<string, PhotoRecord>): Failure | null => {
    const again = replaceCheck(current);
    if (again) return again;
    const room = projectRoom(current, map, !!input.replacesId);
    return room ? fail("conflict", room) : null;
  };
  const pre = roomCheck(await store.currentLayout(projectId), byId(await store.photosFor(projectId)));
  if (pre) return pre;

  try {
    if ((await ports.scanner.scan(input.bytes)) !== "clean") return fail("invalid", "The file did not pass the security scan.");
  } catch {
    return fail("unavailable", "Photo upload is not available right now.");
  }

  const id = deps.newId();
  const files: StoredSizes = { full: { storageKey: `investments/${projectId}/${deps.newId()}`, contentType: stripped.info.mime } };
  let variants: Awaited<ReturnType<ImageVariantPort["make"]>> = {};
  if (ports.variants.available) {
    try { variants = await ports.variants.make(stripped.bytes, stripped.info.width); } catch { variants = {}; }
  }
  const blobs: [PhotoSize, Uint8Array][] = [["full", stripped.bytes]];
  for (const size of ["thumb", "medium"] as const) {
    const v = variants[size];
    if (v && v.length > 0 && sniffMime(v) === "image/webp") {
      files[size] = { storageKey: `investments/${projectId}/${deps.newId()}`, contentType: "image/webp" };
      blobs.push([size, v]);
    }
  }
  try {
    for (const [size, bytes] of blobs) await ports.storage.put(files[size]!.storageKey, bytes, files[size]!.contentType);
  } catch {
    return fail("unavailable", "Photo upload is not available right now.");
  }
  // Review first: if the gallery write then fails, the project only waits for a review it did not need.
  if (!(await backToReview(deps, p, actor))) return fail("conflict", "The project changed meanwhile. Reload and try again.");
  const record: PhotoRecord = {
    id, listingId: projectId, kind: "photo", uploadedBy: actor.userId, contentType: stripped.info.mime, width: stripped.info.width, height: stripped.info.height,
    variants: (["thumb", "medium"] as const).filter(s => files[s])
  };
  const sha256 = createHash("sha256").update(stripped.bytes).digest("hex");
  let saved: Result<{ version: number }>;
  try {
    saved = await store.updateGallery(projectId, actor.userId, (current, map) => {
      const again = roomCheck(current, map);
      if (again) return again;
      return { ok: true, addPhoto: { record, files, sha256, sizeBytes: stripped.bytes.length }, entries: layoutWithUpload(current, id, input.replacesId), tourUrl: null };
    });
  } catch {
    saved = fail("unavailable", "Photo upload is not available right now.");
  }
  if (!saved.ok) {
    console.error(`project photo upload: not recorded, orphaned storage keys ${Object.values(files).map(f => f!.storageKey).join(",")}`);
    return saved;
  }
  await audit(deps, actor.userId, projectId, input.replacesId ? "investment.project_photo_replaced" : "investment.project_photo_uploaded", {
    photoId: id, ...(input.replacesId ? { replacesId: input.replacesId } : {}), sizeBytes: stripped.bytes.length, layoutVersion: saved.value.version, backToReview: p.status === "approved"
  });
  return { ok: true, value: { id } };
}

/** Owner only: a whole new order, captions, descriptions and hidden flags. Leaving a photo out is refused (hide it instead). */
export async function updateProjectLayout(
  deps: InvestmentDeps, store: ProjectPhotoStore, actor: Actor, projectId: string, body: unknown
): Promise<Result<{ version: number; backToReview: boolean }>> {
  const p = await deps.repo.getProject(projectId);
  if (!p || p.ownerUserId !== actor.userId) return notFound();
  if (!ownerMayEdit(p)) return fail("conflict", "Photos of a rejected project cannot be changed.");
  const version = (body as Record<string, unknown> | null)?.["version"];
  if (!Number.isInteger(version) || (version as number) < 0) return fail("invalid", "Invalid gallery version.");
  const entries = { entries: (body as Record<string, unknown>)["entries"], allowFlagged: (body as Record<string, unknown>)["allowFlagged"] === true };
  const fixMessage = (m: string) => m.replace("Photos of a published listing cannot be deleted.", "Project photos cannot be deleted.").replace(/A listing can show up to \d+ photos\./, `A project can show up to ${PROJECT_PHOTO_MAX} photos.`);
  const tooMany = (list: readonly LayoutEntry[]) => list.filter(e => !e.hidden).length > PROJECT_PHOTO_MAX;

  // Decide on review before writing, against the layout as it is now; the locked write below refuses a stale version.
  const [current, photos] = await Promise.all([store.currentLayout(projectId), store.photosFor(projectId)]);
  const first = checkLayoutChange(current, byId(photos), entries, { everPublished: true });
  if (!first.ok) return fail("invalid", fixMessage(first.message));
  if (tooMany(first.entries)) return fail("invalid", `A project can show up to ${PROJECT_PHOTO_MAX} photos.`);
  if (version !== current.version) return fail("conflict", "The gallery was changed elsewhere. Reload and try again.");
  const review = p.status === "approved" && !onlyHides(current.entries, first.entries);
  if (review && !(await backToReview(deps, p, actor))) return fail("conflict", "The project changed meanwhile. Reload and try again.");

  let r: Result<{ version: number }>;
  try {
    r = await store.updateGallery(projectId, actor.userId, (cur, map) => {
      const c = checkLayoutChange(cur, map, entries, { everPublished: true });
      if (!c.ok) return fail("invalid", fixMessage(c.message));
      return { ok: true, entries: c.entries, tourUrl: null, expectVersion: version as number };
    });
  } catch {
    return fail("unavailable", "The gallery could not be saved right now.");
  }
  if (!r.ok) return r;
  await audit(deps, actor.userId, projectId, "investment.project_photos_changed", {
    layoutVersion: r.value.version, hidden: first.entries.filter(e => e.hidden).map(e => e.photoId), count: first.entries.length, backToReview: review
  });
  return { ok: true, value: { version: r.value.version, backToReview: review } };
}

/**
 * Bytes of one size of a project photo. The owner (hidden ones too), reviewing staff (logged), or an investor who may see
 * the project (showing photos only). A photo dropped from the gallery is never served. Storage is read only after the check.
 */
export async function readProjectPhoto(
  deps: InvestmentDeps, store: ProjectPhotoStore, storage: ObjectStoragePort, actor: Actor | null, photoId: string, size: PhotoSize, staff?: StaffView
): Promise<Result<{ bytes: Uint8Array; contentType: PhotoMime }>> {
  const photo = await store.photoById(photoId);
  const p = photo ? await deps.repo.getProject(photo.listingId) : undefined;
  if (!photo || !p) return notFound("Photo not found.");
  const entry = (await store.currentLayout(p.id)).entries.find(e => e.photoId === photoId);
  if (!entry) return notFound("Photo not found.");
  const isOwner = actor !== null && actor.userId === p.ownerUserId;
  if (!isOwner && !staff) {
    if (entry.hidden || !actor || !(await viewProject(deps, actor, p.id)).ok) return notFound("Photo not found.");
  }
  const sizes = await store.storedSizes(photoId);
  const file = sizes[size] ?? sizes.full;
  if (!file) return notFound("Photo not found.");
  if (!storage.configured) return fail("unavailable", "File storage is not configured.");
  let bytes: Uint8Array;
  try { bytes = await storage.get(file.storageKey); } catch { return fail("unavailable", "The photo could not be read right now."); }
  if (staff && !isOwner) await audit(deps, staff.staffId, p.id, "investment.project_photo_viewed_by_staff", { photoId });
  return { ok: true, value: { bytes, contentType: file.contentType } };
}

/** In-memory store for tests (same rules as the SQL store, minus real locking). */
export function createInMemoryProjectPhotoStore() {
  const photos: (PhotoRecord & { files: StoredSizes; sizeBytes: number })[] = [];
  const layouts: (Layout & { projectId: string; changedBy: string })[] = [];
  const current = (projectId: string): Layout => {
    const l = layouts.filter(x => x.projectId === projectId).at(-1);
    return l ? { version: l.version, entries: l.entries.map(e => ({ ...e })), tourUrl: null } : EMPTY_LAYOUT;
  };
  const strip = ({ files: _f, sizeBytes: _s, ...p }: (typeof photos)[number]): PhotoRecord => p;
  const of = (projectId: string) => photos.filter(p => p.listingId === projectId).map(strip);
  const store: ProjectPhotoStore = {
    async photosFor(id) { return of(id); },
    async photoById(id) { const p = photos.find(x => x.id === id); return p ? strip(p) : undefined; },
    async currentLayout(id) { return current(id); },
    async storedSizes(id) { return photos.find(p => p.id === id)?.files ?? {}; },
    async bytesUploadedSince(userId) { return photos.filter(p => p.uploadedBy === userId).reduce((n, p) => n + p.sizeBytes, 0); },
    async updateGallery(projectId, actorId, plan) {
      const cur = current(projectId);
      const p = plan(cur, byId(of(projectId)));
      if (!p.ok) return p;
      if (p.expectVersion !== undefined && p.expectVersion !== cur.version) return fail("conflict", "The gallery was changed elsewhere. Reload and try again.");
      if (p.addPhoto) photos.push({ ...p.addPhoto.record, files: p.addPhoto.files, sizeBytes: p.addPhoto.sizeBytes });
      layouts.push({ projectId, changedBy: actorId, version: cur.version + 1, entries: p.entries, tourUrl: null });
      return { ok: true, value: { version: cur.version + 1 } };
    },
    async coversFor(ids) {
      const out = new Map<string, { cover: PhotoView | null; photoCount: number }>();
      for (const id of ids) out.set(id, coverOf(current(id), byId(of(id))));
      return out;
    }
  };
  return { store, photos, layouts };
}

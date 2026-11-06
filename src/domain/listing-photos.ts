import type { JobAssignment } from "./job-chat";
import type { PhotoMime } from "./image-meta";
import { classifyTour, type TourKind } from "./virtual-tour";
import { PROFANITY_MESSAGE, findProfanity, hasProfanity } from "./profanity-filter";
export { PROFANITY_MESSAGE, findProfanity };

/**
 * Listing photo gallery rules (pure). Two records:
 * - listing_photo: one immutable row per stored file (never updated, never deleted).
 * - listing_photo_layout: append-only; each row is the whole ordered gallery at that moment (order, captions, alt text,
 *   hidden flags, tour link). The newest row is the current gallery. The first visible photo is the cover.
 * Before a listing has ever been published the owner may drop a photo from the gallery (it is then never served again).
 * After that, a photo can only be hidden, reordered or replaced; its file and every earlier layout stay on record.
 */
export type PhotoKind = "photo" | "floorplan" | "photo360";
export const PHOTO_KINDS: readonly PhotoKind[] = ["photo", "floorplan", "photo360"];
export const PHOTO_MIMES: readonly PhotoMime[] = ["image/jpeg", "image/png", "image/webp"];

export const PHOTO_LIMITS = {
  maxPhotos: 40,
  maxFloorplans: 10,
  /** Equirectangular 360 photos (one per room or outdoor area). */
  max360: 20,
  /** Hidden entries count here too, so a published listing cannot grow without bound. */
  maxEntries: 120,
  maxBytes: 10_000_000,
  minSide: 200,
  maxSide: 12_000,
  maxPixels: 60_000_000,
  captionMax: 140,
  altMax: 200,
  tourUrlMax: 500
} as const;

/** Investor project galleries (project-photos.ts): photos only, a lower cap. Here so browser code can read it. */
export const PROJECT_PHOTO_MAX = 30;

export type PhotoSize = "thumb" | "medium" | "full";
export const VARIANT_WIDTH: Record<Exclude<PhotoSize, "full">, number> = { thumb: 480, medium: 1280 };

/** Immutable file record. Storage keys are never sent to a browser. */
export interface PhotoRecord {
  id: string;
  listingId: string;
  kind: PhotoKind;
  uploadedBy: string;
  contentType: PhotoMime;
  width: number;
  height: number;
  /** Which resized copies exist (made with the optional image library). */
  variants: Exclude<PhotoSize, "full">[];
}

/** Rooms and areas a photo can be filed under. An empty category means "not sorted yet". */
export const PHOTO_CATEGORIES = [
  { key: "exterior", label: "Exterior and street" }, { key: "living", label: "Living areas" }, { key: "kitchen", label: "Kitchen" },
  { key: "dining", label: "Dining" }, { key: "bedroom", label: "Bedrooms" }, { key: "bathroom", label: "Bathrooms" },
  { key: "laundry", label: "Laundry" }, { key: "outdoor", label: "Outdoor and garden" }, { key: "pool", label: "Pool" },
  { key: "garage", label: "Garage and parking" }, { key: "view", label: "Views" }, { key: "other", label: "Other" }
] as const;
export type PhotoCategory = (typeof PHOTO_CATEGORIES)[number]["key"];
const CATEGORY_KEYS: ReadonlySet<string> = new Set(PHOTO_CATEGORIES.map(c => c.key));
export const isPhotoCategory = (v: unknown): v is PhotoCategory => typeof v === "string" && CATEGORY_KEYS.has(v);
export const categoryLabel = (key: string) => PHOTO_CATEGORIES.find(c => c.key === key)?.label ?? "";

export const FEATURE_LIMITS = { maxPerPhoto: 5, maxChars: 40 } as const;

/** `category` and `features` are optional so galleries saved before they existed (and investor project galleries) stay valid. */
export interface LayoutEntry { photoId: string; caption: string; alt: string; hidden: boolean; category?: PhotoCategory; features?: string[] }
export interface Layout { version: number; entries: LayoutEntry[]; tourUrl: string | null }
export const EMPTY_LAYOUT: Layout = { version: 0, entries: [], tourUrl: null };

/** What the browser gets for one photo. */
export interface PhotoView {
  id: string; kind: PhotoKind; width: number; height: number; caption: string; alt: string; hidden: boolean;
  /** "" when the owner has not filed the photo under a room. */
  category: PhotoCategory | ""; features: string[];
  sizes: PhotoSize[];
}

// --- Who may do what ---------------------------------------------------------------------------------------------

const MEDIA_ROLES: readonly JobAssignment["kind"][] = ["photographer", "agent"];

/** Owner, or an approved photographer/agent on this listing, may add photos. */
export function canUploadPhotos(userId: string, ownerUserId: string, listingId: string, assignments: readonly JobAssignment[]): boolean {
  if (userId === ownerUserId) return true;
  return assignments.some(a => a.listingId === listingId && a.contractorUserId === userId && a.status === "approved" && MEDIA_ROLES.includes(a.kind));
}

/** Draft photos: the owner and an approved or completed photographer/agent on the listing (staff are checked separately). */
export function canViewDraftPhotos(userId: string | undefined, ownerUserId: string, listingId: string, assignments: readonly JobAssignment[]): boolean {
  if (userId === undefined) return false;
  if (userId === ownerUserId) return true;
  return assignments.some(a => a.listingId === listingId && a.contractorUserId === userId &&
    (a.status === "approved" || a.status === "completed") && MEDIA_ROLES.includes(a.kind));
}

/** Withdrawn listings may have been live, so they count as published (same rule as documents). */
export const everPublished = (status: string) => status === "published" || status === "suspended" || status === "withdrawn" || status === "archived";
/** Order, captions and hiding can change while the listing is a draft, in review or live. A withdrawn listing is read-only. */
export const galleryEditable = (status: string) => status === "draft" || status === "pending_review" || status === "published";

// --- Text cleaning -----------------------------------------------------------------------------------------------

/** Trims, folds whitespace and drops control and bidi-override characters. */
export function cleanText(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? null : s;
}

/** Up to five short feature tags ("stone benchtop"). Returns null when the input is not a list of clean short strings. */
export function cleanFeatures(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > FEATURE_LIMITS.maxPerPhoto) return null;
  const out: string[] = [];
  for (const f of v) {
    const t = cleanText(f, FEATURE_LIMITS.maxChars);
    if (t === null) return null;
    if (t && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/** Optional video or virtual tour link: https only, no credentials, no odd ports. */
export function cleanTourUrl(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > PHOTO_LIMITS.tourUrlMax) return undefined;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

// --- Upload checks -----------------------------------------------------------------------------------------------

/** Size and dimension checks on the stripped image (the type has already been sniffed from the bytes). */
export function checkImage(info: { width: number; height: number }, sizeBytes: number): string | null {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) return "The file is empty.";
  if (sizeBytes > PHOTO_LIMITS.maxBytes) return "Each photo must be 10 MB or smaller.";
  const { width: w, height: h } = info;
  if (Math.min(w, h) < PHOTO_LIMITS.minSide) return `Photos must be at least ${PHOTO_LIMITS.minSide} pixels on each side.`;
  if (Math.max(w, h) > PHOTO_LIMITS.maxSide || w * h > PHOTO_LIMITS.maxPixels) return "The image is too large in pixels.";
  return null;
}

const countKind = (entries: readonly LayoutEntry[], photos: ReadonlyMap<string, PhotoRecord>, kind: PhotoKind) =>
  entries.filter(e => !e.hidden && photos.get(e.photoId)?.kind === kind).length;

/** Room for one more of this kind? Checked against the current layout before anything is stored. */
export function roomFor(layout: Layout, photos: ReadonlyMap<string, PhotoRecord>, kind: PhotoKind, replacing = false): string | null {
  if (layout.entries.length >= PHOTO_LIMITS.maxEntries) return "This gallery is full.";
  if (replacing) return null;
  if (kind === "photo" && countKind(layout.entries, photos, "photo") >= PHOTO_LIMITS.maxPhotos) return `A listing can show up to ${PHOTO_LIMITS.maxPhotos} photos.`;
  if (kind === "floorplan" && countKind(layout.entries, photos, "floorplan") >= PHOTO_LIMITS.maxFloorplans) return `A listing can show up to ${PHOTO_LIMITS.maxFloorplans} floor plans.`;
  if (kind === "photo360" && countKind(layout.entries, photos, "photo360") >= PHOTO_LIMITS.max360) return `A listing can show up to ${PHOTO_LIMITS.max360} 360 photos.`;
  return null;
}

/**
 * The layout after an upload: a new photo goes at the end, a replacement takes the old one's place (keeping its caption
 * and alt text) and the old one is hidden right after it, so it stays on record.
 */
export function layoutWithUpload(layout: Layout, photoId: string, replacesId?: string): LayoutEntry[] {
  const fresh: LayoutEntry = { photoId, caption: "", alt: "", hidden: false };
  if (!replacesId) return [...layout.entries, fresh];
  const out: LayoutEntry[] = [];
  for (const e of layout.entries) {
    if (e.photoId === replacesId) out.push({ ...fresh, caption: e.caption, alt: e.alt, ...(e.category ? { category: e.category } : {}), ...(e.features?.length ? { features: e.features } : {}) }, { ...e, hidden: true });
    else out.push(e);
  }
  return out;
}

// --- Layout changes ----------------------------------------------------------------------------------------------

export type LayoutCheck = { ok: true; entries: LayoutEntry[]; tourUrl: string | null } | { ok: false; message: string };

/**
 * Validates a whole new layout sent by the owner (order, captions, alt text, hidden flags, tour link).
 * Every entry must be a photo of this listing that is in the current layout, with no repeats. Leaving a photo out
 * removes it, which is only allowed before the listing has ever been published; afterwards it must be hidden instead.
 */
export function checkLayoutChange(
  current: Layout, photos: ReadonlyMap<string, PhotoRecord>, body: unknown, ctx: { everPublished: boolean }
): LayoutCheck {
  if (typeof body !== "object" || body === null) return { ok: false, message: "Invalid gallery." };
  const allowFlagged = (body as Record<string, unknown>)["allowFlagged"] === true;
  const raw = (body as Record<string, unknown>)["entries"];
  if (!Array.isArray(raw) || raw.length > PHOTO_LIMITS.maxEntries) return { ok: false, message: "Invalid gallery." };
  const inCurrent = new Set(current.entries.map(e => e.photoId));
  const seen = new Set<string>();
  const entries: LayoutEntry[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) return { ok: false, message: "Invalid gallery." };
    const o = r as Record<string, unknown>;
    const id = o["photoId"];
    if (typeof id !== "string" || !inCurrent.has(id) || !photos.has(id) || seen.has(id)) return { ok: false, message: "The gallery has changed. Reload and try again." };
    seen.add(id);
    const caption = cleanText(o["caption"], PHOTO_LIMITS.captionMax);
    if (caption === null) return { ok: false, message: `Captions must be ${PHOTO_LIMITS.captionMax} characters or fewer.` };
    const alt = cleanText(o["alt"], PHOTO_LIMITS.altMax);
    if (alt === null) return { ok: false, message: `Descriptions must be ${PHOTO_LIMITS.altMax} characters or fewer.` };
    if (o["hidden"] !== undefined && typeof o["hidden"] !== "boolean") return { ok: false, message: "Invalid gallery." };
    const cat = o["category"];
    if (cat !== undefined && cat !== null && cat !== "" && !isPhotoCategory(cat)) return { ok: false, message: "Unknown room or category." };
    const features = cleanFeatures(o["features"]);
    if (features === null) return { ok: false, message: `Features must be up to ${FEATURE_LIMITS.maxPerPhoto} short tags of ${FEATURE_LIMITS.maxChars} characters or fewer.` };
    if (!allowFlagged && hasProfanity(caption, alt, ...features)) return { ok: false, message: PROFANITY_MESSAGE };
    entries.push({
      photoId: id, caption, alt, hidden: o["hidden"] === true,
      ...(isPhotoCategory(cat) ? { category: cat } : {}), ...(features.length ? { features } : {})
    });
  }
  const dropped = current.entries.filter(e => !seen.has(e.photoId));
  if (dropped.length && ctx.everPublished) return { ok: false, message: "Photos of a published listing cannot be deleted. Hide or replace them instead." };
  if (countKind(entries, photos, "photo") > PHOTO_LIMITS.maxPhotos) return { ok: false, message: `A listing can show up to ${PHOTO_LIMITS.maxPhotos} photos.` };
  if (countKind(entries, photos, "floorplan") > PHOTO_LIMITS.maxFloorplans) return { ok: false, message: `A listing can show up to ${PHOTO_LIMITS.maxFloorplans} floor plans.` };
  const hasTour = Object.prototype.hasOwnProperty.call(body, "tourUrl");
  const tourUrl = hasTour ? cleanTourUrl((body as Record<string, unknown>)["tourUrl"]) : current.tourUrl;
  if (tourUrl === undefined) return { ok: false, message: "The tour link must be a full https:// address." };
  return { ok: true, entries, tourUrl };
}

/** Pure reorder helper for the owner screen (also used by the up/down buttons). */
export function moveEntry<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

/** Puts a photo first, which makes it the cover. */
export function makeCover<T>(list: readonly T[], isIt: (t: T) => boolean): T[] {
  const i = list.findIndex(isIt);
  return i < 0 ? [...list] : moveEntry(list, i, 0);
}

/** Rooms that have at least one photo, in the standard order, with counts (for the gallery filter). */
export function categoriesIn(views: readonly Pick<PhotoView, "category">[]): { key: PhotoCategory; label: string; count: number }[] {
  return PHOTO_CATEGORIES.map(c => ({ key: c.key, label: c.label, count: views.filter(v => v.category === c.key).length })).filter(c => c.count > 0);
}

// --- Views -------------------------------------------------------------------------------------------------------

/** Gallery entries joined with their file records. Public viewers never get hidden entries. */
export function viewsFor(layout: Layout, photos: ReadonlyMap<string, PhotoRecord>, includeHidden: boolean): PhotoView[] {
  const out: PhotoView[] = [];
  for (const e of layout.entries) {
    const p = photos.get(e.photoId);
    if (!p || (e.hidden && !includeHidden)) continue;
    out.push({ id: p.id, kind: p.kind, width: p.width, height: p.height, caption: e.caption, alt: e.alt, hidden: e.hidden,
      category: e.category ?? "", features: e.features ?? [], sizes: [...p.variants, "full"] });
  }
  return out;
}

/** Cover photo and count for a browse card: the first visible photo (floor plans are never the cover). */
export function coverOf(layout: Layout, photos: ReadonlyMap<string, PhotoRecord>): { cover: PhotoView | null; photoCount: number; tour?: TourKind } {
  const all = viewsFor(layout, photos, false);
  const visible = all.filter(v => v.kind === "photo");
  const tour = classifyTour(layout.tourUrl)?.kind ?? (all.some(v => v.kind === "photo360") ? "360" : undefined);
  return { cover: visible[0] ?? null, photoCount: visible.length, ...(tour ? { tour } : {}) };
}

export interface CardPhoto { photoCount: number; tour?: TourKind; cover?: { id: string; width: number; height: number; srcSet: string; alt: string } }

/** Fields a browse card needs: cover image (with srcset) and the visible photo count. */
export function cardPhoto(c: { cover: PhotoView | null; photoCount: number; tour?: TourKind } | undefined, base = PHOTO_BASE): CardPhoto {
  const tour = c?.tour ? { tour: c.tour } : {};
  if (!c?.cover) return { photoCount: c?.photoCount ?? 0, ...tour };
  const v = c.cover;
  return { photoCount: c.photoCount, ...tour, cover: { id: v.id, width: v.width, height: v.height, srcSet: srcSetFor(v, base), alt: v.alt || v.caption } };
}

/** Where listing photos are served. Investor project photos use their own routes (see project-photos.ts). */
export const PHOTO_BASE = "/api/photos";

/** Unguessable URL of one size of a photo. */
export const photoUrl = (id: string, size: PhotoSize = "full", base = PHOTO_BASE) => (size === "full" ? `${base}/${id}` : `${base}/${id}?size=${size}`);

/** srcset with the real width of each stored size (a resized copy is never wider than the original). */
export function srcSetFor(v: Pick<PhotoView, "id" | "width" | "sizes">, base = PHOTO_BASE): string {
  const parts: string[] = [];
  for (const s of v.sizes) {
    const w = s === "full" ? v.width : Math.min(VARIANT_WIDTH[s], v.width);
    if (s !== "full" && w >= v.width) continue;
    parts.push(`${photoUrl(v.id, s, base)} ${w}w`);
  }
  return parts.join(", ");
}

/** Text alternative for an image: the owner's description, else the caption, else a numbered fallback. */
export function altFor(v: Pick<PhotoView, "alt" | "caption" | "kind">, index: number, total: number, title: string): string {
  if (v.alt) return v.alt;
  if (v.caption) return v.caption;
  return `${v.kind === "floorplan" ? "Floor plan" : "Photo"} ${index + 1} of ${total}: ${title}`;
}

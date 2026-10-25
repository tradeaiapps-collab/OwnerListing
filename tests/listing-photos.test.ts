import { describe, expect, it } from "vitest";
import {
  EMPTY_LAYOUT, PHOTO_LIMITS, altFor, canUploadPhotos, canViewDraftPhotos, cardPhoto, checkImage, checkLayoutChange, cleanText, cleanTourUrl,
  coverOf, everPublished, galleryEditable, layoutWithUpload, makeCover, moveEntry, roomFor, srcSetFor, viewsFor,
  type Layout, type PhotoKind, type PhotoRecord
} from "../src/domain/listing-photos";
import type { JobAssignment } from "../src/domain/job-chat";

const photo = (id: string, kind: PhotoKind = "photo", variants: PhotoRecord["variants"] = []): PhotoRecord =>
  ({ id, listingId: "L", kind, uploadedBy: "owner", contentType: "image/jpeg", width: 2000, height: 1500, variants });
const map = (...p: PhotoRecord[]) => new Map(p.map(x => [x.id, x]));
const layout = (ids: string[], hidden: string[] = []): Layout =>
  ({ version: 3, tourUrl: null, entries: ids.map(id => ({ photoId: id, caption: "", alt: "", hidden: hidden.includes(id) })) });
const assignment = (kind: JobAssignment["kind"], status: JobAssignment["status"]): JobAssignment =>
  ({ id: "a", listingId: "L", ownerUserId: "owner", contractorUserId: "c", kind, status });

describe("who may add and see photos", () => {
  it("owner and approved photographer/agent may upload; inspectors, proposed or other listings may not", () => {
    expect(canUploadPhotos("owner", "owner", "L", [])).toBe(true);
    expect(canUploadPhotos("c", "owner", "L", [assignment("photographer", "approved")])).toBe(true);
    expect(canUploadPhotos("c", "owner", "L", [assignment("agent", "approved")])).toBe(true);
    expect(canUploadPhotos("c", "owner", "L", [assignment("inspector", "approved")])).toBe(false);
    expect(canUploadPhotos("c", "owner", "L", [assignment("photographer", "proposed")])).toBe(false);
    expect(canUploadPhotos("c", "owner", "OTHER", [assignment("photographer", "approved")])).toBe(false);
    expect(canUploadPhotos("x", "owner", "L", [])).toBe(false);
  });
  it("draft photos: owner and the listing's photographer/agent only; never signed-out visitors", () => {
    expect(canViewDraftPhotos(undefined, "owner", "L", [])).toBe(false);
    expect(canViewDraftPhotos("x", "owner", "L", [])).toBe(false);
    expect(canViewDraftPhotos("c", "owner", "L", [assignment("agent", "completed")])).toBe(true);
    expect(canViewDraftPhotos("c", "owner", "L", [assignment("solicitor", "approved")])).toBe(false);
  });
  it("withdrawn counts as published and is read-only", () => {
    expect([everPublished("draft"), everPublished("pending_review"), everPublished("published"), everPublished("withdrawn")]).toEqual([false, false, true, true]);
    expect(galleryEditable("withdrawn")).toBe(false);
    expect(galleryEditable("published")).toBe(true);
  });
});

describe("upload checks", () => {
  it("size and pixel limits", () => {
    expect(checkImage({ width: 800, height: 600 }, 1000)).toBeNull();
    expect(checkImage({ width: 800, height: 600 }, 0)).toMatch(/empty/);
    expect(checkImage({ width: 800, height: 600 }, PHOTO_LIMITS.maxBytes + 1)).toMatch(/10 MB/);
    expect(checkImage({ width: 100, height: 600 }, 1000)).toMatch(/at least/);
    expect(checkImage({ width: 12_001, height: 600 }, 1000)).toMatch(/too large/);
    expect(checkImage({ width: 9000, height: 9000 }, 1000)).toMatch(/too large/);
  });
  it("40 visible photos and 10 floor plans; hidden ones do not count toward those", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `p${i}`);
    const photos = map(...ids.map(id => photo(id)));
    expect(roomFor(layout(ids), photos, "photo")).toMatch(/up to 40/);
    expect(roomFor(layout(ids), photos, "floorplan")).toBeNull();
    expect(roomFor(layout(ids, ["p0"]), photos, "photo")).toBeNull();
    expect(roomFor(layout(ids), photos, "photo", true)).toBeNull();
    const plans = Array.from({ length: 10 }, (_, i) => `f${i}`);
    expect(roomFor(layout(plans), map(...plans.map(id => photo(id, "floorplan"))), "floorplan")).toMatch(/up to 10/);
    const full = Array.from({ length: PHOTO_LIMITS.maxEntries }, (_, i) => `h${i}`);
    expect(roomFor(layout(full, full), map(...full.map(id => photo(id))), "photo", true)).toMatch(/full/);
  });
  it("a new photo goes last; a replacement takes the old place and keeps the old one hidden, with its caption", () => {
    const l: Layout = { ...layout(["a", "b"]), entries: [{ photoId: "a", caption: "Kitchen", alt: "Stone bench", hidden: false }, { photoId: "b", caption: "", alt: "", hidden: false }] };
    expect(layoutWithUpload(l, "c").map(e => e.photoId)).toEqual(["a", "b", "c"]);
    expect(layoutWithUpload(l, "n", "a")).toEqual([
      { photoId: "n", caption: "Kitchen", alt: "Stone bench", hidden: false },
      { photoId: "a", caption: "Kitchen", alt: "Stone bench", hidden: true },
      { photoId: "b", caption: "", alt: "", hidden: false }
    ]);
  });
});

describe("layout changes", () => {
  const photos = map(photo("a"), photo("b"), photo("c", "floorplan"));
  const cur = layout(["a", "b", "c"]);
  const entries = (ids: string[], extra: Record<string, unknown> = {}) => ids.map(id => ({ photoId: id, caption: "", alt: "", hidden: false, ...extra }));

  it("reorders, sets captions and alt text, hides, and cleans text", () => {
    const r = checkLayoutChange(cur, photos, { entries: [{ photoId: "b", caption: "  Big\nkitchen ‮ ", alt: "Kitchen", hidden: true }, ...entries(["a", "c"])] }, { everPublished: true });
    expect(r).toEqual({ ok: true, tourUrl: null, entries: [{ photoId: "b", caption: "Big kitchen", alt: "Kitchen", hidden: true }, ...entries(["a", "c"])] });
  });
  it("removing a photo is allowed only before the listing was ever published", () => {
    expect(checkLayoutChange(cur, photos, { entries: entries(["a", "c"]) }, { everPublished: false }).ok).toBe(true);
    const r = checkLayoutChange(cur, photos, { entries: entries(["a", "c"]) }, { everPublished: true });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/cannot be deleted/) });
  });
  it("refuses unknown, repeated or other-listing photos, bad text, bad hidden flags and bad shapes", () => {
    for (const body of [
      { entries: entries(["a", "b", "c", "x"]) }, { entries: entries(["a", "a", "b", "c"]) }, { entries: [...entries(["a", "b"]), { photoId: "c", caption: "x".repeat(141) }] },
      { entries: [...entries(["a", "b"]), { photoId: "c", alt: 5 }] }, { entries: [...entries(["a", "b"]), { photoId: "c", hidden: "yes" }] },
      { entries: "a" }, null, { entries: [null] }
    ]) expect(checkLayoutChange(cur, photos, body, { everPublished: false }).ok).toBe(false);
    // A photo uploaded but dropped from an earlier layout cannot come back.
    expect(checkLayoutChange(layout(["a", "c"]), photos, { entries: entries(["a", "b", "c"]) }, { everPublished: false }).ok).toBe(false);
  });
  it("tour link: https only, no credentials; omitted keeps the current one", () => {
    expect(cleanTourUrl("https://tour.example.com/x?y=1")).toBe("https://tour.example.com/x?y=1");
    for (const bad of ["http://x.example", "javascript:alert(1)", "https://u:p@x.example", "https://x.example:8443/", "not a url", 5]) expect(cleanTourUrl(bad)).toBeUndefined();
    expect(cleanTourUrl("")).toBeNull();
    const withTour = { ...cur, tourUrl: "https://t.example/" };
    expect(checkLayoutChange(withTour, photos, { entries: entries(["a", "b", "c"]) }, { everPublished: false })).toMatchObject({ ok: true, tourUrl: "https://t.example/" });
    expect(checkLayoutChange(withTour, photos, { entries: entries(["a", "b", "c"]), tourUrl: null }, { everPublished: false })).toMatchObject({ ok: true, tourUrl: null });
    expect(checkLayoutChange(withTour, photos, { entries: entries(["a", "b", "c"]), tourUrl: "data:text/html,x" }, { everPublished: false }).ok).toBe(false);
  });
  it("cleanText refuses non-strings and over-long text", () => {
    expect(cleanText(undefined, 5)).toBe("");
    expect(cleanText(3, 5)).toBeNull();
    expect(cleanText("abcdef", 5)).toBeNull();
  });
  it("moveEntry and makeCover", () => {
    expect(moveEntry(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveEntry(["a", "b"], 0, 5)).toEqual(["a", "b"]);
    expect(makeCover(["a", "b", "c"], x => x === "c")).toEqual(["c", "a", "b"]);
  });
});

describe("views, cover and srcset", () => {
  const photos = map(photo("plan", "floorplan"), photo("a", "photo", ["thumb", "medium"]), photo("b"));
  it("public views drop hidden photos; the cover is the first visible photo, never a floor plan", () => {
    const l = layout(["plan", "a", "b"], ["a"]);
    expect(viewsFor(l, photos, false).map(v => v.id)).toEqual(["plan", "b"]);
    expect(viewsFor(l, photos, true).map(v => v.id)).toEqual(["plan", "a", "b"]);
    expect(coverOf(l, photos)).toMatchObject({ cover: { id: "b" }, photoCount: 1 });
    expect(coverOf(EMPTY_LAYOUT, photos)).toEqual({ cover: null, photoCount: 0 });
    expect(cardPhoto(undefined)).toEqual({ photoCount: 0 });
  });
  it("srcset lists each stored size with its real width", () => {
    const [a] = viewsFor(layout(["a"]), photos, false);
    expect(srcSetFor(a!)).toBe(`/api/photos/a?size=thumb 480w, /api/photos/a?size=medium 1280w, /api/photos/a 2000w`);
    expect(cardPhoto({ cover: a!, photoCount: 3 })).toMatchObject({ photoCount: 3, cover: { id: "a", width: 2000, height: 1500 } });
  });
  it("alt text falls back to the caption, then a numbered description", () => {
    expect(altFor({ alt: "Pool", caption: "x", kind: "photo" }, 0, 3, "Home")).toBe("Pool");
    expect(altFor({ alt: "", caption: "Deck", kind: "photo" }, 0, 3, "Home")).toBe("Deck");
    expect(altFor({ alt: "", caption: "", kind: "floorplan" }, 1, 3, "Home")).toBe("Floor plan 2 of 3: Home");
  });
});

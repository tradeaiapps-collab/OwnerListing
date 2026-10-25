import { beforeEach, describe, expect, it, vi } from "vitest";
import { noVariants, type ImageVariantPort } from "../src/adapters/image-variants";
import { createUnconfiguredScanner, type MalwareScanPort } from "../src/adapters/malware-scan";
import { createUnconfiguredStorage, type ObjectStoragePort } from "../src/adapters/object-storage";
import type { AuditEvent } from "../src/domain/audit";
import { createDraft, createInMemoryListingRepository, type Actor, type DraftInput, type ListingServiceDeps } from "../src/domain/listing-service";
import { createInMemoryPhotoStore } from "../src/domain/photo-service";
import type { StaffActor } from "../src/domain/staff-access";
import { has, jpeg, png, webp } from "./helpers/image-fixtures";

const state = vi.hoisted(() => ({
  actor: null as Actor | null, staff: null as StaffActor | null, deps: null as unknown, store: null as unknown, ports: null as unknown,
  hits: 1 as number | undefined, hitThrows: false, buckets: [] as string[]
}));
vi.mock("../src/server/context", () => ({
  getActor: () => state.actor, getStaff: async () => state.staff, getDeps: () => state.deps, getDb: () => ({}),
  getPhotoPorts: async () => state.ports, getUploadPorts: () => state.ports
}));
vi.mock("../src/server/photos-db", () => ({ createPgPhotoStore: () => state.store }));
vi.mock("../src/server/offer-flow-db", () => ({
  countHitPg: async (_db: unknown, bucket: string) => { state.buckets.push(bucket); if (state.hitThrows) throw new Error("down"); return state.hits; }
}));

import * as uploadRoute from "../app/api/listings/[id]/photos/route";
import * as layoutRoute from "../app/api/listings/[id]/photos/layout/route";
import * as fileRoute from "../app/api/photos/[id]/route";

process.env["APP_URL"] = "http://test";
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: Actor = { userId: uid(1), userType: "owner" };
const stranger: Actor = { userId: uid(2), userType: "owner" };
const photographer: Actor = { userId: uid(3), userType: "agent" };
const draft: DraftInput = { title: "Family home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD", transactionType: "sale", useClass: "residential", propertyType: "house" };
const EXE = Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0]);
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");

let listingId: string;
let mem: ReturnType<typeof createInMemoryPhotoStore>;
let objects: Map<string, { bytes: Uint8Array; type: string }>;
let audit: AuditEvent[];
let termsOk: boolean;
let scanResult: "clean" | "infected" | "throw";
let deps: ListingServiceDeps;

beforeEach(async () => {
  let n = 100;
  audit = []; termsOk = true; scanResult = "clean";
  state.actor = owner; state.staff = null; state.hits = 1; state.hitThrows = false; state.buckets = [];
  deps = {
    repo: createInMemoryListingRepository(), appendAudit: async e => { audit.push(e); }, now: () => "2026-10-25T00:00:00.000Z",
    newId: () => uid(++n), requiredDisclosures: () => [], termsCurrentFor: async () => termsOk
  };
  state.deps = deps;
  listingId = (await createDraft(deps, owner, draft)).id;
  mem = createInMemoryPhotoStore({ assignments: [{ id: uid(50), listingId, ownerUserId: owner.userId, contractorUserId: photographer.userId, kind: "photographer", status: "approved" }] });
  state.store = mem.store;
  objects = new Map();
  const storage: ObjectStoragePort = {
    configured: true,
    async put(key, bytes, type) { if (objects.has(key)) throw new Error("exists"); objects.set(key, { bytes, type }); },
    async get(key) { const o = objects.get(key); if (!o) throw new Error("missing"); return o.bytes; }
  };
  const scanner: MalwareScanPort = { configured: true, async scan() { if (scanResult === "throw") throw new Error("down"); return scanResult; } };
  state.ports = { storage, scanner, variants: noVariants };
});

async function setStatus(status: "published" | "withdrawn" | "pending_review") {
  const rec = (await deps.repo.get(listingId))!;
  await deps.repo.save({ ...rec, listing: { ...rec.listing, status } });
}

function upload(bytes: Uint8Array, o: { type?: string; name?: string; kind?: string; replacesId?: string; id?: string; origin?: string; length?: number } = {}) {
  const form = new FormData();
  form.set("file", new File([bytes as Uint8Array<ArrayBuffer>], o.name ?? "IMG_0001.jpg", { type: o.type ?? "image/jpeg" }));
  if (o.kind) form.set("kind", o.kind);
  if (o.replacesId) form.set("replacesId", o.replacesId);
  return uploadRoute.POST(new Request("http://test/x", {
    method: "POST", body: form, headers: { origin: o.origin ?? "http://test", "content-length": String(o.length ?? bytes.length + 400) }
  }), { params: Promise.resolve({ id: o.id ?? listingId }) });
}
const list = (id = listingId) => uploadRoute.GET(new Request("http://test/x"), { params: Promise.resolve({ id }) });
const put = (body: unknown, o: { origin?: string; type?: string } = {}) => layoutRoute.PUT(new Request("http://test/x", {
  method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body), headers: { origin: o.origin ?? "http://test", "content-type": o.type ?? "application/json" }
}), { params: Promise.resolve({ id: listingId }) });
const file = (id: string, size?: string) => fileRoute.GET(new Request(`http://test/api/photos/${id}${size ? `?size=${size}` : ""}`), { params: Promise.resolve({ id }) });
const added = async (bytes = jpeg(), o: Parameters<typeof upload>[1] = {}) => {
  const r = await upload(bytes, o);
  expect(r.status).toBe(201);
  return (await r.json()).id as string;
};
const gallery = async () => (await (await list()).json());

describe("POST /api/listings/[id]/photos (upload)", () => {
  it("stores the image without EXIF/GPS under a random key, drops the filename, records it and audits", async () => {
    const id = await added(jpeg({ orientation: 6 }), { name: "my-house-gps.jpg" });
    const [stored] = [...objects.entries()];
    expect(stored![0]).toMatch(new RegExp(`^listings/${listingId}/[0-9a-f-]{36}$`));
    expect(stored![1].type).toBe("image/jpeg");
    expect(has(stored![1].bytes, "GPS-LAT")).toBe(false);
    expect(has(stored![1].bytes, "SERIAL-CAM")).toBe(false);
    expect(has(stored![1].bytes, "my-house")).toBe(false);
    expect(mem.photos[0]).toMatchObject({ id, kind: "photo", width: 600, height: 800, uploadedBy: owner.userId });
    expect(mem.layouts.at(-1)!.entries.map(e => e.photoId)).toEqual([id]);
    expect(audit.map(e => e.eventType).filter(t => t.startsWith("photo."))).toEqual(["photo.uploaded"]);
    expect(state.buckets[0]).not.toContain(owner.userId);
  });

  it("accepts PNG and WebP, and floor plans", async () => {
    await added(png(), { type: "image/png", name: "a.png" });
    await added(webp(), { type: "image/webp", name: "a.webp", kind: "floorplan" });
    expect(mem.photos.map(p => [p.contentType, p.kind])).toEqual([["image/png", "photo"], ["image/webp", "floorplan"]]);
  });

  it("refuses cross-origin requests, missing sessions and missing terms", async () => {
    expect((await upload(jpeg(), { origin: "https://evil.example" })).status).toBe(403);
    state.actor = null;
    expect((await upload(jpeg())).status).toBe(401);
    state.actor = owner; termsOk = false;
    expect((await upload(jpeg())).status).toBe(403);
    expect(objects.size).toBe(0);
  });

  it("refuses another owner's listing and an unknown listing; an approved photographer may add", async () => {
    state.actor = stranger;
    expect((await upload(jpeg())).status).toBe(403);
    expect((await upload(jpeg(), { id: uid(999) })).status).toBe(404);
    expect((await upload(jpeg(), { id: "not-a-uuid" })).status).toBe(404);
    state.actor = photographer;
    expect((await upload(jpeg())).status).toBe(201);
  });

  it("wrong types and spoofed content types are refused (type comes from the bytes)", async () => {
    expect((await upload(PDF, { type: "application/pdf", name: "plan.pdf" })).status).toBe(400);
    expect((await upload(EXE, { type: "image/jpeg", name: "photo.jpg" })).status).toBe(400);
    expect((await upload(png(), { type: "image/jpeg", name: "photo.jpg" })).status).toBe(400);
    const heic = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]);
    expect((await upload(heic, { type: "image/heic", name: "a.heic" })).status).toBe(400);
    const r = await upload(jpeg().subarray(0, 60), { name: "cut.jpg" });
    expect(r.status).toBe(400);
    expect((await upload(jpeg(), { kind: "video" })).status).toBe(400);
    expect(objects.size).toBe(0);
  });

  it("enforces the 10 MB limit before reading the body, and tiny images", async () => {
    expect((await upload(jpeg(), { length: 10_200_000 })).status).toBe(413);
    expect((await upload(jpeg({ width: 100, height: 80 }))).status).toBe(400);
    const big = new Uint8Array(10_000_001); big.set(jpeg());
    expect((await upload(big, { length: 10_000_200 })).status).toBe(413);
  });

  it("fails closed: unconfigured storage or scanner (503, nothing stored), infected (400), scanner error (503)", async () => {
    const ports = state.ports as { storage: ObjectStoragePort; scanner: MalwareScanPort; variants: ImageVariantPort };
    state.ports = { ...ports, storage: createUnconfiguredStorage() };
    expect((await upload(jpeg())).status).toBe(503);
    state.ports = { ...ports, scanner: createUnconfiguredScanner() };
    expect((await upload(jpeg())).status).toBe(503);
    state.ports = ports;
    scanResult = "infected";
    expect((await upload(jpeg())).status).toBe(400);
    scanResult = "throw";
    expect((await upload(jpeg())).status).toBe(503);
    expect(objects.size).toBe(0);
    expect(mem.photos).toHaveLength(0);
  });

  it("rate limit (429), store error on the limiter (503) and the daily byte quota", async () => {
    state.hits = 121;
    expect((await upload(jpeg())).status).toBe(429);
    state.hits = 1; state.hitThrows = true;
    expect((await upload(jpeg())).status).toBe(503);
    state.hitThrows = false;
    mem.store.bytesUploadedSince = async () => 499_999_999;
    expect((await upload(jpeg())).status).toBe(429);
    mem.store.bytesUploadedSince = async () => undefined;
    expect((await upload(jpeg())).status).toBe(429);
  });

  it("limits a gallery to 40 showing photos", async () => {
    for (let i = 0; i < 40; i++) await added();
    expect((await upload(jpeg())).status).toBe(409);
    expect((await upload(jpeg(), { kind: "floorplan" })).status).toBe(201);
  });

  it("replace keeps the old photo on record, hidden, and takes its place; only the same kind; photographer only their own", async () => {
    const a = await added(), b = await added();
    const n = await added(jpeg(), { replacesId: a });
    expect(mem.layouts.at(-1)!.entries.map(e => [e.photoId, e.hidden])).toEqual([[n, false], [a, true], [b, false]]);
    expect(mem.photos.map(p => p.id)).toContain(a);
    expect(audit.at(-1)!.eventType).toBe("photo.replaced");
    expect((await upload(jpeg(), { replacesId: a })).status).toBe(409);
    expect((await upload(jpeg(), { replacesId: b, kind: "floorplan" })).status).toBe(400);
    expect((await upload(jpeg(), { replacesId: uid(999) })).status).toBe(404);
    state.actor = photographer;
    expect((await upload(jpeg(), { replacesId: b })).status).toBe(403);
  });

  it("a withdrawn listing's gallery is read-only", async () => {
    await setStatus("withdrawn");
    expect((await upload(jpeg())).status).toBe(409);
  });

  it("has no DELETE handler", () => {
    expect((uploadRoute as Record<string, unknown>)["DELETE"]).toBeUndefined();
    expect((fileRoute as Record<string, unknown>)["DELETE"]).toBeUndefined();
    expect((layoutRoute as Record<string, unknown>)["DELETE"]).toBeUndefined();
  });
});

describe("PUT /api/listings/[id]/photos/layout", () => {
  it("reorders, sets the cover, captions and alt text, as a new history row", async () => {
    const a = await added(), b = await added();
    const g = await gallery();
    const r = await put({ version: g.version, entries: [{ photoId: b, caption: "Kitchen", alt: "Stone kitchen" }, { photoId: a }], tourUrl: "https://tour.example/1" });
    expect(r.status).toBe(200);
    const after = await gallery();
    expect(after.photos.map((p: { id: string }) => p.id)).toEqual([b, a]);
    expect(after.photos[0]).toMatchObject({ caption: "Kitchen", alt: "Stone kitchen" });
    expect(after.tourUrl).toBe("https://tour.example/1");
    expect(mem.layouts).toHaveLength(3);
    expect(audit.at(-1)).toMatchObject({ eventType: "photo.layout_changed", payload: { removed: [], hidden: [], count: 2 } });
  });

  it("refuses a stale version (409) so two tabs cannot overwrite each other", async () => {
    const a = await added();
    expect((await put({ version: 0, entries: [{ photoId: a }] })).status).toBe(409);
  });

  it("draft: remove is allowed; after publishing: remove refused, hide allowed, hidden not public", async () => {
    const a = await added(), b = await added();
    expect((await put({ version: 2, entries: [{ photoId: b }] })).status).toBe(200);
    expect((await file(a)).status).toBe(404); // dropped from the draft: never served, even to the owner
    const c = await added();
    await setStatus("published");
    expect((await put({ version: 4, entries: [{ photoId: b }] })).status).toBe(400);
    expect((await put({ version: 4, entries: [{ photoId: b }, { photoId: c, hidden: true }] })).status).toBe(200);
    state.actor = null;
    expect((await file(c)).status).toBe(404);
    expect((await file(b)).status).toBe(200);
    state.actor = owner;
    expect((await file(c)).status).toBe(200);
  });

  it("owner only, CSRF, JSON, terms and rate limit", async () => {
    const a = await added();
    const body = { version: 1, entries: [{ photoId: a }] };
    expect((await put(body, { origin: "https://evil.example" })).status).toBe(403);
    expect((await put(body, { type: "text/plain" })).status).toBe(403);
    state.actor = photographer;
    expect((await put(body)).status).toBe(404);
    state.actor = stranger;
    expect((await put(body)).status).toBe(404);
    state.actor = null;
    expect((await put(body)).status).toBe(401);
    state.actor = owner; termsOk = false;
    expect((await put(body)).status).toBe(403);
    termsOk = true; state.hits = 121;
    expect((await put(body)).status).toBe(429);
    state.hits = 1;
    expect((await put("{not json")).status).toBe(400);
    expect((await put({ entries: [{ photoId: a }] })).status).toBe(400);
  });
});

describe("GET /api/photos/[id] and the gallery list", () => {
  it("drafts are not public: signed-out and other users get 404; owner, photographer and case staff may see them", async () => {
    const a = await added();
    state.actor = null;
    expect((await file(a)).status).toBe(404);
    expect((await list()).status).toBe(404);
    state.actor = stranger;
    expect((await file(a)).status).toBe(404);
    expect((await list()).status).toBe(404);
    state.actor = photographer;
    expect((await file(a)).status).toBe(200);
    state.actor = null;
    state.staff = { id: uid(70), role: "technical" };
    expect((await file(a)).status).toBe(404);
    state.staff = { id: uid(71), role: "super_admin" };
    const r = await file(a);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(audit.at(-1)).toMatchObject({ eventType: "photo.viewed_by_staff", actorId: uid(71) });
    state.staff = null; state.actor = owner;
    expect((await file(a)).headers.get("cache-control")).toBe("private, no-store");
  });

  it("published photos are public with a fixed image type, nosniff, sandbox CSP and a short public cache", async () => {
    const a = await added(png(), { type: "image/png" });
    await setStatus("published");
    state.actor = null;
    const r = await file(a);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(r.headers.get("cache-control")).toBe("public, max-age=600");
    expect(r.headers.get("content-disposition")).toBe("inline");
    const g = await gallery();
    expect(g).toMatchObject({ canManage: false, canUpload: false, photos: [{ id: a, kind: "photo" }] });
    expect(JSON.stringify(g)).not.toMatch(/listings\//); // storage keys never leave the server
  });

  it("a missing size falls back to full; unknown sizes and malformed ids are 404; storage errors are 503", async () => {
    const a = await added();
    expect((await file(a, "thumb")).status).toBe(200);
    expect((await file(a, "huge")).status).toBe(404);
    expect((await file("../etc/passwd")).status).toBe(404);
    expect((await file(uid(999))).status).toBe(404);
    objects.clear();
    expect((await file(a)).status).toBe(503);
  });

  it("serves the resized copy when one was made", async () => {
    const ports = state.ports as { storage: ObjectStoragePort; scanner: MalwareScanPort };
    const tiny = webp({ width: 480, height: 360 });
    state.ports = { ...ports, variants: { available: true, async make() { return { thumb: tiny, medium: Uint8Array.from([1, 2, 3]) }; } } };
    const a = await added(jpeg({ width: 2000, height: 1500 }));
    expect(mem.photos[0]!.variants).toEqual(["thumb"]); // the non-WebP "medium" output was refused
    const r = await file(a, "thumb");
    expect(r.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(tiny);
  });

  it("the owner's list includes hidden photos and edit rights; drafts list for the photographer without manage rights", async () => {
    const a = await added(), b = await added();
    await put({ version: 2, entries: [{ photoId: a }, { photoId: b, hidden: true }] });
    expect(await gallery()).toMatchObject({ canManage: true, canUpload: true, everPublished: false, photos: [{ id: a }, { id: b, hidden: true }] });
    state.actor = photographer;
    expect(await gallery()).toMatchObject({ canManage: false, canUpload: true, photos: [{ id: a }] });
  });
});

describe("browse cards", () => {
  it("GET /api/listings adds the cover photo (with srcset) and the photo count; a photo lookup error leaves cards without photos", async () => {
    const { GET } = await import("../app/api/listings/route");
    const a = await added(), b = await added();
    await put({ version: 2, entries: [{ photoId: b, alt: "Front garden" }, { photoId: a }] });
    await setStatus("published");
    state.actor = null;
    const d = await (await GET(new Request("http://test/api/listings"))).json();
    expect(d.listings[0]).toMatchObject({ id: listingId, photoCount: 2, cover: { id: b, alt: "Front garden", srcSet: `/api/photos/${b} 800w` } });
    expect(JSON.stringify(d)).not.toContain("ownerUserId");
    mem.store.coversFor = async () => { throw new Error("down"); };
    const e = await (await GET(new Request("http://test/api/listings"))).json();
    expect(e.listings[0]).toMatchObject({ id: listingId });
    expect(e.listings[0].cover).toBeUndefined();
  });
});

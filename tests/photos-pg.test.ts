import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noVariants } from "../src/adapters/image-variants";
import type { ObjectStoragePort } from "../src/adapters/object-storage";
import { listPhotos, readPhoto, updateLayout, uploadPhoto } from "../src/domain/photo-service";
import type { Actor, ListingServiceDeps } from "../src/domain/listing-service";
import { appendAuditPg, createPgListingRepository } from "../src/server/db";
import { createPgPhotoStore } from "../src/server/photos-db";
import { tourFactsPg } from "../src/server/chat-assistant-db";
import { jpeg, png } from "./helpers/image-fixtures";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("listing photos on Postgres", () => {
  let t: TestDb;
  let deps: ListingServiceDeps;
  let owner: Actor, other: Actor;
  const objects = new Map<string, Uint8Array>();
  const storage: ObjectStoragePort = {
    configured: true,
    async put(k, b) { objects.set(k, b); },
    async get(k) { const b = objects.get(k); if (!b) throw new Error("missing"); return b; }
  };
  const ports = { storage, scanner: { configured: true, async scan() { return "clean" as const; } }, variants: noVariants };

  beforeAll(async () => {
    t = await createTestDb();
    owner = { userId: await addUser(t.db, "owner"), userType: "owner" };
    other = { userId: await addUser(t.db, "owner"), userType: "owner" };
    deps = {
      repo: createPgListingRepository(t.db), appendAudit: e => appendAuditPg(t.db, e), now: () => new Date().toISOString(),
      newId: () => randomUUID(), requiredDisclosures: () => []
    };
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("uploads, lists, reorders and keeps every layout as history", async () => {
    const lid = await addListing(t.db, owner.userId);
    const store = createPgPhotoStore(t.db);
    const a = await uploadPhoto(deps, store, ports, owner, lid, { kind: "photo", declaredMime: "image/jpeg", bytes: jpeg({ orientation: 8 }) });
    const b = await uploadPhoto(deps, store, ports, owner, lid, { kind: "floorplan", declaredMime: "image/png", bytes: png() });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const g = await listPhotos(deps, store, owner, lid);
    expect(g.ok && g.value.photos.map(p => [p.id, p.kind, p.width, p.height])).toEqual([[a.value.id, "photo", 600, 800], [b.value.id, "floorplan", 300, 200]]);
    const r = await updateLayout(deps, store, owner, lid, { version: 2, entries: [{ photoId: b.value.id, caption: "Plan" }, { photoId: a.value.id }] });
    expect(r).toEqual({ ok: true, value: { version: 3 } });
    expect((await updateLayout(deps, store, owner, lid, { version: 2, entries: [] })).ok).toBe(false);
    const rows = await t.db.query("SELECT version, jsonb_array_length(entries) AS n FROM listing_photo_layout WHERE listing_id = $1 ORDER BY version", [lid]);
    expect(rows.rows).toEqual([{ version: 1, n: 1 }, { version: 2, n: 2 }, { version: 3, n: 2 }]);
    const keys = await t.db.query("SELECT storage_key, sha256, size_bytes FROM listing_photo WHERE listing_id = $1", [lid]);
    expect(keys.rows.every(k => /^listings\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(String(k["storage_key"])) && String(k["sha256"]).length === 64)).toBe(true);
    const ev = await t.db.query("SELECT event_type FROM audit_event WHERE aggregate_id = $1 ORDER BY occurred_at", [lid]);
    expect(ev.rows.map(e => e["event_type"])).toEqual(["photo.uploaded", "photo.uploaded", "photo.layout_changed"]);
  });

  it("parallel uploads to one listing are serialised: none is lost", async () => {
    const lid = await addListing(t.db, owner.userId);
    const store = createPgPhotoStore(t.db);
    const results = await Promise.all(Array.from({ length: 6 }, () => uploadPhoto(deps, store, ports, owner, lid, { kind: "photo", declaredMime: "image/jpeg", bytes: jpeg() })));
    expect(results.every(r => r.ok)).toBe(true);
    const cur = await store.currentLayout(lid);
    expect(cur.version).toBe(6);
    expect(cur.entries).toHaveLength(6);
  });

  it("stores 360 photos (2:1 only), keeps them off the cover and counts, and feeds card badge and Elena", async () => {
    const lid = await addListing(t.db, owner.userId);
    const store = createPgPhotoStore(t.db);
    const flat = await uploadPhoto(deps, store, ports, owner, lid, { kind: "photo360", declaredMime: "image/jpeg", bytes: jpeg({ width: 1200, height: 900 }) });
    expect(flat).toMatchObject({ ok: false });
    const pano = await uploadPhoto(deps, store, ports, owner, lid, { kind: "photo360", declaredMime: "image/jpeg", bytes: jpeg({ width: 2400, height: 1200 }) });
    expect(pano.ok).toBe(true);
    const layout = await store.currentLayout(lid);
    await updateLayout(deps, store, owner, lid, { version: layout.version, entries: layout.entries.map(e => ({ ...e, caption: "Kitchen" })), tourUrl: "https://my.matterport.com/show/?m=abcd1234" });
    const c = (await store.coversFor([lid])).get(lid);
    expect(c).toMatchObject({ cover: null, photoCount: 0, tour: "3d" });
    expect(await tourFactsPg(t.db, lid)).toMatchObject({ rooms: ["Kitchen"], panoramas: 1, tour: { provider: "matterport" } });
    expect(await tourFactsPg(t.db, randomUUID())).toBeUndefined();
  });

  it("photo rows and layout history are append-only in the database", async () => {
    const lid = await addListing(t.db, owner.userId);
    const store = createPgPhotoStore(t.db);
    const a = await uploadPhoto(deps, store, ports, owner, lid, { kind: "photo", declaredMime: "image/jpeg", bytes: jpeg() });
    expect(a.ok).toBe(true);
    await expect(t.db.query("DELETE FROM listing_photo WHERE listing_id = $1", [lid])).rejects.toThrow(/append-only/);
    await expect(t.db.query("UPDATE listing_photo SET kind = 'floorplan' WHERE listing_id = $1", [lid])).rejects.toThrow(/append-only/);
    await expect(t.db.query("DELETE FROM listing_photo_layout WHERE listing_id = $1", [lid])).rejects.toThrow(/append-only/);
    await expect(t.db.query("UPDATE listing_photo_layout SET entries = '[]' WHERE listing_id = $1", [lid])).rejects.toThrow(/append-only/);
    await expect(t.db.query("INSERT INTO listing_photo_layout (listing_id, version, entries, changed_by) VALUES ($1, 1, '[]', $2)", [lid, owner.userId])).rejects.toThrow();
    await expect(t.db.query("INSERT INTO listing_photo_layout (listing_id, version, entries, tour_url, changed_by) VALUES ($1, 9, '[]', 'javascript:x', $2)", [lid, owner.userId])).rejects.toThrow();
  });

  it("drafts are private, published photos are public, and covers feed the browse cards", async () => {
    const lid = await addListing(t.db, owner.userId);
    const store = createPgPhotoStore(t.db);
    const a = await uploadPhoto(deps, store, ports, owner, lid, { kind: "photo", declaredMime: "image/jpeg", bytes: jpeg() });
    if (!a.ok) throw new Error(a.message);
    expect((await readPhoto(deps, store, storage, null, a.value.id, "full")).ok).toBe(false);
    expect((await readPhoto(deps, store, storage, other, a.value.id, "full")).ok).toBe(false);
    expect((await listPhotos(deps, store, other, lid)).ok).toBe(false);
    expect(await readPhoto(deps, store, storage, owner, a.value.id, "thumb")).toMatchObject({ ok: true, value: { isPublic: false, contentType: "image/jpeg" } });
    expect((await uploadPhoto(deps, store, ports, other, lid, { kind: "photo", declaredMime: "image/jpeg", bytes: jpeg() })).ok).toBe(false);
    await t.db.query("UPDATE property_listing SET status = 'published' WHERE id = $1", [lid]);
    expect(await readPhoto(deps, store, storage, null, a.value.id, "full")).toMatchObject({ ok: true, value: { isPublic: true } });
    const covers = await store.coversFor([lid, randomUUID()]);
    expect(covers.get(lid)).toMatchObject({ photoCount: 1, cover: { id: a.value.id } });
    expect(await store.bytesUploadedSince(owner.userId, new Date(Date.now() - 60_000).toISOString())).toBeGreaterThan(0);
    // After publishing, the owner may hide but not remove.
    const v = (await store.currentLayout(lid)).version;
    expect((await updateLayout(deps, store, owner, lid, { version: v, entries: [] })).ok).toBe(false);
    expect((await updateLayout(deps, store, owner, lid, { version: v, entries: [{ photoId: a.value.id, hidden: true }] })).ok).toBe(true);
    expect((await readPhoto(deps, store, storage, null, a.value.id, "full")).ok).toBe(false);
    expect((await store.coversFor([lid])).get(lid)).toEqual({ cover: null, photoCount: 0 });
  });
});

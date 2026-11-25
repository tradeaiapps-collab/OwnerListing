import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { imageSanitiserFromEnv, noSanitiser } from "../src/adapters/image-sanitiser";
import { noVariants } from "../src/adapters/image-variants";
import { createUnconfiguredScanner } from "../src/adapters/malware-scan";
import type { ObjectStoragePort } from "../src/adapters/object-storage";
import { createDraft, createInMemoryListingRepository, type Actor, type ListingServiceDeps } from "../src/domain/listing-service";
import { createInMemoryPhotoStore, uploadPhoto, type PhotoPorts } from "../src/domain/photo-service";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: Actor = { userId: uid(1), userType: "owner" };
const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");

async function realJpeg(): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width: 640, height: 480, channels: 3, background: "#4080c0" } })
    .withExif({ IFD0: { Copyright: "SECRET-OWNER-NAME" } }).jpeg().toBuffer());
}

async function setup(ports: Partial<PhotoPorts>) {
  let n = 100;
  const deps: ListingServiceDeps = {
    repo: createInMemoryListingRepository(), appendAudit: async () => {}, now: () => "2026-11-22T00:00:00.000Z", newId: () => uid(++n),
    requiredDisclosures: () => [], termsCurrentFor: async () => true
  };
  const listing = await createDraft(deps, owner, { title: "Home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD", transactionType: "sale", useClass: "residential", propertyType: "house" });
  const objects = new Map<string, Uint8Array>();
  const storage: ObjectStoragePort = { configured: true, async put(k, b) { objects.set(k, b); }, async get(k) { return objects.get(k)!; } };
  const mem = createInMemoryPhotoStore();
  const all: PhotoPorts = { storage, scanner: createUnconfiguredScanner(), variants: noVariants, ...ports };
  return { run: (bytes: Uint8Array, mime = "image/jpeg") => uploadPhoto(deps, mem.store, all, owner, listing.id, { kind: "photo", declaredMime: mime, bytes }), objects, mem };
}

describe("image sanitiser", () => {
  it("is off unless IMAGE_SANITISER=sharp", async () => {
    expect((await imageSanitiserFromEnv({})).available).toBe(false);
    expect((await imageSanitiserFromEnv({ IMAGE_SANITISER: "yes" })).available).toBe(false);
    expect((await imageSanitiserFromEnv({ IMAGE_SANITISER: "sharp" })).available).toBe(true);
  });

  it("re-encodes: metadata and appended payload are gone, pixels stay", async () => {
    const s = await imageSanitiserFromEnv({ IMAGE_SANITISER: "sharp" });
    const src = await realJpeg();
    expect(text(src)).toContain("SECRET-OWNER-NAME");
    const dirty = new Uint8Array([...src, ...new TextEncoder().encode("<?php system($_GET['c']); ?>")]);
    const out = await s.sanitise(dirty, "image/jpeg");
    expect(text(out)).not.toContain("SECRET-OWNER-NAME");
    expect(text(out)).not.toContain("<?php");
    expect(await sharp(out).metadata()).toMatchObject({ width: 640, height: 480, format: "jpeg" });
  });

  it("refuses corrupt or non-image bytes", async () => {
    const s = await imageSanitiserFromEnv({ IMAGE_SANITISER: "sharp" });
    await expect(s.sanitise(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), "image/jpeg")).rejects.toThrow();
  });

  it("uploads work with no ClamAV when the sanitiser is on, and store the cleaned bytes", async () => {
    const t = await setup({ sanitiser: await imageSanitiserFromEnv({ IMAGE_SANITISER: "sharp" }) });
    const src = await realJpeg();
    const r = await t.run(new Uint8Array([...src, ...new TextEncoder().encode("PAYLOAD-AFTER-EOI")]));
    expect(r.ok).toBe(true);
    const [stored] = [...t.objects.values()];
    expect(text(stored!)).not.toContain("PAYLOAD-AFTER-EOI");
    expect(text(stored!)).not.toContain("SECRET-OWNER-NAME");
  });

  it("fails closed with neither a scanner nor a sanitiser, and rejects an unreadable image", async () => {
    const off = await setup({ sanitiser: noSanitiser });
    const r = await off.run(await realJpeg());
    expect(r).toMatchObject({ ok: false, code: "unavailable" });
    expect(off.objects.size).toBe(0);
    const on = await setup({ sanitiser: await imageSanitiserFromEnv({ IMAGE_SANITISER: "sharp" }) });
    const bad = await on.run(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]));
    expect(bad).toMatchObject({ ok: false, code: "invalid" });
    expect(on.objects.size).toBe(0);
  });
});

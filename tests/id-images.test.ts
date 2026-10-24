import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalDiskStorage } from "../src/adapters/object-storage";
import {
  ID_IMAGE_CONSENT_VERSION, IdImageKeyError, MAX_ID_IMAGE_BYTES, canClaim, cleanIdImage, holdsClaim, openIdImage, sealIdImage
} from "../src/domain/id-image";
import { reviewSubmission, type IdSubmission } from "../src/domain/id-verification";
import { approvalBlocker, claimIdSubmission, idImagesReady, runIdImageRetention, submitIdImages, viewIdImage, type IdUploadInput } from "../src/server/id-image";
import { GPS_TEXT, HEIC, KEY, PDF, TTL, deps, jpegWithExif, memStorage, memStore, pngWithText, scanner, webpWithExif } from "./helpers/id-image-fakes";

const BUYER = "b0000000-0000-4000-8000-000000000001";
const REV1 = "a0000000-0000-4000-8000-000000000001";
const REV2 = "a0000000-0000-4000-8000-000000000002";
const SUB = "c0000000-0000-4000-8000-000000000001";
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s, "latin1"));

const input = (o: { fields?: Record<string, string | undefined>; files?: IdUploadInput["files"] } = {}): IdUploadInput => ({
  fields: { consent: "true", consentVersion: ID_IMAGE_CONSENT_VERSION, documentKind: "drivers_licence", documentCountry: "AU", expiryDate: "2030-01-01", selfieSource: "camera", ...o.fields },
  files: o.files ?? { front: jpegWithExif(), back: pngWithText(), selfie: webpWithExif() }
});

function world(o: Parameters<typeof memStore>[1] = {}) {
  const clock = { now: Date.parse("2026-10-25T00:00:00.000Z") };
  const m = memStore(clock, o);
  const s = memStorage();
  const sc = scanner();
  const d = deps({ clock, store: m.store, storage: s.port, scanner: sc });
  let reads = 0;
  const submit = (i: IdUploadInput = input(), ip = "203.0.113.5", user = BUYER) => submitIdImages(d, user, ip, async () => { reads++; return i; });
  return { clock, m, s, sc, d, submit, reads: () => reads };
}

async function submitted() {
  const w = world();
  const r = await w.submit();
  expect(r.ok).toBe(true);
  const id = [...w.m.rows.keys()][0]!;
  return { ...w, id };
}

describe("type check and metadata stripping (from bytes, no re-encode)", () => {
  it("removes EXIF/GPS, XMP and comments from JPEG and keeps the image data", () => {
    const r = cleanIdImage(jpegWithExif());
    expect(r.ok && r.mime).toBe("image/jpeg");
    if (!r.ok) return;
    expect(has(r.bytes, GPS_TEXT)).toBe(false);
    expect(has(r.bytes, "Exif")).toBe(false);
    expect(has(r.bytes, "comment")).toBe(false);
    expect(has(r.bytes, "JFIF")).toBe(true);
    expect([...r.bytes.slice(-5)]).toEqual([0x12, 0x34, 0x56, 0xff, 0xd9]);
  });
  it("removes text and eXIf chunks from PNG", () => {
    const r = cleanIdImage(pngWithText());
    expect(r.ok && r.mime).toBe("image/png");
    if (r.ok) { expect(has(r.bytes, GPS_TEXT)).toBe(false); expect(has(r.bytes, "IDAT")).toBe(true); }
  });
  it("removes EXIF and XMP chunks from WebP, clears their flags and fixes the RIFF size", () => {
    const r = cleanIdImage(webpWithExif());
    expect(r.ok && r.mime).toBe("image/webp");
    if (!r.ok) return;
    const b = Buffer.from(r.bytes);
    expect(has(r.bytes, GPS_TEXT)).toBe(false);
    expect(has(r.bytes, "XMP ")).toBe(false);
    expect(b.readUInt32LE(4)).toBe(b.length - 8);
    expect(b[20]! & 0x0c).toBe(0);
  });
  it("refuses HEIC, PDF, unknown bytes, empty and oversize files, whatever the declared type", () => {
    for (const bytes of [HEIC, PDF, new Uint8Array([1, 2, 3, 4]), new Uint8Array(0)]) expect(cleanIdImage(bytes).ok).toBe(false);
    const big = new Uint8Array(MAX_ID_IMAGE_BYTES + 1); big.set(jpegWithExif());
    const r = cleanIdImage(big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/under 10 MB/);
  });
  it("refuses damaged JPEG and PNG structures", () => {
    expect(cleanIdImage(jpegWithExif().slice(0, 30)).ok).toBe(false);
    expect(cleanIdImage(pngWithText().slice(0, 40)).ok).toBe(false);
  });
});

describe("AES-256-GCM sealing", () => {
  const plain = new Uint8Array([1, 2, 3, 4, 5]);
  it("round-trips and never contains the plaintext", () => {
    const s = sealIdImage(plain, KEY, SUB, "front", "id/a/b");
    expect(has(s, "\x01\x02\x03\x04\x05")).toBe(false);
    expect(openIdImage(s, KEY, SUB, "front", "id/a/b")).toEqual(plain);
  });
  it("rejects tampered ciphertext, a copy moved to another submission, part or key, and a different key", () => {
    const s = sealIdImage(plain, KEY, SUB, "front", "id/a/b");
    const t = new Uint8Array(s); t[t.length - 1]! ^= 1;
    expect(openIdImage(t, KEY, SUB, "front", "id/a/b")).toBeUndefined();
    expect(openIdImage(s, KEY, REV1, "front", "id/a/b")).toBeUndefined();
    expect(openIdImage(s, KEY, SUB, "selfie", "id/a/b")).toBeUndefined();
    expect(openIdImage(s, KEY, SUB, "front", "id/a/c")).toBeUndefined();
    expect(openIdImage(s, Buffer.alloc(32, 9).toString("base64"), SUB, "front", "id/a/b")).toBeUndefined();
  });
  it("fails closed on a missing or malformed key", () => {
    for (const k of [undefined, "", "short", Buffer.alloc(16).toString("base64")]) {
      expect(() => sealIdImage(plain, k, SUB, "front", "id/a/b")).toThrow(IdImageKeyError);
    }
  });
});

describe("configuration fails closed", () => {
  it("is ready only with storage that can delete, a scanner, a 32-byte key and the retention secret", () => {
    expect(idImagesReady(deps())).toBe(true);
    expect(idImagesReady(deps({ key: undefined }))).toBe(false);
    expect(idImagesReady(deps({ key: "x".repeat(44) }))).toBe(false);
    expect(idImagesReady(deps({ storage: memStorage({ configured: false }).port }))).toBe(false);
    expect(idImagesReady(deps({ storage: memStorage({ removable: false }).port }))).toBe(false);
    expect(idImagesReady(deps({ scanner: scanner("clean", false) }))).toBe(false);
    expect(idImagesReady(deps({ retentionSecret: undefined }))).toBe(false);
    expect(idImagesReady(deps({ retentionSecret: "short" }))).toBe(false);
  });
  it("missing key: upload is unavailable and the body is never read", async () => {
    const clock = { now: Date.now() };
    const m = memStore(clock);
    let read = false;
    const r = await submitIdImages(deps({ key: undefined, store: m.store, clock }), BUYER, "1.1.1.1", async () => { read = true; return input(); });
    expect(r).toMatchObject({ ok: false, code: "unavailable" });
    expect(read).toBe(false);
    expect(m.rows.size).toBe(0);
  });
});

describe("buyer upload", () => {
  it("stores three encrypted images under random keys, records the consent version and logs, with no document number anywhere", async () => {
    const w = await submitted();
    const row = w.m.rows.get(w.id)!;
    expect(row.status).toBe("pending");
    expect(row.documentCountry).toBe("AU");
    expect(Object.keys(row.images).sort()).toEqual(["back", "front", "selfie"]);
    for (const img of Object.values(row.images)) {
      expect(img.key).toMatch(/^id\/[0-9a-f]{32}\/[0-9a-f]{32}$/);
      expect(img.key).not.toContain(BUYER);
      expect(img.sha256).toMatch(/^[0-9a-f]{64}$/);
      const stored = w.s.objects.get(img.key)!;
      expect(has(stored, "JFIF") || has(stored, "IHDR") || has(stored, "WEBP")).toBe(false);
    }
    expect(w.m.consents).toEqual([{ userId: BUYER, version: ID_IMAGE_CONSENT_VERSION }]);
    expect(w.m.log.map(e => e.event)).toEqual(["submitted"]);
    expect(JSON.stringify(row)).not.toMatch(/number/i);
    expect(w.sc.scanned).toBe(3);
  });
  it("a passport needs only the photo page and a selfie", async () => {
    const w = world();
    const r = await w.submit(input({ fields: { documentKind: "passport" }, files: { front: jpegWithExif(), selfie: jpegWithExif() } }));
    expect(r.ok).toBe(true);
    expect(Object.keys([...w.m.rows.values()][0]!.images).sort()).toEqual(["front", "selfie"]);
  });
  it("refuses without the consent tick or with an old wording version, storing and recording nothing", async () => {
    for (const fields of [{ consent: undefined }, { consent: "false" }, { consentVersion: "2020-01-01.v0" }]) {
      const w = world();
      expect(await w.submit(input({ fields }))).toMatchObject({ ok: false, code: "invalid" });
      expect(w.s.objects.size).toBe(0);
      expect(w.m.consents).toEqual([]);
    }
  });
  it("refuses a wrong type (HEIC, PDF) or oversize photo before scanning or storing", async () => {
    for (const bad of [HEIC, PDF, new Uint8Array(MAX_ID_IMAGE_BYTES + 1)]) {
      const w = world();
      expect(await w.submit(input({ files: { front: bad, back: jpegWithExif(), selfie: jpegWithExif() } }))).toMatchObject({ ok: false, code: "invalid" });
      expect(w.s.objects.size).toBe(0);
      expect(w.sc.scanned).toBe(0);
      expect(w.m.log.map(e => e.event)).toEqual(["refused"]);
    }
  });
  it("refuses overseas documents, a missing back, a missing selfie, a non-camera selfie and an expired document", async () => {
    const files = { front: jpegWithExif(), back: jpegWithExif(), selfie: jpegWithExif() };
    for (const i of [
      input({ fields: { documentCountry: "NZ" } }), input({ files: { front: files.front, selfie: files.selfie } }),
      input({ files: { front: files.front, back: files.back } }), input({ fields: { selfieSource: "gallery" } }),
      input({ fields: { expiryDate: "2020-01-01" } }), input({ fields: { documentKind: "medicare" } })
    ]) {
      const w = world();
      expect((await w.submit(i)).ok).toBe(false);
      expect(w.s.objects.size).toBe(0);
    }
  });
  it("infected photo is refused and logged; a scanner error is 'unavailable' (fails closed)", async () => {
    const clock = { now: Date.now() };
    for (const [verdict, code] of [["infected", "invalid"], ["error", "unavailable"]] as const) {
      const m = memStore(clock), s = memStorage();
      const r = await submitIdImages(deps({ clock, store: m.store, storage: s.port, scanner: scanner(verdict) }), BUYER, "ip", async () => input());
      expect(r).toMatchObject({ ok: false, code });
      expect(s.objects.size).toBe(0);
    }
  });
  it("double submit: a second upload while one is waiting is refused before the body is read", async () => {
    const w = await submitted();
    const before = w.reads();
    expect(await w.submit()).toMatchObject({ ok: false, code: "conflict" });
    expect(w.reads()).toBe(before);
  });
  it("double submit race: if the insert loses, the stored images are removed again", async () => {
    const w = world();
    const orig = w.m.store.insertSubmission;
    w.m.store.insertSubmission = async () => false;
    expect(await w.submit()).toMatchObject({ ok: false, code: "conflict" });
    expect(w.s.objects.size).toBe(0);
    w.m.store.insertSubmission = orig;
  });
  it("rate limits per user and per IP are counted before the body is read; a counter error fails closed", async () => {
    const w = world();
    for (let i = 0; i < 6; i++) await w.submit(input({ fields: { consent: "no" } }));
    expect(await w.submit()).toMatchObject({ ok: false, code: "rate_limited" });
    const ipOnly = world();
    for (let i = 0; i < 20; i++) await ipOnly.submit(input({ fields: { consent: "no" } }), "198.51.100.1", `b0000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(await ipOnly.submit(input(), "198.51.100.1", "b0000000-0000-4000-8000-000000000099")).toMatchObject({ ok: false, code: "rate_limited" });
    const broken = world({ hitsOverride: undefined });
    expect(await broken.submit()).toMatchObject({ ok: false, code: "rate_limited" });
    expect(broken.reads()).toBe(0);
    expect(broken.m.log.map(e => e.event)).toEqual(["rate_limited"]);
    expect(JSON.stringify(broken.m.log)).not.toContain("203.0.113.5");
  });
  it("needs email and mobile verified first, and refuses an already verified buyer", async () => {
    expect(await world({ phone: false }).submit()).toMatchObject({ ok: false, code: "forbidden" });
    expect(await world({ id: true }).submit()).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("reviewer claim and the decrypt view", () => {
  it("a reviewer cannot claim or view their own identity check", async () => {
    const w = await submitted();
    expect(await claimIdSubmission(w.d, BUYER, w.id, TTL)).toMatchObject({ ok: false, code: "forbidden" });
    expect((await viewIdImage(w.d, BUYER, w.id, "front")).ok).toBe(false);
  });
  it("a non-assigned reviewer gets not found; only the claim holder sees the (stripped) image and each view is audited with the reviewer id", async () => {
    const w = await submitted();
    expect(await viewIdImage(w.d, REV1, w.id, "front")).toMatchObject({ ok: false, code: "not_found" });
    expect((await claimIdSubmission(w.d, REV1, w.id, TTL)).ok).toBe(true);
    expect(await claimIdSubmission(w.d, REV2, w.id, TTL)).toMatchObject({ ok: false, code: "conflict" });
    expect(await viewIdImage(w.d, REV2, w.id, "front")).toMatchObject({ ok: false, code: "not_found" });
    const r = await viewIdImage(w.d, REV1, w.id, "front");
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.mime).toBe("image/jpeg"); expect(has(r.value.bytes, GPS_TEXT)).toBe(false); }
    expect(w.m.views).toEqual([expect.objectContaining({ submissionId: w.id, staffId: REV1, part: "front" })]);
    expect(await viewIdImage(w.d, REV1, w.id, "../etc")).toMatchObject({ ok: false, code: "not_found" });
  });
  it("access is short-lived: after 30 minutes the claim no longer opens images and another reviewer may take it", async () => {
    const w = await submitted();
    await claimIdSubmission(w.d, REV1, w.id, TTL);
    w.clock.now += TTL + 1;
    expect(await viewIdImage(w.d, REV1, w.id, "front")).toMatchObject({ ok: false, code: "not_found" });
    expect((await claimIdSubmission(w.d, REV2, w.id, TTL)).ok).toBe(true);
  });
  it("tampered ciphertext is refused and logged, never shown", async () => {
    const w = await submitted();
    await claimIdSubmission(w.d, REV1, w.id, TTL);
    const key = w.m.rows.get(w.id)!.images.front!.key;
    const b = w.s.objects.get(key)!; b[b.length - 2]! ^= 0xff;
    expect(await viewIdImage(w.d, REV1, w.id, "front")).toMatchObject({ ok: false, code: "unavailable" });
    expect(w.m.log.map(e => e.event)).toContain("integrity_failed");
  });
  it("a swapped image (another part's ciphertext under this key) fails the AAD check", async () => {
    const w = await submitted();
    await claimIdSubmission(w.d, REV1, w.id, TTL);
    const imgs = w.m.rows.get(w.id)!.images;
    w.s.objects.set(imgs.front!.key, w.s.objects.get(imgs.selfie!.key)!);
    expect((await viewIdImage(w.d, REV1, w.id, "front")).ok).toBe(false);
  });
  it("no audit row, no image: a failed audit write refuses the view before storage is read", async () => {
    const w = await submitted();
    await claimIdSubmission(w.d, REV1, w.id, TTL);
    w.m.st.failView = true;
    let reads = 0;
    const get = w.s.port.get;
    w.s.port.get = async k => { reads++; return get(k); };
    expect(await viewIdImage(w.d, REV1, w.id, "front")).toMatchObject({ ok: false, code: "unavailable" });
    expect(reads).toBe(0);
  });
  it("approval needs a live claim and every image opened under it", async () => {
    const w = await submitted();
    expect(await approvalBlocker(w.d, REV1, w.id)).toMatch(/Claim/);
    await claimIdSubmission(w.d, REV1, w.id, TTL);
    await viewIdImage(w.d, REV1, w.id, "front");
    await viewIdImage(w.d, REV1, w.id, "selfie");
    expect(await approvalBlocker(w.d, REV1, w.id)).toMatch(/every image/);
    await viewIdImage(w.d, REV1, w.id, "back");
    expect(await approvalBlocker(w.d, REV1, w.id)).toBeNull();
    expect(await approvalBlocker(deps({ key: undefined }), REV1, w.id)).toMatch(/unavailable/);
  });
  it("claim rules (pure): not own, not after own approval, not while another holds it", () => {
    const now = Date.parse("2026-10-25T00:00:00Z");
    const c = { userId: BUYER, status: "pending", approvals: [REV1], assignedTo: null, assignedAt: null };
    expect(canClaim({ ...c, userId: REV2 }, REV2, now).ok).toBe(false);
    expect(canClaim(c, REV1, now).ok).toBe(false);
    expect(canClaim(c, REV2, now).ok).toBe(true);
    expect(canClaim({ ...c, assignedTo: REV1, assignedAt: new Date(now - 1000).toISOString() }, REV2, now).ok).toBe(false);
    expect(holdsClaim({ ...c, status: "approved", assignedTo: REV2, assignedAt: new Date(now).toISOString() }, REV2, now)).toBe(false);
  });
  it("two-person rule still applies to overseas documents (domain unchanged)", () => {
    const s: IdSubmission = { id: SUB, userId: BUYER, documentKind: "passport", documentCountry: "GB", expiryDate: "2030-01-01", selfieCapturedInApp: true, submittedAt: "", status: "pending", approvals: [] };
    const ticks = { documentLooksGenuine: true, photoMatchesSelfie: true, nameMatchesAccount: true, notExpired: true };
    const first = reviewSubmission(s, { id: REV1, role: "compliance" }, "approve", ticks, "2026-10-25T00:00:00Z");
    expect(first.status).toBe("pending");
    expect(() => reviewSubmission(first, { id: REV1, role: "compliance" }, "approve", ticks, "x")).toThrow(/different reviewer/);
  });
});

describe("retention", () => {
  const decide = (w: Awaited<ReturnType<typeof submitted>>, status: string, daysAgo: number) => {
    const r = w.m.rows.get(w.id)!;
    r.status = status; r.decidedAt = w.clock.now - daysAgo * 86_400_000;
  };
  const now = (w: { clock: { now: number } }) => new Date(w.clock.now).toISOString();
  it("deletes images 7 days after approval and 30 after rejection or needs-more, and not before", async () => {
    for (const [status, keepDays, goneDays] of [["approved", 6, 8], ["rejected", 29, 31], ["needs_more", 29, 31]] as const) {
      const w = await submitted();
      decide(w, status, keepDays);
      expect(await runIdImageRetention(w.d, now(w))).toEqual({ deleted: 0, failed: 0 });
      expect(w.s.objects.size).toBe(3);
      decide(w, status, goneDays);
      expect(await runIdImageRetention(w.d, now(w))).toEqual({ deleted: 1, failed: 0 });
      expect(w.s.objects.size).toBe(0);
      expect(w.m.rows.get(w.id)!.images).toEqual({});
      expect(w.m.log.map(e => e.event)).toContain("images_deleted");
      expect(await runIdImageRetention(w.d, now(w))).toEqual({ deleted: 0, failed: 0 });
    }
  });
  it("never touches pending submissions", async () => {
    const w = await submitted();
    w.clock.now += 365 * 86_400_000;
    expect(await runIdImageRetention(w.d, now(w))).toEqual({ deleted: 0, failed: 0 });
  });
  it("deleted after retention: the image can no longer be viewed", async () => {
    const w = await submitted();
    decide(w, "rejected", 31);
    await runIdImageRetention(w.d, now(w));
    w.m.rows.get(w.id)!.status = "pending";
    await claimIdSubmission(w.d, REV1, w.id, TTL);
    expect(await viewIdImage(w.d, REV1, w.id, "front")).toMatchObject({ ok: false, code: "not_found" });
  });
  it("a storage delete failure is counted and logged, and the row is not marked deleted", async () => {
    const w = await submitted();
    decide(w, "approved", 8);
    const r = await runIdImageRetention({ store: w.m.store, storage: memStorage({ failRemove: true }).port }, now(w));
    expect(r).toEqual({ deleted: 0, failed: 1 });
    expect(w.m.rows.get(w.id)!.deletedAt).toBeNull();
    expect(w.m.log.map(e => e.event)).toContain("delete_failed");
  });
  it("refuses to run on storage that cannot delete", async () => {
    await expect(runIdImageRetention({ store: memStore({ now: 0 }).store, storage: memStorage({ removable: false }).port }, new Date().toISOString())).rejects.toThrow();
  });
});

describe("local-disk storage", () => {
  it("can delete id/ images only; listing files stay undeletable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ol-id-"));
    const s = createLocalDiskStorage(dir);
    await s.put("id/aa/bb", new Uint8Array([1]), "application/octet-stream");
    await s.put("listings/aa/bb", new Uint8Array([1]), "image/jpeg");
    await s.remove!("id/aa/bb");
    await s.remove!("id/aa/bb");
    await expect(s.remove!("listings/aa/bb")).rejects.toThrow(/Only identity images/);
    await expect(s.remove!("id/../listings/aa/bb")).rejects.toThrow();
    expect(await readdir(path.join(dir, "id", "aa"))).toEqual([]);
    expect(await readdir(path.join(dir, "listings", "aa"))).toEqual(["bb"]);
  });
});

describe("migration and code rules", () => {
  const root = path.join(__dirname, "..");
  const sql = readFileSync(path.join(root, "db/20261025120000_id_images.sql"), "utf8");
  it("has a unique timestamp prefix", () => {
    expect(readdirSync(path.join(root, "db")).filter(f => f.startsWith("20261025120000"))).toHaveLength(1);
  });
  it("makes the consent and submission logs append-only, allows one pending submission, and has no document number column", () => {
    for (const t of ["id_image_consent", "id_submission_log"]) {
      expect(sql).toMatch(new RegExp(`BEFORE UPDATE OR DELETE ON ${t}\\s+FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation`));
    }
    expect(sql).toMatch(/CREATE UNIQUE INDEX \w+ ON id_submission\(user_id\) WHERE status = 'pending'/);
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/document_number|licence_number|passport_number|card_number/i);
  });
  it("the buyer has no route that returns images, and the image route sends no-store", () => {
    const buyerRoutes = path.join(root, "app/api/buyer/verification/id/images/route.ts");
    expect(readFileSync(buyerRoutes, "utf8")).not.toMatch(/storage\.get|viewIdImage|openIdImage/);
    const view = readFileSync(path.join(root, "app/api/staff/id-review/[id]/image/[part]/route.ts"), "utf8");
    expect(view).toMatch(/no-store/);
    expect(view).toMatch(/staffGate\(req, "identity\.review"\)/);
  });
  it("never logs (no console) in the ID image code", () => {
    for (const f of ["src/server/id-image.ts", "src/server/id-image-db.ts", "src/domain/id-image.ts"]) {
      expect(readFileSync(path.join(root, f), "utf8")).not.toMatch(/console\./);
    }
  });
});

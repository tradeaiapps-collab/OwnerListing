import { describe, expect, it } from "vitest";
import {
  createInMemoryIdRepository, pendingQueue, purgeDueImages, reviewId, sniffImage, submitId, viewIdImage,
  type FileStore, type IdDeps, type SubmitInput
} from "../src/domain/id-review-service";
import type { StaffActor } from "../src/domain/staff-access";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const OK = { documentLooksGenuine: true, photoMatchesSelfie: true, nameMatchesAccount: true, notExpired: true, officialStatusCheck: "done" } as const;
const buyer = { userId: "buyer1", userType: "owner" as const };
const staffA = { userId: "staffA", userType: "owner" as const };
const staffB = { userId: "staffB", userType: "owner" as const };

function setup(opts: { files?: boolean } = {}) {
  const blobs = new Map<string, Uint8Array>();
  const files: FileStore = {
    async put(k, b) { blobs.set(k, b); }, async get(k) { return blobs.get(k); }, async delete(k) { blobs.delete(k); }
  };
  const ids = createInMemoryIdRepository({ buyer1: "Buyer One" });
  const roles: Record<string, StaffActor> = { staffA: { id: "staffA", role: "compliance" }, staffB: { id: "staffB", role: "compliance" }, sup: { id: "sup", role: "support" } };
  let clock = Date.parse("2026-10-23T00:00:00Z");
  let n = 0;
  const deps: IdDeps = {
    ids, files: opts.files === false ? undefined : files, staffFor: async id => roles[id],
    appendAudit: async () => {}, now: () => new Date(clock).toISOString(), newId: () => `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`
  };
  return { deps, ids, blobs, advanceDays: (d: number) => { clock += d * 86_400_000; } };
}

const input = (over: Partial<SubmitInput> = {}): SubmitInput => ({
  documentKind: "drivers_licence", documentCountry: "AU", expiryDate: "2030-01-01",
  front: JPEG, back: JPEG, selfie: JPEG, selfieCapturedInApp: true, ...over
});

describe("submitId", () => {
  it("is blocked without private storage", async () => {
    expect(await submitId(setup({ files: false }).deps, buyer, input())).toMatchObject({ ok: false, code: "unavailable" });
  });
  it("stores three images under random keys and queues the submission", async () => {
    const { deps, blobs, ids } = setup();
    const r = await submitId(deps, buyer, input());
    expect(r.ok).toBe(true);
    expect(blobs.size).toBe(3);
    expect([...ids.rows.values()][0]?.status).toBe("pending");
  });
  it("rejects files that are not JPEG or PNG, even if named as images", async () => {
    const { deps, blobs } = setup();
    const r = await submitId(deps, buyer, input({ front: new Uint8Array([0x4d, 0x5a, 0, 0, 0]) }));
    expect(r).toMatchObject({ ok: false, code: "invalid" });
    expect(blobs.size).toBe(0);
    expect(sniffImage(JPEG)).toBe("image/jpeg");
  });
  it("rejects oversize images, missing selfie, expired document and passports without back are fine", async () => {
    const { deps } = setup();
    expect((await submitId(deps, buyer, input({ front: new Uint8Array(5 * 1024 * 1024 + 1).fill(0xff) }))).ok).toBe(false);
    const { selfie: _s, ...noSelfie } = input();
    expect((await submitId(deps, buyer, noSelfie)).ok).toBe(false);
    expect((await submitId(deps, buyer, input({ expiryDate: "2020-01-01" }))).ok).toBe(false);
    const { back: _b, ...passport } = input({ documentKind: "passport" });
    expect((await submitId(deps, buyer, passport)).ok).toBe(true);
  });
  it("allows only one waiting submission and cleans up the extra files", async () => {
    const { deps, blobs } = setup();
    await submitId(deps, buyer, input());
    expect(await submitId(deps, buyer, input())).toMatchObject({ ok: false, code: "conflict" });
    expect(blobs.size).toBe(3);
  });
});

describe("staff review", () => {
  it("only identity reviewers can see the queue or images", async () => {
    const { deps } = setup();
    const sub = await submitId(deps, buyer, input());
    const id = sub.ok ? sub.value.id : "";
    expect(await pendingQueue(deps, buyer)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await pendingQueue(deps, { userId: "sup", userType: "owner" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await viewIdImage(deps, buyer, id, "front")).toMatchObject({ ok: false, code: "forbidden" });
    expect((await pendingQueue(deps, staffA)).ok).toBe(true);
  });
  it("logs every image view", async () => {
    const { deps, ids } = setup();
    const sub = await submitId(deps, buyer, input());
    const id = sub.ok ? sub.value.id : "";
    const r = await viewIdImage(deps, staffA, id, "front");
    expect(r.ok && r.value.contentType).toBe("image/jpeg");
    expect(ids.accessLog).toHaveLength(1);
  });
  it("one Australian approval verifies the account", async () => {
    const { deps, ids } = setup();
    const sub = await submitId(deps, buyer, input());
    const id = sub.ok ? sub.value.id : "";
    expect(await reviewId(deps, staffA, id, "approve", OK)).toMatchObject({ ok: true, value: { status: "approved" } });
    expect(ids.verified.has("buyer1")).toBe(true);
  });
  it("overseas documents need two different reviewers", async () => {
    const { deps, ids } = setup();
    const sub = await submitId(deps, buyer, input({ documentKind: "passport", documentCountry: "NZ" }));
    const id = sub.ok ? sub.value.id : "";
    expect(await reviewId(deps, staffA, id, "approve", OK)).toMatchObject({ ok: true, value: { status: "pending" } });
    expect(ids.verified.size).toBe(0);
    expect(await reviewId(deps, staffA, id, "approve", OK)).toMatchObject({ ok: false, code: "conflict" });
    expect(await reviewId(deps, staffB, id, "approve", OK)).toMatchObject({ ok: true, value: { status: "approved" } });
  });
  it("approval needs every check and the official licence check result", async () => {
    const { deps } = setup();
    const sub = await submitId(deps, buyer, input());
    const id = sub.ok ? sub.value.id : "";
    expect(await reviewId(deps, staffA, id, "approve", { ...OK, photoMatchesSelfie: false })).toMatchObject({ ok: false, code: "invalid" });
    const { officialStatusCheck: _o, ...noOfficial } = OK;
    expect(await reviewId(deps, staffA, id, "approve", noOfficial)).toMatchObject({ ok: false, code: "invalid" });
  });
  it("staff cannot review their own ID, and a rejection does not verify", async () => {
    const { deps, ids } = setup();
    const own = await submitId(deps, staffA, input());
    expect(await reviewId(deps, staffA, own.ok ? own.value.id : "", "approve", OK)).toMatchObject({ ok: false, code: "forbidden" });
    const sub = await submitId(deps, buyer, input());
    expect(await reviewId(deps, staffB, sub.ok ? sub.value.id : "", "reject", OK)).toMatchObject({ ok: true, value: { status: "rejected" } });
    expect(ids.verified.size).toBe(0);
  });
});

describe("retention", () => {
  it("deletes images after the retention period and keeps the result", async () => {
    const { deps, blobs, ids, advanceDays } = setup();
    const sub = await submitId(deps, buyer, input());
    await reviewId(deps, staffA, sub.ok ? sub.value.id : "", "approve", OK);
    expect(await purgeDueImages(deps)).toBe(0);
    advanceDays(8);
    expect(await purgeDueImages(deps)).toBe(1);
    expect(blobs.size).toBe(0);
    expect(ids.verified.has("buyer1")).toBe(true);
  });
});

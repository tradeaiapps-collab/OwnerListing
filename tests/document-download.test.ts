import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectStoragePort } from "../src/adapters/object-storage";
import { createUnconfiguredStorage } from "../src/adapters/object-storage";
import { createInMemoryDocumentStore, uploadAccess, type DocumentStore } from "../src/domain/document-service";
import type { DocumentKind, DocumentRecord, Visibility } from "../src/domain/documents";
import type { AuditEvent } from "../src/domain/audit";
import { createDraft, createInMemoryListingRepository, type Actor, type DraftInput, type ListingServiceDeps } from "../src/domain/listing-service";

const state = vi.hoisted(() => ({
  actor: null as Actor | null,
  deps: null as ListingServiceDeps | null,
  store: null as DocumentStore | null,
  storage: null as ObjectStoragePort | null
}));

vi.mock("../src/server/context", () => ({
  getActor: () => state.actor,
  getDeps: () => state.deps,
  getDb: () => ({}),
  getUploadPorts: () => ({ storage: state.storage })
}));
vi.mock("../src/server/documents-db", () => ({ createPgDocumentStore: () => state.store }));

import { GET as fileRoute } from "../app/api/documents/[id]/file/route";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: Actor = { userId: uid(1), userType: "owner" };
const stranger: Actor = { userId: uid(2), userType: "owner" };
const inspector: Actor = { userId: uid(3), userType: "agent" };
const input: DraftInput = {
  title: "Family home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD",
  transactionType: "sale", useClass: "residential", propertyType: "house"
};
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);

let listingId: string;
let audits: AuditEvent[];
let n: number;

const doc = (id: number, kind: DocumentKind, visibility: Visibility, status: DocumentRecord["status"] = "active"): DocumentRecord => ({
  id: uid(id), listingId, ownerUserId: owner.userId, kind, uploadedBy: owner.userId, visibility, status
});
const assignment = (status: "approved" | "completed" | "cancelled") =>
  ({ id: uid(50), listingId, ownerUserId: owner.userId, contractorUserId: inspector.userId, kind: "inspector", status }) as const;

async function setStatus(status: "published" | "withdrawn") {
  const rec = (await state.deps!.repo.get(listingId))!;
  await state.deps!.repo.save({ ...rec, listing: { ...rec.listing, status } });
}

beforeEach(async () => {
  n = 100;
  audits = [];
  state.actor = null;
  state.deps = {
    repo: createInMemoryListingRepository(),
    appendAudit: async e => { audits.push(e); },
    now: () => "2026-10-24T00:00:00.000Z",
    newId: () => uid(++n),
    requiredDisclosures: () => []
  };
  listingId = (await createDraft(state.deps, owner, input)).id;
  audits.length = 0;
  const docs = [
    doc(10, "photo", "public"), doc(11, "building_inspection", "parties"), doc(12, "contract", "owner_only"),
    doc(13, "photo", "public", "superseded"), doc(14, "building_inspection", "parties", "superseded")
  ];
  const files = Object.fromEntries(docs.map(d => [d.id, { storageKey: `key-${d.id}`, contentType: "image/jpeg" }]));
  state.store = createInMemoryDocumentStore({ documents: docs, files, assignments: [assignment("approved")] }).store;
  state.storage = { configured: true, async put() {}, async get() { return BYTES; } };
});

const get = (id: string) => fileRoute(new Request(`http://test/api/documents/${id}/file`), { params: Promise.resolve({ id }) });
const status = async (id: number) => (await get(uid(id))).status;

describe("GET /api/documents/[id]/file: visibility matrix", () => {
  it("serves a public file of a published listing to a signed-out visitor, as a safe attachment", async () => {
    await setStatus("published");
    const r = await get(uid(10));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toBe("attachment");
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(BYTES);
    expect(audits.filter(a => a.eventType === "document.downloaded")).toEqual([]);
  });
  it("hides even a public file while the listing is not published", async () => {
    expect(await status(10)).toBe(404);
    state.actor = stranger;
    expect(await status(10)).toBe(404);
  });
  it("gives a signed-out visitor nothing but public files", async () => {
    await setStatus("published");
    expect(await status(11)).toBe(404);
    expect(await status(12)).toBe(404);
  });
  it("denies a signed-in stranger parties and owner-only files", async () => {
    await setStatus("published");
    state.actor = stranger;
    expect(await status(11)).toBe(404);
    expect(await status(12)).toBe(404);
    expect(await status(10)).toBe(200);
  });
  it("lets an approved contractor read parties files but not owner-only ones", async () => {
    state.actor = inspector;
    expect(await status(11)).toBe(200);
    expect(await status(12)).toBe(404);
  });
  it("lets a completed contractor read parties files, and not a cancelled one", async () => {
    const files = { [uid(11)]: { storageKey: "k", contentType: "application/pdf" } };
    state.actor = inspector;
    state.store = createInMemoryDocumentStore({ documents: [doc(11, "building_inspection", "parties")], files, assignments: [assignment("completed")] }).store;
    expect(await status(11)).toBe(200);
    state.store = createInMemoryDocumentStore({ documents: [doc(11, "building_inspection", "parties")], files, assignments: [assignment("cancelled")] }).store;
    expect(await status(11)).toBe(404);
  });
  it("serves superseded versions to the owner only", async () => {
    await setStatus("published");
    expect(await status(13)).toBe(404);
    state.actor = stranger;
    expect(await status(13)).toBe(404);
    state.actor = inspector;
    expect(await status(14)).toBe(404);
    state.actor = owner;
    expect(await status(13)).toBe(200);
    expect(await status(14)).toBe(200);
  });
  it("lets the owner read everything, including owner-only files on a draft", async () => {
    state.actor = owner;
    for (const id of [10, 11, 12]) expect(await status(id)).toBe(200);
  });
  it("answers 404 for a malformed id, an unknown file and a file with no stored object", async () => {
    state.actor = owner;
    expect((await get("nope")).status).toBe(404);
    expect(await status(999)).toBe(404);
    state.store = createInMemoryDocumentStore({ documents: [doc(10, "photo", "public")] }).store;
    expect(await status(10)).toBe(404);
  });
});

describe("GET /api/documents/[id]/file: audit log", () => {
  it("logs every download of a non-public file with who, which file and its visibility", async () => {
    state.actor = inspector;
    await get(uid(11));
    state.actor = owner;
    await get(uid(12));
    await get(uid(12));
    const logged = audits.filter(a => a.eventType === "document.downloaded");
    expect(logged.map(a => [a.actorId, a.aggregateId])).toEqual([[inspector.userId, uid(11)], [owner.userId, uid(12)], [owner.userId, uid(12)]]);
    expect(logged[0]!.payload).toEqual({ listingId, kind: "building_inspection", visibility: "parties" });
  });
  it("logs nothing for a denied request", async () => {
    state.actor = stranger;
    await get(uid(12));
    expect(audits).toEqual([]);
  });
});

describe("GET /api/documents/[id]/file: storage off", () => {
  it("answers 503 with a plain message when storage is not configured, for an allowed reader", async () => {
    state.storage = createUnconfiguredStorage();
    state.actor = owner;
    const r = await get(uid(12));
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toMatch(/not configured/i);
    expect(audits).toEqual([]);
  });
  it("still answers 404, not 503, to someone who may not read the file", async () => {
    state.storage = createUnconfiguredStorage();
    state.actor = stranger;
    expect(await status(12)).toBe(404);
    state.actor = null;
    expect(await status(10)).toBe(404);
  });
  it("answers 503 and logs nothing when the read fails", async () => {
    state.storage = { configured: true, async put() {}, async get() { throw new Error("boom"); } };
    state.actor = owner;
    expect(await status(12)).toBe(503);
    expect(audits).toEqual([]);
  });
  it("the unconfigured stub refuses to read", async () => {
    await expect(createUnconfiguredStorage().get("k")).rejects.toThrow();
  });
});

describe("uploadAccess", () => {
  it("gives the owner every kind, an approved contractor only their own, and others nothing", async () => {
    expect((await uploadAccess(state.deps!, state.store!, owner, listingId)).kinds).toHaveLength(10);
    expect(await uploadAccess(state.deps!, state.store!, inspector, listingId)).toEqual({ isOwner: false, kinds: ["building_inspection", "pest_report"] });
    expect((await uploadAccess(state.deps!, state.store!, stranger, listingId)).kinds).toEqual([]);
    expect((await uploadAccess(state.deps!, state.store!, null, listingId)).kinds).toEqual([]);
  });
});

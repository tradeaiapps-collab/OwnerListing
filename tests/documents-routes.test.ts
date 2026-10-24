import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDocumentStore, type DocumentStore } from "../src/domain/document-service";
import type { DocumentKind, DocumentRecord, Visibility } from "../src/domain/documents";
import {
  createDraft, createInMemoryListingRepository,
  type Actor, type DraftInput, type ListingServiceDeps
} from "../src/domain/listing-service";

const state = vi.hoisted(() => ({
  actor: null as Actor | null,
  deps: null as ListingServiceDeps | null,
  store: null as DocumentStore | null
}));

vi.mock("../src/server/context", () => ({
  getActor: () => state.actor,
  getDeps: () => state.deps,
  getDb: () => ({})
}));
vi.mock("../src/server/documents-db", () => ({
  createPgDocumentStore: () => state.store
}));

import { GET as listRoute } from "../app/api/listings/[id]/documents/route";
import { POST as deletionRoute } from "../app/api/documents/[id]/deletion-request/route";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: Actor = { userId: uid(1), userType: "owner" };
const stranger: Actor = { userId: uid(2), userType: "owner" };
const contractor: Actor = { userId: uid(3), userType: "agent" };
const input: DraftInput = {
  title: "Family home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD",
  transactionType: "sale", useClass: "residential", propertyType: "house"
};

let n: number;
let listingId: string;
let mem: ReturnType<typeof createInMemoryDocumentStore>;

const doc = (id: number, kind: DocumentKind, visibility: Visibility, status: DocumentRecord["status"] = "active"): DocumentRecord => ({
  id: uid(id), listingId, ownerUserId: owner.userId, kind, uploadedBy: owner.userId, visibility, status
});

async function setStatus(status: "published" | "withdrawn") {
  const rec = (await state.deps!.repo.get(listingId))!;
  await state.deps!.repo.save({ ...rec, listing: { ...rec.listing, status } });
}

beforeEach(async () => {
  n = 100;
  state.actor = null;
  state.deps = {
    repo: createInMemoryListingRepository(),
    appendAudit: async () => {},
    now: () => "2026-10-24T00:00:00.000Z",
    newId: () => uid(++n),
    requiredDisclosures: () => []
  };
  listingId = (await createDraft(state.deps, owner, input)).id;
  mem = createInMemoryDocumentStore({
    documents: [
      doc(10, "photo", "public"),
      doc(11, "building_inspection", "parties"),
      doc(12, "contract", "owner_only"),
      doc(13, "photo", "public", "superseded")
    ],
    assignments: [{
      id: uid(50), listingId, ownerUserId: owner.userId, contractorUserId: contractor.userId,
      kind: "inspector", status: "approved"
    }]
  });
  state.store = mem.store;
});

const list = (id = listingId) =>
  listRoute(new Request(`http://test/api/listings/${id}/documents`), { params: Promise.resolve({ id }) });
const del = (id: string) =>
  deletionRoute(new Request(`http://test/api/documents/${id}/deletion-request`, { method: "POST" }), { params: Promise.resolve({ id }) });
const ids = async (r: Response) => ((await r.json()) as { documents: { id: string }[] }).documents.map(d => d.id).sort();

describe("GET /api/listings/[id]/documents", () => {
  it("returns 404 for an unknown listing and for a malformed id", async () => {
    expect((await list(uid(999))).status).toBe(404);
    expect((await list("not-a-uuid")).status).toBe(404);
  });
  it("shows the owner every version of every file", async () => {
    state.actor = owner;
    const r = await list();
    expect(r.status).toBe(200);
    expect(await ids(r)).toEqual([uid(10), uid(11), uid(12), uid(13)]);
  });
  it("returns metadata only, with no storage key, fingerprint or uploader", async () => {
    state.actor = owner;
    const body = (await (await list()).json()) as { documents: Record<string, unknown>[] };
    for (const d of body.documents) {
      expect(Object.keys(d).every(k => ["id", "kind", "visibility", "status", "supersedesId"].includes(k))).toBe(true);
    }
  });
  it("returns 404 to a stranger and to a signed-out visitor while the listing is a draft", async () => {
    state.actor = stranger;
    expect((await list()).status).toBe(404);
    state.actor = null;
    expect((await list()).status).toBe(404);
  });
  it("shows an approved contractor their parties files but never owner-only or superseded ones", async () => {
    state.actor = contractor;
    const r = await list();
    expect(r.status).toBe(200);
    expect(await ids(r)).toEqual([uid(11)]);
  });
  it("shows a signed-out visitor only active public files once the listing is published", async () => {
    await setStatus("published");
    state.actor = null;
    const r = await list();
    expect(r.status).toBe(200);
    expect(await ids(r)).toEqual([uid(10)]);
  });
});

describe("POST /api/documents/[id]/deletion-request", () => {
  it("returns 401 when signed out", async () => {
    expect((await del(uid(10))).status).toBe(401);
  });
  it("returns 404 for a malformed id", async () => {
    state.actor = owner;
    expect((await del("nope")).status).toBe(404);
  });
  it("returns 404 to a non-owner and records nothing", async () => {
    state.actor = stranger;
    expect((await del(uid(10))).status).toBe(404);
    state.actor = contractor;
    expect((await del(uid(11))).status).toBe(404);
    expect(mem.requests).toEqual([]);
  });
  it("records delete_now before the listing has been published, and still removes nothing", async () => {
    state.actor = owner;
    const r = await del(uid(10));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { outcome: string }).outcome).toBe("delete_now");
    expect(mem.requests).toHaveLength(1);
    expect(mem.documents.map(d => d.id)).toContain(uid(10));
  });
  it("records amend_only once published or withdrawn, and keeps the file", async () => {
    state.actor = owner;
    await setStatus("published");
    expect(((await (await del(uid(10))).json()) as { outcome: string }).outcome).toBe("amend_only");
    await setStatus("withdrawn");
    expect(((await (await del(uid(11))).json()) as { outcome: string }).outcome).toBe("amend_only");
    expect(mem.requests.map(r => r.outcome)).toEqual(["amend_only", "amend_only"]);
    expect(mem.documents).toHaveLength(4);
  });
});

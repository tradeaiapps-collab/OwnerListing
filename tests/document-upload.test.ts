import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUnconfiguredScanner, type MalwareScanPort } from "../src/adapters/malware-scan";
import { createUnconfiguredStorage, objectStorageFromEnv, type ObjectStoragePort } from "../src/adapters/object-storage";
import { createInMemoryDocumentStore } from "../src/domain/document-service";
import type { NewDocument, UploadStore } from "../src/domain/document-upload";
import type { DocumentRecord } from "../src/domain/documents";
import { sniffMime } from "../src/domain/file-sniff";
import { createDraft, createInMemoryListingRepository, type Actor, type DraftInput, type ListingServiceDeps } from "../src/domain/listing-service";

const state = vi.hoisted(() => ({
  actor: null as Actor | null,
  deps: null as ListingServiceDeps | null,
  store: null as unknown,
  ports: null as unknown
}));

vi.mock("../src/server/context", () => ({
  getActor: () => state.actor,
  getDeps: () => state.deps,
  getDb: () => ({}),
  getUploadPorts: () => state.ports
}));
vi.mock("../src/server/documents-db", () => ({ createPgDocumentStore: () => state.store }));

import { POST } from "../app/api/listings/[id]/documents/route";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: Actor = { userId: uid(1), userType: "owner" };
const stranger: Actor = { userId: uid(2), userType: "owner" };
const inspector: Actor = { userId: uid(3), userType: "agent" };
const input: DraftInput = {
  title: "Family home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD",
  transactionType: "sale", useClass: "residential", propertyType: "house"
};

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
const EXE = Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0]); // "MZ" Windows executable

let listingId: string;
let stored: { key: string; type: string }[];
let scanned: number;
let hasProperty: boolean;
let added: { doc: NewDocument; supersede?: DocumentRecord }[];
let storage: ObjectStoragePort;
let scanner: MalwareScanPort;

process.env["APP_URL"] = "http://test";

beforeEach(async () => {
  let n = 100;
  state.actor = owner;
  state.deps = {
    repo: createInMemoryListingRepository(), appendAudit: async () => {}, now: () => "2026-10-24T00:00:00.000Z",
    newId: () => uid(++n), requiredDisclosures: () => []
  };
  listingId = (await createDraft(state.deps, owner, input)).id;
  const mem = createInMemoryDocumentStore({
    documents: [{ id: uid(10), listingId, ownerUserId: owner.userId, kind: "photo", uploadedBy: owner.userId, visibility: "public", status: "active" }],
    assignments: [{ id: uid(50), listingId, ownerUserId: owner.userId, contractorUserId: inspector.userId, kind: "inspector", status: "approved" }]
  });
  added = [];
  hasProperty = true;
  const store: UploadStore = {
    ...mem.store, async listingHasProperty() { return hasProperty; },
    async addDocument(doc, supersede) { added.push({ doc, ...(supersede ? { supersede } : {}) }); }
  };
  state.store = store;
  stored = []; scanned = 0;
  storage = { configured: true, async put(key, _b, type) { stored.push({ key, type }); } };
  scanner = { configured: true, async scan() { scanned++; return "clean"; } };
  state.ports = { storage, scanner };
});

function upload(bytes: Uint8Array, over: { name?: string; type?: string; kind?: string; visibility?: string; supersedesId?: string; id?: string } = {}) {
  const form = new FormData();
  form.set("file", new File([bytes as Uint8Array<ArrayBuffer>], over.name ?? "scan.pdf", { type: over.type ?? "application/pdf" }));
  form.set("kind", over.kind ?? "contract");
  form.set("visibility", over.visibility ?? "owner_only");
  if (over.supersedesId) form.set("supersedesId", over.supersedesId);
  return POST(
    new Request("http://x/api", { method: "POST", body: form, headers: { "content-length": String(bytes.length + 500), origin: "http://test" } }),
    { params: Promise.resolve({ id: over.id ?? listingId }) }
  );
}

describe("sniffMime", () => {
  it("recognises real content, not names", () => {
    expect(sniffMime(PDF)).toBe("application/pdf");
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(EXE)).toBeNull();
    expect(sniffMime(new Uint8Array())).toBeNull();
  });
});

describe("POST /api/listings/[id]/documents", () => {
  it("refuses a cross-origin upload and stores nothing", async () => {
    const form = new FormData();
    form.set("file", new File([PDF as Uint8Array<ArrayBuffer>], "scan.pdf", { type: "application/pdf" }));
    form.set("kind", "contract");
    form.set("visibility", "owner_only");
    const res = await POST(
      new Request("http://x/api", { method: "POST", body: form, headers: { "content-length": "600", origin: "http://evil.example" } }),
      { params: Promise.resolve({ id: listingId }) }
    );
    expect(res.status).toBe(403);
    expect(stored).toHaveLength(0);
  });

  it("owner can upload; only a random key and the hash are recorded", async () => {
    const res = await upload(PDF, { name: "../../etc/passwd.pdf" });
    expect(res.status).toBe(201);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.key).toMatch(/^listings\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    expect(stored[0]!.key).not.toContain("passwd");
    expect(added[0]!.doc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(added[0]!.doc)).not.toContain("passwd");
    expect(await res.json()).toEqual({ id: expect.any(String) });
    expect(scanned).toBe(1);
  });

  it("approved contractor can add their own kind, shared with parties", async () => {
    state.actor = inspector;
    expect((await upload(PDF, { kind: "pest_report", visibility: "parties" })).status).toBe(201);
  });

  it("requires a session", async () => {
    state.actor = null;
    expect((await upload(PDF)).status).toBe(401);
    expect(stored).toHaveLength(0);
  });

  it("rejects a user with no role on the listing", async () => {
    state.actor = stranger;
    expect((await upload(PDF)).status).toBe(403);
    expect(stored).toHaveLength(0);
  });

  it("rejects a contractor adding a kind outside their role", async () => {
    state.actor = inspector;
    expect((await upload(PDF, { kind: "contract", visibility: "parties" })).status).toBe(403);
  });

  it("rejects a contractor making a file public", async () => {
    state.actor = inspector;
    expect((await upload(PDF, { kind: "pest_report", visibility: "public" })).status).toBe(400);
  });

  it("rejects a type not allowed for the kind", async () => {
    expect((await upload(JPEG, { kind: "contract", type: "image/jpeg" })).status).toBe(400);
    expect(stored).toHaveLength(0);
  });

  it("rejects a spoofed type: executable declared as PDF with a .pdf name", async () => {
    expect((await upload(EXE, { name: "contract.pdf", type: "application/pdf" })).status).toBe(400);
    expect(stored).toHaveLength(0);
    expect(scanned).toBe(0);
  });

  it("rejects a JPEG declared as PDF", async () => {
    expect((await upload(JPEG, { type: "application/pdf" })).status).toBe(400);
  });

  it("ignores the filename extension when the bytes are right", async () => {
    expect((await upload(PDF, { name: "evil.exe" })).status).toBe(201);
  });

  it("rejects an empty file", async () => {
    expect((await upload(new Uint8Array())).status).toBe(400);
  });

  it("rejects an oversize file for its kind (photo over 25 MB)", async () => {
    const big = new Uint8Array(25_000_001);
    big.set(JPEG);
    expect((await upload(big, { kind: "photo", type: "image/jpeg", visibility: "public" })).status).toBe(400);
    expect(stored).toHaveLength(0);
  });

  it("rejects a request over the route limit before reading it", async () => {
    const form = new FormData();
    form.set("file", new File([PDF], "a.pdf", { type: "application/pdf" }));
    const res = await POST(
      new Request("http://x/api", { method: "POST", body: form, headers: { "content-length": "100000001", origin: "http://test" } }),
      { params: Promise.resolve({ id: listingId }) }
    );
    expect(res.status).toBe(413);
  });

  it("refuses when storage is not configured (default)", async () => {
    state.ports = { storage: createUnconfiguredStorage(), scanner };
    expect((await upload(PDF)).status).toBe(503);
    expect(added).toHaveLength(0);
    expect(scanned).toBe(0);
  });

  it("refuses when the malware scanner is not configured (default)", async () => {
    state.ports = { storage, scanner: createUnconfiguredScanner() };
    expect((await upload(PDF)).status).toBe(503);
    expect(stored).toHaveLength(0);
  });

  it("environment wiring fails closed with no provider settings", () => {
    expect(objectStorageFromEnv({}).configured).toBe(false);
  });

  it("rejects an infected file and stores nothing", async () => {
    state.ports = { storage, scanner: { configured: true, async scan() { return "infected"; } } };
    expect((await upload(PDF)).status).toBe(400);
    expect(stored).toHaveLength(0);
    expect(added).toHaveLength(0);
  });

  it("refuses when the scanner errors", async () => {
    state.ports = { storage, scanner: { configured: true, async scan() { throw new Error("down"); } } };
    expect((await upload(PDF)).status).toBe(503);
    expect(stored).toHaveLength(0);
  });

  it("records nothing when storage errors", async () => {
    state.ports = { storage: { configured: true, async put() { throw new Error("down"); } }, scanner };
    expect((await upload(PDF)).status).toBe(503);
    expect(added).toHaveLength(0);
  });

  it("replacing a file creates a new version and keeps the old one (superseded, not deleted)", async () => {
    const res = await upload(JPEG, { kind: "photo", type: "image/jpeg", visibility: "public", supersedesId: uid(10) });
    expect(res.status).toBe(201);
    expect(added[0]!.doc.record.supersedesId).toBe(uid(10));
    expect(added[0]!.supersede).toMatchObject({ id: uid(10), status: "superseded" });
  });

  it("rejects replacing a file of a different kind or from another listing", async () => {
    expect((await upload(PDF, { kind: "contract", supersedesId: uid(10) })).status).toBe(400);
    expect((await upload(PDF, { supersedesId: uid(999) })).status).toBe(404);
  });

  it("a contractor cannot replace the owner's file", async () => {
    state.actor = inspector;
    const store = state.store as UploadStore;
    const prev: DocumentRecord = { id: uid(11), listingId, ownerUserId: owner.userId, kind: "pest_report", uploadedBy: owner.userId, visibility: "parties", status: "active" };
    (store as { documentById: UploadStore["documentById"] }).documentById = async () => prev;
    expect((await upload(PDF, { kind: "pest_report", visibility: "parties", supersedesId: uid(11) })).status).toBe(403);
  });

  it("rejects a malformed listing id and a missing listing", async () => {
    expect((await upload(PDF, { id: "nope" })).status).toBe(404);
    expect((await upload(PDF, { id: uid(777) })).status).toBe(404);
  });

  it("offers no delete handler on this route", async () => {
    const mod = (await import("../app/api/listings/[id]/documents/route")) as Record<string, unknown>;
    expect(mod["DELETE"]).toBeUndefined();
    expect(mod["PUT"]).toBeUndefined();
    expect(mod["PATCH"]).toBeUndefined();
  });
});

describe("follow-ups: no body read before cheap checks, missing property, orphaned object", () => {
  const spyUpload = () => {
    const form = new FormData();
    form.set("file", new File([PDF as Uint8Array<ArrayBuffer>], "scan.pdf", { type: "application/pdf" }));
    form.set("kind", "contract"); form.set("visibility", "owner_only");
    const req = new Request("http://x/api", { method: "POST", body: form, headers: { "content-length": "100000", origin: "http://test" } });
    const spy = vi.spyOn(req, "formData");
    return { spy, res: POST(req, { params: Promise.resolve({ id: listingId }) }) };
  };

  it("never reads the body for a wrong-role user", async () => {
    state.actor = stranger;
    const { spy, res } = spyUpload();
    expect((await res).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it("never reads the body when storage is not configured", async () => {
    state.ports = { storage: createUnconfiguredStorage(), scanner };
    const { spy, res } = spyUpload();
    expect((await res).status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });

  it("never reads the body when the scanner is not configured", async () => {
    state.ports = { storage, scanner: createUnconfiguredScanner() };
    const { spy, res } = spyUpload();
    expect((await res).status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns 409 when the listing has no property record, storing nothing", async () => {
    hasProperty = false;
    const res = await upload(PDF);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no property record/i);
    expect(stored).toHaveLength(0);
    expect(added).toHaveLength(0);
  });

  it("logs the orphaned key (no delete) when the record insert fails", async () => {
    const base = state.store as UploadStore;
    state.store = { ...base, async addDocument() { throw new Error("db down"); } };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await upload(PDF);
    expect(res.status).toBe(503);
    expect(stored).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(stored[0]!.key));
    expect("delete" in storage).toBe(false);
    log.mockRestore();
  });
});

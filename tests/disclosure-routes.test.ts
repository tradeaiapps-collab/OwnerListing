import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisclosureConfigVersion } from "../src/domain/disclosure-config";
import type { StaffActor } from "../src/domain/staff-access";
import { createInMemoryListingRepository, type Actor, type ListingServiceDeps } from "../src/domain/listing-service";
import type { PropertyListing } from "../src/domain/listing";

const state = vi.hoisted(() => ({
  actor: null as Actor | null,
  staff: null as StaffActor | null,
  deps: null as unknown,
  version: null as unknown,
  docOk: true,
  calls: [] as unknown[][],
  audits: [] as string[],
  approve: { ok: true, retiredId: null } as unknown,
  review: { outcome: "reviewed", listingId: "L", key: "k" } as unknown
}));

vi.mock("../src/server/context", () => ({
  getActor: () => state.actor, getDeps: () => state.deps, getStaff: async () => state.staff,
  getDb: () => ({ query: async () => ({ rows: [] }) })
}));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_db: unknown, e: { eventType: string }) => { state.audits.push(e.eventType); } }));
vi.mock("../src/server/disclosure-config-db", () => ({
  approvedVersionPg: async () => state.version,
  listingDisclosuresPg: async () => [],
  activeListingDocumentPg: async () => state.docOk,
  submitDisclosurePg: async (_db: unknown, a: unknown) => { state.calls.push(["submit", a]); },
  listVersionsPg: async () => [],
  createDraftVersionPg: async (_db: unknown, input: unknown, staffId: string) => { state.calls.push(["draft", staffId]); return { ok: true, id: "V2", version: 2 }; },
  approveVersionPg: async (_db: unknown, id: string, staffId: string) => { state.calls.push(["approve", id, staffId]); return state.approve; },
  reviewQueuePg: async () => [],
  reviewDisclosurePg: async (_db: unknown, ...a: unknown[]) => { state.calls.push(["review", ...a]); return state.review; }
}));

import * as required from "../app/api/listings/[id]/required-disclosures/route";
import * as submit from "../app/api/listings/[id]/disclosures/[key]/route";
import * as versions from "../app/api/staff/disclosures/route";
import * as approve from "../app/api/staff/disclosures/[id]/approve/route";
import * as queue from "../app/api/staff/disclosure-reviews/route";
import * as review from "../app/api/staff/disclosure-reviews/[id]/route";
process.env["APP_URL"] = "http://test";

const owner: Actor = { userId: "owner-1", userType: "owner" };
const other: Actor = { userId: "owner-2", userType: "owner" };
const comp: StaffActor = { id: "00000000-0000-4000-8000-000000000001", role: "compliance" };
const support: StaffActor = { id: "00000000-0000-4000-8000-000000000002", role: "support" };
const DOC = "00000000-0000-4000-8000-0000000000d1";
const LID = "00000000-0000-4000-8000-0000000000a1";
const VERSION: DisclosureConfigVersion = {
  id: "V1", jurisdiction: "QLD", transactionType: "sale", useClass: "residential", version: 1, status: "approved", note: "Approved by counsel.",
  createdBy: null, createdAt: "2026-10-25T00:00:00.000Z", approvedBy: comp.id, approvedAt: "2026-10-25T01:00:00.000Z",
  items: [
    { key: "qld_seller_disclosure_statement", label: "Seller disclosure statement", description: "The signed statement.", legalRef: "PLA 2023", notApplicableAllowed: false },
    { key: "qld_pool_safety_sale", label: "Pool", description: "Pool certificate or Form 36.", legalRef: "Building Act 1975", notApplicableAllowed: true, propertyTypes: ["house"] },
    { key: "qld_body_corporate_certificate", label: "Body corporate", description: "BCCM certificate.", legalRef: "BCCMA", notApplicableAllowed: true, propertyTypes: ["unit"] }
  ]
};

const listing = (o: Partial<PropertyListing> = {}): PropertyListing => ({
  id: LID, ownerUserId: owner.userId, ownerUserType: "owner", jurisdiction: "QLD", status: "draft", title: "Home", propertyType: "house",
  useClass: "residential", transactionType: "sale", address: "1 St", disclosures: [], createdAt: "2026-10-25", updatedAt: "2026-10-25", ...o
});

beforeEach(async () => {
  const repo = createInMemoryListingRepository();
  await repo.insert({ listing: listing(), listingFeePaid: false, termsAccepted: true });
  state.deps = { repo, appendAudit: async (e: { eventType: string }) => { state.audits.push(e.eventType); }, now: () => "2026-10-25T00:00:00.000Z", newId: () => "x", requiredDisclosures: () => null } as unknown as ListingServiceDeps;
  state.actor = null; state.staff = null; state.version = VERSION; state.docOk = true; state.calls = []; state.audits = [];
  state.approve = { ok: true, retiredId: null }; state.review = { outcome: "reviewed", listingId: LID, key: "k" };
});

const json = (method: string, body?: unknown) => new Request("http://test/x", {
  method, headers: { "content-type": "application/json", origin: "http://test" }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const lctx = { params: Promise.resolve({ id: LID }) };
const kctx = (key: string) => ({ params: Promise.resolve({ id: LID, key }) });
const sctx = { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000099" }) };

describe("GET /api/listings/{id}/required-disclosures", () => {
  it("is for the owner (others get 404, signed out 401)", async () => {
    expect((await required.GET(json("GET"), lctx)).status).toBe(401);
    state.actor = other;
    expect((await required.GET(json("GET"), lctx)).status).toBe(404);
  });
  it("returns the items for the property type with their state", async () => {
    state.actor = owner;
    const r = await required.GET(json("GET"), lctx);
    const d = await r.json();
    expect(d.version).toEqual({ id: "V1", version: 1, approvedAt: VERSION.approvedAt });
    expect(d.items.map((i: { key: string; state: string }) => [i.key, i.state])).toEqual([["qld_seller_disclosure_statement", "missing"], ["qld_pool_safety_sale", "missing"]]);
    expect(d.editable).toBe(true);
  });
  it("answers 423 region_not_enabled without an approved version", async () => {
    state.actor = owner; state.version = null;
    const r = await required.GET(json("GET"), lctx);
    expect(r.status).toBe(423);
    expect((await r.json()).code).toBe("region_not_enabled");
  });
});

describe("PUT /api/listings/{id}/disclosures/{key}", () => {
  it("records evidence from the listing's own documents and audits it", async () => {
    state.actor = owner;
    const r = await submit.PUT(json("PUT", { evidenceDocumentId: DOC }), kctx("qld_seller_disclosure_statement"));
    expect(r.status).toBe(200);
    expect(state.calls).toEqual([["submit", { listingId: LID, jurisdiction: "QLD", key: "qld_seller_disclosure_statement", versionId: "V1", actorId: owner.userId, input: { kind: "evidence", documentId: DOC } }]]);
    expect(state.audits).toEqual(["listing.disclosure_submitted"]);
  });
  it("refuses a document from elsewhere, an item not required for this property type, and an unallowed not-applicable claim", async () => {
    state.actor = owner;
    state.docOk = false;
    expect((await submit.PUT(json("PUT", { evidenceDocumentId: DOC }), kctx("qld_seller_disclosure_statement"))).status).toBe(400);
    state.docOk = true;
    expect((await submit.PUT(json("PUT", { evidenceDocumentId: DOC }), kctx("qld_body_corporate_certificate"))).status).toBe(404);
    expect((await submit.PUT(json("PUT", { notApplicable: true, note: "Not needed." }), kctx("qld_seller_disclosure_statement"))).status).toBe(400);
    expect((await submit.PUT(json("PUT", { notApplicable: true, note: "There is no pool." }), kctx("qld_pool_safety_sale"))).status).toBe(200);
    expect(state.calls).toHaveLength(1);
  });
  it("is closed once published, and 423 without an approved version", async () => {
    state.actor = owner;
    const deps = state.deps as ListingServiceDeps;
    const rec = (await deps.repo.get(LID))!;
    state.version = null;
    expect((await submit.PUT(json("PUT", { evidenceDocumentId: DOC }), kctx("qld_seller_disclosure_statement"))).status).toBe(423);
    state.version = VERSION;
    await deps.repo.save({ ...rec, listing: { ...rec.listing, status: "published" } });
    expect((await submit.PUT(json("PUT", { evidenceDocumentId: DOC }), kctx("qld_seller_disclosure_statement"))).status).toBe(409);
    expect(state.calls).toEqual([]);
  });
  it("needs the CSRF origin", async () => {
    state.actor = owner;
    const r = await submit.PUT(new Request("http://test/x", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }), kctx("qld_seller_disclosure_statement"));
    expect(r.status).toBe(403);
  });
});

describe("staff disclosure routes", () => {
  const draft = { jurisdiction: "QLD", transactionType: "sale", useClass: "residential", note: "Counsel advice of 1 Nov 2026.", items: VERSION.items };
  it("need the disclosure permissions (support has none)", async () => {
    state.staff = support;
    expect((await versions.GET(json("GET"))).status).toBe(403);
    expect((await versions.POST(json("POST", draft))).status).toBe(403);
    expect((await approve.POST(json("POST", { reason: "Counsel confirmed the list." }), sctx)).status).toBe(403);
    expect((await queue.GET(json("GET"))).status).toBe(403);
    expect((await review.POST(json("POST", { decision: "verify", reason: "Form 2 is signed and complete." }), sctx)).status).toBe(403);
    expect(state.calls).toEqual([]);
  });
  it("compliance drafts (validated), approves with a reason, and reviews evidence, all audited", async () => {
    state.staff = comp;
    expect((await versions.POST(json("POST", { ...draft, note: "x" }))).status).toBe(400);
    expect((await versions.POST(json("POST", draft))).status).toBe(201);
    expect((await approve.POST(json("POST", { reason: "short" }), sctx)).status).toBe(400);
    expect((await approve.POST(json("POST", { reason: "Counsel confirmed the list." }), sctx)).status).toBe(200);
    expect((await review.POST(json("POST", { decision: "accept", reason: "Form 2 is signed and complete." }), sctx)).status).toBe(400);
    expect((await review.POST(json("POST", { decision: "verify", reason: "Form 2 is signed and complete." }), sctx)).status).toBe(200);
    expect(state.audits).toEqual(["staff.disclosure_config_drafted", "staff.disclosure_config_approved", "staff.disclosure_verified"]);
  });
  it("passes approval refusals through and maps review outcomes", async () => {
    state.staff = comp;
    state.approve = { ok: false, status: 403, error: "Someone other than the author must approve this version." };
    expect((await approve.POST(json("POST", { reason: "Counsel confirmed the list." }), sctx)).status).toBe(403);
    for (const [outcome, status] of [["not_found", 404], ["already_reviewed", 409], ["own_listing", 403]] as const) {
      state.review = { outcome };
      expect((await review.POST(json("POST", { decision: "reject", reason: "The certificate has expired." }), sctx)).status).toBe(status);
    }
  });
});

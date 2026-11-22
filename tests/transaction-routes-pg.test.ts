import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rulesOnlyEngine, type AiEnginePort } from "../src/domain/ai-engine";
import type { Actor } from "../src/domain/listing-service";
import { appendAuditPg, createPgListingRepository, type Queryable } from "../src/server/db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const state = vi.hoisted(() => ({
  actor: null as Actor | null, db: null as unknown as Queryable, engine: null as unknown as AiEnginePort,
  email: { configured: false, result: "sent" as string, sent: [] as { to: string; subject: string; text: string }[] }
}));
vi.mock("../src/server/messaging", () => ({
  getEmailPort: async () => ({
    get configured() { return state.email.configured; },
    send: async (m: { to: string; subject: string; text: string }) => { state.email.sent.push(m); return { status: state.email.result }; }
  })
}));
vi.mock("../src/server/context", async () => {
  const { createPgListingRepository, appendAuditPg } = await import("../src/server/db");
  const { randomUUID } = await import("node:crypto");
  return {
    getActor: async () => state.actor,
    getDb: () => state.db,
    getDeps: () => ({ repo: createPgListingRepository(state.db), appendAudit: (e: never) => appendAuditPg(state.db, e), now: () => new Date().toISOString(), newId: () => randomUUID() })
  };
});
vi.mock("../src/server/ai", () => ({ getAiEngine: async () => state.engine }));

import * as templates from "../app/api/listings/[id]/document-templates/route";
import * as docList from "../app/api/listings/[id]/generated-documents/route";
import * as doc from "../app/api/generated-documents/[id]/route";
import * as docHistory from "../app/api/generated-documents/[id]/history/route";
import * as sigRequests from "../app/api/generated-documents/[id]/signature-requests/route";
import * as sigRequest from "../app/api/signature-requests/[id]/route";
import * as uploadedHistory from "../app/api/documents/[id]/history/route";
import * as assistant from "../app/api/listings/[id]/transaction-assistant/route";
import { CONSENT_VERSION_FOR_TESTS } from "./helpers/consent";
void createPgListingRepository; void appendAuditPg; void randomUUID;

process.env["APP_URL"] = "http://test";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (url = "http://test/x") => new Request(url);
const send = (method: string, body: unknown, origin = "http://test") =>
  new Request("http://test/x", { method, headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
const post = (body: unknown) => send("POST", body);
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const inDays = (d: number, h = 1) => new Date(Date.now() + d * 86_400_000 + h * 3_600_000).toISOString();

describe.skipIf(!DATABASE_URL)("documents, signing and the assistant over HTTP on Postgres", () => {
  let t: TestDb;
  let owner: Actor, buyer: Actor, buyer2: Actor, inspector: Actor, stranger: Actor, stranger2: Actor;
  let listingId: string;
  const as = (a: Actor | null) => { state.actor = a; };

  beforeAll(async () => {
    t = await createTestDb();
    state.db = t.db;
    const mk = async (type: "owner" | "buyer" | "agent"): Promise<Actor> => ({ userId: await addUser(t.db, type), userType: type === "agent" ? "agent" : type });
    owner = await mk("owner"); buyer = await mk("buyer"); buyer2 = await mk("buyer"); stranger = await mk("buyer"); stranger2 = await mk("owner");
    inspector = { userId: await addUser(t.db, "agent"), userType: "vendor" };
    listingId = await addListing(t.db, owner.userId, { jurisdiction: "QLD", status: "published", title: "Queenslander", address_text: "12 River Rd, Brisbane" });
    for (const b of [buyer, buyer2]) await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1,$2)", [listingId, b.userId]);
    await t.db.query("INSERT INTO job_assignment (listing_id, owner_user_id, contractor_user_id, kind, status) VALUES ($1,$2,$3,'inspector','approved')", [listingId, owner.userId, inspector.userId]);
    state.engine = rulesOnlyEngine;
  }, 60_000);
  afterAll(async () => { await t?.close(); });
  beforeEach(() => as(owner));

  describe("access", () => {
    it("401 signed out, 404 for strangers, on every route", async () => {
      as(null);
      expect((await templates.GET(get(), ctx(listingId))).status).toBe(401);
      expect((await assistant.GET(get(), ctx(listingId))).status).toBe(401);
      for (const s of [stranger, stranger2]) {
        as(s);
        expect((await templates.GET(get(), ctx(listingId))).status).toBe(404);
        expect((await docList.GET(get(), ctx(listingId))).status).toBe(404);
        expect((await assistant.POST(post({ question: "hi" }), ctx(listingId))).status).toBe(404);
      }
      as(owner);
      expect((await templates.GET(get(), ctx("not-a-uuid"))).status).toBe(404);
    });
    it("refuses a cross-site POST", async () => {
      expect((await templates.POST(send("POST", {}, "http://evil.test"), ctx(listingId))).status).toBe(403);
    });
    it("keeps buyers and inspectors out of the owner's tools", async () => {
      for (const a of [buyer, inspector]) {
        as(a);
        expect((await templates.POST(post({}), ctx(listingId))).status).toBe(404);
      }
    });
  });

  describe("templates, versions and history", () => {
    const fields = { address: "12 River Rd, Brisbane", state: "QLD", buyerName: "Ben Buyer", price: "850,000", deposit: "50,000", settlementDays: "30", conditions: "Subject to finance" };
    let docId: string;

    it("lists templates with prefilled fields and makes a document", async () => {
      const list = await json(await templates.GET(get(), ctx(listingId)));
      expect(list.templates).toHaveLength(4);
      const heads = list.templates.find((x: any) => x.id === "purchase_heads_of_terms");
      expect(heads.fields.find((f: any) => f.key === "address").value).toBe("12 River Rd, Brisbane");
      expect(heads.fields.find((f: any) => f.key === "state").value).toBe("QLD");
      expect((await templates.POST(post({ templateId: "nope", fields }), ctx(listingId))).status).toBe(400);
      const bad = await templates.POST(post({ templateId: "purchase_heads_of_terms", fields: { ...fields, price: "", state: "NSW" } }), ctx(listingId));
      expect(bad.status).toBe(400);
      expect(Object.keys((await json(bad)).fields).sort()).toEqual(["price", "state"]);
      const ok = await templates.POST(post({ templateId: "purchase_heads_of_terms", fields }), ctx(listingId));
      expect(ok.status).toBe(201);
      docId = (await json(ok)).document.id;
    });

    it("makes version 2 once, keeps version 1, and records both in the history", async () => {
      const v2 = await templates.POST(post({ templateId: "purchase_heads_of_terms", fields: { ...fields, price: "860,000" }, supersedesId: docId }), ctx(listingId));
      expect(v2.status).toBe(201);
      expect((await json(v2)).document.version).toBe(2);
      expect((await templates.POST(post({ templateId: "purchase_heads_of_terms", fields, supersedesId: docId }), ctx(listingId))).status).toBe(409);
      expect((await templates.POST(post({ templateId: "deposit_trust_notice", fields: { address: "a", buyerName: "b", deposit: "1", trustHolder: "t", dueDate: "d" }, supersedesId: docId }), ctx(listingId))).status).toBe(404);
      const h = await json(await docHistory.GET(get(), ctx(docId)));
      expect(h.versions.map((v: any) => v.version)).toEqual([1, 2]);
      expect(h.versions[0].contentSha256).not.toBe(h.versions[1].contentSha256);
      expect(h.events.map((e: any) => e.type)).toEqual(["created", "version_created"]);
      await expect(t.db.query("UPDATE generated_document SET body = 'x' WHERE id = $1", [docId])).rejects.toThrow(/append-only/);
      const rows = (await json(await docList.GET(get(), ctx(listingId)))).documents;
      expect(rows.filter((d: any) => d.latest && d.templateId === "purchase_heads_of_terms")).toHaveLength(1);
    });

    it("hides documents from people who are not signers", async () => {
      for (const a of [buyer, stranger, inspector]) {
        as(a);
        expect((await doc.GET(get(), ctx(docId))).status).toBe(404);
        expect((await docHistory.GET(get(), ctx(docId))).status).toBe(404);
      }
      as(buyer);
      expect((await json(await docList.GET(get(), ctx(listingId)))).documents).toEqual([]);
    });
  });

  describe("e-signing", () => {
    const fields = { address: "12 River Rd, Brisbane", buyerName: "Ben Buyer", deposit: "50,000", trustHolder: "Smith & Co Solicitors", dueDate: "within 2 business days" };
    const newDoc = async () => (await json(await templates.POST(post({ templateId: "deposit_trust_notice", fields }), ctx(listingId)))).document.id as string;
    const send2 = (docId: string, signers: unknown) => sigRequests.POST(post({ signers }), ctx(docId));
    const consent = { consent: true, consentVersion: CONSENT_VERSION_FOR_TESTS };

    it("only the owner sends; signers must be the owner or an enquiring buyer; one open request per document", async () => {
      const d = await newDoc();
      as(buyer);
      expect((await send2(d, [{ userId: buyer.userId, roleLabel: "Buyer" }])).status).toBe(404);
      as(owner);
      expect((await send2(d, [{ userId: stranger.userId, roleLabel: "Buyer" }])).status).toBe(400);
      expect((await send2(d, [{ userId: inspector.userId, roleLabel: "Buyer" }])).status).toBe(400);
      expect((await send2(d, [])).status).toBe(400);
      const ok = await send2(d, [{ userId: owner.userId, roleLabel: "Owner" }, { userId: buyer.userId, roleLabel: "Buyer" }]);
      expect(ok.status).toBe(201);
      expect((await send2(d, [{ userId: buyer.userId, roleLabel: "Buyer" }])).status).toBe(409);
      // a new version cancels the open request so the old text can never be signed
      const reqId = (await json(ok)).request.id as string;
      const v2 = await templates.POST(post({ templateId: "deposit_trust_notice", fields: { ...fields, deposit: "60,000" }, supersedesId: d }), ctx(listingId));
      expect(v2.status).toBe(201);
      as(buyer);
      await doc.GET(get(), ctx(d));
      expect((await sigRequest.POST(post({ action: "sign", typedName: "Ben Buyer", ...consent }), ctx(reqId))).status).toBe(409);
    });

    it("signs: needs the document opened, consent and a full name; is final; completes when everyone signed", async () => {
      const d = await newDoc();
      as(owner);
      const reqId = (await json(await send2(d, [{ userId: owner.userId, roleLabel: "Owner" }, { userId: buyer.userId, roleLabel: "Buyer" }]))).request.id as string;
      as(buyer);
      const sign = (body: Record<string, unknown>) => sigRequest.POST(post({ action: "sign", ...body }), ctx(reqId));
      expect((await sign({ typedName: "Ben Buyer", ...consent })).status).toBe(409); // not opened yet
      const view = await json(await doc.GET(get(), ctx(d)));
      expect(view.document.body).toContain("Smith & Co Solicitors");
      expect(view.document.fields).toBeUndefined();
      expect(view.requests[0].mine).toEqual({ status: "pending", roleLabel: "Buyer" });
      expect((await sign({ typedName: "Ben Buyer", consent: false, consentVersion: CONSENT_VERSION_FOR_TESTS })).status).toBe(400);
      expect((await sign({ typedName: "Ben", ...consent })).status).toBe(400);
      expect((await sign({ typedName: "Ben Buyer", consent: true, consentVersion: "old" })).status).toBe(400);
      const s = await sign({ typedName: "Ben Buyer", ...consent });
      expect(s.status).toBe(200);
      const sj = await json(s);
      expect(sj.status).toBe("pending");
      expect(sj.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect((await sign({ typedName: "Ben Buyer", ...consent })).status).toBe(409);
      expect((await sigRequest.POST(post({ action: "decline" }), ctx(reqId))).status).toBe(409);
      await expect(t.db.query("UPDATE signature_signer SET typed_name = 'Someone Else' WHERE request_id = $1 AND user_id = $2", [reqId, buyer.userId])).rejects.toThrow(/cannot be changed/);
      await expect(t.db.query("DELETE FROM signature_signer WHERE request_id = $1", [reqId])).rejects.toThrow(/append-only/);

      as(buyer2);
      expect((await sigRequest.POST(post({ action: "sign", typedName: "Bea Buyer", ...consent }), ctx(reqId))).status).toBe(404);
      as(owner);
      await doc.GET(get(), ctx(d));
      const o = await json(await sigRequest.POST(post({ action: "sign", typedName: "Olive Owner", ...consent }), ctx(reqId)));
      expect(o.status).toBe("completed");
      expect(o.evidenceSha256).not.toBe(sj.evidenceSha256);

      const final = await json(await doc.GET(get(), ctx(d)));
      expect(final.requests[0].status).toBe("completed");
      expect(final.requests[0].signers.map((x: any) => x.typedName).sort()).toEqual(["Ben Buyer", "Olive Owner"]);
      const h = await json(await docHistory.GET(get(), ctx(d)));
      expect(h.events.map((e: any) => e.type)).toEqual(["created", "sign_requested", "viewed", "signed", "viewed", "signed", "completed"]);
      const listed = (await json(await docList.GET(get(), ctx(listingId)))).documents.find((x: any) => x.id === d);
      expect(listed.state).toBe("signed");
      as(owner);
      expect((await sigRequest.POST(post({ action: "cancel" }), ctx(reqId))).status).toBe(409);
    });

    it("lets a signer decline (closing the request), lets the owner cancel, and expires old requests", async () => {
      as(owner);
      const d1 = await newDoc();
      const r1 = (await json(await send2(d1, [{ userId: buyer.userId, roleLabel: "Buyer" }]))).request.id as string;
      as(buyer);
      expect((await sigRequest.POST(post({ action: "decline", reason: "Wrong deposit amount" }), ctx(r1))).status).toBe(200);
      as(owner);
      expect((await json(await doc.GET(get(), ctx(d1)))).requests[0].signers[0].declineReason).toBe("Wrong deposit amount");
      as(buyer);
      expect((await json(await doc.GET(get(), ctx(d1)))).requests[0].signers[0].declineReason).toBeNull();
      as(owner);
      expect((await send2(d1, [{ userId: buyer.userId, roleLabel: "Buyer" }])).status).toBe(201); // a new request after a decline

      const d2 = await newDoc();
      const r2 = (await json(await send2(d2, [{ userId: buyer.userId, roleLabel: "Buyer" }]))).request.id as string;
      as(buyer);
      expect((await sigRequest.POST(post({ action: "cancel" }), ctx(r2))).status).toBe(403);
      as(owner);
      expect((await sigRequest.POST(post({ action: "cancel" }), ctx(r2))).status).toBe(200);
      as(buyer);
      expect((await doc.GET(get(), ctx(d2)))).toHaveProperty("status", 200);

      as(owner);
      const d3 = await newDoc();
      const r3 = (await json(await send2(d3, [{ userId: buyer.userId, roleLabel: "Buyer" }]))).request.id as string;
      as(buyer);
      await doc.GET(get(), ctx(d3));
      await t.db.query("UPDATE signature_request SET expires_at = now() - interval '1 minute' WHERE id = $1", [r3]);
      expect((await sigRequest.POST(post({ action: "sign", typedName: "Ben Buyer", ...consent }), ctx(r3))).status).toBe(409);
      expect((await json(await doc.GET(get(), ctx(d3)))).requests[0].status).toBe("expired");
      const types = (await json(await docHistory.GET(get(), ctx(d3)))).events.map((e: any) => e.type);
      expect(types).toContain("expired");
    });
  });

  describe("uploaded document history", () => {
    it("shows versions and downloads to the owner, and 404 to people who cannot open the file", async () => {
      const prop = String((await t.db.query("INSERT INTO property (address_text, state) VALUES ('12 River Rd','QLD') RETURNING id")).rows[0]!["id"]);
      await t.db.query("UPDATE property_listing SET property_id = $1 WHERE id = $2", [prop, listingId]);
      const ins = async (supersedes: string | null) => String((await t.db.query(
        `INSERT INTO property_document (property_id, listing_id, kind, storage_key, sha256, uploaded_by, source, declared_mime, size_bytes, visibility, status, supersedes_id)
         VALUES ($1,$2,'building_inspection',$3,repeat('a',64),$4,'owner_supplied','application/pdf',10,'owner_only','active',$5) RETURNING id`,
        [prop, listingId, `k-${randomUUID()}`, owner.userId, supersedes])).rows[0]!["id"]);
      const v1 = await ins(null);
      await t.db.query("UPDATE property_document SET status = 'superseded' WHERE id = $1", [v1]);
      const v2 = await ins(v1);
      await t.db.query("INSERT INTO audit_event (actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id) VALUES ('user',$1,'document',$2,'document.downloaded','c')", [owner.userId, v2]);
      as(owner);
      const h = await json(await uploadedHistory.GET(get(), ctx(v2)));
      expect(h.entries.map((e: any) => e.type)).toEqual(["uploaded", "version_created", "downloaded"]);
      as(buyer);
      expect((await uploadedHistory.GET(get(), ctx(v2))).status).toBe(404);
      as(null);
      expect((await uploadedHistory.GET(get(), ctx(v2))).status).toBe(404);
      expect((await uploadedHistory.GET(get(), ctx("nope"))).status).toBe(404);
    });
  });

  describe("the assistant", () => {
    beforeAll(async () => {
      // Inspections come from the inspections module; seed one finished report in its tables and share it with one buyer.
      const insp = String((await t.db.query(
        `INSERT INTO inspection (listing_id, requested_by, inspector_user_id, inspection_type, scheduled_at, status, completed_at)
         VALUES ($1,$2,$3,'building', now() - interval '2 days', 'completed', now() - interval '1 day') RETURNING id`, [listingId, owner.userId, inspector.userId])).rows[0]!["id"]);
      for (const [sev, area, title] of [["critical", "Wiring", "Exposed live wires in the roof space"], ["minor", "Door", "Back door sticks"]] as const)
        await t.db.query("INSERT INTO inspection_finding (inspection_id, area, title, severity, followup_status, created_by) VALUES ($1,$2,$3,$4,'open',$5)", [insp, area, title, sev, inspector.userId]);
      await t.db.query("INSERT INTO inspection_share (inspection_id, shared_with_user_id, shared_by) VALUES ($1,$2,$3)", [insp, buyer.userId, owner.userId]);
    });
    it("gives the owner an overview and answers from the right desk", async () => {
      const o = await json(await assistant.GET(get(), ctx(listingId)));
      expect(o.persona.name).toBe("Elena");
      expect(o.stage).toBe("marketing");
      expect(o.requirements.some((r: any) => r.key === "building_inspection")).toBe(true);
      expect(o.findings.total).toBeGreaterThanOrEqual(2);
      expect(o.insights.completenessPct).toBeGreaterThanOrEqual(0);
      const a = await json(await assistant.POST(post({ question: "Summarise the inspection findings" }), ctx(listingId)));
      expect(a.answer.deskLabel).toBe("Inspection desk");
      expect(a.answer.text).toContain("URGENT · Wiring");
      expect((await json(await assistant.POST(post({ question: "What documents are missing?" }), ctx(listingId)))).answer.desk).toBe("documents");
      expect((await json(await assistant.POST(post({ question: "Should I sign this?" }), ctx(listingId)))).answer.topic).toBe("advice");
      expect((await assistant.POST(post({ question: "" }), ctx(listingId))).status).toBe(400);
      expect((await assistant.POST(post({ question: "x".repeat(301) }), ctx(listingId))).status).toBe(400);
    });
    it("shows a buyer only an inspection shared with them and no owner-only document status", async () => {
      as(buyer2);
      expect((await json(await assistant.GET(get(), ctx(listingId)))).findings.total).toBe(0);
      as(buyer);
      expect((await json(await assistant.GET(get(), ctx(listingId)))).findings.total).toBeGreaterThanOrEqual(2);
    });
    it("gives the AI summary only from a self-hosted engine and checks its text", async () => {
      expect((await json(await assistant.POST(post({ aiSummary: true }), ctx(listingId)))).ai.state).toBe("unavailable");
      state.engine = { ...rulesOnlyEngine, info: () => ({ id: "t", kind: "self_hosted", version: "1" }), generate: async () => "Exposed wiring in the roof space is the most serious item. A back door sticks." };
      expect((await json(await assistant.POST(post({ aiSummary: true }), ctx(listingId)))).ai.state).toBe("ready");
      state.engine = { ...rulesOnlyEngine, info: () => ({ id: "t", kind: "self_hosted", version: "1" }), generate: async () => "You should not buy it. Call 0412 345 678." };
      expect((await json(await assistant.POST(post({ aiSummary: true }), ctx(listingId)))).ai.state).toBe("unavailable");
      state.engine = rulesOnlyEngine;
    });
  });
});

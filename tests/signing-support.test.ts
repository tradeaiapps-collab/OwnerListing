import { beforeEach, describe, expect, it, vi } from "vitest";
import { STARTER_TEMPLATES } from "../src/config/document-templates";
import { validateTemplateContent } from "../src/domain/doc-templates";
import type { Actor } from "../src/domain/listing-service";
import { createInMemorySigningRepository, generateDocument, sendDocument, type SigningRepository } from "../src/domain/signing-service";

const state = vi.hoisted(() => ({ staff: null as { id: string; role: string } | null, repo: null as SigningRepository | null, audit: [] as { eventType: string; payload: unknown; actorId: string }[] }));
vi.mock("../src/server/context", () => ({ getStaff: () => state.staff, getDb: () => ({}) }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_db: unknown, e: { eventType: string; payload: unknown; actorId: string }) => { state.audit.push(e); } }));
vi.mock("../src/server/signing-db", () => ({ getSigningRepo: () => state.repo }));
import * as route from "../app/api/staff/signing-documents/[id]/route";

const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const LISTING = "55555555-5555-4555-8555-555555555555";
const tpl = STARTER_TEMPLATES.find(s => s.key === "inspection_access")!;
const content = validateTemplateContent(tpl.content);
const ids = { newId: (() => { let n = 0; return () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`; })(), now: () => "2026-11-05T00:00:00.000Z" };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (reason = "dispute-support") => new Request(`http://test/x?reason=${reason}`);
let sentId = "", draftId = "";

describe("staff support view of a signing document", () => {
  beforeEach(async () => {
    if (!content.ok) throw new Error("template");
    state.audit = []; state.staff = { id: "st-1", role: "support" };
    state.repo = createInMemorySigningRepository({
      listings: [{ id: LISTING, ownerUserId: owner.userId, ownerName: "Olive Owner", title: "House", address: "1 Test St", jurisdiction: "QLD" }],
      accounts: [{ id: "33333333-3333-4333-8333-333333333333", email: "amy@agency.test", displayName: "Amy Agent", status: "active" }],
      templates: [{ templateId: "t", key: tpl.key, title: tpl.title, category: "agreement", versionId: "v", version: 1, content: content.value }]
    });
    const body = { templateKey: tpl.key, values: { inspection_date: "2026-12-02" }, signers: [{ email: "amy@agency.test", roleLabel: "Visitor" }] };
    const a = await generateDocument(state.repo, owner, LISTING, body, ids); const b = await generateDocument(state.repo, owner, LISTING, body, ids);
    if (!a.ok || !b.ok) throw new Error("gen");
    sentId = a.value.id; draftId = b.value.id;
    await sendDocument(state.repo, owner, sentId, ids);
  });

  it("returns a sent document and writes the reason to the platform audit log", async () => {
    const r = await route.GET(get(), ctx(sentId));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { document: { id: string } }).document.id).toBe(sentId);
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]).toMatchObject({ eventType: "staff.signing_document_viewed", actorId: "st-1", payload: { viewReason: "dispute-support" } });
  });

  it("refuses without a session, without the permission, or without the reason, and logs nothing", async () => {
    state.staff = null;
    expect((await route.GET(get(), ctx(sentId))).status).toBe(401);
    state.staff = { id: "st-2", role: "technical" };
    expect((await route.GET(get(), ctx(sentId))).status).toBe(403);
    state.staff = { id: "st-1", role: "support" };
    expect((await route.GET(get("curiosity"), ctx(sentId))).status).toBe(400);
    expect((await route.GET(new Request("http://test/x"), ctx(sentId))).status).toBe(400);
    expect(state.audit).toHaveLength(0);
  });

  it("answers 404 for a draft or an unknown document, and logs nothing", async () => {
    expect((await route.GET(get(), ctx(draftId))).status).toBe(404);
    expect((await route.GET(get(), ctx("not-a-uuid"))).status).toBe(404);
    expect(state.audit).toHaveLength(0);
  });
});

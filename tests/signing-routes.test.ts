import { beforeEach, describe, expect, it, vi } from "vitest";
import { STARTER_TEMPLATES } from "../src/config/document-templates";
import { validateTemplateContent } from "../src/domain/doc-templates";
import type { Actor } from "../src/domain/listing-service";
import { createInMemorySigningRepository, type SigningRepository } from "../src/domain/signing-service";

const state = vi.hoisted(() => ({ actor: null as Actor | null, repo: null as SigningRepository | null, allowed: true }));
vi.mock("../src/server/context", () => ({ getActor: () => state.actor, getDb: () => ({}), getStaff: () => null }));
vi.mock("../src/server/signing-db", () => {
  let n = 0;
  return {
    getSigningRepo: () => state.repo,
    signingIds: { newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`, now: () => "2026-11-05T00:00:00.000Z" },
    requestContext: () => ({ ip: "203.0.113.1", userAgent: "test" }),
    signingPersona: async () => ({ id: "elena", name: "Elena", icon: "/i.png", portrait: "/p.jpg", poses: {} })
  };
});

vi.mock("../src/server/rate-guard", () => ({ withinRates: async () => state.allowed }));
import * as templatesRoute from "../app/api/doc-templates/route";
import * as listingRoute from "../app/api/listings/[id]/signing-documents/route";
import * as mineRoute from "../app/api/signing-documents/route";
import * as docRoute from "../app/api/signing-documents/[id]/route";
import * as pdfRoute from "../app/api/signing-documents/[id]/pdf/route";
import * as staffRoute from "../app/api/staff/doc-templates/route";
process.env["APP_URL"] = "http://test";

const LISTING = "55555555-5555-4555-8555-555555555555";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const agent: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "agent" };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown, origin = "http://test") => new Request("http://test/x", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
const tpl = STARTER_TEMPLATES.find(s => s.key === "inspection_access")!;
const content = validateTemplateContent(tpl.content);

describe("signing routes", () => {
  beforeEach(() => {
    if (!content.ok) throw new Error("template");
    state.repo = createInMemorySigningRepository({
      listings: [{ id: LISTING, ownerUserId: owner.userId, ownerName: "Olive Owner", title: "House", address: "1 Test St", jurisdiction: "QLD" }],
      accounts: [{ id: agent.userId, email: "amy@agency.test", displayName: "Amy Agent", status: "active" }],
      templates: [{ templateId: "t", key: tpl.key, title: tpl.title, category: "agreement", versionId: "v", version: 1, content: content.value }]
    });
    state.actor = owner;
  });

  it("returns 401 for every route when signed out and 403 or 404 for staff without a session", async () => {
    state.actor = null;
    expect((await templatesRoute.GET(new Request("http://test/x"))).status).toBe(401);
    expect((await listingRoute.GET(new Request("http://test/x"), ctx(LISTING))).status).toBe(401);
    expect((await listingRoute.POST(post({}), ctx(LISTING))).status).toBe(401);
    expect((await mineRoute.GET(new Request("http://test/x"))).status).toBe(401);
    expect((await docRoute.GET(new Request("http://test/x"), ctx("x"))).status).toBe(401);
    expect((await docRoute.POST(post({ action: "send" }), ctx("x"))).status).toBe(401);
    expect((await staffRoute.GET(new Request("http://test/x"))).status).toBe(401);
  });

  it("rejects a cross-site POST before anything else", async () => {
    expect((await listingRoute.POST(post({}, "http://evil.test"), ctx(LISTING))).status).toBe(403);
    expect((await docRoute.POST(post({ action: "sign" }, "http://evil.test"), ctx("x"))).status).toBe(403);
  });

  it("walks generate, send, view with the persona, sign and complete over HTTP", async () => {
    expect(((await (await templatesRoute.GET(new Request("http://test/x"))).json()) as { templates: unknown[] }).templates).toHaveLength(1);
    const gen = await listingRoute.POST(post({ templateKey: tpl.key, values: { inspection_date: "2026-12-02" }, signers: [{ email: "amy@agency.test", roleLabel: "Visitor" }] }), ctx(LISTING));
    expect(gen.status).toBe(200);
    expect(await gen.json()).toMatchObject({ status: "received" });
    const listed = (await (await listingRoute.GET(new Request("http://test/x"), ctx(LISTING))).json()) as { documents: { id: string; status: string }[] };
    const document = listed.documents[0]!;
    expect(document.status).toBe("draft");
    expect((await listingRoute.GET(new Request("http://test/x"), ctx(LISTING))).status).toBe(200);

    state.actor = agent;
    expect((await docRoute.GET(new Request("http://test/x"), ctx(document.id))).status).toBe(404);
    state.actor = owner;
    expect((await docRoute.POST(post({ action: "send" }), ctx(document.id))).status).toBe(200);
    expect((await docRoute.POST(post({ action: "bogus" }), ctx(document.id))).status).toBe(400);

    state.actor = agent;
    const view = await docRoute.GET(new Request("http://test/x"), ctx(document.id));
    const body = (await view.json()) as { persona: { name: string }; viewer: { canSign: boolean } };
    expect(body.persona.name).toBe("Elena");
    expect(body.viewer.canSign).toBe(true);
    expect((await docRoute.POST(post({ action: "explain", clauseId: "risk" }), ctx(document.id))).status).toBe(200);
    expect((await docRoute.POST(post({ action: "sign", typedName: "Wrong Name", consent: true }), ctx(document.id))).status).toBe(400);
    const signed = await docRoute.POST(post({ action: "sign", typedName: "Amy Agent", consent: true }), ctx(document.id));
    expect(signed.status).toBe(200);
    expect(((await signed.json()) as { document: { status: string } }).document.status).toBe("completed");
    expect((await docRoute.POST(post({ action: "sign", typedName: "Amy Agent", consent: true }), ctx(document.id))).status).toBe(409);
    expect(((await (await mineRoute.GET(new Request("http://test/x"))).json()) as { documents: unknown[] }).documents).toHaveLength(1);

    // The signed copy: both parties get a PDF with the seal; a stranger gets 404.
    const pdf = await pdfRoute.GET(new Request("http://test/x"), ctx(document.id));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("cache-control")).toBe("private, no-store");
    const text = Buffer.from(await pdf.arrayBuffer()).toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("amy@agency.test");
    expect(text).toContain("Seal SHA-256");
    state.actor = owner;
    expect((await pdfRoute.GET(new Request("http://test/x"), ctx(document.id))).status).toBe(200);
    state.actor = { userId: "44444444-4444-4444-8444-444444444444", userType: "owner" };
    expect((await pdfRoute.GET(new Request("http://test/x"), ctx(document.id))).status).toBe(404);
  });

  it("gives no signed copy before everyone has signed", async () => {
    await listingRoute.POST(post({ templateKey: tpl.key, values: { inspection_date: "2026-12-02" }, signers: [{ email: "amy@agency.test", roleLabel: "Visitor" }] }), ctx(LISTING));
    const id = ((await (await listingRoute.GET(new Request("http://test/x"), ctx(LISTING))).json()) as { documents: { id: string }[] }).documents[0]!.id;
    expect((await pdfRoute.GET(new Request("http://test/x"), ctx(id))).status).toBe(409);
  });

  it("answers the same whether or not a signer address has an account, and limits attempts", async () => {
    const known = await listingRoute.POST(post({ templateKey: tpl.key, values: { inspection_date: "2026-12-02" }, signers: [{ email: "amy@agency.test", roleLabel: "Visitor" }] }), ctx(LISTING));
    const unknown = await listingRoute.POST(post({ templateKey: tpl.key, values: { inspection_date: "2026-12-02" }, signers: [{ email: "ghost@nowhere.test", roleLabel: "Visitor" }] }), ctx(LISTING));
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual(await known.json());
    const listed = (await (await listingRoute.GET(new Request("http://test/x"), ctx(LISTING))).json()) as { documents: unknown[] };
    expect(listed.documents).toHaveLength(1);
    state.allowed = false;
    expect((await listingRoute.POST(post({}), ctx(LISTING))).status).toBe(429);
    expect((await docRoute.POST(post({ action: "sign", typedName: "x", consent: true }), ctx(LISTING))).status).toBe(429);
    state.allowed = true;
  });
});

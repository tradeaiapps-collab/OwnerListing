import { beforeEach, describe, expect, it, vi } from "vitest";
import { STARTER_TEMPLATES } from "../src/config/document-templates";
import { validateTemplateContent } from "../src/domain/doc-templates";
import type { Actor } from "../src/domain/listing-service";
import { createInMemorySigningRepository, type SigningRepository } from "../src/domain/signing-service";

const state = vi.hoisted(() => ({ actor: null as Actor | null, repo: null as SigningRepository | null }));
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

import * as templatesRoute from "../app/api/doc-templates/route";
import * as listingRoute from "../app/api/listings/[id]/signing-documents/route";
import * as mineRoute from "../app/api/signing-documents/route";
import * as docRoute from "../app/api/signing-documents/[id]/route";
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
    expect(gen.status).toBe(201);
    const { document } = (await gen.json()) as { document: { id: string; status: string } };
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
  });
});

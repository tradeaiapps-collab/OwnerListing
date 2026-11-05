import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeEsign, type FakeEsign } from "../src/adapters/docusign";
import { STARTER_TEMPLATES } from "../src/config/document-templates";
import { validateTemplateContent } from "../src/domain/doc-templates";
import type { Actor } from "../src/domain/listing-service";
import { createInMemorySigningRepository, type SigningRepository } from "../src/domain/signing-service";

const state = vi.hoisted(() => ({ actor: null as Actor | null, repo: null as SigningRepository | null, files: new Map<string, Uint8Array>(), mfaAt: undefined as number | undefined }));
vi.mock("../src/server/context", () => ({
  getActor: () => state.actor, getDb: () => ({}), getStaff: () => null,
  getUploadPorts: () => ({ storage: { configured: true, put: async (k: string, b: Uint8Array) => { state.files.set(k, b); }, get: async (k: string) => { const b = state.files.get(k); if (!b) throw new Error("gone"); return b; } } })
}));
vi.mock("../src/server/mfa-context", async () => {
  const real = await vi.importActual<typeof import("../src/server/mfa-context")>("../src/server/mfa-context");
  return { ...real, recentMfaAt: async () => state.mfaAt };
});
vi.mock("../src/server/rate-guard", () => ({ withinRates: async () => true }));
vi.mock("../src/server/signing-db", () => {
  let n = 0;
  return {
    getSigningRepo: () => state.repo,
    signingIds: { newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`, now: () => "2026-11-05T00:00:00.000Z" },
    requestContext: () => ({ ip: "203.0.113.1", userAgent: "test" }),
    signingPersona: async () => ({ id: "elena", name: "Elena", icon: "/i.png", portrait: "/p.jpg", poses: {} })
  };
});

import * as listingRoute from "../app/api/listings/[id]/signing-documents/route";
import * as docRoute from "../app/api/signing-documents/[id]/route";
import * as fileRoute from "../app/api/signing-documents/[id]/files/[kind]/route";
import * as hook from "../app/api/webhooks/docusign/route";
import { setEsignOverride } from "../src/server/esign";

const LISTING = "55555555-5555-4555-8555-555555555555";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const agent: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "agent" };
const other: Actor = { userId: "44444444-4444-4444-8444-444444444444", userType: "buyer" };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const fctx = (id: string, kind: string) => ({ params: Promise.resolve({ id, kind }) });
const post = (body: unknown) => new Request("http://test/x", { method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(body) });
const tpl = STARTER_TEMPLATES.find(s => s.key === "inspection_access")!;
const content = validateTemplateContent(tpl.content);
const KEY = "k".repeat(32);
const hookReq = (payload: unknown, key = KEY) => {
  const raw = JSON.stringify(payload);
  return new Request("http://test/api/webhooks/docusign", { method: "POST", headers: { "content-type": "application/json", "x-docusign-signature-1": createHmac("sha256", key).update(raw).digest("base64") }, body: raw });
};

describe("DocuSign routes", () => {
  let fake: FakeEsign;
  beforeEach(() => {
    if (!content.ok) throw new Error("template");
    process.env["APP_URL"] = "http://test";
    process.env["SIGNING_PROVIDER"] = "docusign";
    process.env["DOCUSIGN_CONNECT_HMAC_KEY"] = KEY;
    state.files.clear();
    state.mfaAt = Math.floor(Date.now() / 1000);
    state.repo = createInMemorySigningRepository({
      listings: [{ id: LISTING, ownerUserId: owner.userId, ownerName: "Olive Owner", title: "House", address: "1 Test St", jurisdiction: "QLD" }],
      accounts: [{ id: agent.userId, email: "amy@agency.test", displayName: "Amy Agent", status: "active" }, { id: other.userId, email: "x@x.test", displayName: "Xavier", status: "active" }],
      templates: [{ templateId: "t", key: tpl.key, title: tpl.title, category: "agreement", versionId: "v", version: 1, content: content.value }]
    });
    fake = createFakeEsign();
    setEsignOverride({ repo: state.repo, esign: fake, storage: { configured: true, put: async (k, b) => { state.files.set(k, b); } }, ids: { newId: () => crypto.randomUUID(), now: () => "2026-11-05T00:00:00.000Z" }, appUrl: "https://ol.test" });
    state.actor = owner;
  });

  // Generating answers the same "received" message whatever the signers (no account disclosure), so the new draft is found in the list.
  const listedIds = async () => ((await (await listingRoute.GET(new Request("http://test/x"), ctx(LISTING))).json()) as { documents: { id: string }[] }).documents.map(d => d.id);
  const generateWith = async (body: unknown) => {
    const before = new Set(await listedIds());
    const r = await listingRoute.POST(post(body), ctx(LISTING));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "received" });
    const id = (await listedIds()).find(x => !before.has(x))!;
    return (await state.repo!.document(id))!;
  };
  const generate = () => generateWith({ templateKey: tpl.key, values: { inspection_date: "2026-12-02" }, signers: [{ email: "amy@agency.test", roleLabel: "Inspector" }] });

  it("new documents use DocuSign when selected, are refused when it is selected but not set up, and use built-in otherwise", async () => {
    expect((await generate()).provider).toBe("docusign");
    setEsignOverride(null);
    const body = { templateKey: tpl.key, values: { inspection_date: "2026-12-02" }, signers: [{ email: "amy@agency.test", roleLabel: "Inspector" }] };
    expect((await listingRoute.POST(post(body), ctx(LISTING))).status).toBe(503);
    process.env["SIGNING_PROVIDER"] = "builtin";
    expect((await generateWith(body)).provider).toBe("builtin");
  });

  it("send, signing link, webhook completion and signed-copy download work end to end, with access limited to the parties", async () => {
    const d = await generate();
    expect((await docRoute.POST(post({ action: "send" }), ctx(d.id))).status).toBe(200);
    const envelopeId = [...fake.envelopes.keys()][0]!;

    state.actor = agent;
    state.mfaAt = undefined;
    const stale = await docRoute.POST(post({ action: "docusign_link" }), ctx(d.id));
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { code: string }).code).toBe("mfa_required");
    state.mfaAt = Math.floor(Date.now() / 1000);
    const link = await docRoute.POST(post({ action: "docusign_link" }), ctx(d.id));
    expect(link.status).toBe(200);
    expect(((await link.json()) as { url: string }).url).toContain("docusign.net");
    state.actor = other;
    expect((await docRoute.POST(post({ action: "docusign_link" }), ctx(d.id))).status).toBe(404);
    expect((await docRoute.POST(post({ action: "sign", typedName: "Amy Agent", consent: true }), ctx(d.id))).status).toBe(404);

    const done = await hook.POST(hookReq({ event: "envelope-completed", data: { envelopeId, envelopeSummary: { status: "completed", recipients: { signers: [{ recipientId: "1", status: "completed" }] } } } }));
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ ok: true, status: "completed" });

    state.actor = agent;
    const view = (await (await docRoute.GET(new Request("http://test/x"), ctx(d.id))).json()) as { document: { status: string }; artifacts: { kind: string }[] };
    expect(view.document.status).toBe("completed");
    expect(view.artifacts.map(a => a.kind).sort()).toEqual(["certificate", "signed_pdf"]);
    const pdf = await fileRoute.GET(new Request("http://test/x"), fctx(d.id, "signed_pdf"));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe('attachment; filename="signed-document.pdf"');
    expect(pdf.headers.get("cache-control")).toBe("no-store");
    expect(String.fromCharCode(...new Uint8Array(await pdf.arrayBuffer()).slice(0, 4))).toBe("%PDF");
    state.actor = owner;
    expect((await fileRoute.GET(new Request("http://test/x"), fctx(d.id, "certificate"))).status).toBe(200);
    expect((await fileRoute.GET(new Request("http://test/x"), fctx(d.id, "other"))).status).toBe(404);
    state.actor = other;
    expect((await fileRoute.GET(new Request("http://test/x"), fctx(d.id, "signed_pdf"))).status).toBe(404);
    state.actor = null;
    expect((await fileRoute.GET(new Request("http://test/x"), fctx(d.id, "signed_pdf"))).status).toBe(401);
  });

  it("webhook: needs the key, a valid signature, and returns 404 for unknown envelopes so DocuSign retries", async () => {
    const ev = { event: "envelope-completed", data: { envelopeId: "unknown-envelope", envelopeSummary: { status: "completed" } } };
    expect((await hook.POST(hookReq(ev, "wrong".repeat(8)))).status).toBe(401);
    expect((await hook.POST(new Request("http://test/x", { method: "POST", body: JSON.stringify(ev) }))).status).toBe(401);
    expect((await hook.POST(hookReq(ev))).status).toBe(404);
    const noise = await hook.POST(hookReq({ event: "template-created", data: {} }));
    expect(noise.status).toBe(200);
    delete process.env["DOCUSIGN_CONNECT_HMAC_KEY"];
    expect((await hook.POST(hookReq(ev))).status).toBe(503);
  });

  it("webhook asks DocuSign to retry (503) while the signed copy cannot be downloaded", async () => {
    const d = await generate();
    await docRoute.POST(post({ action: "send" }), ctx(d.id));
    const envelopeId = [...fake.envelopes.keys()][0]!;
    fake.failNext("download");
    const ev = { event: "envelope-completed", data: { envelopeId, envelopeSummary: { status: "completed" } } };
    expect((await hook.POST(hookReq(ev))).status).toBe(503);
    expect((await hook.POST(hookReq(ev))).status).toBe(200);
  });

  it("decline over webhook then retry from the owner creates a new draft", async () => {
    const d = await generate();
    await docRoute.POST(post({ action: "send" }), ctx(d.id));
    const envelopeId = [...fake.envelopes.keys()][0]!;
    await hook.POST(hookReq({ event: "recipient-declined", data: { envelopeId, envelopeSummary: { status: "sent", recipients: { signers: [{ recipientId: "1", status: "declined", declinedReason: "No" }] } } } }));
    state.actor = agent;
    expect((await docRoute.POST(post({ action: "retry" }), ctx(d.id))).status).toBe(404);
    state.actor = owner;
    const r = await docRoute.POST(post({ action: "retry" }), ctx(d.id));
    expect(r.status).toBe(201);
    expect(((await r.json()) as { document: { status: string; provider: string } }).document).toMatchObject({ status: "draft", provider: "docusign" });
  });

  it("explains when DocuSign is not set up instead of failing silently", async () => {
    const d = await generate();
    setEsignOverride(null);
    expect((await docRoute.POST(post({ action: "send" }), ctx(d.id))).status).toBe(503);
    expect((await docRoute.POST(post({ action: "refresh" }), ctx(d.id))).status).toBe(503);
  });
});

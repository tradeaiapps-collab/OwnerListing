import { createHmac, generateKeyPairSync, createVerify } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createDocusignProvider, createFakeEsign, docusignConfigFromEnv, jwtAssertion, type FakeEsign } from "../src/adapters/docusign";
import { STARTER_TEMPLATES } from "../src/config/document-templates";
import { buildEnvelope, parseConnectEvent, renderDocumentHtml, verifyConnectSignature } from "../src/domain/docusign";
import { validateTemplateContent } from "../src/domain/doc-templates";
import { applyEnvelopeUpdate, cancelWithProvider, docusignSigningLink, ensureSignedCopies, refreshFromDocusign, retryDocument, sendViaDocusign, type EsignDeps } from "../src/domain/esign-service";
import type { Actor } from "../src/domain/listing-service";
import { createInMemorySigningRepository, declineDocument, generateDocument, sendDocument, signDocument, viewDocument, type SigningRepository } from "../src/domain/signing-service";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: Actor = { userId: U(1), userType: "owner" };
const agent: Actor = { userId: U(2), userType: "agent" };
const buyer: Actor = { userId: U(3), userType: "buyer" };
const stranger: Actor = { userId: U(4), userType: "owner" };
const LISTING = U(100);
let n = 1000;
const ids = { newId: () => U(++n), now: () => "2026-11-05T01:00:00.000Z" };
const starter = STARTER_TEMPLATES.find(s => s.key === "agent_appointment")!;
const valid = validateTemplateContent(starter.content);
if (!valid.ok) throw new Error("starter invalid");
const body = {
  templateKey: "agent_appointment",
  values: { agent_name: "Acme Realty", licence_number: "L-123", start_date: "2026-11-10", end_date: "2027-02-10", commission: "1.5% of the sale price" },
  signers: [{ email: "amy@agency.test", roleLabel: "Agent" }, { email: "bo@buyer.test", roleLabel: "Buyer" }]
};

describe("DocuSign pure helpers", () => {
  it("builds an embedded-signing envelope with one anchored signature box per signer and an authenticated webhook", () => {
    const signers = [{ recipientId: "1", clientUserId: "s1", name: "Amy <b>", email: "a@x.test", roleLabel: "Agent", routingOrder: 1 }];
    const html = renderDocumentHtml({ title: "T & C", listingTitle: "House", bodySha256: "a".repeat(64), clauses: [{ id: "c1", heading: "H<1>", text: "Pay $1 & more", explanation: "e" }], signers });
    expect(html).toContain("H&lt;1&gt;");
    expect(html).toContain("Amy &lt;b&gt;");
    expect(html).toContain("/ol_sign_1/");
    expect(html).not.toContain("<b>");
    const env = buildEnvelope({ subject: "s", title: "T", html, signers, webhookUrl: "https://x.test/api/webhooks/docusign" }) as Record<string, any>;
    expect(env.status).toBe("sent");
    expect(env.recipients.signers[0]).toMatchObject({ clientUserId: "s1", roleName: "Agent", tabs: { signHereTabs: [{ anchorString: "/ol_sign_1/" }] } });
    expect(env.eventNotification).toMatchObject({ url: "https://x.test/api/webhooks/docusign", includeHMAC: "true" });
    expect(buildEnvelope({ subject: "s", title: "T", html, signers }).eventNotification).toBeUndefined();
  });

  it("verifies the Connect HMAC and refuses a wrong, missing or unset key", () => {
    const raw = '{"event":"envelope-completed"}';
    const good = createHmac("sha256", "k".repeat(20)).update(raw).digest("base64");
    expect(verifyConnectSignature("k".repeat(20), raw, [null, good])).toBe(true);
    expect(verifyConnectSignature("k".repeat(20), raw + " ", [good])).toBe(false);
    expect(verifyConnectSignature("k".repeat(20), raw, [null, undefined, "AAAA"])).toBe(false);
    expect(verifyConnectSignature("", raw, [good])).toBe(false);
  });

  it("reads envelope and recipient events and ignores the rest", () => {
    const ev = (event: string, status: string, signers: unknown[]) => ({ event, data: { envelopeId: "E1", envelopeSummary: { status, recipients: { signers } } } });
    expect(parseConnectEvent(ev("envelope-completed", "completed", []))).toEqual({ envelopeId: "E1", envelope: "completed", recipients: [] });
    expect(parseConnectEvent(ev("recipient-completed", "sent", [{ recipientId: "1", status: "completed" }, { recipientId: "2", status: "sent" }])))
      .toEqual({ envelopeId: "E1", recipients: [{ recipientId: "1", state: "completed" }] });
    expect(parseConnectEvent(ev("recipient-declined", "sent", [{ recipientId: "2", status: "declined", declinedReason: " too much " }])))
      .toEqual({ envelopeId: "E1", recipients: [{ recipientId: "2", state: "declined", declinedReason: "too much" }] });
    expect(parseConnectEvent(ev("envelope-sent", "sent", []))).toEqual({ envelopeId: "E1", envelope: "sent", recipients: [] }); // harmless: changes nothing
    expect(parseConnectEvent({ event: "x" })).toBeNull();
    expect(parseConnectEvent(null)).toBeNull();
  });
});

describe("DocuSign client", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const env = {
    DOCUSIGN_INTEGRATION_KEY: "11111111-2222-4333-8444-555555555555", DOCUSIGN_USER_ID: "66666666-7777-4888-8999-000000000000",
    DOCUSIGN_ACCOUNT_ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", DOCUSIGN_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n")
  } as unknown as NodeJS.ProcessEnv;

  it("only accepts complete settings that point at DocuSign's own hosts", () => {
    expect(docusignConfigFromEnv(env)).toMatchObject({ basePath: "https://demo.docusign.net/restapi", oauthHost: "account-d.docusign.com" });
    expect(docusignConfigFromEnv({ ...env, DOCUSIGN_BASE_PATH: "https://evil.example.com/restapi" })).toBeUndefined();
    expect(docusignConfigFromEnv({ ...env, DOCUSIGN_BASE_PATH: "http://demo.docusign.net/restapi" })).toBeUndefined();
    expect(docusignConfigFromEnv({ ...env, DOCUSIGN_OAUTH_HOST: "docusign.net.evil.com" })).toBeUndefined();
    expect(docusignConfigFromEnv({ ...env, DOCUSIGN_PRIVATE_KEY: "nope" })).toBeUndefined();
    expect(docusignConfigFromEnv({ ...env, DOCUSIGN_USER_ID: "" })).toBeUndefined();
  });

  it("signs a JWT assertion that verifies with the public key", () => {
    const cfg = docusignConfigFromEnv(env)!;
    const [h, c, s] = jwtAssertion(cfg, 1_800_000_000).split(".");
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toMatchObject({ iss: cfg.integrationKey, sub: cfg.userId, aud: "account-d.docusign.com", exp: 1_800_003_600, scope: "signature impersonation" });
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
  });

  it("gets a token once, sends it as a bearer, and checks the PDF and signing-link hosts", async () => {
    const calls: { url: string; auth?: string; method?: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string> | undefined)?.["authorization"];
      calls.push({ url, ...(auth ? { auth } : {}), ...(init.method ? { method: init.method } : {}) });
      if (url.endsWith("/oauth/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
      if (url.endsWith("/views/recipient")) return Response.json({ url: "https://demo.docusign.net/Signing/abc" });
      if (url.endsWith("/documents/combined")) return new Response(new TextEncoder().encode("%PDF-1.7 " + "x".repeat(200)));
      if (url.endsWith("/documents/certificate")) return new Response("<html>not a pdf " + "x".repeat(200));
      return Response.json({ envelopeId: "ENV-12345678" });
    }) as unknown as typeof fetch;
    const p = createDocusignProvider(docusignConfigFromEnv(env)!, fetchImpl, () => 1_800_000_000_000);
    expect(await p.createEnvelope({ status: "sent" })).toEqual({ envelopeId: "ENV-12345678" });
    expect(await p.recipientView("ENV-12345678", { clientUserId: "s", name: "A", email: "a@x.test", returnUrl: "https://x.test/r" })).toBe("https://demo.docusign.net/Signing/abc");
    expect((await p.download("ENV-12345678", "combined")).length).toBeGreaterThan(100);
    await expect(p.download("ENV-12345678", "certificate")).rejects.toThrow(/not a PDF/);
    expect(calls.filter(c => c.url.endsWith("/oauth/token"))).toHaveLength(1);
    expect(calls.find(c => c.url.includes("/envelopes"))).toMatchObject({ auth: "Bearer tok", url: expect.stringContaining("/v2.1/accounts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/envelopes") });
  });

  it("refuses a signing link that points outside DocuSign and reports failures without leaking bodies", async () => {
    const mk = (res: (u: string) => Response) => createDocusignProvider(docusignConfigFromEnv(env)!, (async (u: string) => (u.endsWith("/oauth/token") ? Response.json({ access_token: "t" }) : res(u))) as unknown as typeof fetch);
    await expect(mk(() => Response.json({ url: "https://evil.example.com/x" })).recipientView("E1234567", { clientUserId: "s", name: "A", email: "a@x.test", returnUrl: "https://x.test" })).rejects.toThrow(/unexpected signing link/);
    await expect(mk(() => Response.json({ errorCode: "ANCHOR_TAB_STRING_NOT_FOUND", message: "secret detail" }, { status: 400 })).createEnvelope({})).rejects.toThrow(/400 ANCHOR_TAB_STRING_NOT_FOUND\)\.$/);
    await expect(createDocusignProvider(docusignConfigFromEnv(env)!, (async () => Response.json({ error: "consent_required" }, { status: 400 })) as unknown as typeof fetch).createEnvelope({})).rejects.toThrow(/consent_required/);
  });
});

describe("DocuSign signing flow", () => {
  let repo: SigningRepository;
  let fake: FakeEsign;
  let stored: Map<string, Uint8Array>;
  let deps: EsignDeps;
  beforeEach(() => {
    repo = createInMemorySigningRepository({
      listings: [{ id: LISTING, ownerUserId: owner.userId, ownerName: "Olive Owner", title: "Queenslander", address: "1 Test St", jurisdiction: "QLD" }],
      accounts: [
        { id: owner.userId, email: "olive@home.test", displayName: "Olive Owner", status: "active" },
        { id: agent.userId, email: "amy@agency.test", displayName: "Amy Agent", status: "active" },
        { id: buyer.userId, email: "bo@buyer.test", displayName: "Bo Buyer", status: "active" }
      ],
      templates: [{ templateId: U(50), key: "agent_appointment", title: starter.title, category: "agreement", versionId: U(51), version: 1, content: valid.value }]
    });
    fake = createFakeEsign();
    stored = new Map();
    deps = { repo, esign: fake, storage: { configured: true, put: async (k, b) => { stored.set(k, b); } }, ids, appUrl: "https://ol.test" };
  });
  const gen = async () => { const r = await generateDocument(repo, owner, LISTING, body, ids, {}, { provider: "docusign" }); if (!r.ok) throw new Error(r.message); return r.value; };
  const sent = async () => { const d = await gen(); const r = await sendViaDocusign(deps, owner, d.id); if (!r.ok) throw new Error(r.message); return (await repo.document(d.id))!; };
  const recipientOf = async (d: { id: string }, who: Actor) => (await repo.signerContacts(d.id)).find(c => c.userId === who.userId)!.recipientId!;
  const doc = async (id: string) => (await repo.document(id))!;

  it("creates the envelope with every signer, then marks the document out for signature and records the envelope", async () => {
    const d = await sent();
    expect(d).toMatchObject({ provider: "docusign", status: "out_for_signature" });
    const env = fake.envelopes.get(d.envelopeId!)!.definition as Record<string, any>;
    expect(env.recipients.signers.map((s: any) => [s.name, s.email, s.roleName])).toEqual([["Amy Agent", "amy@agency.test", "Agent"], ["Bo Buyer", "bo@buyer.test", "Buyer"]]);
    expect(env.eventNotification.url).toBe("https://ol.test/api/webhooks/docusign");
    expect(JSON.stringify(env)).toContain(d.bodySha256);
    expect((await viewDocument(repo, owner, d.id, ids) as any).value.events.map((e: any) => e.eventType)).toEqual(["created", "sent", "owner_viewed"]);
  });

  it("leaves the document a draft and records nothing when DocuSign refuses", async () => {
    const d = await gen();
    fake.failNext("createEnvelope");
    expect(await sendViaDocusign(deps, owner, d.id)).toMatchObject({ ok: false, code: "unavailable" });
    expect((await doc(d.id)).status).toBe("draft");
    expect((await doc(d.id)).envelopeId).toBeUndefined();
    expect(await sendViaDocusign(deps, owner, d.id)).toMatchObject({ ok: true });
  });

  it("only the owner sends, and only once; built-in actions are refused on a DocuSign document", async () => {
    const d = await gen();
    expect(await sendViaDocusign(deps, stranger, d.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await sendDocument(repo, owner, d.id, ids)).toMatchObject({ ok: false, code: "conflict" });
    await sendViaDocusign(deps, owner, d.id);
    expect(await sendViaDocusign(deps, owner, d.id)).toMatchObject({ ok: false, code: "conflict" });
    expect(await signDocument(repo, agent, d.id, { typedName: "Amy Agent", consent: true }, ids)).toMatchObject({ ok: false, code: "conflict" });
    expect(await declineDocument(repo, agent, d.id, {}, ids)).toMatchObject({ ok: false, code: "conflict" });
    expect(fake.envelopes.size).toBe(1);
  });

  it("a built-in document cannot be sent through DocuSign", async () => {
    const r = await generateDocument(repo, owner, LISTING, body, ids);
    if (!r.ok) throw new Error(r.message);
    expect(await sendViaDocusign(deps, owner, r.value.id)).toMatchObject({ ok: false, code: "conflict" });
  });

  it("gives each signer their own one-time signing link, only while they are pending", async () => {
    const d = await sent();
    const link = await docusignSigningLink(deps, agent, d.id, { ip: "203.0.113.9" });
    expect(link).toEqual({ ok: true, value: { url: expect.stringContaining("docusign.net") } });
    expect(fake.views[0]).toMatchObject({ envelopeId: d.envelopeId, returnUrl: `https://ol.test/signing/${d.id}?docusign=return` });
    expect(fake.views[0]!.clientUserId).toBe((await repo.signerContacts(d.id)).find(c => c.userId === agent.userId)!.signerId);
    await docusignSigningLink(deps, agent, d.id);
    expect((await repo.events(d.id)).filter(e => e.eventType === "viewed")).toHaveLength(1);
    expect(await docusignSigningLink(deps, owner, d.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await docusignSigningLink(deps, stranger, d.id)).toMatchObject({ ok: false, code: "not_found" });
    fake.failNext("recipientView");
    expect(await docusignSigningLink(deps, buyer, d.id)).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("records each signature from webhooks, then stores the signed PDF and certificate once when DocuSign completes", async () => {
    const d = await sent();
    const a = await recipientOf(d, agent), b = await recipientOf(d, buyer);
    expect(await applyEnvelopeUpdate(deps, { envelopeId: d.envelopeId!, recipients: [{ recipientId: a, state: "delivered" }] })).toMatchObject({ ok: true });
    await applyEnvelopeUpdate(deps, { envelopeId: d.envelopeId!, recipients: [{ recipientId: a, state: "completed" }] });
    expect((await doc(d.id)).status).toBe("out_for_signature");
    expect((await doc(d.id)).signers.map(s => s.status)).toEqual(["signed", "pending"]);
    const done = await applyEnvelopeUpdate(deps, { envelopeId: d.envelopeId!, envelope: "completed", recipients: [{ recipientId: a, state: "completed" }, { recipientId: b, state: "completed" }] });
    expect(done).toMatchObject({ ok: true, value: { status: "completed" } });
    expect((await doc(d.id)).signers.every(s => s.status === "signed" && s.typedName)).toBe(true);
    const arts = await repo.artifacts(d.id);
    expect(arts.map(x => x.kind).sort()).toEqual(["certificate", "signed_pdf"]);
    expect(stored.size).toBe(2);
    expect([...stored.keys()].every(k => /^signing\/[0-9a-f-]{36}\/[A-Za-z0-9_-]+$/.test(k))).toBe(true);
    expect(arts[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Same event again: nothing duplicates.
    await applyEnvelopeUpdate(deps, { envelopeId: d.envelopeId!, envelope: "completed", recipients: [] });
    expect(stored.size).toBe(2);
    const types = (await repo.events(d.id)).map(e => e.eventType);
    expect(types.filter(t => t === "completed" || t === "stored")).toEqual(["completed", "stored"]);
    expect(types.filter(t => t === "signed")).toHaveLength(2);
  });

  it("keeps the document completed and retries the copy later when storage or the download fails", async () => {
    const d = await sent();
    const upd = { envelopeId: d.envelopeId!, envelope: "completed" as const, recipients: [] };
    fake.failNext("download");
    expect(await applyEnvelopeUpdate(deps, upd)).toMatchObject({ ok: false, code: "unavailable" });
    expect((await doc(d.id)).status).toBe("completed");
    expect(await repo.artifacts(d.id)).toHaveLength(0);
    deps.storage = { configured: false, put: async () => undefined };
    expect(await applyEnvelopeUpdate(deps, upd)).toMatchObject({ ok: false, code: "unavailable" });
    deps.storage = { configured: true, put: async (k, b) => { stored.set(k, b); } };
    expect(await applyEnvelopeUpdate(deps, upd)).toMatchObject({ ok: true });
    expect(await repo.artifacts(d.id)).toHaveLength(2);
    expect(await ensureSignedCopies(deps, await doc(d.id))).toMatchObject({ ok: true });
    expect(stored.size).toBe(2);
  });

  it("closes the document when a signer declines, keeping the reason, and ignores later events", async () => {
    const d = await sent();
    const a = await recipientOf(d, agent), b = await recipientOf(d, buyer);
    await applyEnvelopeUpdate(deps, { envelopeId: d.envelopeId!, recipients: [{ recipientId: b, state: "declined", declinedReason: "Wrong price" }] });
    const after = await doc(d.id);
    expect(after.status).toBe("declined");
    expect(after.signers.map(s => s.status)).toEqual(["pending", "declined"]);
    const ev = (await repo.events(d.id)).find(e => e.eventType === "declined")!;
    expect(ev.detail).toMatchObject({ source: "docusign", reason: "Wrong price" });
    await applyEnvelopeUpdate(deps, { envelopeId: d.envelopeId!, envelope: "completed", recipients: [{ recipientId: a, state: "completed" }] });
    expect((await doc(d.id)).status).toBe("declined");
    expect(await repo.artifacts(d.id)).toHaveLength(0);
  });

  it("handles envelope-level decline and void, and unknown envelopes", async () => {
    const d1 = await sent(), d2 = await sent();
    await applyEnvelopeUpdate(deps, { envelopeId: d1.envelopeId!, envelope: "declined", recipients: [] });
    await applyEnvelopeUpdate(deps, { envelopeId: d2.envelopeId!, envelope: "voided", recipients: [] });
    expect((await doc(d1.id)).status).toBe("declined");
    expect((await doc(d2.id)).status).toBe("cancelled");
    expect(await applyEnvelopeUpdate(deps, { envelopeId: "nope-nope-nope", recipients: [] })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("cancelling voids the envelope first; if DocuSign cannot be reached the document stays open", async () => {
    const d = await sent();
    fake.failNext("voidEnvelope");
    expect(await cancelWithProvider(deps, repo, owner, d.id, ids)).toMatchObject({ ok: false, code: "unavailable" });
    expect((await doc(d.id)).status).toBe("out_for_signature");
    expect(await cancelWithProvider(deps, repo, owner, d.id, ids)).toMatchObject({ ok: true, value: { status: "cancelled" } });
    expect(fake.envelopes.get(d.envelopeId!)).toMatchObject({ status: "voided", voided: "Cancelled by the owner" });
    expect(await cancelWithProvider(undefined, repo, stranger, d.id, ids)).toMatchObject({ ok: false });
  });

  it("refresh pulls the latest status from DocuSign for the owner or a signer only", async () => {
    const d = await sent();
    fake.envelopes.get(d.envelopeId!)!.status = "voided";
    expect(await refreshFromDocusign(deps, stranger, d.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await refreshFromDocusign(deps, buyer, d.id)).toMatchObject({ ok: true, value: { status: "cancelled" } });
  });

  it("retry makes a new draft with the same frozen text, hash and signers, and only for the owner of a closed document", async () => {
    const d = await sent();
    expect(await retryDocument(repo, owner, d.id, ids, "docusign")).toMatchObject({ ok: false, code: "conflict" });
    await applyEnvelopeUpdate(deps, { envelopeId: d.envelopeId!, recipients: [{ recipientId: await recipientOf(d, buyer), state: "declined" }] });
    expect(await retryDocument(repo, stranger, d.id, ids, "docusign")).toMatchObject({ ok: false, code: "not_found" });
    const r = await retryDocument(repo, owner, d.id, ids, "docusign");
    if (!r.ok) throw new Error(r.message);
    expect(r.value).toMatchObject({ status: "draft", provider: "docusign", retryOf: d.id, bodySha256: d.bodySha256, title: d.title });
    expect(r.value.clauses).toEqual(d.clauses);
    expect(r.value.signers.map(s => [s.userId, s.roleLabel, s.status])).toEqual(d.signers.map(s => [s.userId, s.roleLabel, "pending"]));
    expect((await repo.events(d.id)).some(e => e.eventType === "retried")).toBe(true);
    expect(await sendViaDocusign(deps, owner, r.value.id)).toMatchObject({ ok: true });
    expect(fake.envelopes.size).toBe(2);
  });
});

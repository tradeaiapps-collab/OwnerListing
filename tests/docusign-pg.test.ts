import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeEsign } from "../src/adapters/docusign";
import { applyEnvelopeUpdate, retryDocument, sendViaDocusign, type EsignDeps } from "../src/domain/esign-service";
import type { Actor } from "../src/domain/listing-service";
import { generateDocument } from "../src/domain/signing-service";
import type { StaffActor } from "../src/domain/staff-access";
import { installStarters, loadTemplates, publishVersion } from "../src/server/doc-template-db";
import { createPgSigningRepository } from "../src/server/signing-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("DocuSign signing on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });
  const ids = { newId: () => randomUUID(), now: () => new Date().toISOString() };
  const emailOf = async (id: string) => String((await t.db.query("SELECT email FROM app_user WHERE id = $1", [id])).rows[0]!["email"]);

  it("sends, records webhook signatures, keeps the signed PDF in document history, and the database protects the record", async () => {
    const author: StaffActor = { id: await addUser(t.db, "admin"), role: "compliance" }, reviewer: StaffActor = { id: await addUser(t.db, "admin"), role: "compliance" };
    await installStarters(t.db, author);
    const tpl = (await loadTemplates(t.db)).find(x => x.key === "inspection_access")!;
    if (tpl.liveVersion === null) await publishVersion(t.db, reviewer, tpl.id, tpl.latestVersion);
    const ownerId = await addUser(t.db, "owner"), inspectorId = await addUser(t.db, "agent"), buyerId = await addUser(t.db, "buyer");
    const listingId = await addListing(t.db, ownerId, { jurisdiction: "QLD", title: "Queenslander", address_text: "9 River Rd" });
    const prop = await t.db.query("INSERT INTO property (address_text, state) VALUES ('9 River Rd', 'QLD') RETURNING id");
    await t.db.query("UPDATE property_listing SET property_id = $2 WHERE id = $1", [listingId, prop.rows[0]!["id"]]);
    const owner: Actor = { userId: ownerId, userType: "owner" };
    const repo = createPgSigningRepository(t.db);
    const fake = createFakeEsign();
    const stored = new Map<string, Uint8Array>();
    const deps: EsignDeps = { repo, esign: fake, storage: { configured: true, put: async (k, b) => { stored.set(k, b); } }, ids, appUrl: "https://ol.test" };

    const g = await generateDocument(repo, owner, listingId, {
      templateKey: "inspection_access", values: { inspection_date: "2026-12-02" },
      signers: [{ email: await emailOf(inspectorId), roleLabel: "Inspector" }, { email: await emailOf(buyerId), roleLabel: "Buyer" }]
    }, ids, {}, { provider: "docusign" });
    if (!g.ok) throw new Error(g.message);
    expect(g.value).toMatchObject({ provider: "docusign", status: "draft" });

    expect(await sendViaDocusign(deps, owner, g.value.id)).toMatchObject({ ok: true, value: { status: "out_for_signature" } });
    const sent = (await repo.document(g.value.id))!;
    expect(sent.envelopeId).toBeTruthy();
    expect((await repo.documentByEnvelope(sent.envelopeId!))?.id).toBe(g.value.id);
    const contacts = await repo.signerContacts(g.value.id);
    expect(contacts.map(c => c.recipientId).sort()).toEqual(["1", "2"]);
    expect(contacts.every(c => c.email.includes("@"))).toBe(true);

    await applyEnvelopeUpdate(deps, { envelopeId: sent.envelopeId!, recipients: [{ recipientId: contacts[0]!.recipientId!, state: "completed" }] });
    expect((await repo.document(g.value.id))!.signers.filter(s => s.status === "signed")).toHaveLength(1);
    const done = await applyEnvelopeUpdate(deps, { envelopeId: sent.envelopeId!, envelope: "completed", recipients: contacts.map(c => ({ recipientId: c.recipientId!, state: "completed" as const })) });
    expect(done).toMatchObject({ ok: true, value: { status: "completed" } });
    await applyEnvelopeUpdate(deps, { envelopeId: sent.envelopeId!, envelope: "completed", recipients: [] });

    const arts = await repo.artifacts(g.value.id);
    expect(arts.map(a => a.kind).sort()).toEqual(["certificate", "signed_pdf"]);
    expect(stored.size).toBe(2);
    const key = await repo.artifactKey(g.value.id, "signed_pdf");
    expect(stored.has(key!)).toBe(true);
    const hist = await t.db.query("SELECT kind, visibility, status, storage_key, uploaded_by FROM property_document WHERE listing_id = $1", [listingId]);
    expect(hist.rows).toEqual([{ kind: "contract", visibility: "parties", status: "active", storage_key: key, uploaded_by: ownerId }]);
    expect((await repo.events(g.value.id)).map(e => e.eventType)).toEqual(["created", "sent", "signed", "signed", "completed", "stored"]);

    await expect(t.db.query("UPDATE signing_document SET provider = 'builtin' WHERE id = $1", [g.value.id])).rejects.toThrow(/provider and envelope/);
    await expect(t.db.query("UPDATE signing_document SET esign_envelope_id = 'something-else' WHERE id = $1", [g.value.id])).rejects.toThrow(/provider and envelope/);
    await expect(t.db.query("UPDATE signing_artifact SET sha256 = repeat('0', 64)")).rejects.toThrow();
    await expect(t.db.query("DELETE FROM signing_artifact")).rejects.toThrow();
    await expect(t.db.query("INSERT INTO signing_document (listing_id, template_version_id, created_by, title, rendered, field_values, body_sha256, provider) SELECT listing_id, template_version_id, created_by, title, rendered, field_values, body_sha256, 'other' FROM signing_document LIMIT 1")).rejects.toThrow();
    const dupe = await t.db.query("SELECT 1 FROM signing_signer WHERE document_id = $1", [g.value.id]);
    expect(dupe.rows).toHaveLength(2);
  });

  it("declines close the document and retry creates a linked draft; one envelope cannot belong to two documents", async () => {
    const ownerId = await addUser(t.db, "owner"), inspectorId = await addUser(t.db, "agent");
    const listingId = await addListing(t.db, ownerId, { jurisdiction: "QLD", title: "House", address_text: "1 A St" });
    const owner: Actor = { userId: ownerId, userType: "owner" };
    const repo = createPgSigningRepository(t.db);
    const deps: EsignDeps = { repo, esign: createFakeEsign(), storage: { configured: true, put: async () => undefined }, ids, appUrl: "https://ol.test" };
    const body = { templateKey: "inspection_access", values: { inspection_date: "2026-12-02" }, signers: [{ email: await emailOf(inspectorId), roleLabel: "Inspector" }] };
    const a = await generateDocument(repo, owner, listingId, body, ids, {}, { provider: "docusign" });
    const b = await generateDocument(repo, owner, listingId, body, ids, {}, { provider: "docusign" });
    if (!a.ok || !b.ok) throw new Error("generate");
    await sendViaDocusign(deps, owner, a.value.id);
    const env = (await repo.document(a.value.id))!.envelopeId!;
    await expect(repo.setEnvelope(b.value.id, env, [])).rejects.toThrow(/signing_document_envelope_idx/);

    await applyEnvelopeUpdate(deps, { envelopeId: env, recipients: [{ recipientId: "1", state: "declined", declinedReason: "Not now" }] });
    expect((await repo.document(a.value.id))!).toMatchObject({ status: "declined", signers: [{ status: "declined" }] });
    const retry = await retryDocument(repo, owner, a.value.id, ids, "docusign");
    if (!retry.ok) throw new Error(retry.message);
    expect(retry.value).toMatchObject({ status: "draft", retryOf: a.value.id, bodySha256: a.value.bodySha256, provider: "docusign" });
    expect((await repo.events(a.value.id)).map(e => e.eventType)).toContain("retried");
  });
});

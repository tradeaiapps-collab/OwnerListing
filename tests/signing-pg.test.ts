import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STARTER_TEMPLATES } from "../src/config/document-templates";
import type { Actor } from "../src/domain/listing-service";
import { cancelDocument, explainClause, generateDocument, sendDocument, signDocument, viewDocument } from "../src/domain/signing-service";
import type { StaffActor } from "../src/domain/staff-access";
import { createTemplate, installStarters, loadTemplates, publishVersion, saveVersion } from "../src/server/doc-template-db";
import { createPgSigningRepository } from "../src/server/signing-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("document templates and signing on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });
  const ids = { newId: () => randomUUID(), now: () => new Date().toISOString() };
  const staffUser = async (): Promise<StaffActor> => ({ id: await addUser(t.db, "admin"), role: "compliance" });
  const emailOf = async (id: string) => String((await t.db.query("SELECT email FROM app_user WHERE id = $1", [id])).rows[0]!["email"]);

  it("installs starters as drafts, versions without overwriting, and needs a second person to publish", async () => {
    const author = await staffUser(), reviewer = await staffUser();
    expect((await installStarters(t.db, author)).installed).toHaveLength(STARTER_TEMPLATES.length);
    expect((await installStarters(t.db, author)).installed).toHaveLength(0);
    let tpl = (await loadTemplates(t.db)).find(x => x.key === "agent_appointment")!;
    expect(tpl).toMatchObject({ liveVersion: null, latestVersion: 1 });

    const edited = structuredClone(tpl.latest);
    edited.clauses[0]!.text += " (reviewed)";
    expect(await saveVersion(t.db, author, tpl.id, 1, edited, "counsel tweak")).toEqual({ ok: true, version: 2 });
    expect(await saveVersion(t.db, reviewer, tpl.id, 1, edited, "stale")).toMatchObject({ ok: false, code: "conflict" });
    expect(await saveVersion(t.db, author, randomUUID(), 0, edited, "")).toMatchObject({ ok: false, code: "not_found" });

    expect(await publishVersion(t.db, author, tpl.id, 2)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await publishVersion(t.db, reviewer, tpl.id, 9)).toMatchObject({ ok: false, code: "not_found" });
    expect(await publishVersion(t.db, reviewer, tpl.id, 2)).toEqual({ ok: true, version: 2 });
    expect(await publishVersion(t.db, reviewer, tpl.id, 2)).toMatchObject({ ok: false, code: "conflict" });
    tpl = (await loadTemplates(t.db)).find(x => x.key === "agent_appointment")!;
    expect(tpl.liveVersion).toBe(2);
    expect(tpl.versions.find(v => v.live)?.version).toBe(2);

    expect(await createTemplate(t.db, author, { key: "agent_appointment", title: "Dup", category: "contract", content: tpl.latest })).toMatchObject({ ok: false, code: "conflict" });
    expect(await createTemplate(t.db, author, { key: "x", title: "Bad key", category: "contract", content: tpl.latest })).toMatchObject({ ok: false, code: "invalid" });
    const audit = await t.db.query("SELECT count(*) AS n FROM audit_event WHERE aggregate_type = 'doc_template' AND event_type = 'doc_template.published'");
    expect(Number(audit.rows[0]!["n"])).toBeGreaterThanOrEqual(1);
    await expect(t.db.query("UPDATE doc_template_version SET change_note = 'x'")).rejects.toThrow();
    await expect(t.db.query("DELETE FROM doc_template_publish")).rejects.toThrow();
  });

  it("generates, sends, signs and completes a document, and the database refuses to alter what was signed", async () => {
    const author = await staffUser(), reviewer = await staffUser();
    await installStarters(t.db, author).catch(() => undefined);
    const tpl = (await loadTemplates(t.db)).find(x => x.key === "inspection_access")!;
    if (tpl.liveVersion === null) await publishVersion(t.db, reviewer, tpl.id, tpl.latestVersion);

    const ownerId = await addUser(t.db, "owner"), visitorId = await addUser(t.db, "agent");
    const listingId = await addListing(t.db, ownerId, { jurisdiction: "QLD", title: "Queenslander", address_text: "9 River Rd" });
    const owner: Actor = { userId: ownerId, userType: "owner" }, visitor: Actor = { userId: visitorId, userType: "agent" };
    const repo = createPgSigningRepository(t.db);

    const g = await generateDocument(repo, owner, listingId, {
      templateKey: "inspection_access", values: { inspection_date: "2026-12-02" },
      signers: [{ email: await emailOf(visitorId), roleLabel: "Visitor" }, { email: await emailOf(ownerId), roleLabel: "Owner" }]
    }, ids, { ip: "203.0.113.9", userAgent: "UA" });
    if (!g.ok) throw new Error(g.message);
    const doc = g.value;
    expect(doc.clauses[0]!.text).toContain("9 River Rd");
    expect(doc.clauses[0]!.text).toContain("2 December 2026");
    expect(doc.status).toBe("draft");
    expect((await viewDocument(repo, visitor, doc.id, ids)).ok).toBe(false);

    expect((await sendDocument(repo, owner, doc.id, ids)).ok).toBe(true);
    const seen = await viewDocument(repo, visitor, doc.id, ids, { ip: "198.51.100.1", userAgent: "Visitor UA" });
    expect(seen.ok && seen.value.viewer.canSign).toBe(true);
    expect((await explainClause(repo, visitor, doc.id, "risk", ids)).ok).toBe(true);
    const name = "Test agent";
    expect((await signDocument(repo, visitor, doc.id, { typedName: name, consent: true }, ids, { ip: "198.51.100.1", userAgent: "Visitor UA" })).ok).toBe(true);
    expect((await signDocument(repo, visitor, doc.id, { typedName: name, consent: true }, ids)).ok).toBe(false);
    await viewDocument(repo, owner, doc.id, ids);
    const done = await signDocument(repo, owner, doc.id, { typedName: "Test owner", consent: true }, ids);
    expect(done.ok && done.value.status).toBe("completed");
    expect((await cancelDocument(repo, owner, doc.id, ids)).ok).toBe(false);

    const v = await viewDocument(repo, owner, doc.id, ids);
    if (!v.ok) throw new Error("view");
    expect(v.value.events.map(e => e.eventType)).toEqual(["created", "sent", "viewed", "explained", "signed", "viewed", "signed", "completed"]);
    const signedEvent = v.value.events.find(e => e.eventType === "signed");
    expect(signedEvent?.ip).toBe("198.51.100.1");
    const hashes = await t.db.query("SELECT DISTINCT body_sha256 FROM signing_event WHERE document_id = $1", [doc.id]);
    expect(hashes.rows.map(r => String(r["body_sha256"]).trim())).toEqual([doc.bodySha256]);

    // Permanent record: the text, a signature, the event trail and the documents themselves cannot be changed or removed.
    await expect(t.db.query("UPDATE signing_document SET rendered = '{}'::jsonb WHERE id = $1", [doc.id])).rejects.toThrow(/cannot change/);
    await expect(t.db.query("UPDATE signing_document SET status = 'draft' WHERE id = $1", [doc.id])).rejects.toThrow(/reopened/);
    await expect(t.db.query("UPDATE signing_signer SET typed_name = 'Forged' WHERE document_id = $1", [doc.id])).rejects.toThrow();
    await expect(t.db.query("DELETE FROM signing_signer WHERE document_id = $1", [doc.id])).rejects.toThrow();
    await expect(t.db.query("UPDATE signing_event SET ip = '1.1.1.1' WHERE document_id = $1", [doc.id])).rejects.toThrow();
    await expect(t.db.query("DELETE FROM signing_document WHERE id = $1", [doc.id])).rejects.toThrow();
  });

  it("completes when the last two signers sign at the same time", async () => {
    const reviewer = await staffUser();
    const tpl = (await loadTemplates(t.db)).find(x => x.key === "inspection_access")!;
    if (tpl.liveVersion === null) await publishVersion(t.db, reviewer, tpl.id, tpl.latestVersion);
    const ownerId = await addUser(t.db, "owner"), a = await addUser(t.db, "agent"), b = await addUser(t.db, "agent");
    const listingId = await addListing(t.db, ownerId);
    const owner: Actor = { userId: ownerId, userType: "owner" };
    const repo = createPgSigningRepository(t.db);
    const g = await generateDocument(repo, owner, listingId, {
      templateKey: "inspection_access", values: { inspection_date: "2026-12-02" },
      signers: [{ email: await emailOf(a), roleLabel: "First" }, { email: await emailOf(b), roleLabel: "Second" }]
    }, ids);
    if (!g.ok) throw new Error(g.message);
    await sendDocument(repo, owner, g.value.id, ids);
    const pa: Actor = { userId: a, userType: "agent" }, pb: Actor = { userId: b, userType: "agent" };
    await viewDocument(repo, pa, g.value.id, ids); await viewDocument(repo, pb, g.value.id, ids);
    const results = await Promise.all([
      signDocument(createPgSigningRepository(t.db), pa, g.value.id, { typedName: "Test agent", consent: true }, ids),
      signDocument(createPgSigningRepository(t.db), pb, g.value.id, { typedName: "Test agent", consent: true }, ids)
    ]);
    expect(results.every(r => r.ok)).toBe(true);
    const after = await viewDocument(repo, owner, g.value.id, ids);
    expect(after.ok && after.value.document.status).toBe("completed");
  });
});

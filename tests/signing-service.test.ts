import { beforeEach, describe, expect, it } from "vitest";
import { validateTemplateContent } from "../src/domain/doc-templates";
import type { Actor } from "../src/domain/listing-service";
import {
  cancelDocument, createInMemorySigningRepository, declineDocument, documentsForListing, explainClause, generateDocument, listTemplates, myDocuments,
  sendDocument, signDocument, viewDocument, type SigningRepository
} from "../src/domain/signing-service";
import { STARTER_TEMPLATES } from "../src/config/document-templates";

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
  signers: [{ email: "amy@agency.test", roleLabel: "Agent" }, { email: "olive@home.test", roleLabel: "Owner" }]
};

describe("document signing service", () => {
  let repo: SigningRepository & { eventsRaw: unknown[] };
  beforeEach(() => {
    repo = createInMemorySigningRepository({
      listings: [{ id: LISTING, ownerUserId: owner.userId, ownerName: "Olive Owner", title: "Queenslander", address: "1 Test St", jurisdiction: "QLD" }],
      accounts: [
        { id: owner.userId, email: "olive@home.test", displayName: "Olive Owner", status: "active" },
        { id: agent.userId, email: "amy@agency.test", displayName: "Amy Agent", status: "active" },
        { id: buyer.userId, email: "bo@buyer.test", displayName: "Bo Buyer", status: "active" },
        { id: U(9), email: "closed@x.test", displayName: "Closed", status: "closed" }
      ],
      templates: [{ templateId: U(50), key: "agent_appointment", title: starter.title, category: "agreement", versionId: U(51), version: 1, content: valid.value }]
    });
  });

  const generate = async (b: unknown = body) => {
    const r = await generateDocument(repo, owner, LISTING, b, ids, { ip: "203.0.113.5", userAgent: "UA" });
    if (!r.ok) throw new Error(r.message);
    return r.value;
  };
  const sent = async () => { const d = await generate(); const r = await sendDocument(repo, owner, d.id, ids); if (!r.ok) throw new Error(r.message); return d; };

  it("lists published templates for owners and agents only", async () => {
    const r = await listTemplates(repo, owner);
    expect(r.ok && r.value.map(t => t.key)).toEqual(["agent_appointment"]);
    expect((await listTemplates(repo, buyer)).ok).toBe(false);
  });

  it("generates a draft with values filled in, a hash and a created event; only the listing's owner can", async () => {
    const d = await generate();
    expect(d.status).toBe("draft");
    expect(d.clauses[0]!.text).toContain("Olive Owner (the owner) appoints Acme Realty, licence L-123");
    expect(d.clauses[1]!.text).toContain("10 November 2026");
    expect(d.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.signers.map(s => s.status)).toEqual(["pending", "pending"]);
    expect(repo.eventsRaw).toHaveLength(1);
    for (const a of [agent, stranger]) expect((await generateDocument(repo, a, LISTING, body, ids)).ok).toBe(false);
  });

  it("rejects unknown templates, missing values, bad signers, duplicate signers and accounts that cannot sign", async () => {
    const code = async (b: unknown) => { const r = await generateDocument(repo, owner, LISTING, b, ids); return r.ok ? "ok" : r.code; };
    expect(await code({ ...body, templateKey: "nope" })).toBe("not_found");
    expect(await code({ ...body, values: {} })).toBe("invalid");
    expect(await code({ ...body, signers: [] })).toBe("invalid");
    expect(await code({ ...body, signers: [{ email: "not-an-email", roleLabel: "X1" }] })).toBe("invalid");
    expect(await code({ ...body, signers: [{ email: "nobody@x.test", roleLabel: "Agent" }] })).toBe("invalid");
    expect(await code({ ...body, signers: [{ email: "closed@x.test", roleLabel: "Agent" }] })).toBe("invalid");
    expect(await code({ ...body, signers: [{ email: "amy@agency.test", roleLabel: "Agent" }, { email: "AMY@agency.test", roleLabel: "Again" }] })).toBe("invalid");
    expect(await code(null)).toBe("invalid");
    expect((await generateDocument(repo, owner, "bad-id", body, ids)).ok).toBe(false);
  });

  it("keeps a draft private to the owner until it is sent", async () => {
    const d = await generate();
    expect((await viewDocument(repo, agent, d.id, ids)).ok).toBe(false);
    expect((await signDocument(repo, agent, d.id, { typedName: "Amy Agent", consent: true }, ids)).ok).toBe(false);
    expect((await viewDocument(repo, owner, d.id, ids)).ok).toBe(true);
    expect((await myDocuments(repo, agent)).ok && (await myDocuments(repo, agent) as { value: unknown[] }).value).toHaveLength(0);
  });

  it("runs send -> view -> explain -> sign -> sign -> completed, with an event per step carrying the same hash", async () => {
    const d = await sent();
    expect((await sendDocument(repo, owner, d.id, ids)).ok).toBe(false);

    const v = await viewDocument(repo, agent, d.id, ids, { ip: "198.51.100.7", userAgent: "Agent browser" });
    expect(v.ok && v.value.viewer).toMatchObject({ role: "signer", canSign: true });
    const ex = await explainClause(repo, agent, d.id, "fee", ids);
    expect(ex.ok && ex.value.explanation).toContain("only fee");
    expect((await explainClause(repo, agent, d.id, "nope", ids)).ok).toBe(false);

    const early = await signDocument(repo, owner, d.id, { typedName: "Olive Owner", consent: true }, ids);
    expect(!early.ok && early.message).toMatch(/read the document/);

    expect((await signDocument(repo, agent, d.id, { typedName: "Amy Agent", consent: false }, ids)).ok).toBe(false);
    const wrong = await signDocument(repo, agent, d.id, { typedName: "Someone Else", consent: true }, ids);
    expect(!wrong.ok && wrong.message).toMatch(/exactly as it appears/);

    const first = await signDocument(repo, agent, d.id, { typedName: "  amy   agent ", consent: true }, ids, { ip: "198.51.100.7" });
    expect(first.ok && first.value.status).toBe("out_for_signature");
    expect(first.ok && first.value.signers.find(s => s.userId === agent.userId)).toMatchObject({ status: "signed", typedName: "amy agent" });
    expect((await signDocument(repo, agent, d.id, { typedName: "Amy Agent", consent: true }, ids)).ok).toBe(false);

    await viewDocument(repo, owner, d.id, ids);
    const last = await signDocument(repo, owner, d.id, { typedName: "Olive Owner", consent: true }, ids);
    expect(last.ok && last.value.status).toBe("completed");

    const view = await viewDocument(repo, owner, d.id, ids);
    if (!view.ok) throw new Error("view");
    expect(view.value.events.map(e => e.eventType)).toEqual(["created", "sent", "viewed", "explained", "signed", "viewed", "signed", "completed"]);
    expect(view.value.viewer.canSign).toBe(false);
    const hashes = new Set((repo.eventsRaw as { bodySha256: string }[]).map(e => e.bodySha256));
    expect([...hashes]).toEqual([d.bodySha256]);
    expect((await signDocument(repo, owner, d.id, { typedName: "Olive Owner", consent: true }, ids)).ok).toBe(false);
  });

  it("records a signer's first view only once", async () => {
    const d = await sent();
    await viewDocument(repo, agent, d.id, ids);
    await viewDocument(repo, agent, d.id, ids);
    const v = await viewDocument(repo, owner, d.id, ids);
    if (!v.ok) throw new Error("view");
    const agentSigner = v.value.document.signers.find(x => x.userId === agent.userId)!;
    expect(v.value.events.filter(e => e.eventType === "viewed" && e.signerId === agentSigner.id)).toHaveLength(1);
  });

  it("closes the document when a signer declines, and nobody can sign afterwards", async () => {
    const d = await sent();
    const r = await declineDocument(repo, agent, d.id, { reason: "Fee too high" }, ids);
    expect(r.ok && r.value.status).toBe("declined");
    const v = await viewDocument(repo, owner, d.id, ids);
    expect(v.ok && v.value.events.at(-1)).toMatchObject({ eventType: "declined", detail: { reason: "Fee too high" } });
    await viewDocument(repo, owner, d.id, ids);
    expect((await signDocument(repo, owner, d.id, { typedName: "Olive Owner", consent: true }, ids)).ok).toBe(false);
    expect((await declineDocument(repo, owner, d.id, {}, ids)).ok).toBe(false);
  });

  it("lets only the owner cancel, and not a closed document", async () => {
    const d = await sent();
    expect((await cancelDocument(repo, agent, d.id, ids)).ok).toBe(false);
    const r = await cancelDocument(repo, owner, d.id, ids);
    expect(r.ok && r.value.status).toBe("cancelled");
    expect((await cancelDocument(repo, owner, d.id, ids)).ok).toBe(false);
    expect((await sendDocument(repo, owner, d.id, ids)).ok).toBe(false);
  });

  it("answers 404 for strangers and bad ids, and scopes lists", async () => {
    const d = await sent();
    expect((await viewDocument(repo, stranger, d.id, ids)).ok).toBe(false);
    expect((await viewDocument(repo, buyer, d.id, ids)).ok).toBe(false);
    expect((await explainClause(repo, stranger, d.id, "fee", ids)).ok).toBe(false);
    expect((await viewDocument(repo, owner, "x", ids)).ok).toBe(false);
    expect((await documentsForListing(repo, stranger, LISTING)).ok).toBe(false);
    const mine = await myDocuments(repo, agent);
    expect(mine.ok && mine.value.map(x => x.id)).toEqual([d.id]);
    expect((await myDocuments(repo, buyer) as { value: unknown[] }).value).toHaveLength(0);
  });
});

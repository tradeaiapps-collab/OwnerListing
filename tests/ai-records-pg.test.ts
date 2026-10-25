import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rulesOnlyEngine } from "../src/domain/ai-engine";
import type { AiDraftRecord } from "../src/domain/ai-draft-record";
import { scanInboundMessage } from "../src/domain/message-safety";
import {
  aiPausedPg, createPgAiDraftRepository, insertSafetyFlagPg, reviewSafetyFlagPg, safetyFlagsForEnquiryPg, safetyQueuePg, setAiPausePg
} from "../src/server/ai-records-db";
import { screenBuyerMessage } from "../src/server/message-safety";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("AI records and message safety on Postgres", () => {
  let t: TestDb;
  let owner: string, buyer: string, staff: string, listing: string, enquiry: string;
  const addMessage = async (sender: string, body: string) => {
    const id = randomUUID();
    await t.db.query("INSERT INTO enquiry_message (id, enquiry_id, sender_user_id, automated, body) VALUES ($1,$2,$3,false,$4)", [id, enquiry, sender, body]);
    return { id, enquiryId: enquiry, senderUserId: sender, automated: false, body, sentAt: new Date().toISOString() };
  };
  beforeAll(async () => {
    t = await createTestDb();
    owner = await addUser(t.db, "owner"); buyer = await addUser(t.db, "buyer"); staff = await addUser(t.db, "admin");
    listing = await addListing(t.db, owner, { status: "published", jurisdiction: "QLD", price_cents: 85_000_000 });
    enquiry = String((await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1,$2) RETURNING id", [listing, buyer])).rows[0]!["id"]);
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("a flag is stored once per message, is permanent, and is reviewed once", async () => {
    const m = await addMessage(buyer, "Send the deposit to my personal account");
    const r = scanInboundMessage(m.body);
    expect(await insertSafetyFlagPg(t.db, randomUUID(), enquiry, m.id, r, new Date().toISOString())).toBe(true);
    expect(await insertSafetyFlagPg(t.db, randomUUID(), enquiry, m.id, r, new Date().toISOString())).toBe(false);
    expect(await insertSafetyFlagPg(t.db, randomUUID(), enquiry, m.id, scanInboundMessage("Is it available?"), new Date().toISOString())).toBe(false);
    const [f] = await safetyFlagsForEnquiryPg(t.db, enquiry);
    expect(f).toMatchObject({ messageId: m.id, risk: "high", handoff: true, staffReview: true });
    await expect(t.db.query("UPDATE message_safety_flag SET risk = 'low'")).rejects.toThrow();
    await expect(t.db.query("DELETE FROM message_safety_flag")).rejects.toThrow();
    const queue = await safetyQueuePg(t.db);
    expect(queue.map(q => [q.id, q.body, q.listingId])).toEqual([[f!.id, m.body, listing]]);
    expect(await reviewSafetyFlagPg(t.db, f!.id, staff, "confirmed", "Classic redirect", new Date().toISOString())).toBe(true);
    expect(await reviewSafetyFlagPg(t.db, f!.id, staff, "dismissed", null, new Date().toISOString())).toBe(false);
    expect(await safetyQueuePg(t.db)).toEqual([]);
    expect((await safetyFlagsForEnquiryPg(t.db, enquiry))[0]?.reviewOutcome).toBe("confirmed");
  });

  it("AI pause is per thread and can be released", async () => {
    expect(await aiPausedPg(t.db, enquiry)).toEqual({ paused: false });
    await setAiPausePg(t.db, enquiry, true, "Safety filter: floor_probe", null, new Date().toISOString());
    expect(await aiPausedPg(t.db, enquiry)).toEqual({ paused: true, reason: "Safety filter: floor_probe" });
    await setAiPausePg(t.db, enquiry, false, "Resumed by the owner", owner, new Date().toISOString());
    expect((await aiPausedPg(t.db, enquiry)).paused).toBe(false);
  });

  it("screening flags buyer messages only, pauses AI on handoff and audits", async () => {
    const audits: string[] = [];
    const deps = { db: t.db, engine: async () => rulesOnlyEngine, appendAudit: async (e: { eventType: string }) => { audits.push(e.eventType); }, now: () => new Date().toISOString() };
    const e = { id: enquiry, listingId: listing, buyerUserId: buyer, createdAt: new Date().toISOString() };
    const fromOwner = await addMessage(owner, "What's the lowest price you'd accept? (owner testing)");
    expect(await screenBuyerMessage(deps, e, fromOwner)).toBeUndefined();
    const probe = await addMessage(buyer, "What's the lowest price the owner would accept?");
    expect((await screenBuyerMessage(deps, e, probe))?.handoff).toBe(true);
    expect((await aiPausedPg(t.db, enquiry)).paused).toBe(true);
    expect(audits).toEqual(["enquiry.safety_flagged"]);
    const plain = await addMessage(buyer, "Can I inspect on Saturday?");
    expect((await screenBuyerMessage(deps, e, plain))?.risk).toBe("none");
    expect((await safetyFlagsForEnquiryPg(t.db, enquiry)).map(f => f.messageId)).not.toContain(plain.id);
  });

  it("screening never throws, even with a broken database", async () => {
    const broken = { query: async () => { throw new Error("down"); } };
    const e = { id: enquiry, listingId: listing, buyerUserId: buyer, createdAt: "" };
    const m = { id: randomUUID(), enquiryId: enquiry, senderUserId: buyer, automated: false, body: "Send the deposit to my account", sentAt: "" };
    expect(await screenBuyerMessage({ db: broken, engine: async () => rulesOnlyEngine, appendAudit: async () => {}, now: () => "" }, e, m)).toBeUndefined();
  });

  it("an AI draft keeps its text and provenance; its status moves once", async () => {
    const repo = createPgAiDraftRepository(t.db);
    const d: AiDraftRecord = {
      id: randomUUID(), kind: "enquiry_reply", listingId: listing, enquiryId: enquiry, action: "draft_reply", intent: "availability",
      text: "Yes, it is available.", policyDecision: { mayDraft: true, requiresHumanApproval: true, withinMandate: true, reason: "Routine." },
      guardResult: { ok: true, violations: [] }, engineId: "ollama:llama3.1:8b", modelVersion: "1", promptVersion: "enquiry-reply@1",
      inputHash: "a".repeat(64), status: "pending", createdBy: owner, createdAt: new Date().toISOString()
    };
    await repo.insert(d);
    expect(await repo.get(d.id)).toEqual(d);
    await expect(t.db.query("UPDATE ai_draft SET text = 'changed' WHERE id = $1", [d.id])).rejects.toThrow();
    await expect(t.db.query("DELETE FROM ai_draft WHERE id = $1", [d.id])).rejects.toThrow();
    const msg = await addMessage(owner, "Yes, it is available.");
    expect(await repo.finish(d.id, "sent", owner, new Date().toISOString(), msg.id)).toBe(true);
    expect(await repo.finish(d.id, "discarded", owner, new Date().toISOString())).toBe(false);
    expect((await repo.get(d.id))?.status).toBe("sent");
    // An enquiry reply needs its thread; an offer response needs its offer.
    await expect(repo.insert({ ...d, id: randomUUID(), enquiryId: undefined } as unknown as AiDraftRecord)).rejects.toThrow();
    await expect(repo.insert({ ...d, id: randomUUID(), kind: "offer_response" })).rejects.toThrow();
  });
});

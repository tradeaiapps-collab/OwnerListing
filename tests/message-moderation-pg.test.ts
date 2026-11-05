import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { moderateMessage } from "../src/domain/message-moderation";
import { insertModerationFlagPg, moderateSentMessage, moderationFlagsForEnquiryPg, moderationQueuePg, reviewModerationFlagPg } from "../src/server/message-moderation-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("message moderation on Postgres", () => {
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

  it("stores a flag once per message, only for risky seller messages, and never for the buyer", async () => {
    const clean = await addMessage(owner, "Thanks for your offer.");
    expect(await moderateSentMessage(t.db, { id: enquiry, listingId: listing, buyerUserId: buyer, createdAt: "" }, clean)).toMatchObject({ risk: "none" });
    expect(await moderationFlagsForEnquiryPg(t.db, enquiry, owner)).toEqual([]);

    const bad = await addMessage(owner, "Take it or leave it. WhatsApp me and we can do a cash deal.");
    const r = moderateMessage(bad.body);
    expect(await insertModerationFlagPg(t.db, enquiry, bad, r)).toBe(true);
    expect(await insertModerationFlagPg(t.db, enquiry, bad, r)).toBe(false);
    const [f] = await moderationFlagsForEnquiryPg(t.db, enquiry, owner);
    expect(f).toMatchObject({ messageId: bad.id, severity: "high", status: "open" });

    const fromBuyer = await addMessage(buyer, "WhatsApp me for a cash deal");
    expect(await moderateSentMessage(t.db, { id: enquiry, listingId: listing, buyerUserId: buyer, createdAt: "" }, fromBuyer)).toBeUndefined();
    expect(await moderationFlagsForEnquiryPg(t.db, enquiry, buyer)).toEqual([]);
  });

  it("flags are permanent, the queue shows sender counts, and a decision happens once", async () => {
    await expect(t.db.query("UPDATE message_moderation_flag SET severity = 'low'")).rejects.toThrow();
    await expect(t.db.query("DELETE FROM message_moderation_flag")).rejects.toThrow();
    for (const body of ["Hurry, today only!", "You don't need a solicitor."]) await insertModerationFlagPg(t.db, enquiry, await addMessage(owner, body), moderateMessage(body));
    const q = await moderationQueuePg(t.db);
    expect(q).toHaveLength(3);
    expect(q[0]!.severity).toBe("high");
    expect(q.every(x => x.senderFlags30d === 3 && x.trainingSuggested)).toBe(true);
    expect(q[0]!.body.length).toBeGreaterThan(0);
    const id = q[0]!.id;
    expect(await reviewModerationFlagPg(t.db, id, staff, "request_revision", "Remove the off-platform offer", new Date().toISOString())).toBe(true);
    expect(await reviewModerationFlagPg(t.db, id, staff, "approve", null, new Date().toISOString())).toBe(false);
    expect((await moderationQueuePg(t.db)).map(x => x.id)).not.toContain(id);
    expect((await moderationQueuePg(t.db, "reviewed")).map(x => [x.id, x.status, x.reviewNote])).toEqual([[id, "revision_requested", "Remove the off-platform offer"]]);
  });
});

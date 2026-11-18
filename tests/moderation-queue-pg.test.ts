import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideQueueItemPg, enqueueModerationItemPg, getQueueTargetPg, listQueuePg, queueCountsPg } from "../src/server/moderation-queue-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("moderation queue (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  const setup = async () => {
    const owner = await addUser(db, "owner");
    const staff = await addUser(db, "admin");
    const listingId = await addListing(db, owner, { title: "Queue test home" });
    const id = (await enqueueModerationItemPg(db, {
      subjectType: "listing", subjectId: listingId, subjectLabel: "Queue test home", subjectOwnerId: owner,
      source: "content_filter", reason: "Possible contact details in description", detail: "call 0400 000 000", severity: "high"
    }))!;
    return { owner, staff, listingId, id };
  };

  it("queues once per subject, source and reason while it is open, and records the raise", async () => {
    const { owner, listingId, id } = await setup();
    expect(id).toBeTruthy();
    const again = await enqueueModerationItemPg(db, {
      subjectType: "listing", subjectId: listingId, subjectLabel: "x", subjectOwnerId: owner, source: "content_filter", reason: "Possible contact details in description"
    });
    expect(again).toBeNull();
    const item = (await listQueuePg(db, { view: "open" })).find(i => i.id === id)!;
    expect(item).toMatchObject({ subjectType: "listing", severity: "high", status: "open", detail: "call 0400 000 000" });
    expect(item.history.map(h => h.action)).toEqual(["raised"]);
    await expect(enqueueModerationItemPg(db, { subjectType: "listing", subjectId: "nope", subjectLabel: "x", source: "s", reason: "r" })).rejects.toThrow(/Invalid/);
  });

  it("escalates, then a decision closes it with history, audit and a permanent record", async () => {
    const { staff, id } = await setup();
    const me = { id: staff, role: "compliance" };
    expect(await decideQueueItemPg(db, id, me, "escalate", "open", "Needs the compliance lead to look.")).toBe(true);
    expect((await getQueueTargetPg(db, id))?.status).toBe("escalated");
    expect((await listQueuePg(db, { view: "escalated" })).some(i => i.id === id)).toBe(true);
    // A stale second escalate (item no longer open) is refused.
    expect(await decideQueueItemPg(db, id, me, "escalate", "open", "Second try at the same step.")).toBe(false);
    expect(await decideQueueItemPg(db, id, me, "reject", "escalated", "Breaks the contact details rule.")).toBe(true);
    const done = (await listQueuePg(db, { view: "decided" })).find(i => i.id === id)!;
    expect(done).toMatchObject({ status: "rejected", decisionNote: "Breaks the contact details rule." });
    expect(done.history.map(h => h.action)).toEqual(["raised", "escalate", "reject"]);
    const audit = await db.query("SELECT event_type FROM audit_event WHERE aggregate_type = 'moderation_item' AND aggregate_id = $1 ORDER BY occurred_at", [id]);
    expect(audit.rows.map(r => r["event_type"])).toEqual(["moderation_item.escalate", "moderation_item.reject"]);
    await expect(db.query("UPDATE moderation_item SET status = 'approved', decided_at = now() WHERE id = $1", [id])).rejects.toThrow(/already decided/);
    await expect(db.query("DELETE FROM moderation_item WHERE id = $1", [id])).rejects.toThrow(/permanent/);
    await expect(db.query("DELETE FROM moderation_item_event WHERE item_id = $1", [id])).rejects.toThrow(/permanent/);
  });

  it("filters by type, counts the tabs, and a decided subject can be queued again", async () => {
    const { owner, staff, listingId, id } = await setup();
    const profile = (await enqueueModerationItemPg(db, { subjectType: "profile", subjectId: randomUUID(), subjectLabel: "A profile", source: "report", reason: "Abusive bio" }))!;
    expect((await listQueuePg(db, { view: "open", subjectType: "profile" })).map(i => i.id)).toContain(profile);
    expect((await listQueuePg(db, { view: "open", subjectType: "profile" })).map(i => i.id)).not.toContain(id);
    expect((await queueCountsPg(db)).open).toBeGreaterThanOrEqual(2);
    expect(await decideQueueItemPg(db, id, { id: staff, role: "support" }, "approve", "open", "Looks fine on review.")).toBe(true);
    const again = await enqueueModerationItemPg(db, {
      subjectType: "listing", subjectId: listingId, subjectLabel: "Queue test home", subjectOwnerId: owner, source: "content_filter", reason: "Possible contact details in description"
    });
    expect(again).toBeTruthy();
  });

  it("the database refuses a decision by the content owner", async () => {
    const { owner, id } = await setup();
    await expect(decideQueueItemPg(db, id, { id: owner, role: "support" }, "approve", "open", "Approving my own listing.")).rejects.toThrow(/check/);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideQueueItemPg, enqueueModerationItemPg, getQueueTargetPg, getSuspensionPg, listQueuePg, queueCountsPg, rejectAndSuspendPg, reinstateQueueItemPg, SuspensionConflict } from "../src/server/moderation-queue-db";
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

  const status = async (table: string, id: string) => String((await db.query(`SELECT status FROM ${table} WHERE id = $1`, [id])).rows[0]!["status"]);

  it("reject + suspend listing: decision, listing status and both audit events commit together", async () => {
    const { owner, staff, listingId, id } = await setup();
    await db.query("UPDATE property_listing SET status = 'published' WHERE id = $1", [listingId]);
    const me = { id: staff, role: "compliance" };
    const r = await rejectAndSuspendPg(db, id, me, "open", "Contact details in the description.", { kind: "listing", listingId, from: "published", reason: "Contact details in the description." });
    expect(r).toEqual({ decided: true, listingsSuspended: 1 });
    expect(await status("property_listing", listingId)).toBe("suspended");
    expect((await getQueueTargetPg(db, id))?.status).toBe("rejected");
    const ev = await db.query("SELECT event_type, payload FROM audit_event WHERE (aggregate_type = 'listing' AND aggregate_id = $1) OR (aggregate_type = 'moderation_item' AND aggregate_id = $2) ORDER BY event_type", [listingId, id]);
    expect(ev.rows.map(x => x["event_type"])).toEqual(["listing.suspended", "moderation_item.reject"]);
    expect(ev.rows.find(x => x["event_type"] === "moderation_item.reject")!["payload"]).toMatchObject({ suspended: "listing", listingId });
    expect(owner).toBeTruthy();
  });

  it("reject + suspend account: the account and, optionally, its live listings", async () => {
    const { owner, staff, listingId, id } = await setup();
    await db.query("UPDATE property_listing SET status = 'published' WHERE id = $1", [listingId]);
    const me = { id: staff, role: "compliance" };
    const r = await rejectAndSuspendPg(db, id, me, "open", "Repeated contact leakage in messages.", { kind: "account", userId: owner, from: "active", reason: "Repeated contact leakage in messages.", withListings: true });
    expect(r).toEqual({ decided: true, listingsSuspended: 1 });
    expect(await status("app_user", owner)).toBe("suspended");
    expect(await status("property_listing", listingId)).toBe("suspended");
    const ev = await db.query("SELECT event_type FROM audit_event WHERE aggregate_id = ANY($1::text[]) ORDER BY event_type", [[owner, listingId, id]]);
    expect(ev.rows.map(x => x["event_type"])).toEqual(["listing.suspended", "moderation_item.reject", "user.suspended"]);
  });

  it("rolls everything back when the listing changed after staff looked at it", async () => {
    const { staff, listingId, id } = await setup(); // listing is still a draft, so it cannot be suspended
    await expect(rejectAndSuspendPg(db, id, { id: staff, role: "compliance" }, "open", "Contact details in the description.", { kind: "listing", listingId, from: "published", reason: "x" })).rejects.toBeInstanceOf(SuspensionConflict);
    expect((await getQueueTargetPg(db, id))?.status).toBe("open");
    expect((await db.query("SELECT 1 FROM audit_event WHERE aggregate_id = $1", [id])).rows).toHaveLength(0);
  });

  it("a decision someone else took first suspends nothing", async () => {
    const { staff, listingId, id } = await setup();
    await db.query("UPDATE property_listing SET status = 'published' WHERE id = $1", [listingId]);
    expect(await decideQueueItemPg(db, id, { id: staff, role: "support" }, "approve", "open", "Looks fine on review.")).toBe(true);
    const r = await rejectAndSuspendPg(db, id, { id: staff, role: "compliance" }, "open", "Contact details in the description.", { kind: "listing", listingId, from: "published", reason: "x" });
    expect(r.decided).toBe(false);
    expect(await status("property_listing", listingId)).toBe("published");
  });

  it("reinstates a suspended listing once: status, history row, audit and the list view all agree", async () => {
    const { staff, listingId, id } = await setup();
    await db.query("UPDATE property_listing SET status = 'published' WHERE id = $1", [listingId]);
    const me = { id: staff, role: "compliance" };
    await rejectAndSuspendPg(db, id, me, "open", "Contact details in the description.", { kind: "listing", listingId, from: "published", reason: "Contact details in the description." });
    expect((await listQueuePg(db, { view: "decided" })).find(i => i.id === id)).toMatchObject({ suspended: "listing", reinstated: false });
    expect(await getSuspensionPg(db, id)).toEqual({ suspension: { kind: "listing", listingId }, reinstated: false });

    const event = { id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user" as const, actorId: staff, aggregateType: "listing", aggregateId: listingId, eventType: "listing.published", correlationId: randomUUID(), payload: { action: "reinstate" } };
    const plan = { kind: "listing" as const, listingId, reason: "The owner removed the phone number." };
    expect(await reinstateQueueItemPg(db, id, me, plan, event)).toBe(true);
    expect(await status("property_listing", listingId)).toBe("published");
    expect((await listQueuePg(db, { view: "decided" })).find(i => i.id === id)).toMatchObject({ suspended: "listing", reinstated: true, status: "rejected" });
    expect((await getQueueTargetPg(db, id))?.status).toBe("rejected");
    const h = (await listQueuePg(db, { view: "decided" })).find(i => i.id === id)!.history;
    expect(h.map(x => x.action)).toEqual(["raised", "reject", "reinstate"]);
    expect(h[2]!.note).toBe("The owner removed the phone number.");
    const ev = await db.query("SELECT payload FROM audit_event WHERE aggregate_type = 'moderation_item' AND aggregate_id = $1 AND event_type = 'moderation_item.reinstated'", [id]);
    expect(ev.rows[0]!["payload"]).toMatchObject({ reinstated: "listing", listingId, reason: "The owner removed the phone number." });
    // A second attempt does nothing.
    expect(await reinstateQueueItemPg(db, id, me, plan, event)).toBe(false);
  });

  it("reinstates a suspended account, and rolls everything back if it changed in the meantime", async () => {
    const { owner, staff, id } = await setup();
    const me = { id: staff, role: "compliance" };
    await rejectAndSuspendPg(db, id, me, "open", "Repeated contact leakage in messages.", { kind: "account", userId: owner, from: "active", reason: "Repeated contact leakage in messages.", withListings: false });
    expect(await getSuspensionPg(db, id)).toEqual({ suspension: { kind: "account", userId: owner }, reinstated: false });
    const plan = { kind: "account" as const, userId: owner, from: "suspended", reason: "Account verified and warned.", withListings: false };
    await db.query("UPDATE app_user SET status = 'active' WHERE id = $1", [owner]); // someone else already lifted it
    await expect(reinstateQueueItemPg(db, id, me, plan)).rejects.toThrow(SuspensionConflict);
    expect((await getSuspensionPg(db, id)).reinstated).toBe(false);
    await db.query("UPDATE app_user SET status = 'suspended' WHERE id = $1", [owner]);
    expect(await reinstateQueueItemPg(db, id, me, plan)).toBe(true);
    expect(await status("app_user", owner)).toBe("active");
    expect((await getSuspensionPg(db, id)).reinstated).toBe(true);
    const ev = await db.query("SELECT event_type FROM audit_event WHERE aggregate_id = ANY($1::text[]) ORDER BY event_type", [[owner, id]]);
    expect(ev.rows.map(x => x["event_type"])).toEqual(["moderation_item.reinstated", "moderation_item.reject", "user.reinstated", "user.suspended"]);
  });

  it("a rejection that suspended nothing has nothing to reinstate, and an open item cannot be reinstated", async () => {
    const { staff, id } = await setup();
    const me = { id: staff, role: "compliance" };
    expect(await getSuspensionPg(db, id)).toEqual({ suspension: null, reinstated: false });
    await expect(reinstateQueueItemPg(db, id, me, { kind: "account", userId: staff, from: "suspended", reason: "Not rejected yet.", withListings: false })).rejects.toThrow(SuspensionConflict);
    await decideQueueItemPg(db, id, me, "reject", "open", "Breaks the contact details rule.");
    expect((await listQueuePg(db, { view: "decided" })).find(i => i.id === id)).toMatchObject({ suspended: null, reinstated: false });
  });
});

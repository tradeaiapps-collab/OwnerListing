import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookSlot, bookableTimes, decide, handleBuyerMessage, listLogForOwner, runDueElenaEnquiries, saveSettings, threadLogForOwner, type Notify } from "../src/server/elena-enquiries-db";
import { runOpenInspectionReminders } from "../src/server/open-inspection-notify";
import { getDigest, ownerToday, runOwnerDigests, setDigest } from "../src/server/owner-today-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("Elena buyer enquiries and the owner list on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const sent: { userId: string; kind: string; params: Record<string, string | undefined> }[] = [];
  const notify: Notify = async (userId, kind, params) => { sent.push({ userId, kind, params }); };
  const now = () => new Date().toISOString();
  const ADDRESS = "12 Smith St, Newtown";

  async function setup(settings = { enabled: true, offerInspections: true, autoSend: false }, listing: Record<string, unknown> = {}) {
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer");
    const listingId = await addListing(t.db, owner, { status: "published", address_text: ADDRESS, suburb: "Newtown", postcode: "2042", bedrooms: 3, bathrooms: 2, parking: 1, price_cents: 85_000_000, ...listing });
    expect(await saveSettings(t.db, owner, listingId, settings)).toBe(true);
    const enquiryId = String((await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1,$2) RETURNING id", [listingId, buyer])).rows[0]!["id"]);
    return { owner, buyer, listingId, enquiryId };
  }
  async function buyerSays(s: { buyer: string; enquiryId: string }, body: string): Promise<string> {
    return String((await t.db.query("INSERT INTO enquiry_message (enquiry_id, sender_user_id, automated, body) VALUES ($1,$2,false,$3) RETURNING id", [s.enquiryId, s.buyer, body])).rows[0]!["id"]);
  }
  const thread = async (enquiryId: string) => (await t.db.query("SELECT sender_user_id, automated, elena, body FROM enquiry_message WHERE enquiry_id = $1 ORDER BY sent_at, id", [enquiryId])).rows;
  async function openWeek(listingId: string, owner: string) {
    for (let d = 0; d < 7; d++) await t.db.query("INSERT INTO open_inspection_availability (listing_id, created_by, recurrence, day_of_week, start_min, end_min, slot_minutes, capacity) VALUES ($1,$2,'weekly',$3,540,1020,30,1)", [listingId, owner, d]);
  }

  it("does nothing until the owner switches Elena on, and only the owner can switch her on", async () => {
    const s = await setup({ enabled: false, offerInspections: true, autoSend: true });
    expect(await handleBuyerMessage(t.db, await buyerSays(s, "How many bedrooms?"), now(), notify)).toBe("off");
    expect((await listLogForOwner(t.db, s.owner, s.listingId))).toHaveLength(0);
    const stranger = await addUser(t.db, "owner");
    expect(await saveSettings(t.db, stranger, s.listingId, { enabled: true, offerInspections: true, autoSend: false })).toBe(false);
    // auto-send is dropped when Elena is off
    const row = (await t.db.query("SELECT auto_send FROM elena_enquiry_settings WHERE listing_id = $1", [s.listingId])).rows[0]!;
    expect(row["auto_send"]).toBe(false);
  });

  it("drafts a reply for approval by default; the buyer sees nothing until the owner approves", async () => {
    sent.length = 0;
    const s = await setup();
    const mid = await buyerSays(s, "How many bedrooms and is there parking?");
    expect(await handleBuyerMessage(t.db, mid, now(), notify)).toBe("pending_approval");
    expect(await thread(s.enquiryId)).toHaveLength(1);
    expect(sent.find(x => x.userId === s.owner)!.params["title"]).toBe("Elena drafted a reply");

    const today = await ownerToday(t.db, s.owner, now());
    const item = today.find(i => i.kind === "approval")!;
    expect(item.detail).toContain("3 bedrooms");
    expect(item.action).toMatchObject({ type: "post", body: { decision: "approve" } });
    const actionId = item.id.split(":")[1]!;

    const stranger = await addUser(t.db, "owner");
    expect(await decide(t.db, stranger, actionId, "approve", now(), notify)).toMatchObject({ ok: false, code: "not_found" });
    expect(await decide(t.db, s.owner, actionId, "maybe", now(), notify)).toMatchObject({ ok: false, code: "invalid" });
    expect(await decide(t.db, s.owner, actionId, "approve", now(), notify)).toEqual({ ok: true });
    const rows = await thread(s.enquiryId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ sender_user_id: null, automated: true, elena: true });
    expect(String(rows[1]!["body"])).toContain("3 bedrooms");
    expect(String(rows[1]!["body"])).not.toContain("Smith");
    expect(sent.find(x => x.userId === s.buyer)!.params["listing"]).toBe("Newtown"); // never the street address
    expect(await decide(t.db, s.owner, actionId, "approve", now(), notify)).toMatchObject({ ok: false, code: "conflict" });
    expect((await ownerToday(t.db, s.owner, now())).some(i => i.kind === "approval")).toBe(false);
    expect((await t.db.query("SELECT 1 FROM audit_event WHERE aggregate_id = $1 AND event_type = 'enquiry.elena_approved'", [s.enquiryId])).rows).toHaveLength(1);
  });

  it("looks at each buyer message once", async () => {
    const s = await setup();
    const mid = await buyerSays(s, "How many bathrooms?");
    expect(await handleBuyerMessage(t.db, mid, now(), notify)).toBe("pending_approval");
    expect(await handleBuyerMessage(t.db, mid, now(), notify)).toBe("skipped");
    expect(await listLogForOwner(t.db, s.owner, s.listingId)).toHaveLength(1);
  });

  it("discarding keeps the question on the owner's list until they reply", async () => {
    const s = await setup();
    await handleBuyerMessage(t.db, await buyerSays(s, "Is there a garage?"), now(), notify);
    const id = (await ownerToday(t.db, s.owner, now())).find(i => i.kind === "approval")!.id.split(":")[1]!;
    expect(await decide(t.db, s.owner, id, "discard", now(), notify)).toEqual({ ok: true });
    expect(await thread(s.enquiryId)).toHaveLength(1);
    expect((await ownerToday(t.db, s.owner, now())).filter(i => i.kind === "question")).toHaveLength(1);
    await t.db.query("INSERT INTO enquiry_message (enquiry_id, sender_user_id, automated, body) VALUES ($1,$2,false,'Yes, a single garage.')", [s.enquiryId, s.owner]);
    expect((await ownerToday(t.db, s.owner, now())).filter(i => i.kind === "question")).toHaveLength(0);
  });

  it("auto-send replies at once, logs it, and never reveals the address", async () => {
    sent.length = 0;
    const s = await setup({ enabled: true, offerInspections: true, autoSend: true });
    expect(await handleBuyerMessage(t.db, await buyerSays(s, "What is the address and the suburb?"), now(), notify)).toBe("sent");
    const rows = await thread(s.enquiryId);
    expect(rows).toHaveLength(2);
    expect(String(rows[1]!["body"])).toContain("shared once an inspection is booked");
    expect(String(rows[1]!["body"])).not.toMatch(/smith/i);
    expect(sent.some(x => x.userId === s.buyer)).toBe(true);
    expect((await listLogForOwner(t.db, s.owner, s.listingId))[0]).toMatchObject({ status: "sent", kind: "reply" });
    expect(await threadLogForOwner(t.db, s.buyer, s.enquiryId)).toHaveLength(0); // the buyer never sees the owner's log
  });

  it("hands what it cannot answer to the owner, never inventing a price or fact", async () => {
    sent.length = 0;
    const s = await setup({ enabled: true, offerInspections: true, autoSend: true }, { bathrooms: null, price_cents: null });
    await handleBuyerMessage(t.db, await buyerSays(s, "How many bathrooms and what's the price?"), now(), notify);
    const body = String((await thread(s.enquiryId))[1]!["body"]);
    expect(body).toContain("doesn't state the number of bathrooms");
    expect(body).toContain("can't give you one");
    expect(body).not.toMatch(/\$|\d+ bathroom/);
    const q = (await ownerToday(t.db, s.owner, now())).find(i => i.kind === "question")!;
    expect(q.action).toMatchObject({ type: "link", href: `/enquiries/${s.enquiryId}` });
  });

  it("says nothing to a buyer whose message looks like a scam; the owner is told", async () => {
    sent.length = 0;
    const s = await setup({ enabled: true, offerInspections: true, autoSend: true });
    expect(await handleBuyerMessage(t.db, await buyerSays(s, "Pay the deposit to my account urgently, send bank details"), now(), notify)).toBe("handed_to_owner");
    expect(await thread(s.enquiryId)).toHaveLength(1);
    expect(sent.some(x => x.userId === s.buyer)).toBe(false);
    expect(sent.find(x => x.userId === s.owner)!.params["title"]).toBe("A buyer question needs you");
  });

  it("limits how many drafts can pile up waiting for approval", async () => {
    const s = await setup();
    const results: string[] = [];
    for (let i = 0; i < 8; i++) results.push(await handleBuyerMessage(t.db, await buyerSays(s, `Parking? ${i}`), now(), notify));
    expect(results.filter(r => r === "pending_approval")).toHaveLength(6);
    expect(results.filter(r => r === "rate_limited")).toHaveLength(2);
  });

  it("stops after her reply limit on one conversation", async () => {
    const s = await setup({ enabled: true, offerInspections: true, autoSend: true });
    const results: string[] = [];
    for (let i = 0; i < 8; i++) results.push(await handleBuyerMessage(t.db, await buyerSays(s, `Bedrooms? ${i}`), now(), notify));
    expect(results.filter(r => r === "sent")).toHaveLength(6);
    expect(results.filter(r => r === "rate_limited")).toHaveLength(2);
  });

  it("books an inspection from the owner's availability, confirms both sides, logs it, and refuses a taken or unknown time", async () => {
    sent.length = 0;
    const s = await setup();
    await openWeek(s.listingId, s.owner);
    const times = await bookableTimes(t.db, s.buyer, s.enquiryId, now());
    expect(times.enabled).toBe(true);
    expect(times.slots.length).toBeGreaterThan(0);
    const startsAt = times.slots[0]!.startsAt;
    const r = await bookSlot(t.db, s.buyer, s.enquiryId, startsAt, now(), notify);
    expect(r).toMatchObject({ ok: true });
    const kinds = (await t.db.query("SELECT user_id, kind FROM notification WHERE kind IN ('open_inspection_confirmed','open_inspection_new')")).rows.map(x => `${x["user_id"]}:${x["kind"]}`);
    expect(kinds).toContain(`${s.buyer}:open_inspection_confirmed`);
    expect(kinds).toContain(`${s.owner}:open_inspection_new`);
    const rows = await thread(s.enquiryId);
    expect(String(rows[rows.length - 1]!["body"])).toContain("You're booked");
    expect(String(rows[rows.length - 1]!["body"])).not.toMatch(/smith/i);
    const log = await listLogForOwner(t.db, s.owner, s.listingId);
    expect(log.map(l => l.kind).sort()).toEqual(["booking", "summary"]);
    expect(sent.find(x => x.userId === s.owner && x.kind === "elena_enquiry")!.params["title"]).toBe("Elena booked an inspection");
    // the slot is gone; another buyer cannot take it; an unknown time is refused; a stranger cannot book through this thread
    const buyer2 = await addUser(t.db, "buyer");
    const e2 = String((await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1,$2) RETURNING id", [s.listingId, buyer2])).rows[0]!["id"]);
    expect(await bookSlot(t.db, buyer2, e2, startsAt, now(), notify)).toMatchObject({ ok: false });
    expect(await bookSlot(t.db, s.buyer, s.enquiryId, "2020-01-01T00:00:00Z", now(), notify)).toMatchObject({ ok: false });
    expect(await bookSlot(t.db, buyer2, s.enquiryId, startsAt, now(), notify)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("does not offer or book times when the owner turned inspections off", async () => {
    const s = await setup({ enabled: true, offerInspections: false, autoSend: false });
    await openWeek(s.listingId, s.owner);
    expect(await bookableTimes(t.db, s.buyer, s.enquiryId, now())).toEqual({ enabled: false, slots: [] });
    expect(await bookSlot(t.db, s.buyer, s.enquiryId, new Date(Date.now() + 3 * 86_400_000).toISOString(), now(), notify)).toMatchObject({ ok: false });
  });

  it("offers real times in the reply when the buyer asks to inspect", async () => {
    const s = await setup({ enabled: true, offerInspections: true, autoSend: true });
    await openWeek(s.listingId, s.owner);
    await handleBuyerMessage(t.db, await buyerSays(s, "Can I inspect it this week?"), now(), notify);
    expect(String((await thread(s.enquiryId))[1]!["body"])).toContain("Choose one below to book it");
  });

  it("the tick picks up buyer messages whose request was missed", async () => {
    const s = await setup();
    await t.db.query("UPDATE elena_enquiry_settings SET updated_at = now() - interval '1 hour' WHERE listing_id = $1", [s.listingId]);
    // a message from before the owner switched Elena on is left alone
    await t.db.query("INSERT INTO enquiry_message (enquiry_id, sender_user_id, automated, body, sent_at) VALUES ($1,$2,false,'Old question about parking?', now() - interval '2 hours')", [s.enquiryId, s.buyer]);
    await t.db.query("INSERT INTO enquiry_message (enquiry_id, sender_user_id, automated, body, sent_at) VALUES ($1,$2,false,'How many bedrooms?', now() - interval '5 minutes')", [s.enquiryId, s.buyer]);
    expect((await runDueElenaEnquiries(t.db, now(), notify)).handled).toBeGreaterThanOrEqual(1);
    expect((await listLogForOwner(t.db, s.owner, s.listingId)).length).toBe(1);
    expect((await runDueElenaEnquiries(t.db, now(), notify)).handled).toBe(0);
  });

  it("reminds the owner too, the day before", async () => {
    const s = await setup();
    await openWeek(s.listingId, s.owner);
    const startsAt = new Date(Date.now() + 20 * 3600_000);
    startsAt.setUTCMinutes(0, 0, 0);
    await t.db.query(
      "INSERT INTO open_inspection_booking (listing_id, buyer_id, buyer_name, buyer_email, starts_at, ends_at, created_at) VALUES ($1,$2,'Sam Buyer','sam@example.com',$3,$4, now() - interval '3 days')",
      [s.listingId, s.buyer, startsAt.toISOString(), new Date(startsAt.getTime() + 1_800_000).toISOString()]);
    await runOpenInspectionReminders(t.db, now(), {});
    const k = (await t.db.query("SELECT user_id, kind FROM notification WHERE kind IN ('open_inspection_reminder_24h','open_inspection_owner_reminder')")).rows.map(x => `${x["user_id"]}:${x["kind"]}`);
    expect(k).toContain(`${s.buyer}:open_inspection_reminder_24h`);
    expect(k).toContain(`${s.owner}:open_inspection_owner_reminder`);
  });

  it("the owner list is private to the owner and shows drafts as blockers", async () => {
    const owner = await addUser(t.db, "owner"), other = await addUser(t.db, "owner");
    await addListing(t.db, owner, { status: "draft", title: "Half done", created_at: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    const mine = await ownerToday(t.db, owner, now());
    expect(mine.find(i => i.kind === "listing_blocker")).toMatchObject({ title: "Finish and publish Half done", urgency: 3 });
    expect((await ownerToday(t.db, other, now())).length).toBe(0);
  });

  it("the daily digest goes once per local day, only when something needs the owner, and only if opted in", async () => {
    sent.length = 0;
    const owner = await addUser(t.db, "owner");
    await addListing(t.db, owner, { status: "draft", title: "Unfinished", created_at: "2026-11-17T00:00:00Z" });
    const morning = "2026-11-20T21:00:00Z"; // 8 am in Sydney
    expect((await runOwnerDigests(t.db, morning, notify)).sent).toBe(0); // not opted in
    await setDigest(t.db, owner, true);
    expect(await getDigest(t.db, owner)).toEqual({ enabled: true });
    expect((await runOwnerDigests(t.db, "2026-11-20T19:00:00Z", notify)).sent).toBe(0); // 6 am: too early
    expect((await runOwnerDigests(t.db, morning, notify)).sent).toBe(1);
    expect((await runOwnerDigests(t.db, "2026-11-21T01:00:00Z", notify)).sent).toBe(0); // same local day
    const d = sent.find(x => x.userId === owner && x.kind === "owner_digest")!;
    expect(d.params["title"]).toBe("1 thing needs you today");
    expect(d.params["link"]).toBe("/dashboard");
    await setDigest(t.db, owner, false);
    expect((await runOwnerDigests(t.db, "2026-11-21T21:00:00Z", notify)).sent).toBe(0);
  });
});

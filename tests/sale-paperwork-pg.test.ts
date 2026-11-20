import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSettlement, tickChecklistItem } from "../src/server/settlement-db";
import { loadPaperwork, paperworkView, runDuePaperwork, saveChaseSetting, type PaperSender } from "../src/server/sale-paperwork-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("Elena sale paperwork on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const hours = (base: string, h: number) => new Date(new Date(base).getTime() + h * 3600_000).toISOString();
  const outbox: { userId: string; title: string; body: string; link: string }[] = [];
  const sender: PaperSender = { async send(userId, title, body, link) { outbox.push({ userId, title, body, link }); return true; } };
  const one = async (sql: string, p: unknown[]) => String((await t.db.query(sql, p)).rows[0]!["id"]);

  async function setup(chase = true) {
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer");
    const listingId = await addListing(t.db, owner, { address_text: "12 Reef St, Newtown", status: "published" });
    const token = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [token, listingId, buyer]);
    const offerId = await one("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status) VALUES ($1,$2,80000000,30,4000000,true,$3,'accepted') RETURNING id", [listingId, buyer, token]);
    await t.db.query("INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id) VALUES ($1,'accepted','owner',$2)", [offerId, owner]);
    const r = await createSettlement(t.db, owner, offerId);
    if (!r.ok) throw new Error(r.error);
    if (chase) expect(await saveChaseSetting(t.db, owner, listingId, true)).toBe(true);
    return { owner, buyer, listingId, settlementId: r.value.id };
  }
  const sentTo = (id: string) => outbox.filter(o => o.userId === id);

  it("only the listing's owner can switch reminders on", async () => {
    const s = await setup(false);
    const stranger = await addUser(t.db, "owner");
    expect(await saveChaseSetting(t.db, stranger, s.listingId, true)).toBe(false);
    expect(await saveChaseSetting(t.db, s.owner, s.listingId, true)).toBe(true);
    const audit = (await t.db.query("SELECT payload FROM audit_event WHERE aggregate_id = $1 AND event_type = 'paperwork.chase_setting'", [s.listingId])).rows;
    expect(audit).toHaveLength(1);
  });

  it("builds the checklist from existing facts: contract open, current-stage buyer step open, later steps upcoming", async () => {
    const s = await setup();
    const d = (await loadPaperwork(t.db, s.listingId))!;
    expect(d.saleInProgress).toBe(true);
    const by = (k: string) => d.items.find(i => i.key === k)!;
    expect(by("contract-of-sale")).toMatchObject({ status: "open", blocks: "settlement" });
    expect(by("trust-account")).toMatchObject({ status: "open" });
    expect(d.items.find(i => i.label.startsWith("Arrange the deposit"))).toMatchObject({ party: "buyer", status: "open" });
    expect(d.items.find(i => i.label.startsWith("Final walkthrough"))!.status).toBe("upcoming");
    const view = await paperworkView(t.db, s.listingId, d);
    expect(view.chase).toBe(true);
    expect(view.note).toMatch(/not legal advice/);
  });

  it("reminds each person only about their own items, a day after the sale starts, then waits three days between reminders", async () => {
    outbox.length = 0;
    const now = new Date().toISOString();
    const s = await setup();
    await runDuePaperwork(t.db, now, sender);
    expect(sentTo(s.owner)).toHaveLength(0);                       // the clock starts, nobody is chased on the first sighting
    const r = await runDuePaperwork(t.db, hours(now, 25), sender);
    expect(r.sent).toBeGreaterThanOrEqual(2);
    const toOwner = sentTo(s.owner), toBuyer = sentTo(s.buyer);
    expect(toOwner).toHaveLength(1);
    expect(toBuyer).toHaveLength(1);
    expect(toOwner[0]!.body).toContain("Contract of sale");
    expect(toOwner[0]!.body).not.toContain("Arrange the deposit");
    expect(toBuyer[0]!.body).toContain("Arrange the deposit");
    expect(toBuyer[0]!.body).not.toContain("Contract of sale");
    expect(toBuyer[0]!.body).not.toMatch(/\$\s?\d|80,?000,?000|trust account/i);
    expect(toOwner[0]!.link).toBe(`/listings/${s.listingId}/paperwork`);
    expect(toBuyer[0]!.link).toBe(`/settlements/${s.settlementId}`);
    const logged = (await t.db.query("SELECT party, body FROM elena_paperwork_message WHERE listing_id = $1", [s.listingId])).rows;
    expect(logged.find(r => r["party"] === "buyer")!["body"]).toMatch(/^Hi there,/);   // the owner reads this log: no buyer name in it
    expect(logged.find(r => r["party"] === "owner")!["body"]).toMatch(/^Hi Test,/);
    await runDuePaperwork(t.db, hours(now, 26), sender);              // same day: nothing more
    await runDuePaperwork(t.db, hours(now, 24 + 60), sender);         // under three days after the first: nothing
    expect(sentTo(s.owner)).toHaveLength(1);
    await runDuePaperwork(t.db, hours(now, 25 + 73), sender);
    expect(sentTo(s.owner)).toHaveLength(2);
    expect(sentTo(s.owner)[1]!.title).toMatch(/Reminder/);
  });

  it("stops after three reminders and tells the owner, who is not told again", async () => {
    outbox.length = 0;
    const now = new Date().toISOString();
    const s = await setup();
    await runDuePaperwork(t.db, now, sender);
    for (let i = 0; i < 3; i++) await runDuePaperwork(t.db, hours(now, 25 + i * 73), sender);
    expect(sentTo(s.buyer)).toHaveLength(3);
    const stop = await runDuePaperwork(t.db, hours(now, 25 + 3 * 73), sender);
    expect(stop.stopped).toBeGreaterThanOrEqual(2);
    expect(sentTo(s.buyer)).toHaveLength(3);                          // the buyer is not sent a fourth
    expect(sentTo(s.owner).at(-1)!.title).toMatch(/stopped chasing/);
    const before = outbox.length;
    await runDuePaperwork(t.db, hours(now, 25 + 9 * 73), sender);
    expect(outbox.length).toBe(before);
    expect((await t.db.query("SELECT state FROM elena_paperwork_chase WHERE listing_id = $1", [s.listingId])).rows.map(r => r["state"])).toEqual(["stopped", "stopped"]);
  });

  it("stops the moment the person has finished, and does nothing when the owner has not switched it on", async () => {
    outbox.length = 0;
    const now = new Date().toISOString();
    const s = await setup();
    const off = await setup(false);
    await runDuePaperwork(t.db, now, sender);
    const t1 = await tickChecklistItem(t.db, s.buyer, s.settlementId, { stage: "deposit_received", role: "buyer", itemId: "buyer-0", done: true });
    expect(t1.ok).toBe(true);
    const r = await runDuePaperwork(t.db, hours(now, 25), sender);
    expect(r.done).toBeGreaterThanOrEqual(1);
    expect(sentTo(s.buyer)).toHaveLength(0);
    expect(sentTo(s.owner)).toHaveLength(1);
    expect(sentTo(off.owner)).toHaveLength(0);
    expect(sentTo(off.buyer)).toHaveLength(0);
    expect((await t.db.query("SELECT 1 FROM elena_paperwork_chase WHERE listing_id = $1", [off.listingId])).rows).toHaveLength(0);
  });

  it("a contract file counts once it is active, and the owner is no longer chased for it", async () => {
    outbox.length = 0;
    const now = new Date().toISOString();
    const s = await setup();
    await runDuePaperwork(t.db, now, sender);
    const prop = await one("INSERT INTO property (address_text, state) VALUES ('12 Reef St','NSW') RETURNING id", []);
    await t.db.query("INSERT INTO property_document (property_id, listing_id, kind, storage_key, sha256, uploaded_by, source, declared_mime, size_bytes, status) VALUES ($1,$2,'contract','k',$3,$4,'owner_supplied','application/pdf',1000,'held')", [prop, s.listingId, "a".repeat(64), s.owner]);
    expect((await loadPaperwork(t.db, s.listingId))!.items.find(i => i.key === "contract-of-sale")!.status).toBe("open"); // a held file does not count
    await t.db.query("UPDATE property_document SET status = 'active' WHERE listing_id = $1", [s.listingId]);
    expect((await loadPaperwork(t.db, s.listingId))!.items.find(i => i.key === "contract-of-sale")!.status).toBe("done");
    await runDuePaperwork(t.db, hours(now, 25), sender);
    expect(sentTo(s.owner).length === 0 || !sentTo(s.owner).some(o => o.body.includes("Contract of sale"))).toBe(true);
  });

  it("the log is permanent, delivery failures are recorded, and a failed send still counts toward the three", async () => {
    outbox.length = 0;
    const now = new Date().toISOString();
    const s = await setup();
    const failing: PaperSender = { async send() { return false; } };
    await runDuePaperwork(t.db, now, failing);
    await runDuePaperwork(t.db, hours(now, 25), failing);
    const log = (await t.db.query("SELECT id, status, kind FROM elena_paperwork_message WHERE listing_id = $1", [s.listingId])).rows;
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log.every(r => r["status"] === "failed")).toBe(true);
    await expect(t.db.query("UPDATE elena_paperwork_message SET body = 'x' WHERE id = $1", [log[0]!["id"]])).rejects.toThrow();
    await expect(t.db.query("DELETE FROM elena_paperwork_message WHERE id = $1", [log[0]!["id"]])).rejects.toThrow();
    expect((await t.db.query("SELECT reminders FROM elena_paperwork_chase WHERE listing_id = $1 AND party = 'owner'", [s.listingId])).rows[0]!["reminders"]).toBe(1);
  });
});

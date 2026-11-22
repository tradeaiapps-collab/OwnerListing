import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSettlement, updateMilestone } from "../src/server/settlement-db";
import { inbox, markRead, sendMessage, setArchived, setMuted, threadMessages } from "../src/server/transaction-message-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("sale messaging on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });
  const env = {};
  const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
  const one = async (sql: string, p: unknown[]) => String((await t.db.query(sql, p)).rows[0]!["id"]);

  async function setup() {
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer"), agent = await addUser(t.db, "agent"), stranger = await addUser(t.db, "buyer");
    const listingId = await addListing(t.db, owner, { title: "12 Reef St", jurisdiction: "NSW" });
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3)", [listingId, agent, owner]);
    const token = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [token, listingId, buyer]);
    const offerId = await one("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status) VALUES ($1,$2,80000000,30,4000000,true,$3,'accepted') RETURNING id", [listingId, buyer, token]);
    await t.db.query("INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, occurred_at) VALUES ($1,'accepted','owner',$2, now())", [offerId, owner]);
    const id = must(await createSettlement(t.db, owner, offerId)).id;
    return { owner, buyer, agent, stranger, id };
  }
  const notified = async (userId: string) => Number((await t.db.query("SELECT count(*) AS n FROM notification WHERE user_id = $1 AND kind = 'message_received'", [userId])).rows[0]!["n"]);

  it("opens a thread with the sale, lets only the three parties in, and keeps messages permanent", async () => {
    const s = await setup();
    const first = must(await threadMessages(t.db, s.buyer, s.id));
    expect(first.title).toBe("12 Reef St - Offer from Test buyer");
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({ type: "system", sender: null });
    expect(first.people.map(p => p.role)).toEqual(["buyer", "seller", "agent"]);
    expect((await threadMessages(t.db, s.stranger, s.id)).ok).toBe(false);
    expect((await sendMessage(t.db, s.stranger, s.id, { body: "hi", replyToId: null }, env)).ok).toBe(false);
    must(await sendMessage(t.db, s.buyer, s.id, { body: "Is the inspection booked?", replyToId: null }, env));
    await expect(t.db.query("UPDATE transaction_messages SET body = 'x' WHERE thread_id = $1", [s.id])).rejects.toThrow(/permanent record/);
    await expect(t.db.query("DELETE FROM transaction_messages WHERE thread_id = $1", [s.id])).rejects.toThrow(/permanent record/);
  });

  it("tracks unread per person, marks read, and shows it in the inbox", async () => {
    const s = await setup();
    const sent = must(await sendMessage(t.db, s.buyer, s.id, { body: "Hello team", replyToId: null }, env));
    must(await sendMessage(t.db, s.owner, s.id, { body: "Hi @buyer, yes", replyToId: sent.id }, env));
    const ownerView = must(await threadMessages(t.db, s.owner, s.id));
    expect(ownerView.messages.filter(m => m.unread)).toEqual([]); // replying counts as having read what came before
    expect(must(await threadMessages(t.db, s.buyer, s.id)).messages.filter(m => m.unread).map(m => m.body)).toEqual(["Hi @buyer, yes"]);
    expect(ownerView.messages.at(-1)).toMatchObject({ type: "mention", mentions: ["buyer"], mine: true, replyTo: { id: sent.id } });
    const row = (await inbox(t.db, s.agent)).threads.find(x => x.id === s.id)!;
    expect(row).toMatchObject({ role: "agent", unread: 3, kind: "transaction" });
    must(await markRead(t.db, s.agent, s.id));
    expect((await inbox(t.db, s.agent)).unread).toBe(0);
    expect((await inbox(t.db, s.stranger)).threads).toEqual([]);
    expect((await sendMessage(t.db, s.owner, s.id, { body: "x", replyToId: randomUUID() }, env))).toMatchObject({ ok: false, status: 404 });
  });

  it("alerts others once while they have unread, always on a mention, never when muted, and not the sender", async () => {
    const s = await setup();
    must(await sendMessage(t.db, s.buyer, s.id, { body: "one", replyToId: null }, env));
    must(await sendMessage(t.db, s.buyer, s.id, { body: "two", replyToId: null }, env));
    expect(await notified(s.owner)).toBe(1);
    expect(await notified(s.buyer)).toBe(0);
    must(await sendMessage(t.db, s.buyer, s.id, { body: "@seller please look", replyToId: null }, env));
    expect(await notified(s.owner)).toBe(2);
    must(await setMuted(t.db, s.agent, s.id, true));
    must(await markRead(t.db, s.agent, s.id));
    must(await sendMessage(t.db, s.buyer, s.id, { body: "@agent ping", replyToId: null }, env));
    expect(await notified(s.agent)).toBe(1);
    const row = (await inbox(t.db, s.agent)).threads.find(x => x.id === s.id)!;
    expect(row.muted).toBe(true);
  });

  it("archives and reopens, refusing messages while archived", async () => {
    const s = await setup();
    must(await setArchived(t.db, s.owner, s.id, true));
    expect(await sendMessage(t.db, s.buyer, s.id, { body: "late", replyToId: null }, env)).toMatchObject({ ok: false, status: 409 });
    expect(must(await threadMessages(t.db, s.buyer, s.id)).archived).toBe(true);
    expect((await setArchived(t.db, s.stranger, s.id, false)).ok).toBe(false);
    must(await setArchived(t.db, s.owner, s.id, false));
    expect((await sendMessage(t.db, s.buyer, s.id, { body: "back", replyToId: null }, env)).ok).toBe(true);
  });

  it("posts system notes when stages move, in the same transaction", async () => {
    const s = await setup();
    must(await updateMilestone(t.db, s.owner, s.id, { stage: "deposit_received", status: "completed" }));
    const msgs = must(await threadMessages(t.db, s.buyer, s.id)).messages;
    expect(msgs.at(-1)).toMatchObject({ type: "system", mentions: ["seller"] });
    expect(msgs.at(-1)!.body).toContain("→");
    expect((await updateMilestone(t.db, s.buyer, s.id, { stage: "cooling_off_expires", status: "completed" })).ok).toBe(false);
    expect(must(await threadMessages(t.db, s.buyer, s.id)).messages).toHaveLength(msgs.length);
  });

  it("gives staff the team channels by permission and keeps deals out of reach", async () => {
    const s = await setup();
    const staff = await addUser(t.db, "admin");
    const viewer = { staffPermissions: ["case.manage"] as readonly string[] };
    const list = (await inbox(t.db, staff, viewer)).threads;
    expect(list.map(x => x.title).sort()).toEqual(["#disputes", "#general", "#inspections"]);
    const disputes = list.find(x => x.title === "#disputes")!;
    must(await sendMessage(t.db, staff, disputes.id, { body: "Case 42 needs a second person @buyer", replyToId: null }, env, viewer));
    expect(must(await threadMessages(t.db, staff, disputes.id, viewer)).messages[0]).toMatchObject({ body: expect.stringContaining("Case 42"), mentions: [], sender: { name: "Test admin" } });
    expect((await threadMessages(t.db, staff, disputes.id, { staffPermissions: ["report.sales"] })).ok).toBe(false);
    expect((await threadMessages(t.db, s.buyer, disputes.id)).ok).toBe(false);
    expect((await threadMessages(t.db, staff, s.id, viewer)).ok).toBe(false);
    expect((await setArchived(t.db, staff, disputes.id, true, viewer))).toMatchObject({ ok: false, status: 409 });
    expect((await inbox(t.db, s.buyer)).threads.some(x => x.kind === "channel")).toBe(false);
  });
});

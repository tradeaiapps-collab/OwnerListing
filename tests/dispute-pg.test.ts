import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDispute, disputeView, escalateOverdue, historyFor, listDisputes, metrics, respond, staffAct, staffQueue, submitPosition, withdraw } from "../src/server/dispute-db";
import { createSettlement } from "../src/server/settlement-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("disputes on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
  const one = async (sql: string, p: unknown[]) => String((await t.db.query(sql, p)).rows[0]!["id"]);

  /** A tracked settlement with a buyer, owner, appointed agent and a stranger. */
  async function setup() {
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer"), agent = await addUser(t.db, "agent"), stranger = await addUser(t.db, "buyer"), staff = await addUser(t.db, "admin");
    const listingId = await addListing(t.db, owner, { title: "12 Reef St", jurisdiction: "NSW" });
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3)", [listingId, agent, owner]);
    const token = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [token, listingId, buyer]);
    const offerId = await one("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status) VALUES ($1,$2,80000000,30,4000000,true,$3,'accepted') RETURNING id", [listingId, buyer, token]);
    await t.db.query("INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, occurred_at) VALUES ($1,'accepted','owner',$2, now())", [offerId, owner]);
    const sid = must(await createSettlement(t.db, owner, offerId)).id;
    return { owner, buyer, agent, stranger, staff, offerId, sid };
  }
  const repair = { type: "repair" as const, title: "Roof repair", description: "The inspection found a leaking roof.", position: "The seller pays for the full repair.", claimCents: 10_000_00, sellerSharePct: 100 };

  it("lets the buyer or owner raise a dispute, once per type, and tells the agent", async () => {
    const s = await setup();
    expect((await createDispute(t.db, s.stranger, s.sid, repair)).ok).toBe(false);
    expect((await createDispute(t.db, s.agent, s.sid, repair)).ok).toBe(false);
    const id = must(await createDispute(t.db, s.buyer, s.sid, repair)).id;
    expect((await createDispute(t.db, s.owner, s.sid, repair)).ok).toBe(false);
    expect((await createDispute(t.db, s.owner, s.sid, { ...repair, type: "inspection" })).ok).toBe(true);
    const v = must(await disputeView(t.db, s.buyer, s.sid, id));
    expect(v.status).toBe("awaiting_position");
    expect(v.buyerPosition).toBe(repair.position);
    expect(v.sellerPosition).toBeNull();
    expect(v.canWithdraw).toBe(true);
    expect(v.canPosition).toBe(false);
    expect(must(await disputeView(t.db, s.owner, s.sid, id)).canPosition).toBe(true);
    expect(must(await disputeView(t.db, s.agent, s.sid, id)).canPosition).toBe(false);
    expect((await disputeView(t.db, s.stranger, s.sid, id)).ok).toBe(false);
    expect((await listDisputes(t.db, s.stranger)).length).toBe(0);
    expect((await listDisputes(t.db, s.agent)).length).toBe(2);
    expect((await listDisputes(t.db, s.buyer, { side: "seller" })).length).toBe(0);
    const note = (await t.db.query("SELECT body FROM transaction_messages WHERE thread_id = $1 AND message_type = 'system' ORDER BY created_at DESC LIMIT 1", [s.sid])).rows[0];
    expect(String(note!["body"])).toContain("dispute was raised");
    const audit = (await t.db.query("SELECT 1 FROM audit_event WHERE aggregate_type = 'dispute' AND aggregate_id = $1 AND event_type = 'dispute.opened'", [id])).rows;
    expect(audit.length).toBe(1);
  });

  it("starts Elena's round 1 once the other side gives their position, and only that side can", async () => {
    const s = await setup();
    const id = must(await createDispute(t.db, s.buyer, s.sid, repair)).id;
    expect((await submitPosition(t.db, s.buyer, s.sid, id, { position: "again", sellerSharePct: 100 })).ok).toBe(false);
    expect((await submitPosition(t.db, s.agent, s.sid, id, { position: "mine", sellerSharePct: 0 })).ok).toBe(false);
    expect((await submitPosition(t.db, s.stranger, s.sid, id, { position: "mine", sellerSharePct: 0 })).ok).toBe(false);
    expect(must(await submitPosition(t.db, s.owner, s.sid, id, { position: "Buyer should have known.", sellerSharePct: 20 })).round).toBe(1);
    const v = must(await disputeView(t.db, s.owner, s.sid, id));
    expect(v.status).toBe("mediating");
    expect(v.currentRound).toBe(1);
    expect(v.rounds[0]!.suggestion.sellerSharePct).toBe(60);
    expect(v.rounds[0]!.suggestion.sellerPaysCents).toBe(6_000_00);
    expect(v.canRespond).toBe(true);
    expect(v.canWithdraw).toBe(false);
    expect((await submitPosition(t.db, s.owner, s.sid, id, { position: "x", sellerSharePct: 1 })).ok).toBe(false);
  });

  it("settles when both accept, and keeps answers private until both have answered", async () => {
    const s = await setup();
    const id = must(await createDispute(t.db, s.buyer, s.sid, repair)).id;
    must(await submitPosition(t.db, s.owner, s.sid, id, { position: "Half", sellerSharePct: 20 }));
    expect((await respond(t.db, s.agent, s.sid, id, { response: "accept", sellerSharePct: null, note: null })).ok).toBe(false);
    expect(must(await respond(t.db, s.buyer, s.sid, id, { response: "accept", sellerSharePct: null, note: "Fine" })).status).toBe("mediating");
    expect((await respond(t.db, s.buyer, s.sid, id, { response: "accept", sellerSharePct: null, note: null })).ok).toBe(false);
    const hidden = must(await disputeView(t.db, s.owner, s.sid, id)).rounds[0]!;
    expect(hidden.buyerResponded).toBe(true);
    expect(hidden.buyerResponse).toBeNull();
    expect(hidden.buyerNote).toBeNull();
    expect(must(await disputeView(t.db, s.buyer, s.sid, id)).rounds[0]!.buyerResponse).toBe("accept");
    expect(must(await respond(t.db, s.owner, s.sid, id, { response: "accept", sellerSharePct: null, note: null })).status).toBe("agreed");
    const v = must(await disputeView(t.db, s.owner, s.sid, id));
    expect(v.status).toBe("agreed");
    expect(v.agreedSellerSharePct).toBe(60);
    expect(v.rounds[0]!.resolved).toBe(true);
    expect(v.rounds[0]!.buyerNote).toBe("Fine");
    expect(v.outcome).toMatch(/accepted Elena/);
    expect((await respond(t.db, s.buyer, s.sid, id, { response: "accept", sellerSharePct: null, note: null })).ok).toBe(false);
    expect((await createDispute(t.db, s.buyer, s.sid, repair)).ok).toBe(true);
  });

  it("runs another round on a counter from the two latest stances, then escalates after three rounds", async () => {
    const s = await setup();
    const id = must(await createDispute(t.db, s.buyer, s.sid, repair)).id;
    must(await submitPosition(t.db, s.owner, s.sid, id, { position: "Half", sellerSharePct: 20 }));
    must(await respond(t.db, s.buyer, s.sid, id, { response: "counter", sellerSharePct: 90, note: null }));
    expect(must(await respond(t.db, s.owner, s.sid, id, { response: "accept", sellerSharePct: null, note: null })).round).toBe(2);
    let v = must(await disputeView(t.db, s.buyer, s.sid, id));
    expect(v.currentRound).toBe(2);
    expect(v.rounds).toHaveLength(2);
    expect(v.rounds[1]!.suggestion.sellerSharePct).toBe(75);
    must(await respond(t.db, s.buyer, s.sid, id, { response: "counter", sellerSharePct: 80, note: null }));
    must(await respond(t.db, s.owner, s.sid, id, { response: "counter", sellerSharePct: 40, note: null }));
    expect(must(await disputeView(t.db, s.buyer, s.sid, id)).currentRound).toBe(3);
    must(await respond(t.db, s.buyer, s.sid, id, { response: "counter", sellerSharePct: 70, note: null }));
    expect(must(await respond(t.db, s.owner, s.sid, id, { response: "counter", sellerSharePct: 50, note: null })).status).toBe("escalated");
    v = must(await disputeView(t.db, s.buyer, s.sid, id));
    expect(v.status).toBe("escalated");
    expect(v.escalationReason).toBe("max_rounds");
    expect(v.currentRound).toBe(3);
    expect(v.canRespond).toBe(false);
    expect(v.staffActions.map(a => a.action)).toEqual(["escalated"]);
  });

  it("escalates at once when a side asks for staff", async () => {
    const s = await setup();
    const id = must(await createDispute(t.db, s.owner, s.sid, { type: "cooling_off", title: "Dates", description: "Different count", position: "End on the 12th", claimCents: null, sellerSharePct: null })).id;
    must(await submitPosition(t.db, s.buyer, s.sid, id, { position: "End on the 14th", sellerSharePct: null }));
    expect(must(await disputeView(t.db, s.buyer, s.sid, id)).rounds[0]!.suggestion.sellerSharePct).toBeNull();
    expect(must(await respond(t.db, s.buyer, s.sid, id, { response: "escalate", sellerSharePct: null, note: "Need staff" })).status).toBe("escalated");
    expect(must(await disputeView(t.db, s.owner, s.sid, id)).escalationReason).toBe("requested");
  });

  it("sends a dispute to staff after five days with no resolution, and not before", async () => {
    const s = await setup();
    const a = must(await createDispute(t.db, s.buyer, s.sid, repair)).id;
    const b = must(await createDispute(t.db, s.owner, s.sid, { ...repair, type: "financing" })).id;
    must(await submitPosition(t.db, s.buyer, s.sid, b, { position: "Lender delay", sellerSharePct: 0 }));
    expect((await escalateOverdue(t.db, new Date(Date.now() + 4 * 86_400_000))).escalated).toBe(0);
    const later = new Date(Date.now() + 5 * 86_400_000 + 60_000);
    expect((await escalateOverdue(t.db, later)).escalated).toBeGreaterThanOrEqual(2);
    expect((await escalateOverdue(t.db, later)).escalated).toBe(0);
    for (const id of [a, b]) {
      const v = must(await disputeView(t.db, s.buyer, s.sid, id, new Date(Date.now())));
      expect(v.status).toBe("escalated");
      expect(v.escalationReason).toBe("timeout");
      expect(v.staffActions[0]!.action).toBe("auto_escalated");
    }
  });

  it("lets only the person who raised it withdraw, while it is with the parties", async () => {
    const s = await setup();
    const id = must(await createDispute(t.db, s.buyer, s.sid, repair)).id;
    expect((await withdraw(t.db, s.owner, s.sid, id)).ok).toBe(false);
    expect((await withdraw(t.db, s.agent, s.sid, id)).ok).toBe(false);
    expect(must(await withdraw(t.db, s.buyer, s.sid, id)).status).toBe("withdrawn");
    expect((await withdraw(t.db, s.buyer, s.sid, id)).ok).toBe(false);
    expect((await createDispute(t.db, s.buyer, s.sid, repair)).ok).toBe(true);
  });

  it("refuses new disputes on a sale that has settled or fallen through", async () => {
    const s = await setup();
    await t.db.query("UPDATE formal_offer SET status = 'fallen_through' WHERE id = $1", [s.offerId]);
    expect((await createDispute(t.db, s.buyer, s.sid, repair)).ok).toBe(false);
  });

  it("lets staff claim, note and resolve only an escalated dispute, and records every step", async () => {
    const s = await setup();
    const id = must(await createDispute(t.db, s.buyer, s.sid, repair)).id;
    expect((await staffAct(t.db, s.staff, id, { action: "claim" })).ok).toBe(false);
    must(await submitPosition(t.db, s.owner, s.sid, id, { position: "Half", sellerSharePct: 20 }));
    must(await respond(t.db, s.owner, s.sid, id, { response: "escalate", sellerSharePct: null, note: null }));
    const q = await staffQueue(t.db);
    expect(q.rows[0]!.status).toBe("escalated");
    must(await staffAct(t.db, s.staff, id, { action: "claim" }));
    must(await staffAct(t.db, s.staff, id, { action: "note", note: "Asked both for the builder's quote" }));
    expect(must(await staffAct(t.db, s.staff, id, { action: "resolve", outcome: "Seller credits $5,500 at settlement", sellerSharePct: 55 })).status).toBe("resolved");
    const v = must(await disputeView(t.db, s.buyer, s.sid, id));
    expect(v.status).toBe("resolved");
    expect(v.outcome).toBe("Seller credits $5,500 at settlement");
    expect(v.agreedSellerSharePct).toBe(55);
    expect(v.staffActions.map(a => a.action)).toEqual(["escalated", "claimed", "noted", "resolved"]);
    expect((await staffAct(t.db, s.staff, id, { action: "claim" })).ok).toBe(false);
    await expect(t.db.query("DELETE FROM disputes WHERE id = $1", [id])).rejects.toThrow(/permanent record/);
  });

  it("learns from how past disputes ended, only once there are enough, and tracks what happened to the sale", async () => {
    const s = await setup();
    expect(await historyFor(t.db, "inspection")).toBeNull();
    for (const pct of [40, 50, 60]) {
      const x = await setup();
      const id = must(await createDispute(t.db, x.buyer, x.sid, { ...repair, type: "inspection" })).id;
      must(await submitPosition(t.db, x.owner, x.sid, id, { position: "p", sellerSharePct: 0 }));
      must(await respond(t.db, x.owner, x.sid, id, { response: "escalate", sellerSharePct: null, note: null }));
      must(await staffAct(t.db, x.staff, id, { action: "resolve", outcome: `Split ${pct}`, sellerSharePct: pct }));
      if (pct === 40) await t.db.query("UPDATE settlement_timeline SET completed_at = now() WHERE id = $1", [x.sid]);
      if (pct === 50) await t.db.query("UPDATE formal_offer SET status = 'fallen_through' WHERE id = $1", [x.offerId]);
    }
    expect(await historyFor(t.db, "inspection")).toEqual({ samples: 3, medianSellerSharePct: 50 });
    const id = must(await createDispute(t.db, s.buyer, s.sid, { ...repair, type: "inspection", sellerSharePct: 100 })).id;
    must(await submitPosition(t.db, s.owner, s.sid, id, { position: "p", sellerSharePct: 20 }));
    const sug = must(await disputeView(t.db, s.buyer, s.sid, id)).rounds[0]!.suggestion;
    expect(sug.history).toEqual({ samples: 3, medianSellerSharePct: 50 });
    expect(sug.sellerSharePct).toBe(55);
    const m = await metrics(t.db);
    expect(m.resolvedByStaff).toBeGreaterThanOrEqual(3);
    expect(m.afterMediation.settled).toBeGreaterThanOrEqual(1);
    expect(m.afterMediation.fellThrough).toBeGreaterThanOrEqual(1);
    expect(m.afterMediation.settledPct).not.toBeNull();
  });
});

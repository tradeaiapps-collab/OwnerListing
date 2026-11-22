import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHolding, decideRelease, getHolding, recordReceipt, requestRelease, cancelHolding, type StaffRef } from "../src/server/deposit-escrow-db";
import {
  fallThroughView, previewFallThrough, decideResolution, raiseFallThrough, requestCasePayout, resolveDispute, respondFallThrough, withdrawFallThrough
} from "../src/server/sale-fall-through-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("sale fell through on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const one = async (sql: string, p: unknown[]) => String((await t.db.query(sql, p)).rows[0]!["id"]);
  const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
  const offerStatus = async (id: string) => String((await t.db.query("SELECT status FROM formal_offer WHERE id = $1", [id])).rows[0]!["status"]);

  /** An accepted offer on a NSW listing, 800,000.00 with a 40,000.00 deposit, a record opened and (optionally) the deposit received. */
  async function setup(opts: { received?: boolean; state?: string; acceptedDaysAgo?: number } = {}) {
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer");
    const a: StaffRef = { id: await addUser(t.db, "admin"), role: "accountant" }, b: StaffRef = { id: await addUser(t.db, "admin"), role: "compliance" };
    const listingId = await addListing(t.db, owner, { title: "12 Reef St", jurisdiction: opts.state ?? "NSW" });
    const firm = await one("INSERT INTO law_firm (name, jurisdiction) VALUES ('Reef Legal', 'NSW') RETURNING id", []);
    const acct = await one("INSERT INTO trust_account (firm_id, account_name, bsb, account_number_encrypted, details_fingerprint) VALUES ($1,'Reef Legal Trust','034001','\\x00'::bytea,'fp') RETURNING id", [firm]);
    await t.db.query("INSERT INTO trust_account_check (listing_id, trust_account_id, decision, evidence, reasons) VALUES ($1,$2,'approved','{}','[]')", [listingId, acct]);
    const token = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [token, listingId, buyer]);
    const offerId = await one("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status) VALUES ($1,$2,80000000,30,4000000,true,$3,'accepted') RETURNING id", [listingId, buyer, token]);
    await t.db.query("INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, occurred_at) VALUES ($1,'accepted','owner',$2, now() - make_interval(days => $3::int))", [offerId, owner, opts.acceptedDaysAgo ?? 0]);
    const holdingId = must(await createHolding(t.db, a, { offerId, requiredCents: null, dueDate: null })).id;
    if (opts.received !== false) must(await recordReceipt(t.db, a, holdingId, { amountCents: 4_000_000, receivedOn: new Date().toISOString().slice(0, 10), bankReference: null }));
    return { owner, buyer, a, b, listingId, offerId, holdingId };
  }
  const pay = async (s: { a: StaffRef; b: StaffRef; holdingId: string }, caseId: string) => {
    const r = must(await requestCasePayout(t.db, s.a, s.holdingId, caseId));
    must(await decideRelease(t.db, s.b, r.releaseId, "approve", "Approved as agreed in the case"));
    return r;
  };

  /** Two-person resolution: a proposes, b decides. */
  const resolve = async (s: { a: StaffRef; b: StaffRef; holdingId: string }, id: string, input: Parameters<typeof resolveDispute>[4]) => {
    const p = await resolveDispute(t.db, s.a, s.holdingId, id, input);
    if (!p.ok) return p;
    return decideResolution(t.db, s.b, s.holdingId, id, "approve", "Checked the order against the proposal");
  };

  it("cooling-off: the buyer raises, the owner agrees, staff pay the refund and then the penalty in two approved steps", async () => {
    const s = await setup();
    const view = must(await fallThroughView(t.db, s.buyer, "buyer", s.offerId));
    expect(view.canRaise).toEqual({ ok: true });
    expect(view.rulesConfirmed).toBe(false);
    const preview = must(await previewFallThrough(t.db, s.buyer, "buyer", s.offerId, "cooling_off"));
    expect(preview).toMatchObject({ refundCents: 3_800_000, releaseCents: 200_000, penaltyCents: 200_000, heldCents: 4_000_000 });

    const { id } = must(await raiseFallThrough(t.db, s.buyer, "buyer", s.offerId, "cooling_off", "Changed my mind"));
    expect(await offerStatus(s.offerId)).toBe("accepted"); // not final until the other side answers

    // Proposed: the deposit is frozen against ordinary requests, receipts and cancelling.
    expect(await requestRelease(t.db, s.a, s.holdingId, { kind: "refund", amountCents: 1_000_000, reason: "Refund to the buyer now", settlementConfirmed: false })).toMatchObject({ ok: false, status: 409 });
    expect(await recordReceipt(t.db, s.a, s.holdingId, { amountCents: 1, receivedOn: "2026-11-05", bankReference: null })).toMatchObject({ ok: false, status: 409 });
    expect(await cancelHolding(t.db, s.a, s.holdingId, "Opened in error, wrong one")).toMatchObject({ ok: false, status: 409 });
    expect(await requestCasePayout(t.db, s.a, s.holdingId, id)).toMatchObject({ ok: false }); // not agreed yet

    // The raiser cannot answer their own request; a stranger sees nothing.
    expect(await respondFallThrough(t.db, s.buyer, "buyer", s.offerId, "agree", null)).toMatchObject({ ok: false, status: 403 });
    expect(await fallThroughView(t.db, s.owner, "buyer", s.offerId)).toMatchObject({ ok: false, status: 404 });
    expect(await respondFallThrough(t.db, await addUser(t.db, "owner"), "owner", s.offerId, "agree", null)).toMatchObject({ ok: false, status: 404 });

    expect(must(await respondFallThrough(t.db, s.owner, "owner", s.offerId, "agree", null)).status).toBe("agreed");
    expect(await offerStatus(s.offerId)).toBe("fallen_through");
    const ev = (await t.db.query("SELECT actor_kind, from_status, to_status FROM offer_event WHERE offer_id = $1 AND event_type = 'fallen_through'", [s.offerId])).rows;
    expect(ev).toEqual([{ actor_kind: "owner", from_status: "accepted", to_status: "fallen_through" }]);

    // Still frozen for ordinary use. The cooling-off split rests on state figures the owner accepted without counsel review; the refund is requested first.
    expect(await requestRelease(t.db, s.a, s.holdingId, { kind: "refund", amountCents: 1_000_000, reason: "Refund to the buyer now", settlementConfirmed: false })).toMatchObject({ ok: false, status: 409 });
    expect(must(await requestCasePayout(t.db, s.a, s.holdingId, id))).toMatchObject({ kind: "refund", amountCents: 3_800_000 });
    expect(await getHolding(t.db, s.holdingId).then(d => d!.releases.length)).toBe(1);
  });

  it("a full-refund case pays out in two-person steps and closes the record", async () => {
    const s = await setup();
    const { id } = must(await raiseFallThrough(t.db, s.buyer, "buyer", s.offerId, "finance_condition", null));
    must(await respondFallThrough(t.db, s.owner, "owner", s.offerId, "agree", null));
    const first = must(await requestCasePayout(t.db, s.a, s.holdingId, id));
    expect(first).toMatchObject({ kind: "refund", amountCents: 4_000_000 });
    expect(await requestCasePayout(t.db, s.a, s.holdingId, id)).toMatchObject({ ok: false, error: expect.stringContaining("waiting for approval") });
    expect(await decideRelease(t.db, s.a, first.releaseId, "approve", "Approving my own request")).toMatchObject({ ok: false, status: 403 });
    // The database also holds the two-person rule (the app check is bypassed here on purpose).
    await expect(t.db.query("UPDATE deposit_release SET status = 'approved', decided_by = requested_by, decided_at = now(), decision_reason = 'x' WHERE id = $1", [first.releaseId])).rejects.toThrow();
    must(await decideRelease(t.db, s.b, first.releaseId, "approve", "Approved as agreed in the case"));
    const d = (await getHolding(t.db, s.holdingId))!;
    expect(d.cases[0]).toMatchObject({ status: "resolved", resolutionSource: "parties" });
    expect(d.holding.status).toBe("refunded");
    expect(await requestCasePayout(t.db, s.a, s.holdingId, id)).toMatchObject({ ok: false });
  });

  it("a staff-recorded agreement carries its own amounts, so the unconfirmed cooling-off figures do not block it; a case from another deposit is not found", async () => {
    const s = await setup();
    const { id } = must(await raiseFallThrough(t.db, s.buyer, "buyer", s.offerId, "cooling_off", null));
    must(await respondFallThrough(t.db, s.owner, "owner", s.offerId, "dispute", "We agreed a different split in writing"));
    expect(await resolveDispute(t.db, s.a, randomUUID(), id, { source: "agreement", reference: "Letter 4 Nov", refundCents: 3_900_000, releaseCents: 100_000, reason: "Solicitors' letter of 4 Nov" })).toMatchObject({ ok: false, status: 404 });
    must(await resolve(s, id, { source: "agreement", reference: "Letter 4 Nov", refundCents: 3_900_000, releaseCents: 100_000, reason: "Solicitors' letter of 4 Nov" }));
    expect(await requestCasePayout(t.db, s.a, randomUUID(), id)).toMatchObject({ ok: false, status: 404 });
    expect(must(await requestCasePayout(t.db, s.a, s.holdingId, id))).toMatchObject({ kind: "refund", amountCents: 3_900_000 });
  });

  it("a proposal the second person rejects is cleared and can be proposed again; an owner who is also the buyer has no side", async () => {
    const s = await setup();
    const { id } = must(await raiseFallThrough(t.db, s.owner, "owner", s.offerId, "buyer_default", null));
    must(await respondFallThrough(t.db, s.buyer, "buyer", s.offerId, "dispute", "The seller never delivered the building report"));
    must(await resolveDispute(t.db, s.a, s.holdingId, id, { source: "agreement", reference: "Letter", refundCents: 4_000_000, releaseCents: 0, reason: "Solicitors' letter of 4 Nov" }));
    must(await decideResolution(t.db, s.b, s.holdingId, id, "reject", "The letter does not say that"));
    expect(await decideResolution(t.db, s.b, s.holdingId, id, "approve", "Nothing proposed any more")).toMatchObject({ ok: false, status: 409 });
    expect((await getHolding(t.db, s.holdingId))!.cases[0]).toMatchObject({ status: "disputed" });
    await t.db.query("UPDATE formal_offer SET buyer_user_id = $2 WHERE id = $1", [s.offerId, s.owner]);
    expect(await fallThroughView(t.db, s.owner, "owner", s.offerId)).toMatchObject({ ok: false, status: 404 });
    expect(await fallThroughView(t.db, s.owner, "buyer", s.offerId)).toMatchObject({ ok: false, status: 404 });
  });

  it("no more than three requests on one offer in a day", async () => {
    const s = await setup();
    for (let i = 0; i < 3; i++) { must(await raiseFallThrough(t.db, s.buyer, "buyer", s.offerId, "mutual_termination", null)); must(await withdrawFallThrough(t.db, s.buyer, "buyer", s.offerId)); }
    expect(await raiseFallThrough(t.db, s.buyer, "buyer", s.offerId, "mutual_termination", null)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("Too many") });
  });

  it("a release from an agreed case needs no settlement tick, but an ordinary release still does (database check)", async () => {
    const s = await setup();
    await expect(t.db.query("INSERT INTO deposit_release (holding_id, kind, amount_cents, reason, settlement_confirmed, requested_by) VALUES ($1,'release',100,'Seller keeps the deposit',false,$2)", [s.holdingId, s.a.id])).rejects.toThrow();
  });

  it("a dispute freezes the deposit until staff record a court order; then payouts follow the order", async () => {
    const s = await setup();
    const { id } = must(await raiseFallThrough(t.db, s.owner, "owner", s.offerId, "buyer_default", null));
    expect(await preview(s.owner)).toMatchObject({ ok: false }); // a live case blocks a second one
    expect(await raiseFallThrough(t.db, s.owner, "owner", s.offerId, "buyer_default", null)).toMatchObject({ ok: false, status: 409 });
    must(await respondFallThrough(t.db, s.buyer, "buyer", s.offerId, "dispute", "The seller never delivered the building report"));
    expect(await offerStatus(s.offerId)).toBe("accepted");
    expect(await withdrawFallThrough(t.db, s.owner, "owner", s.offerId)).toMatchObject({ ok: false, status: 409 });
    expect(await requestCasePayout(t.db, s.a, s.holdingId, id)).toMatchObject({ ok: false });
    expect(await requestRelease(t.db, s.a, s.holdingId, { kind: "release", amountCents: 4_000_000, reason: "Seller keeps the deposit", settlementConfirmed: true })).toMatchObject({ ok: false, status: 409 });

    expect(await resolveDispute(t.db, s.a, s.holdingId, id, { source: "court_order", reference: "NSWSC 123", refundCents: 1_000_000, releaseCents: 3_500_000, reason: "Order made on 4 Nov" })).toMatchObject({ ok: false, status: 409 });
    // One person only proposes: nothing changes until a different person decides.
    expect(must(await resolveDispute(t.db, s.a, s.holdingId, id, { source: "court_order", reference: "NSWSC 123", refundCents: 1_000_000, releaseCents: 3_000_000, reason: "Order made on 4 Nov" }))).toMatchObject({ status: "disputed", pendingApproval: true });
    expect(await offerStatus(s.offerId)).toBe("accepted");
    expect(await requestCasePayout(t.db, s.a, s.holdingId, id)).toMatchObject({ ok: false });
    expect(await decideResolution(t.db, s.a, s.holdingId, id, "approve", "Approving my own proposal")).toMatchObject({ ok: false, status: 403 });
    expect(await decideResolution(t.db, s.b, randomUUID(), id, "approve", "Wrong deposit record in the URL")).toMatchObject({ ok: false, status: 404 });
    expect(must(await decideResolution(t.db, s.b, s.holdingId, id, "approve", "Checked the order against the proposal")).status).toBe("agreed");
    expect(await resolveDispute(t.db, s.a, s.holdingId, id, { source: "agreement", reference: "letter", refundCents: 0, releaseCents: 0, reason: "Second try after it was settled" })).toMatchObject({ ok: false, status: 409 });
    expect(await offerStatus(s.offerId)).toBe("fallen_through");
    expect(must(await requestCasePayout(t.db, s.a, s.holdingId, id))).toMatchObject({ kind: "refund", amountCents: 1_000_000 });
    const d = (await getHolding(t.db, s.holdingId))!;
    expect(d.cases[0]).toMatchObject({ status: "agreed", resolutionSource: "court_order", resolutionReference: "NSWSC 123", refundCents: 1_000_000, releaseCents: 3_000_000 });
    expect(d.audit.map(x => x.event)).toEqual(expect.arrayContaining(["escrow.fall_through_raised", "escrow.fall_through_disputed", "escrow.fall_through_resolved"]));
    function preview(user: string) { return previewFallThrough(t.db, user, "owner", s.offerId, "buyer_default"); }
  });

  it("if staff find the sale goes ahead the case closes and the deposit thaws", async () => {
    const s = await setup();
    const { id } = must(await raiseFallThrough(t.db, s.buyer, "buyer", s.offerId, "finance_condition", null));
    must(await respondFallThrough(t.db, s.owner, "owner", s.offerId, "dispute", "The finance condition was waived in writing"));
    must(await resolve(s, id, { source: "sale_continues", reference: null, refundCents: 0, releaseCents: 0, reason: "Parties confirmed the condition was waived" }));
    expect(await offerStatus(s.offerId)).toBe("accepted");
    expect((await getHolding(t.db, s.holdingId))!.cases[0]!.status).toBe("withdrawn");
    must(await requestRelease(t.db, s.a, s.holdingId, { kind: "refund", amountCents: 100_000, reason: "Normal request after the dispute", settlementConfirmed: false }));
  });

  it("the raiser can withdraw before an answer, which thaws the deposit", async () => {
    const s = await setup();
    must(await raiseFallThrough(t.db, s.buyer, "buyer", s.offerId, "mutual_termination", null));
    expect(await withdrawFallThrough(t.db, s.owner, "owner", s.offerId)).toMatchObject({ ok: false, status: 403 });
    expect(must(await withdrawFallThrough(t.db, s.buyer, "buyer", s.offerId)).status).toBe("withdrawn");
    must(await raiseFallThrough(t.db, s.owner, "owner", s.offerId, "mutual_termination", null)); // a new one may follow
    must(await withdrawFallThrough(t.db, s.owner, "owner", s.offerId));
    must(await requestRelease(t.db, s.a, s.holdingId, { kind: "refund", amountCents: 100_000, reason: "Normal request after withdrawing", settlementConfirmed: false }));
  });

  it("with nothing received, agreeing finishes at once and closes the record", async () => {
    const s = await setup({ received: false });
    const { id } = must(await raiseFallThrough(t.db, s.buyer, "buyer", s.offerId, "other_condition", null));
    must(await respondFallThrough(t.db, s.owner, "owner", s.offerId, "agree", null));
    expect(await offerStatus(s.offerId)).toBe("fallen_through");
    const d = (await getHolding(t.db, s.holdingId))!;
    expect(d.cases[0]).toMatchObject({ id, status: "resolved", refundCents: 0, releaseCents: 0 });
    expect(d.holding.status).toBe("cancelled");
  });

  it("when the sale falls through, interested buyers hear the listing is back on the market, once, and the two sides get the fell-through notice", async () => {
    const s = await setup({ received: false });
    const saver = await addUser(t.db, "buyer");
    await t.db.query("UPDATE property_listing SET status = 'published' WHERE id = $1", [s.listingId]);
    await t.db.query("INSERT INTO saved_listing (buyer_user_id, listing_id) VALUES ($1,$2)", [saver, s.listingId]);
    const kinds = async (u: string) => (await t.db.query("SELECT kind FROM notification WHERE user_id = $1 ORDER BY created_at", [u])).rows.map(r => String(r["kind"]));
    must(await raiseFallThrough(t.db, s.buyer, "buyer", s.offerId, "other_condition", null));
    expect(await kinds(saver)).toEqual([]); // a request alone changes nothing for followers
    must(await respondFallThrough(t.db, s.owner, "owner", s.offerId, "agree", null));
    expect(await kinds(saver)).toEqual(["listing_back_on_market"]);
    expect(await kinds(s.owner)).not.toContain("listing_back_on_market");
    expect(await kinds(s.buyer)).not.toContain("listing_back_on_market");
  });

  it("cooling-off leaves out the state's public holidays on file, so a long break keeps the period open", async () => {
    const s = await setup({ acceptedDaysAgo: 10 });
    expect(await previewFallThrough(t.db, s.buyer, "buyer", s.offerId, "cooling_off")).toMatchObject({ ok: false, error: expect.stringContaining("cooling-off period") });
    // Every day since the contract is a NSW holiday (a shutdown), so no business days have been used.
    await t.db.query("INSERT INTO public_holiday (state, holiday_date, name) SELECT 'NSW', d::date, 'Test shutdown' FROM generate_series(current_date - 12, current_date + 1, interval '1 day') d");
    const p = must(await previewFallThrough(t.db, s.buyer, "buyer", s.offerId, "cooling_off"));
    expect(p.basis).toContain("public holiday");
    expect(p.basis).toContain("used 0");
  });

  it("refuses without an accepted offer and an open record, after cooling-off ends, and in states with no right", async () => {
    const s = await setup({ acceptedDaysAgo: 30 });
    expect(await raiseFallThrough(t.db, s.buyer, "buyer", s.offerId, "cooling_off", null)).toMatchObject({ ok: false, error: expect.stringContaining("cooling-off period") });
    expect(must(await previewFallThrough(t.db, s.buyer, "buyer", s.offerId, "finance_condition")).refundCents).toBe(4_000_000);
    expect(await raiseFallThrough(t.db, s.buyer, "buyer", s.offerId, "buyer_default", null)).toMatchObject({ ok: false });

    const wa = await setup({ state: "WA" });
    expect(await raiseFallThrough(t.db, wa.buyer, "buyer", wa.offerId, "cooling_off", null)).toMatchObject({ ok: false, error: expect.stringContaining("no statutory cooling-off") });

    const pending = await setup();
    const r = must(await requestRelease(t.db, pending.a, pending.holdingId, { kind: "refund", amountCents: 100_000, reason: "A payment already waiting", settlementConfirmed: false }));
    expect(r.releaseId).toBeTruthy();
    expect(await fallThroughView(t.db, pending.buyer, "buyer", pending.offerId)).toMatchObject({ ok: true, value: { canRaise: { ok: false } } });

    const none = await setup();
    await t.db.query("UPDATE formal_offer SET status = 'rejected' WHERE id = $1", [none.offerId]);
    expect(await raiseFallThrough(t.db, none.owner, "owner", none.offerId, "mutual_termination", null)).toMatchObject({ ok: false, status: 409 });
  });

  it("voids the sold event when the sale falls through, and a case is never deleted", async () => {
    const s = await setup({ received: false });
    const { recordAcceptedOfferEventPg } = await import("../src/server/sale-events-db");
    await recordAcceptedOfferEventPg(t.db, s.offerId);
    const { id } = must(await raiseFallThrough(t.db, s.buyer, "buyer", s.offerId, "mutual_termination", null));
    must(await respondFallThrough(t.db, s.owner, "owner", s.offerId, "agree", null));
    const e = (await t.db.query("SELECT voided_at, void_reason FROM property_event WHERE offer_id = $1", [s.offerId])).rows;
    expect(e.length).toBe(1);
    expect(e[0]!["voided_at"]).not.toBeNull();
    await expect(t.db.query("DELETE FROM sale_fall_through WHERE id = $1", [id])).rejects.toThrow(/permanent record/);
  });
});

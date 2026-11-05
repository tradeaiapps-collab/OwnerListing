import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseStatementCsv } from "../src/domain/deposit-escrow";
import {
  accountLedger, cancelHolding, createHolding, decideRelease, getHolding, importStatement, matchLine, overview, receiptFromLine, recordReceipt,
  requestRelease, type StaffRef
} from "../src/server/deposit-escrow-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("deposits in trust on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const one = async (sql: string, p: unknown[]) => String((await t.db.query(sql, p)).rows[0]!["id"]);
  async function account(listingId: string, decision = "approved") {
    const firm = await one("INSERT INTO law_firm (name, jurisdiction) VALUES ('Reef Legal', 'QLD') RETURNING id", []);
    const acct = await one("INSERT INTO trust_account (firm_id, account_name, bsb, account_number_encrypted, details_fingerprint) VALUES ($1,'Reef Legal Trust','034001','\\x00'::bytea,'fp') RETURNING id", [firm]);
    await t.db.query("INSERT INTO trust_account_check (listing_id, trust_account_id, decision, evidence, reasons) VALUES ($1,$2,$3,'{}','[]')", [listingId, acct, decision]);
    return acct;
  }
  async function offer(listingId: string, buyer: string, status = "accepted") {
    const token = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [token, listingId, buyer]);
    return one("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status) VALUES ($1,$2,80000000,30,4000000,true,$3,$4) RETURNING id",
      [listingId, buyer, token, status]);
  }
  const setup = async (withAccount = true) => {
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer");
    const a: StaffRef = { id: await addUser(t.db, "admin"), role: "accountant" }, b: StaffRef = { id: await addUser(t.db, "admin"), role: "compliance" };
    const listingId = await addListing(t.db, owner, { title: "12 Reef St" });
    const acct = withAccount ? await account(listingId) : null;
    const offerId = await offer(listingId, buyer);
    return { a, b, listingId, acct, offerId, buyer };
  };
  const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };

  it("opens a record only for an accepted offer with an approved trust account, once", async () => {
    const s = await setup(false);
    expect(await createHolding(t.db, s.a, { offerId: s.offerId, requiredCents: null, dueDate: null })).toMatchObject({ ok: false, status: 409 });
    const rejected = await account(s.listingId, "rejected");
    expect(rejected).toBeTruthy();
    expect(await createHolding(t.db, s.a, { offerId: s.offerId, requiredCents: null, dueDate: null })).toMatchObject({ ok: false, status: 409 });
    const s2 = await setup();
    const pending = await offer(s2.listingId, s2.buyer, "submitted");
    expect(await createHolding(t.db, s2.a, { offerId: pending, requiredCents: null, dueDate: null })).toMatchObject({ ok: false, status: 409 });
    const v = must(await createHolding(t.db, s2.a, { offerId: s2.offerId, requiredCents: null, dueDate: "2026-11-20" }));
    expect(v.reference).toMatch(/^DEP-[0-9A-Z]{6}$/);
    expect(await createHolding(t.db, s2.a, { offerId: s2.offerId, requiredCents: null, dueDate: null })).toMatchObject({ ok: false, status: 409 });
    const d = await getHolding(t.db, v.id);
    expect(d?.holding).toMatchObject({ requiredCents: 4_000_000, dueDate: "2026-11-20", status: "open", trustAccountId: s2.acct, listingTitle: "12 Reef St", buyerName: "Test b." });
    expect(d?.audit.map(x => x.event)).toEqual(["escrow.holding_opened"]);
    const ov = await overview(t.db);
    expect(ov.holdings.some(h => h.id === v.id)).toBe(true);
    expect(ov.acceptedWithout.some(o => o.offerId === s2.offerId)).toBe(false);
    expect(ov.acceptedWithout.find(o => o.offerId === s.offerId)).toMatchObject({ accountLabel: null, depositCents: 4_000_000 });
  });

  it("records receipts, then needs a second person to release, then closes", async () => {
    const s = await setup();
    const { id } = must(await createHolding(t.db, s.a, { offerId: s.offerId, requiredCents: null, dueDate: null }));
    must(await recordReceipt(t.db, s.a, id, { amountCents: 1_000_000, receivedOn: "2026-11-02", bankReference: "TFR 1" }));
    expect(await recordReceipt(t.db, s.a, id, { amountCents: 3_000_001, receivedOn: "2026-11-02", bankReference: null })).toMatchObject({ ok: false, status: 409 });
    const rel = { kind: "release" as const, amountCents: 4_000_000, reason: "Settlement completed 4 Nov", settlementConfirmed: true };
    expect(await requestRelease(t.db, s.a, id, rel)).toMatchObject({ ok: false, status: 409 });
    must(await recordReceipt(t.db, s.a, id, { amountCents: 3_000_000, receivedOn: "2026-11-03", bankReference: null }));
    const { releaseId } = must(await requestRelease(t.db, s.a, id, rel));
    expect(await requestRelease(t.db, s.a, id, rel)).toMatchObject({ ok: false, status: 409 });
    expect(await decideRelease(t.db, s.a, releaseId, "approve", "I asked and I approve")).toMatchObject({ ok: false, status: 403 });
    expect(must(await decideRelease(t.db, s.b, releaseId, "approve", "Confirmed with Reef Legal"))).toEqual({ outcome: "approved", holdingStatus: "released" });
    expect(await decideRelease(t.db, s.b, releaseId, "approve", "Confirmed with Reef Legal")).toMatchObject({ ok: false, status: 409 });
    const d = await getHolding(t.db, id);
    expect(d?.holding.status).toBe("released");
    expect(d?.movements.map(m => [m.kind, m.amountCents])).toEqual([["receipt", 1_000_000], ["receipt", 3_000_000], ["release", 4_000_000]]);
    expect(d?.audit.map(x => x.event)).toEqual(["escrow.holding_opened", "escrow.receipt_recorded", "escrow.receipt_recorded", "escrow.release_requested", "escrow.release_approved"]);
    expect(await recordReceipt(t.db, s.a, id, { amountCents: 1, receivedOn: "2026-11-03", bankReference: null })).toMatchObject({ ok: false, status: 409 });
  });

  it("refunds part of a deposit, rejects, and cancels only before money", async () => {
    const s = await setup();
    const { id } = must(await createHolding(t.db, s.a, { offerId: s.offerId, requiredCents: 2_000_000, dueDate: null }));
    must(await recordReceipt(t.db, s.a, id, { amountCents: 500_000, receivedOn: "2026-11-02", bankReference: null }));
    expect(await cancelHolding(t.db, s.a, id, "Opened for the wrong offer")).toMatchObject({ ok: false, status: 409 });
    const r1 = must(await requestRelease(t.db, s.a, id, { kind: "refund", amountCents: 500_000, reason: "Finance clause not met", settlementConfirmed: false }));
    expect(must(await decideRelease(t.db, s.b, r1.releaseId, "reject", "Need the termination notice first"))).toMatchObject({ outcome: "rejected", holdingStatus: "open" });
    const r2 = must(await requestRelease(t.db, s.a, id, { kind: "refund", amountCents: 500_000, reason: "Finance clause not met, notice on file", settlementConfirmed: false }));
    expect(must(await decideRelease(t.db, s.b, r2.releaseId, "approve", "Termination notice checked"))).toMatchObject({ holdingStatus: "refunded" });
    const s2 = await setup();
    const h2 = must(await createHolding(t.db, s2.a, { offerId: s2.offerId, requiredCents: null, dueDate: null }));
    expect(must(await cancelHolding(t.db, s2.a, h2.id, "Contract fell through before deposit"))).toEqual({ status: "cancelled" });
  });

  it("keeps the ledger insert-only and records permanent", async () => {
    const s = await setup();
    const { id } = must(await createHolding(t.db, s.a, { offerId: s.offerId, requiredCents: null, dueDate: null }));
    must(await recordReceipt(t.db, s.a, id, { amountCents: 100, receivedOn: "2026-11-02", bankReference: null }));
    await expect(t.db.query("UPDATE deposit_movement SET amount_cents = 1 WHERE holding_id = $1", [id])).rejects.toThrow(/permanent record/);
    await expect(t.db.query("DELETE FROM deposit_movement WHERE holding_id = $1", [id])).rejects.toThrow(/permanent record/);
    await expect(t.db.query("DELETE FROM deposit_holding WHERE id = $1", [id])).rejects.toThrow(/permanent record/);
  });

  it("imports a statement once, suggests and matches lines, and records a receipt from a line", async () => {
    const s = await setup();
    const { id, reference } = must(await createHolding(t.db, s.a, { offerId: s.offerId, requiredCents: null, dueDate: null }));
    const csv = `Date,Description,Amount\n02/11/2026,TFR J CITIZEN ${reference},"40,000.00"\n03/11/2026,Other client,123.00\n03/11/2026,Other client,123.00\n`;
    expect(must(await importStatement(t.db, s.a, s.acct!, "nov.csv", parseStatementCsv(csv)))).toMatchObject({ added: 3, skipped: 0 });
    expect(must(await importStatement(t.db, s.a, s.acct!, "nov-again.csv", parseStatementCsv(csv)))).toMatchObject({ added: 0, skipped: 3 });
    expect(await importStatement(t.db, s.a, randomUUID(), null, parseStatementCsv(csv))).toMatchObject({ ok: false, status: 404 });
    let led = await accountLedger(t.db, s.acct!);
    const dep = led.lines.find(l => l.amountCents === 4_000_000)!, other = led.lines.find(l => l.amountCents === 12_300)!;
    must(await receiptFromLine(t.db, s.a, dep.id, id));
    expect(await receiptFromLine(t.db, s.a, dep.id, id)).toMatchObject({ ok: false, status: 409 });
    led = await accountLedger(t.db, s.acct!);
    expect(led.movements).toHaveLength(1);
    expect(led.movements[0]).toMatchObject({ kind: "receipt", amountCents: 4_000_000, occurredOn: "2026-11-02", reconciled: true });

    // Payout recorded on approval, then matched to the bank debit by hand.
    const { releaseId } = must(await requestRelease(t.db, s.a, id, { kind: "release", amountCents: 4_000_000, reason: "Settled 5 Nov per solicitor", settlementConfirmed: true }));
    must(await decideRelease(t.db, s.b, releaseId, "approve", "Checked with the solicitor"));
    must(await importStatement(t.db, s.a, s.acct!, "dec.csv", parseStatementCsv(`Date,Description,Amount\n06/11/2026,PAY VENDOR,-40000.00\n`)));
    led = await accountLedger(t.db, s.acct!);
    const debit = led.lines.find(l => l.amountCents === -4_000_000)!, payout = led.movements.find(m => m.kind === "release")!;
    expect(await matchLine(t.db, s.a, other.id, payout.id)).toMatchObject({ ok: false, status: 409 });
    expect(await receiptFromLine(t.db, s.a, debit.id, id)).toMatchObject({ ok: false, status: 409 });
    must(await matchLine(t.db, s.a, debit.id, payout.id));
    expect(await matchLine(t.db, s.a, debit.id, payout.id)).toMatchObject({ ok: false, status: 409 });
    led = await accountLedger(t.db, s.acct!);
    expect(led.movements.every(m => m.reconciled)).toBe(true);
    expect((await getHolding(t.db, id))?.audit.filter(a => a.event === "escrow.reconciled")).toHaveLength(1);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseStatementCsv } from "../src/domain/deposit-escrow";
import {
  accountLedger, cancelHolding, createHolding, decideRelease, getHolding, importStatement, matchLine, overview, receiptFromLine, recordReceipt,
  requestRelease, type StaffRef
} from "../src/server/deposit-escrow-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("deposit notices on Postgres", () => {
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

  const notices = async (offerId: string) => (await t.db.query(
    "SELECT n.kind, n.user_id, n.body FROM notification n JOIN formal_offer o ON o.id = $1::uuid WHERE n.kind LIKE 'deposit\\_%' AND n.user_id IN (o.buyer_user_id, (SELECT owner_user_id FROM property_listing WHERE id = o.listing_id)) ORDER BY n.created_at, n.kind", [offerId])).rows;

  it("sends held, pending and refunded notices to both sides, and nothing for a rejected or refused step", async () => {
    const s = await setup();
    const { id } = must(await createHolding(t.db, s.a, { offerId: s.offerId, requiredCents: 2_000_000, dueDate: "2026-12-01" }));
    expect((await notices(s.offerId)).map(n => n.kind)).toEqual(["deposit_held", "deposit_held"]);
    must(await recordReceipt(t.db, s.a, id, { amountCents: 500_000, receivedOn: "2026-11-02", bankReference: null }));
    expect(await requestRelease(t.db, s.a, id, { kind: "refund", amountCents: 9_999_999, reason: "Too much to pay out", settlementConfirmed: false })).toMatchObject({ ok: false });
    expect(await notices(s.offerId)).toHaveLength(2);
    const r1 = must(await requestRelease(t.db, s.a, id, { kind: "refund", amountCents: 500_000, reason: "Finance clause not met", settlementConfirmed: false }));
    expect((await notices(s.offerId)).filter(n => n.kind === "deposit_payout_pending")).toHaveLength(2);
    expect(await decideRelease(t.db, s.a, r1.releaseId, "approve", "I asked and I approve")).toMatchObject({ ok: false, status: 403 });
    must(await decideRelease(t.db, s.b, r1.releaseId, "reject", "Need the termination notice first"));
    expect((await notices(s.offerId)).filter(n => n.kind === "deposit_refunded")).toHaveLength(0);
    const r2 = must(await requestRelease(t.db, s.a, id, { kind: "refund", amountCents: 500_000, reason: "Finance clause not met, notice on file", settlementConfirmed: false }));
    must(await decideRelease(t.db, s.b, r2.releaseId, "approve", "Termination notice checked"));
    const refunded = (await notices(s.offerId)).filter(n => n.kind === "deposit_refunded");
    expect(refunded).toHaveLength(2);
    expect(refunded[0]!.body).toContain("$5,000.00");
  });

  it("sends a released notice to both sides at settlement", async () => {
    const s = await setup();
    const { id } = must(await createHolding(t.db, s.a, { offerId: s.offerId, requiredCents: null, dueDate: null }));
    must(await recordReceipt(t.db, s.a, id, { amountCents: 4_000_000, receivedOn: "2026-11-02", bankReference: null }));
    const { releaseId } = must(await requestRelease(t.db, s.a, id, { kind: "release", amountCents: 4_000_000, reason: "Settlement completed 4 Nov", settlementConfirmed: true }));
    must(await decideRelease(t.db, s.b, releaseId, "approve", "Confirmed with Reef Legal"));
    expect((await notices(s.offerId)).filter(n => n.kind === "deposit_released").map(n => n.user_id)).toHaveLength(2);
  });
});

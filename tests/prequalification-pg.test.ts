import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MalwareScanPort } from "../src/adapters/malware-scan";
import type { ObjectStoragePort } from "../src/adapters/object-storage";
import { bulkVerify, documentKeyFor, listForBuyer, prequalsForListing, reviewPrequal, staffDetail, staffQueue, type StaffRef } from "../src/server/prequalification-db";
import { submitPrequalification, type PrequalDeps } from "../src/server/prequalification-service";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const NOW = "2026-11-05T00:00:00.000Z";
const TODAY = NOW.slice(0, 10);
const LETTER = "Westpac. Date of issue: 1 November 2026. You are pre-approved for $500,000. Valid until 1 March 2027. Subject to a satisfactory property valuation.";
const pdf = (text = LETTER) => new Uint8Array(Buffer.from(`%PDF-1.4\n${text}`));

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("buyer pre-approvals on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const store = new Map<string, Uint8Array>();
  const storage: ObjectStoragePort = { configured: true, async put(k, b) { store.set(k, b); }, async get(k) { return store.get(k)!; } };
  const scanner: MalwareScanPort = { configured: true, async scan(b) { return Buffer.from(b).includes("EICAR") ? "infected" : "clean"; } };
  const deps = (): PrequalDeps => ({ db: t.db, storage, scanner, now: () => NOW, extract: async b => ({ ok: true, text: Buffer.from(b).toString("latin1") }) });
  const staff = async (): Promise<StaffRef> => ({ id: await addUser(t.db, "admin"), role: "compliance" });
  const one = async (sql: string, p: unknown[]) => String((await t.db.query(sql, p)).rows[0]!["id"]);
  async function offer(listingId: string, buyer: string, price = 45_000_000) {
    const token = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [token, listingId, buyer]);
    return one("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash) VALUES ($1,$2,$3,30,100000,true,$4) RETURNING id", [listingId, buyer, price, token]);
  }
  const submit = async (buyer: string, extra: Partial<Parameters<typeof submitPrequalification>[4]> = {}, bytes = pdf()) => {
    const r = await submitPrequalification(deps(), buyer, bytes, "application/pdf", { conditions: [], shareWithSellers: true, ...extra });
    if (!r.ok) throw new Error(r.message);
    return r.value.id;
  };

  it("stores a letter as pending with Elena's reading, and never serves the key to the buyer", async () => {
    const buyer = await addUser(t.db, "buyer");
    const id = await submit(buyer);
    const [mine] = await listForBuyer(t.db, buyer, NOW);
    expect(mine).toMatchObject({ id, status: "pending_review", approvedCents: 50_000_000, confidence: "high" });
    expect(JSON.stringify(mine)).not.toContain("prequal/");
    expect((await documentKeyFor(t.db, id))).toMatch(/^prequal\//);
  });

  it("refuses non-PDF bytes, an infected file and a disguised type", async () => {
    const buyer = await addUser(t.db, "buyer");
    const d = deps();
    expect((await submitPrequalification(d, buyer, new Uint8Array([1, 2, 3]), "application/pdf", { conditions: [], shareWithSellers: true })).ok).toBe(false);
    expect((await submitPrequalification(d, buyer, pdf(), "image/png", { conditions: [], shareWithSellers: true })).ok).toBe(false);
    const inf = await submitPrequalification(d, buyer, pdf("EICAR"), "application/pdf", { conditions: [], shareWithSellers: true });
    expect(inf).toMatchObject({ ok: false, code: "invalid" });
    expect(await listForBuyer(t.db, buyer, NOW)).toHaveLength(0);
  });

  it("fails closed when storage is not configured, and limits uploads per day", async () => {
    const buyer = await addUser(t.db, "buyer");
    expect(await submitPrequalification({ ...deps(), storage: { ...storage, configured: false } }, buyer, pdf(), "application/pdf", { conditions: [], shareWithSellers: true })).toMatchObject({ ok: false, code: "unavailable" });
    for (let i = 0; i < 10; i++) await submit(buyer);
    expect(await submitPrequalification(deps(), buyer, pdf(), "application/pdf", { conditions: [], shareWithSellers: true })).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("seller sees pending, then verified summary after staff confirm; nothing personal", async () => {
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer"), s = await staff();
    const listing = await addListing(t.db, owner, { status: "published", price_cents: 45_000_000 });
    const offerId = await offer(listing, buyer);
    expect((await prequalsForListing(t.db, listing, NOW))[0]!.prequal.state).toBe("none");
    const id = await submit(buyer, { listingId: listing });
    const pending = (await prequalsForListing(t.db, listing, NOW))[0]!;
    expect(pending).toMatchObject({ offerId, prequal: { state: "pending" } });
    expect(pending.prequal.summary).toBeUndefined();

    const r = await reviewPrequal(t.db, s, id, { action: "verify", approvedCents: 50_000_000, expiresOn: "2027-03-01", conditions: ["valuation"] }, NOW);
    expect(r).toEqual({ ok: true, value: { status: "verified" } });
    const v = (await prequalsForListing(t.db, listing, NOW))[0]!.prequal;
    expect(v).toMatchObject({ state: "verified", confidence: "high", approvedCents: 50_000_000 });
    expect(v.summary).toContain("$500,000");
    expect(JSON.stringify(v)).not.toMatch(/Test buyer|prequal\/|sha/i);
    // Past the expiry date the same record reads as expired without any job.
    expect((await prequalsForListing(t.db, listing, "2027-03-02T00:00:00.000Z"))[0]!.prequal.state).toBe("expired");
  });

  it("a letter the buyer did not share, or tied to another listing, is not shown", async () => {
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer"), s = await staff();
    const a = await addListing(t.db, owner, { status: "published", price_cents: 45_000_000 }), b = await addListing(t.db, owner, { status: "published", price_cents: 45_000_000 });
    await offer(a, buyer);
    await reviewPrequal(t.db, s, await submit(buyer, { listingId: b }), { action: "verify", approvedCents: 50_000_000, expiresOn: "2027-03-01", conditions: [] }, NOW);
    await reviewPrequal(t.db, s, await submit(buyer, { shareWithSellers: false }), { action: "verify", approvedCents: 50_000_000, expiresOn: "2027-03-01", conditions: [] }, NOW);
    expect((await prequalsForListing(t.db, a, NOW))[0]!.prequal.state).toBe("none");
  });

  it("only a pending letter can be decided, once; resubmit sets a note the buyer sees", async () => {
    const buyer = await addUser(t.db, "buyer"), s = await staff(), s2 = await staff();
    const id = await submit(buyer);
    expect((await reviewPrequal(t.db, s, id, { action: "resubmit", note: "Send page 2.", conditions: [] }, NOW)).ok).toBe(true);
    expect(await reviewPrequal(t.db, s2, id, { action: "verify", approvedCents: 50_000_000, expiresOn: "2027-03-01", conditions: [] }, NOW)).toMatchObject({ ok: false, status: 409 });
    expect((await listForBuyer(t.db, buyer, NOW))[0]).toMatchObject({ status: "resubmit_requested", note: "Send page 2." });
  });

  it("staff queue masks names, flags unqualified, lists offers without a pre-approval; detail has Elena's reading", async () => {
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer"), bare = await addUser(t.db, "buyer");
    const listing = await addListing(t.db, owner, { status: "published", price_cents: 90_000_000, title: "9 Queue St" });
    await offer(listing, bare, 80_000_000);
    const id = await submit(buyer, { listingId: listing });
    const q = await staffQueue(t.db, "pending_review", NOW);
    const row = q.rows.find(r => r.id === id)!;
    expect(row).toMatchObject({ buyerName: "Test b.", listingTitle: "9 Queue St", percentOfPrice: 56, unqualified: true });
    expect(q.noPrequal.some(n => n.listingTitle === "9 Queue St" && n.buyerName === "Test b.")).toBe(true);
    const d = (await staffDetail(t.db, id, NOW))!;
    expect(d.elena?.extracted.approvedCents).toBe(50_000_000);
    expect(d.listingPriceCents).toBe(90_000_000);
  });

  it("bulk verify only takes cleanly read letters", async () => {
    const s = await staff();
    const good = await submit(await addUser(t.db, "buyer"));
    const noExpiry = await submit(await addUser(t.db, "buyer"), {}, pdf("Westpac pre-approved for $500,000."));
    const lowConf = await submit(await addUser(t.db, "buyer"), {}, pdf("Westpac pre-approved for $500,000. Valid until 1 March 2027. Subject to the sale of your existing property."));
    expect(await bulkVerify(t.db, s, [good, noExpiry, lowConf], NOW, TODAY)).toEqual({ verified: 1, skipped: 2 });
    expect((await staffDetail(t.db, good, NOW))!.status).toBe("verified");
    expect((await staffDetail(t.db, noExpiry, NOW))!.status).toBe("pending_review");
  });

  it("summaries are insert only", async () => {
    const id = await submit(await addUser(t.db, "buyer"));
    await expect(t.db.query("UPDATE prequalification_summaries SET elena_summary = 'x' WHERE prequalification_id = $1", [id])).rejects.toThrow();
    await expect(t.db.query("DELETE FROM prequalification_summaries WHERE prequalification_id = $1", [id])).rejects.toThrow();
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInvoice } from "../src/domain/billing";
import { createOfferLink } from "../src/domain/offer-intake";
import { parseSearchQuery } from "../src/domain/listing-search";
import { parseSavedSearchInput } from "../src/domain/saved-search-service";
import { createPgBillingStore } from "../src/server/billing-db";
import { createPgEnquiryRepository, createPgOfferLinkRepository } from "../src/server/enquiry-db";
import { createPgListingRepository } from "../src/server/db";
import { createPgSavedSearchRepository } from "../src/server/saved-search-db";
import { matchesSearch, type ListingSummary } from "../src/domain/buyer";
import { appointedListingsPg } from "../src/server/agent-inbox-db";
import { buildAlertCandidateQuery } from "../src/server/publish-alerts-db";
import { hasCurrentTermsPg, recordAcceptance } from "../src/server/terms-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL, all db/*.sql applied to a throwaway database exactly as scripts/migrate.mjs does. Skipped without DATABASE_URL (CI sets it).
const rejects = async (p: Promise<unknown>, re: RegExp) => { await expect(p).rejects.toThrow(re); };

describe.skipIf(!DATABASE_URL)("Postgres integration (migrations + raw SQL)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("applies every migration file in order and is recorded once each", async () => {
    expect(t.applied.length).toBeGreaterThanOrEqual(28);
    expect(t.applied).toEqual([...t.applied].sort());
    const n = (await db.query("SELECT count(*) AS n FROM schema_migration")).rows[0]!["n"];
    expect(Number(n)).toBe(t.applied.length);
  });

  describe("billing", () => {
    const setup = async () => {
      const owner = await addUser(db, "owner");
      const listingId = await addListing(db, owner, { status: "draft" });
      const store = createPgBillingStore(db);
      const inv = createInvoice(randomUUID(), owner, 10000, { listingId, planId: "basic" });
      await store.replaceInvoices([], inv);
      return { owner, listingId, store, inv };
    };
    const ev = (invoiceId: string, outcome: "succeeded" | "failed" = "succeeded", amountCents = 11000) =>
      ({ eventId: `evt-${randomUUID()}`, invoiceId, amountCents, outcome, providerRef: "ref-1" });
    const auditCount = async (id: string) => Number((await db.query("SELECT count(*) AS n FROM audit_event WHERE aggregate_id = $1", [id])).rows[0]!["n"]);
    const feePaid = async (listingId: string) => (await db.query("SELECT listing_fee_paid FROM property_listing WHERE id = $1", [listingId])).rows[0]!["listing_fee_paid"];

    it("replaceInvoices inserts the pending invoice and an audit row", async () => {
      const { inv, store, listingId } = await setup();
      expect((await store.invoicesForListing(listingId)).map(i => i.id)).toEqual([inv.id]);
      expect(await auditCount(inv.id)).toBe(1);
    });

    it("replaceInvoices supersedes the old pending invoice", async () => {
      const { owner, listingId, store, inv } = await setup();
      const next = createInvoice(randomUUID(), owner, 20000, { listingId, planId: "standard" });
      await store.replaceInvoices([inv.id], next);
      expect((await store.getInvoice(inv.id))?.status).toBe("failed");
      expect((await store.invoicesForListing(listingId)).map(i => i.id)).toEqual([next.id]);
    });

    it("replaceInvoices rolls back entirely when the insert fails (old invoice stays pending)", async () => {
      const { owner, listingId, store, inv } = await setup();
      const bad = createInvoice(randomUUID(), owner, 20000, { listingId, planId: "no-such-plan" });
      await rejects(store.replaceInvoices([inv.id], bad), /foreign key|plan/i);
      expect((await store.getInvoice(inv.id))?.status).toBe("pending");
    });

    it("settle (paid) marks the invoice paid, the listing fee paid, and audits", async () => {
      const { inv, store, listingId } = await setup();
      const e = ev(inv.id);
      await store.settle(inv, e);
      expect((await store.getInvoice(inv.id))?.status).toBe("paid");
      expect(await feePaid(listingId)).toBe(true);
      expect(await store.eventSeen(e.eventId)).toBe(true);
      expect(await auditCount(inv.id)).toBe(2);
    });

    it("settle replays the same event as a no-op", async () => {
      const { inv, store } = await setup();
      const e = ev(inv.id);
      await store.settle(inv, e);
      await store.settle(inv, e);
      expect(await auditCount(inv.id)).toBe(2);
    });

    it("settle with concurrent duplicate events applies once", async () => {
      const { inv, store } = await setup();
      const e = ev(inv.id);
      await Promise.all([store.settle(inv, e), store.settle(inv, e), store.settle(inv, e)]);
      expect(await auditCount(inv.id)).toBe(2);
      expect(Number((await db.query("SELECT count(*) AS n FROM payment_event WHERE invoice_id = $1", [inv.id])).rows[0]!["n"])).toBe(1);
    });

    it("settle (failed) leaves the listing unpaid", async () => {
      const { inv, store, listingId } = await setup();
      await store.settle(inv, ev(inv.id, "failed"));
      expect((await store.getInvoice(inv.id))?.status).toBe("failed");
      expect(await feePaid(listingId)).toBe(false);
    });

    it("a payment for an invoice no longer pending opens an admin case and never marks the listing paid", async () => {
      const { owner, listingId, store, inv } = await setup();
      await store.replaceInvoices([inv.id], createInvoice(randomUUID(), owner, 20000, { listingId, planId: "standard" }));
      await store.settle(inv, ev(inv.id));
      expect(await feePaid(listingId)).toBe(false);
      expect(Number((await db.query("SELECT count(*) AS n FROM admin_case WHERE subject_id = $1", [inv.id])).rows[0]!["n"])).toBe(1);
    });

    it("flagMismatch records the event and an admin case; price and payment ledgers are append-only", async () => {
      const { inv, store, owner } = await setup();
      await store.flagMismatch(inv, ev(inv.id, "succeeded", 1), "amount mismatch");
      expect((await store.getInvoice(inv.id))?.status).toBe("pending");
      await store.addPrice({ planId: "basic", priceCents: 9900, reason: "launch pricing", setBy: owner });
      expect((await store.currentPrices())["basic"]).toBe(9900);
      await rejects(db.query("UPDATE plan_price SET price_cents = 1"), /append-only/);
      await rejects(db.query("DELETE FROM plan_price"), /append-only/);
      await rejects(db.query("UPDATE payment_event SET amount_cents = 1"), /append-only/);
      await rejects(db.query("DELETE FROM payment_event"), /append-only/);
      await db.query("INSERT INTO add_on_price (feature, price_cents, set_by, reason) VALUES ('video', 500, $1, 'launch')", [owner]);
      await rejects(db.query("UPDATE add_on_price SET price_cents = 1"), /append-only/);
    });
  });

  describe("enquiries", () => {
    const thread = async () => {
      const owner = await addUser(db, "owner");
      const buyer = await addUser(db, "buyer");
      const listingId = await addListing(db, owner);
      const repo = createPgEnquiryRepository(db);
      const id = randomUUID();
      await repo.insert({ id, listingId, buyerUserId: buyer, createdAt: new Date().toISOString() });
      return { owner, buyer, listingId, repo, id };
    };

    it("enquiry_message rejects UPDATE and DELETE", async () => {
      const { repo, id, buyer } = await thread();
      const mid = randomUUID();
      await repo.addMessage({ id: mid, enquiryId: id, senderUserId: buyer, automated: false, body: "hello", sentAt: new Date().toISOString() });
      await rejects(db.query("UPDATE enquiry_message SET body = 'x' WHERE id = $1", [mid]), /permanent record/);
      await rejects(db.query("DELETE FROM enquiry_message WHERE id = $1", [mid]), /permanent record/);
      expect((await repo.messages(id)).map(m => m.body)).toEqual(["hello"]);
    });

    it("one automated notice per thread per hour; human messages unaffected; a later hour is allowed", async () => {
      const { repo, id, buyer } = await thread();
      const at = (iso: string) => ({ id: randomUUID(), enquiryId: id, senderUserId: null, automated: true, body: "notice", sentAt: iso });
      expect(await repo.addNotice(at("2026-10-24T10:05:00Z"))).toBe(true);
      expect(await repo.addNotice(at("2026-10-24T10:55:00Z"))).toBe(false);
      expect(await repo.addNotice(at("2026-10-24T11:06:00Z"))).toBe(true);
      await repo.addMessage({ id: randomUUID(), enquiryId: id, senderUserId: buyer, automated: false, body: "a", sentAt: "2026-10-24T10:10:00Z" });
      await repo.addMessage({ id: randomUUID(), enquiryId: id, senderUserId: buyer, automated: false, body: "b", sentAt: "2026-10-24T10:11:00Z" });
      expect((await repo.messages(id)).filter(m => m.automated)).toHaveLength(2);
      expect(await repo.lastAutomatedAt(id)).toBe("2026-10-24T11:06:00.000Z");
    });

    it("concurrent notices in one hour insert exactly one", async () => {
      const { repo, id } = await thread();
      const r = await Promise.all([1, 2, 3, 4].map(() => repo.addNotice({ id: randomUUID(), enquiryId: id, senderUserId: null, automated: true, body: "n", sentAt: "2026-10-24T09:30:00Z" })));
      expect(r.filter(Boolean)).toHaveLength(1);
    });

    it("one enquiry per buyer per listing; unread counts follow markRead", async () => {
      const { repo, id, buyer, owner, listingId } = await thread();
      await rejects(repo.insert({ id: randomUUID(), listingId, buyerUserId: buyer, createdAt: new Date().toISOString() }), /duplicate key/);
      await repo.addMessage({ id: randomUUID(), enquiryId: id, senderUserId: buyer, automated: false, body: "q", sentAt: "2026-10-24T01:00:00Z" });
      expect((await repo.unreadCounts(owner, [id])).get(id)).toBe(1);
      await repo.markRead(owner, id, "2026-10-24T02:00:00Z");
      expect((await repo.unreadCounts(owner, [id])).get(id)).toBeUndefined();
    });
  });

  describe("offer_link_request", () => {
    const KEY = Buffer.alloc(32, 7).toString("base64");
    const mk = async () => {
      const owner = await addUser(db, "owner");
      const buyer = await addUser(db, "buyer");
      const listingId = await addListing(db, owner);
      const enquiryId = randomUUID();
      await createPgEnquiryRepository(db).insert({ id: enquiryId, listingId, buyerUserId: buyer, createdAt: new Date().toISOString() });
      return { buyer, listingId, enquiryId, repo: createPgOfferLinkRepository(db, () => KEY), reqId: randomUUID(), now: new Date() };
    };

    it("issues and shows the link, then wipes the ciphertext once the link is used", async () => {
      const { buyer, listingId, enquiryId, repo, reqId, now } = await mk();
      expect(await repo.open({ id: reqId, enquiryId, at: now.toISOString() })).toBe(true);
      expect(await repo.open({ id: randomUUID(), enquiryId, at: now.toISOString() })).toBe(false);
      const { token, record } = await createOfferLink(listingId, buyer, now.toISOString());
      expect(await repo.issue(reqId, record, token, now.toISOString())).toBe(true);
      expect(await repo.issue(reqId, record, token, now.toISOString())).toBe(false);
      const stored = (await db.query("SELECT link_ciphertext FROM offer_link_request WHERE id = $1", [reqId])).rows[0]!["link_ciphertext"] as string;
      expect(stored.startsWith("v1.")).toBe(true);
      expect(stored).not.toContain(token);
      expect((await repo.liveLink(enquiryId, now.toISOString()))?.token).toBe(token);

      await db.query("UPDATE offer_link SET used_at = now() WHERE token_hash = $1", [record.tokenHash]);
      expect(await repo.liveLink(enquiryId, now.toISOString())).toBeUndefined();
      expect((await db.query("SELECT link_ciphertext, status FROM offer_link_request WHERE id = $1", [reqId])).rows[0]).toEqual({ link_ciphertext: null, status: "issued" });
    });

    it("wipes the ciphertext when the link has expired", async () => {
      const { buyer, listingId, enquiryId, repo, reqId, now } = await mk();
      await repo.open({ id: reqId, enquiryId, at: now.toISOString() });
      const { token, record } = await createOfferLink(listingId, buyer, now.toISOString());
      await repo.issue(reqId, record, token, now.toISOString());
      const later = new Date(now.getTime() + 365 * 24 * 3600_000).toISOString();
      expect(await repo.liveLink(enquiryId, later)).toBeUndefined();
      expect((await db.query("SELECT link_ciphertext FROM offer_link_request WHERE id = $1", [reqId])).rows[0]!["link_ciphertext"]).toBeNull();
    });

    it("decline works once; CHECKs hold; a new request is allowed after a decline", async () => {
      const { enquiryId, repo, reqId, now } = await mk();
      await repo.open({ id: reqId, enquiryId, at: now.toISOString() });
      expect(await repo.decline(reqId, now.toISOString())).toBe(true);
      expect(await repo.decline(reqId, now.toISOString())).toBe(false);
      expect((await repo.latest(enquiryId))?.status).toBe("declined");
      await rejects(db.query("UPDATE offer_link_request SET status = 'issued' WHERE id = $1", [reqId]), /check constraint/);
      expect(await repo.open({ id: randomUUID(), enquiryId, at: now.toISOString() })).toBe(true);
    });
  });

  describe("listing search", () => {
    beforeAll(async () => {
      const owner = await addUser(db, "owner");
      const row = (n: number, o: Record<string, unknown>) => addListing(db, owner, { title: `S${n}`, status: "published", created_at: new Date(Date.UTC(2026, 0, n)).toISOString(), ...o });
      await row(1, { jurisdiction: "QLD", suburb: "Paddington", postcode: "4064", price_cents: 90000000, bedrooms: 3, bathrooms: 2, parking: 1 });
      await row(2, { jurisdiction: "QLD", suburb: "Padstow_Heights", postcode: "4064", price_cents: 70000000, bedrooms: 2, bathrooms: 1, parking: 0, property_type: "unit" });
      await row(3, { jurisdiction: "NSW", suburb: "Paddington", postcode: "2021", price_cents: 150000000, bedrooms: 4, bathrooms: 3, parking: 2 });
      await row(4, { jurisdiction: "QLD", suburb: "Toowong", postcode: "4066", transaction_type: "rent", price_cents: 70000, bedrooms: 2, bathrooms: 1, parking: 1, property_type: "unit" });
      await row(5, { jurisdiction: "QLD", suburb: "Toowong", postcode: "4066" });
      await row(6, { jurisdiction: "QLD", suburb: "Paddington", postcode: "4064", price_cents: 10000, status: "draft" });
      await row(7, { jurisdiction: "VIC", suburb: "100%", postcode: "3000", price_cents: 50000000 });
    });
    const search = (qs: string) => createPgListingRepository(db).search(parseSearchQuery(new URLSearchParams(qs)));
    const titles = (r: { items: { listing: { title: string } }[] }) => r.items.map(i => i.listing.title);

    it("only published, newest first, with total", async () => {
      const r = await search("");
      expect(r.total).toBe(6);
      expect(titles(r)).toEqual(["S7", "S5", "S4", "S3", "S2", "S1"]);
    });
    it("filters by jurisdiction, type, rooms and postcode", async () => {
      expect(titles(await search("jurisdiction=QLD&transactionType=sale"))).toEqual(["S5", "S2", "S1"]);
      expect(titles(await search("propertyType=unit"))).toEqual(["S4", "S2"]);
      expect(titles(await search("minBedrooms=3"))).toEqual(["S3", "S1"]);
      expect(titles(await search("minBathrooms=2&minParking=2"))).toEqual(["S3"]);
      expect(titles(await search("postcode=4066"))).toEqual(["S5", "S4"]);
    });
    it("filters by price range within a transaction type", async () => {
      expect(titles(await search("transactionType=sale&minPriceCents=80000000&maxPriceCents=100000000"))).toEqual(["S1"]);
      expect(titles(await search("transactionType=rent&maxPriceCents=100000"))).toEqual(["S4"]);
    });
    it("suburb is a case-insensitive prefix match with LIKE wildcards escaped", async () => {
      expect(titles(await search("suburb=pad"))).toEqual(["S3", "S2", "S1"]);
      expect(titles(await search("suburb=Padstow_"))).toEqual(["S2"]);
      expect(titles(await search("suburb=Pad_tow"))).toEqual([]);
      expect(titles(await search("suburb=100%"))).toEqual(["S7"]);
    });
    it("sorts by price with unpriced last, and by bedrooms", async () => {
      expect(titles(await search("transactionType=sale&sort=price_asc"))).toEqual(["S7", "S2", "S1", "S3", "S5"]);
      expect(titles(await search("transactionType=sale&sort=price_desc"))).toEqual(["S3", "S1", "S2", "S7", "S5"]);
      expect(titles(await search("sort=bedrooms_desc")).slice(0, 4)).toEqual(["S3", "S1", "S4", "S2"]);
    });
    it("pages without overlap and reports the total", async () => {
      const [a, b, c] = [await search("pageSize=4&page=1"), await search("pageSize=4&page=2"), await search("pageSize=4&page=3")];
      expect(a.total).toBe(6);
      expect([...titles(a), ...titles(b)]).toEqual(["S7", "S5", "S4", "S3", "S2", "S1"]);
      expect(c.items).toHaveLength(0);
    });
  });

  describe("ledgers and terms", () => {
    it("alert_delivery is insert-only with one sent alert per buyer, channel and listing", async () => {
      const owner = await addUser(db, "owner");
      const buyer = await addUser(db, "buyer");
      const listingId = await addListing(db, owner);
      const ins = (outcome: string) => db.query("INSERT INTO alert_delivery (buyer_user_id, channel, listing_id, outcome) VALUES ($1,'email',$2,$3)", [buyer, listingId, outcome]);
      await ins("sent");
      await rejects(ins("sent"), /duplicate key/);
      await ins("failed");
      await rejects(db.query("UPDATE alert_delivery SET outcome = 'failed'"), /insert-only/);
      await rejects(db.query("DELETE FROM alert_delivery"), /insert-only/);
    });

    it("document_deletion_request and audit_event are append-only", async () => {
      const owner = await addUser(db, "owner");
      const prop = String((await db.query("INSERT INTO property (address_text, state) VALUES ('1 Test St','NSW') RETURNING id")).rows[0]!["id"]);
      const docId = String((await db.query(
        `INSERT INTO property_document (property_id, kind, storage_key, sha256, uploaded_by, source, declared_mime, size_bytes)
         VALUES ($1,'photo','k',repeat('a',64),$2,'owner_supplied','image/jpeg',10) RETURNING id`, [prop, owner])).rows[0]!["id"]);
      await db.query("INSERT INTO document_deletion_request (document_id, requested_by, outcome) VALUES ($1,$2,'held')", [docId, owner]);
      await rejects(db.query("UPDATE document_deletion_request SET reason = 'x'"), /append-only/);
      await rejects(db.query("DELETE FROM document_deletion_request"), /append-only/);
      await db.query("INSERT INTO audit_event (actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id) VALUES ('system','t','x','1','e','c')");
      await rejects(db.query("UPDATE audit_event SET event_type = 'z'"), /append-only/);
      await rejects(db.query("DELETE FROM audit_event"), /append-only/);
    });

    it("terms: acceptance gates access and is append-only; versions are immutable", async () => {
      const user = await addUser(db, "buyer");
      expect(await hasCurrentTermsPg(db, user, "2026-10-25T00:00:00Z")).toBe(false);
      await recordAcceptance(db, user, "2026-10-24");
      await recordAcceptance(db, user, "2026-10-24");
      expect(await hasCurrentTermsPg(db, user, "2026-10-25T00:00:00Z")).toBe(true);
      await rejects(db.query("UPDATE terms_acceptance SET accepted_at = now() WHERE user_id = $1", [user]), /append-only/);
      await rejects(db.query("DELETE FROM terms_acceptance WHERE user_id = $1", [user]), /append-only/);
      await rejects(db.query("UPDATE terms_version SET text_reference = '/x'"), /append-only/);
      await rejects(db.query("DELETE FROM terms_version"), /append-only/);
      await db.query("INSERT INTO terms_version (version, includes_ai_learning_clause, text_reference, effective_at) VALUES ('2026-12-01', false, '/terms', '2026-12-01T00:00:00Z')");
      expect(await hasCurrentTermsPg(db, user, "2026-12-02T00:00:00Z")).toBe(false);
      await rejects(db.query("INSERT INTO user_preference (user_id, locale) VALUES ($1, 'x')", [user]), /check constraint/);
    });
  });

  describe("saved searches and alert preferences", () => {
    it("stores criteria as jsonb, lists newest first per buyer, and round-trips through the parser", async () => {
      const a = await addUser(db, "buyer");
      const b = await addUser(db, "buyer");
      const repo = createPgSavedSearchRepository(db);
      const input = parseSavedSearchInput({ transactionType: "sale", useClass: "residential", jurisdictions: ["QLD"], suburbs: ["Toowong"], propertyTypes: ["house"], minPriceCents: 1, maxPriceCents: 9e9, minBedrooms: 3 });
      if (!input.ok) throw new Error(input.message);
      const first = await repo.insert(a, input.value);
      await repo.insert(a, { ...input.value, suburbs: ["Paddington"] });
      await repo.insert(b, input.value);
      const mine = await repo.list(a);
      expect(mine).toHaveLength(2);
      expect(mine[0]!.suburbs).toEqual(["Paddington"]);
      expect(mine.find(s => s.id === first.id)).toMatchObject({ buyerUserId: a, active: true, jurisdictions: ["QLD"], minBedrooms: 3 });
      expect(await repo.list(b)).toHaveLength(1);
    });

    it("consent and unsubscribe upsert per channel and keep the record", async () => {
      const u = await addUser(db, "buyer");
      const repo = createPgSavedSearchRepository(db);
      await repo.giveConsent(u, "email", "2026-10-24T01:00:00Z");
      await repo.giveConsent(u, "sms", "2026-10-24T01:00:00Z");
      await repo.unsubscribe(u, "email", "2026-10-24T02:00:00Z");
      let prefs = await repo.listPreferences(u);
      expect(prefs.map(p => p.channel)).toEqual(["email", "sms"]);
      expect(prefs[0]).toMatchObject({ consentGivenAt: "2026-10-24T01:00:00.000Z", unsubscribedAt: "2026-10-24T02:00:00.000Z" });
      await repo.giveConsent(u, "email", "2026-10-24T03:00:00Z");
      prefs = await repo.listPreferences(u);
      expect(prefs[0]!.unsubscribedAt).toBeUndefined();
      const fresh = await addUser(db, "buyer");
      await repo.unsubscribe(fresh, "sms", "2026-10-24T02:00:00Z");
      expect((await repo.listPreferences(fresh))[0]).toMatchObject({ channel: "sms", unsubscribedAt: "2026-10-24T02:00:00.000Z" });
    });
  });

  describe("publish alert candidate query", () => {
    const base = { transactionType: "sale", useClass: "residential", jurisdictions: ["QLD"], suburbs: [] as string[], propertyTypes: [] as string[] };
    const listing: ListingSummary = { id: "l1", status: "published", jurisdiction: "QLD", suburb: "New Farm", transactionType: "sale", useClass: "residential", propertyType: "house", priceCents: 120_000_000, bedrooms: 3 };
    const seed = async (buyer: string, criteria: Record<string, unknown>, active = true) =>
      String((await db.query("INSERT INTO saved_search (buyer_user_id, criteria, active) VALUES ($1,$2::jsonb,$3) RETURNING id", [buyer, JSON.stringify(criteria), active])).rows[0]!["id"]);
    const candidates = async (l: ListingSummary, mine: string[]) => {
      const q = buildAlertCandidateQuery(l);
      return (await db.query(q.text, q.params)).rows.map(r => String(r["id"])).filter(id => mine.includes(id));
    };

    it("keeps every search matchesSearch accepts and drops the rest, including missing listing facts and malformed criteria", async () => {
      const buyer = await addUser(db, "buyer");
      const cases: Record<string, Record<string, unknown>> = {
        any: base, otherState: { ...base, jurisdictions: ["NSW"] }, noStateLimit: { ...base, jurisdictions: [] },
        rent: { ...base, transactionType: "rent" }, commercial: { ...base, useClass: "commercial" },
        unit: { ...base, propertyTypes: ["unit"] }, house: { ...base, propertyTypes: ["house", "unit"] },
        suburbHit: { ...base, suburbs: ["  new FARM "] }, suburbMiss: { ...base, suburbs: ["Paddington"] },
        minOk: { ...base, minPriceCents: 100_000_000 }, minHigh: { ...base, minPriceCents: 130_000_000 },
        maxOk: { ...base, maxPriceCents: 120_000_000 }, maxLow: { ...base, maxPriceCents: 100_000_000 },
        bedsOk: { ...base, minBedrooms: 3 }, bedsHigh: { ...base, minBedrooms: 4 },
        badNumber: { ...base, minPriceCents: "lots" }
      };
      const ids: Record<string, string> = {};
      for (const [k, c] of Object.entries(cases)) ids[k] = await seed(buyer, c);
      ids["inactive"] = await seed(buyer, base, false);
      const mine = Object.values(ids);
      const got = new Set(await candidates(listing, mine));
      // Superset of the domain matches (matchesSearch stays the authority).
      for (const [k, c] of Object.entries(cases)) {
        const parsed = parseSavedSearchInput(c);
        if (parsed.ok && matchesSearch({ id: ids[k]!, buyerUserId: buyer, active: true, ...parsed.value }, listing)) expect(got.has(ids[k]!), k).toBe(true);
      }
      for (const k of ["otherState", "rent", "commercial", "unit", "suburbMiss", "minHigh", "maxLow", "bedsHigh", "inactive"]) expect(got.has(ids[k]!), k).toBe(false);
      for (const k of ["any", "noStateLimit", "house", "suburbHit", "minOk", "maxOk", "bedsOk"]) expect(got.has(ids[k]!), k).toBe(true);
    });

    it("a listing without suburb, price or bedrooms only meets searches that do not limit them", async () => {
      const buyer = await addUser(db, "buyer");
      const open = await seed(buyer, base);
      const sub = await seed(buyer, { ...base, suburbs: ["New Farm"] });
      const min = await seed(buyer, { ...base, minPriceCents: 1 });
      const max = await seed(buyer, { ...base, maxPriceCents: 999_999_999 });
      const beds = await seed(buyer, { ...base, minBedrooms: 0 });
      const bare: ListingSummary = { id: "l2", status: "published", jurisdiction: "QLD", transactionType: "sale", useClass: "residential", propertyType: "house" };
      expect(await candidates(bare, [open, sub, min, max, beds])).toEqual([open]);
    });

    it("skips searches of buyers who are not active, and treats a quote in the suburb as data", async () => {
      const gone = await addUser(db, "buyer", "suspended");
      const s = await seed(gone, base);
      expect(await candidates(listing, [s])).toEqual([]);
      const ok = await addUser(db, "buyer");
      const s2 = await seed(ok, { ...base, suburbs: ["O'Connor'; DROP TABLE saved_search;--"] });
      expect(await candidates({ ...listing, suburb: "O'Connor'; DROP TABLE saved_search;--" }, [s2])).toEqual([s2]);
      expect((await db.query("SELECT count(*) AS n FROM saved_search")).rows[0]!["n"]).not.toBe("0");
    });
  });

  describe("agent inbox", () => {
    it("lists only active appointments of that agent with enquiry and unread counts", async () => {
      const owner = await addUser(db, "owner");
      const agent = await addUser(db, "agent");
      const other = await addUser(db, "agent");
      const buyer = await addUser(db, "buyer");
      const mine = await addListing(db, owner, { title: "Mine", jurisdiction: "QLD" });
      const revoked = await addListing(db, owner, { title: "Revoked" });
      const theirs = await addListing(db, owner, { title: "Theirs" });
      const unappointed = await addListing(db, owner, { title: "None" });
      const appoint = (l: string, a: string, revokedAt: string | null = null) =>
        db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by, revoked_at) VALUES ($1,$2,$3,$4)", [l, a, owner, revokedAt]);
      await appoint(mine, agent); await appoint(revoked, agent, "2026-10-01T00:00:00Z"); await appoint(theirs, other);
      const repo = createPgEnquiryRepository(db);
      const enq = randomUUID();
      await repo.insert({ id: enq, listingId: mine, buyerUserId: buyer, createdAt: "2026-10-24T00:00:00Z" });
      await repo.addMessage({ id: randomUUID(), enquiryId: enq, senderUserId: buyer, automated: false, body: "q1", sentAt: "2026-10-24T01:00:00Z" });
      await repo.addMessage({ id: randomUUID(), enquiryId: enq, senderUserId: buyer, automated: false, body: "q2", sentAt: "2026-10-24T02:00:00Z" });
      await repo.addMessage({ id: randomUUID(), enquiryId: enq, senderUserId: agent, automated: false, body: "mine", sentAt: "2026-10-24T03:00:00Z" });
      await repo.insert({ id: randomUUID(), listingId: theirs, buyerUserId: buyer, createdAt: "2026-10-24T00:00:00Z" });
      void unappointed;

      const rows = await appointedListingsPg(db, agent);
      expect(rows.map(r => r.title)).toEqual(["Mine"]);
      expect(rows[0]).toMatchObject({ listingId: mine, jurisdiction: "QLD", enquiries: 1, unread: 2 });
      await repo.markRead(agent, enq, "2026-10-24T02:30:00Z");
      expect((await appointedListingsPg(db, agent))[0]).toMatchObject({ unread: 0 });
      expect((await appointedListingsPg(db, other)).map(r => r.title)).toEqual(["Theirs"]);
      expect((await appointedListingsPg(db, other))[0]).toMatchObject({ enquiries: 1, unread: 0 });
      expect(await appointedListingsPg(db, owner)).toEqual([]);
    });
  });
});

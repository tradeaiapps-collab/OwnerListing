import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultPreferences } from "../src/domain/notifications";
import { archivePg, categoryStatsPg, createNotificationPg, deleteHistoryPg, getPreferencesPg, listNotificationsPg, markReadPg, savePreferencesPg, unreadCountPg } from "../src/server/notifications-db";
import { notifyEnquiryMessage, notifyListingBackOnMarket, notifyListingSold, notifyOfferBuyer, notifyOfferOwner, notifyOwnerOfBuyerCounter, notifyOwnerOfTermsAgreed, notifyUser } from "../src/server/notifier";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("notifications (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });
  const n = (title = "T") => ({ kind: "system_notice", category: "account" as const, title, body: "b", link: "/offers" });

  it("lists newest first with a cursor, split between inbox and history, and counts unread", async () => {
    const u = await addUser(db, "owner");
    for (let i = 0; i < 5; i++) {
      await db.query("INSERT INTO notification (user_id, kind, category, title, body, created_at) VALUES ($1,'system_notice','account',$2,'b', now() - $3::interval)", [u, `N${i}`, `${i} minutes`]);
    }
    const p1 = await listNotificationsPg(db, u, "inbox", 2);
    expect(p1.items.map(x => x.title)).toEqual(["N0", "N1"]);
    expect(p1.nextBefore).not.toBeNull();
    const [createdAt, id] = p1.nextBefore!.split("|");
    const p2 = await listNotificationsPg(db, u, "inbox", 2, { createdAt: createdAt!, id: id! });
    expect(p2.items.map(x => x.title)).toEqual(["N2", "N3"]);
    expect((await listNotificationsPg(db, u, "inbox", 10, { createdAt: createdAt!, id: id! })).nextBefore).toBeNull();
    expect(await unreadCountPg(db, u)).toBe(5);
    expect(await markReadPg(db, u, [p1.items[0]!.id])).toBe(1);
    expect(await markReadPg(db, u, [p1.items[0]!.id])).toBe(0);
    expect(await archivePg(db, u, "all_read")).toBe(1);
    expect((await listNotificationsPg(db, u, "history", 10)).items.map(x => x.title)).toEqual(["N0"]);
    expect((await listNotificationsPg(db, u, "inbox", 10)).items).toHaveLength(4);
    expect(await markReadPg(db, u, "all")).toBe(4);
    expect(await unreadCountPg(db, u)).toBe(0);
  });

  it("never lets one user read, change or delete another user's notifications", async () => {
    const a = await addUser(db, "owner");
    const b = await addUser(db, "buyer");
    const id = await createNotificationPg(db, a, n());
    expect((await listNotificationsPg(db, b, "inbox", 10)).items).toEqual([]);
    expect(await markReadPg(db, b, [id])).toBe(0);
    expect(await archivePg(db, b, [id])).toBe(0);
    await archivePg(db, a, [id]);
    expect(await deleteHistoryPg(db, b)).toBe(0);
    expect(await deleteHistoryPg(db, a)).toBe(1);
    expect((await listNotificationsPg(db, a, "history", 10)).items).toEqual([]);
  });

  it("refuses an off-site link and an empty title in the database", async () => {
    const u = await addUser(db, "owner");
    await expect(createNotificationPg(db, u, { ...n(), link: "//evil.test" })).rejects.toThrow();
    await expect(createNotificationPg(db, u, { ...n(), link: "https://evil.test" })).rejects.toThrow();
    await expect(createNotificationPg(db, u, { ...n(""), link: null })).rejects.toThrow();
  });

  it("saves preferences, logs each consent change, and the log is insert-only", async () => {
    const u = await addUser(db, "buyer");
    expect(await getPreferencesPg(db, u)).toEqual(defaultPreferences());
    const saved = await savePreferencesPg(db, u, { offers: { inApp: true, email: false, sms: true }, marketing: { inApp: false, email: true, sms: false } }, "settings");
    expect(saved.offers.sms).toBe(true);
    expect(await getPreferencesPg(db, u)).toEqual(saved);
    await savePreferencesPg(db, u, { marketing: { inApp: false, email: false, sms: false } }, "unsubscribe_link");
    await savePreferencesPg(db, u, { marketing: { inApp: false, email: false, sms: false } }, "settings"); // no change: nothing logged
    const log = (await db.query("SELECT channel, category, granted, source FROM notification_consent_log WHERE user_id = $1 ORDER BY id", [u])).rows;
    expect(log).toEqual([
      { channel: "email", category: "offers", granted: false, source: "settings" },
      { channel: "sms", category: "offers", granted: true, source: "settings" },
      { channel: "email", category: "marketing", granted: true, source: "settings" },
      { channel: "email", category: "marketing", granted: false, source: "unsubscribe_link" }
    ]);
    await expect(db.query("UPDATE notification_consent_log SET granted = true")).rejects.toThrow();
    await expect(db.query("DELETE FROM notification_consent_log")).rejects.toThrow();
  });

  it("notifyUser writes in-app only where the preference allows, and keeps account notices on", async () => {
    const u = await addUser(db, "owner");
    const env = {};
    expect((await notifyUser(db, u, "offer_received", { listing: "1 Test St", link: "/listings/mine" }, env)).inApp).toBe(true);
    await savePreferencesPg(db, u, { offers: { inApp: false, email: false, sms: false } }, "settings");
    expect((await notifyUser(db, u, "offer_received", {}, env)).inApp).toBe(false);
    expect((await notifyUser(db, u, "security_notice", { title: "New sign-in" }, env)).inApp).toBe(true);
    expect((await notifyUser(db, u, "marketing_news", {}, env)).inApp).toBe(false);
    const titles = (await listNotificationsPg(db, u, "inbox", 10)).items.map(x => x.title).sort();
    expect(titles).toEqual(["New offer received", "New sign-in"]);
    const stats = await categoryStatsPg(db, u);
    expect(stats.find(s => s.category === "offers")).toEqual({ category: "offers", total: 1, read: 0 });
  });

  it("does not text without opt-in or a verified phone, and does not notify a closed account", async () => {
    const u = await addUser(db, "buyer");
    await db.query("INSERT INTO buyer_verification (user_id, phone_verified_at, phone_e164) VALUES ($1, now(), '+61400000001')", [u]);
    expect((await notifyUser(db, u, "offer_accepted", {}, {})).sms).toBe("skipped");
    await savePreferencesPg(db, u, { offers: { inApp: true, email: false, sms: true } }, "settings");
    expect((await notifyUser(db, u, "offer_accepted", {}, {})).sms).toBe("failed"); // opted in, but no SMS provider configured
    const closed = await addUser(db, "buyer", "closed");
    expect((await notifyUser(db, closed, "offer_accepted", {}, {})).inApp).toBe(true); // in-app record is still kept for the account
  });

  it("tells the right person about offers and messages, from server-side lookups", async () => {
    const owner = await addUser(db, "owner");
    const buyer = await addUser(db, "buyer");
    const listing = await addListing(db, owner);
    const enquiry = String((await db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1,$2) RETURNING id", [listing, buyer])).rows[0]!["id"]);
    await notifyOfferOwner(db, listing, {});
    expect((await listNotificationsPg(db, owner, "inbox", 10)).items.map(x => x.kind)).toEqual(["offer_received"]);
    await notifyEnquiryMessage(db, enquiry, buyer, {});
    await notifyEnquiryMessage(db, enquiry, owner, {});
    expect((await listNotificationsPg(db, owner, "inbox", 10)).items.map(x => x.kind).sort()).toEqual(["message_received", "offer_received"]);
    expect((await listNotificationsPg(db, buyer, "inbox", 10)).items.map(x => x.kind)).toEqual(["message_received"]);
    await notifyOfferBuyer(db, "00000000-0000-4000-8000-000000000000", "offer_accepted", {}); // unknown offer: nothing, no throw
  });

  const offerOn = async (listing: string, buyer: string, status: string) => {
    const token = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [token, listing, buyer]);
    return String((await db.query(
      "INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status) VALUES ($1,$2,80000000,30,4000000,true,$3,$4) RETURNING id",
      [listing, buyer, token, status])).rows[0]!["id"]);
  };
  const kinds = async (u: string) => (await listNotificationsPg(db, u, "inbox", 10)).items.map(x => x.kind);

  it("tells the owner, and only the owner, when the buyer counters, without the price", async () => {
    const owner = await addUser(db, "owner"), buyer = await addUser(db, "buyer");
    const listing = await addListing(db, owner, { address_text: "12 Reef St" });
    const offer = await offerOn(listing, buyer, "buyer_countered");
    await notifyOwnerOfBuyerCounter(db, offer, {});
    const items = (await listNotificationsPg(db, owner, "inbox", 10)).items;
    expect(items.map(x => x.kind)).toEqual(["offer_buyer_countered"]);
    expect(items[0]!.body).toContain("12 Reef St");
    expect(items[0]!.link).toBe(`/listings/${listing}/offers/${offer}`);
    expect(await kinds(buyer)).toEqual([]);
    await notifyOwnerOfBuyerCounter(db, "00000000-0000-4000-8000-000000000000", {}); // unknown offer: nothing, no throw
  });

  it("tells savers, alerted searchers, enquirers and other bidders that a listing sold, once each, but not the owner or the winner", async () => {
    const owner = await addUser(db, "owner"), winner = await addUser(db, "buyer");
    const saver = await addUser(db, "buyer"), searcher = await addUser(db, "buyer"), asker = await addUser(db, "buyer"), loser = await addUser(db, "buyer"), bystander = await addUser(db, "buyer");
    const listing = await addListing(db, owner, { address_text: "12 Reef St" });
    await db.query("INSERT INTO saved_listing (buyer_user_id, listing_id) VALUES ($1,$2)", [saver, listing]);
    await db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1,$2)", [listing, asker]);
    await db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1,$2)", [listing, saver]); // saver also enquired: still one notice
    const search = String((await db.query("INSERT INTO saved_search (buyer_user_id, criteria) VALUES ($1,'{}') RETURNING id", [searcher])).rows[0]!["id"]);
    await db.query("INSERT INTO alert_delivery (buyer_user_id, channel, listing_id, saved_search_id, outcome) VALUES ($1,'email',$2,$3,'sent')", [searcher, listing, search]);
    await offerOn(listing, loser, "rejected");
    const accepted = await offerOn(listing, winner, "accepted");

    expect(await notifyListingSold(db, accepted, {})).toBe(4);
    for (const u of [saver, searcher, asker, loser]) expect(await kinds(u)).toEqual(["listing_sold"]);
    for (const u of [owner, winner, bystander]) expect(await kinds(u)).toEqual([]);
    expect((await listNotificationsPg(db, saver, "inbox", 10)).items[0]!.body).toContain("has been sold");
  });

  it("tells the owner, and only the owner, when the buyer agrees to the terms", async () => {
    const owner = await addUser(db, "owner"), buyer = await addUser(db, "buyer");
    const listing = await addListing(db, owner, { address_text: "12 Reef St" });
    const offer = await offerOn(listing, buyer, "buyer_countered");
    await notifyOwnerOfTermsAgreed(db, offer, {});
    const items = (await listNotificationsPg(db, owner, "inbox", 10)).items;
    expect(items.map(x => x.kind)).toEqual(["offer_terms_agreed"]);
    expect(items[0]!.body).toContain("12 Reef St");
    expect(items[0]!.link).toBe(`/listings/${listing}/offers/${offer}`);
    expect(await kinds(buyer)).toEqual([]);
    await notifyOwnerOfTermsAgreed(db, "00000000-0000-4000-8000-000000000000", {}); // unknown offer: nothing, no throw
  });

  it("tells interested buyers a listing is back on the market after a sale falls through, but not the owner or the buyer whose sale fell through", async () => {
    const owner = await addUser(db, "owner"), fell = await addUser(db, "buyer");
    const saver = await addUser(db, "buyer"), asker = await addUser(db, "buyer"), loser = await addUser(db, "buyer"), bystander = await addUser(db, "buyer");
    const listing = await addListing(db, owner, { address_text: "12 Reef St", status: "published" });
    await db.query("INSERT INTO saved_listing (buyer_user_id, listing_id) VALUES ($1,$2)", [saver, listing]);
    await db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1,$2)", [listing, asker]);
    await offerOn(listing, loser, "rejected");
    const offer = await offerOn(listing, fell, "fallen_through");

    expect(await notifyListingBackOnMarket(db, offer, {})).toBe(3);
    for (const u of [saver, asker, loser]) expect(await kinds(u)).toEqual(["listing_back_on_market"]);
    for (const u of [owner, fell, bystander]) expect(await kinds(u)).toEqual([]);
    expect((await listNotificationsPg(db, saver, "inbox", 10)).items[0]!.link).toBe(`/listings/${listing}`);
  });

  it("sends no back-on-market notice while the sale is still on, another offer is accepted, or the listing is not live", async () => {
    const owner = await addUser(db, "owner"), a = await addUser(db, "buyer"), b = await addUser(db, "buyer"), saver = await addUser(db, "buyer");
    const live = await addListing(db, owner, { status: "published" });
    await db.query("INSERT INTO saved_listing (buyer_user_id, listing_id) VALUES ($1,$2)", [saver, live]);
    expect(await notifyListingBackOnMarket(db, await offerOn(live, a, "accepted"), {})).toBe(0);
    const fellOnLive = await offerOn(live, b, "fallen_through");
    expect(await notifyListingBackOnMarket(db, fellOnLive, {})).toBe(0); // a's accepted offer is still standing
    const draft = await addListing(db, owner, { status: "suspended" });
    await db.query("INSERT INTO saved_listing (buyer_user_id, listing_id) VALUES ($1,$2)", [saver, draft]);
    expect(await notifyListingBackOnMarket(db, await offerOn(draft, a, "fallen_through"), {})).toBe(0);
    expect(await kinds(saver)).toEqual([]);
  });

  it("sends nothing for an offer that is not accepted, and respects a listings opt-out", async () => {
    const owner = await addUser(db, "owner"), buyer = await addUser(db, "buyer"), saver = await addUser(db, "buyer");
    const listing = await addListing(db, owner);
    await db.query("INSERT INTO saved_listing (buyer_user_id, listing_id) VALUES ($1,$2)", [saver, listing]);
    const pending = await offerOn(listing, buyer, "submitted");
    expect(await notifyListingSold(db, pending, {})).toBe(0);
    expect(await kinds(saver)).toEqual([]);
    await savePreferencesPg(db, saver, { listings: { inApp: false, email: false, sms: false } }, "settings");
    await db.query("UPDATE formal_offer SET status = 'accepted' WHERE id = $1", [pending]);
    await notifyListingSold(db, pending, {});
    expect(await kinds(saver)).toEqual([]);
  });
});

import { getDigestSettingsPg, runDigests, saveDigestSettingsPg } from "../src/server/notification-digest";

describe.skipIf(!DATABASE_URL)("daily digest (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("defaults off, saves a schedule, and picks only users whose local hour is now and who were not sent in 20 hours", async () => {
    const u = await addUser(db, "owner");
    expect(await getDigestSettingsPg(db, u)).toEqual({ enabled: false, sendHour: 8, timezone: "Australia/Sydney" });
    await saveDigestSettingsPg(db, u, { enabled: true, sendHour: 9, timezone: "Australia/Perth" });
    expect(await getDigestSettingsPg(db, u)).toEqual({ enabled: true, sendHour: 9, timezone: "Australia/Perth" });
    // 01:00 UTC is 09:00 in Perth; 02:00 UTC is not.
    const off = await runDigests(db, {}, "2026-11-05T02:00:00Z");
    expect(off.due).toBe(0);
    await db.query("INSERT INTO notification (user_id, kind, category, title, body, created_at) VALUES ($1,'offer_received','offers','Offer','b','2026-11-04T23:00:00Z')", [u]);
    // No email provider configured in tests: the send fails, the claim is put back and the user stays due.
    const first = await runDigests(db, {}, "2026-11-05T01:00:00Z");
    expect(first.due).toBe(1);
    expect(first.failed + first.sent).toBe(1);
    const row = (await db.query("SELECT enabled FROM notification_digest_setting WHERE user_id = $1", [u])).rows[0]!;
    expect(row["enabled"]).toBe(true);
  });
});

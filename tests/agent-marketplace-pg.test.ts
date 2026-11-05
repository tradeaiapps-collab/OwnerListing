import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBrowse, parseMarketplaceProfile } from "../src/domain/agent-marketplace";
import type { Actor } from "../src/domain/listing-service";
import {
  addPortfolioItem, bookConsultation, browseAgents, cancelConsultation, canReview, getOwnMarketplace, getPublicProfile, getSlots, listMyConsultations,
  removePortfolioItem, saveOwnMarketplace, submitReview
} from "../src/server/agent-marketplace-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("agent marketplace on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const NOW = "2026-11-02T00:00:00.000Z"; // Monday 10:00 in Brisbane
  const as = (userId: string, userType: Actor["userType"]): Actor => ({ userId, userType });
  const agent = async (name: string, licensed = true) => {
    const id = await addUser(t.db, "agent");
    await t.db.query("UPDATE app_user SET display_name = $2 WHERE id = $1", [id, name]);
    if (licensed) await t.db.query("INSERT INTO agent_licence (user_id, jurisdiction, licence_number, status, verified_by, verified_at) VALUES ($1,'QLD','L-1','verified',$1, now())", [id]);
    return id;
  };
  const profile = (o: Record<string, unknown> = {}) => {
    const r = parseMarketplaceProfile({ listed: true, headline: "Bayside specialist", consultModes: ["phone", "video"], videoUrl: "https://meet.example.test/room", specialties: ["investors"], languages: ["english"],
      availability: [{ weekday: 1, startMin: 540, endMin: 660 }, { weekday: 2, startMin: 540, endMin: 660 }], ...o });
    if (!r.ok) throw new Error(r.message);
    return r.value;
  };
  const publish = async (id: string, o: Record<string, unknown> = {}) => {
    await t.db.query("INSERT INTO agent_profile (user_id, bio, service_suburbs) VALUES ($1,$2,$3::text[]) ON CONFLICT (user_id) DO UPDATE SET bio = EXCLUDED.bio, service_suburbs = EXCLUDED.service_suburbs",
      [id, "Twenty years selling homes around the bay.", ["Paddington", "Bulimba"]]);
    return saveOwnMarketplace(t.db, as(id, "agent"), profile(o), NOW);
  };

  it("lists an agent only with a verified licence, a headline and a bio, and hides everyone else", async () => {
    const unlicensed = await agent("No Licence", false);
    await t.db.query("INSERT INTO agent_profile (user_id, bio) VALUES ($1,$2)", [unlicensed, "A long enough bio for listing."]);
    expect(await saveOwnMarketplace(t.db, as(unlicensed, "agent"), profile(), NOW)).toMatchObject({ ok: false, code: "forbidden" });
    const nobio = await agent("No Bio");
    expect(await saveOwnMarketplace(t.db, as(nobio, "agent"), profile(), NOW)).toMatchObject({ ok: false, code: "invalid" });
    expect(await saveOwnMarketplace(t.db, as(await addUser(t.db, "buyer"), "buyer"), profile(), NOW)).toMatchObject({ ok: false, code: "forbidden" });
    const ok = await agent("Alex Morgan");
    expect(await publish(ok)).toMatchObject({ ok: true });
    const seen = (await browseAgents(t.db, parseBrowse(new URLSearchParams("")))).agents.map(a => a.name);
    expect(seen).toContain("Alex Morgan");
    expect(seen).not.toContain("No Licence");
    expect(seen).not.toContain("No Bio");
    expect(await getPublicProfile(t.db, unlicensed)).toBeUndefined();
    // Unlisting hides the agent again.
    expect(await publish(ok, { listed: false })).toMatchObject({ ok: true });
    expect(await getPublicProfile(t.db, ok)).toBeUndefined();
    await publish(ok);
  });

  it("filters, sorts and pages the browse list", async () => {
    const b = await agent("Bea Ng");
    await publish(b, { specialties: ["luxury"], languages: ["mandarin"], consultModes: ["phone"], yearsExperience: 12 });
    const q = (s: string) => browseAgents(t.db, parseBrowse(new URLSearchParams(s)));
    expect((await q("specialty=luxury")).agents.map(a => a.name)).toEqual(["Bea Ng"]);
    expect((await q("language=mandarin")).agents.map(a => a.name)).toEqual(["Bea Ng"]);
    expect((await q("area=bulimba&q=bea")).agents.map(a => a.name)).toEqual(["Bea Ng"]);
    expect((await q("area=nowhere")).total).toBe(0);
    expect((await q("q=%25")).total).toBe(0); // a LIKE wildcard is plain text
    expect((await q("mode=video")).agents.map(a => a.name)).not.toContain("Bea Ng");
    expect((await q("sort=experience")).agents[0]?.name).toBe("Bea Ng");
    expect((await q("minRating=4")).total).toBe(0); // nobody is rated yet
  });

  it("books a slot once, refuses double and out-of-hours bookings, and notifies both sides", async () => {
    const a = await agent("Cam Lee"); await publish(a);
    const buyer = await addUser(t.db, "buyer"), other = await addUser(t.db, "buyer");
    const s = await getSlots(t.db, a, NOW);
    if (!s.ok) throw new Error(s.message);
    const first = s.value.slots[0]!;
    expect(first.startsAt).toBe("2026-11-02T23:00:00.000Z"); // Tuesday 09:00 Brisbane; Monday's window is over
    expect(await bookConsultation(t.db, as(buyer, "buyer"), a, { startsAt: first.startsAt, mode: "phone" }, NOW)).toMatchObject({ ok: false, code: "invalid" }); // phone needs a number
    const booked = await bookConsultation(t.db, as(buyer, "buyer"), a, { startsAt: first.startsAt, mode: "video", note: "Selling in Bulimba" }, NOW);
    expect(booked).toMatchObject({ ok: true });
    expect(await bookConsultation(t.db, as(other, "buyer"), a, { startsAt: first.startsAt, mode: "video" }, NOW)).toMatchObject({ ok: false, code: "conflict" });
    expect(await bookConsultation(t.db, as(other, "buyer"), a, { startsAt: "2026-11-03T03:00:00.000Z", mode: "video" }, NOW)).toMatchObject({ ok: false, code: "conflict" }); // 13:00, outside hours
    expect(await bookConsultation(t.db, as(a, "agent"), a, { startsAt: first.startsAt, mode: "video" }, NOW)).toMatchObject({ ok: false, code: "forbidden" });
    const after = await getSlots(t.db, a, NOW);
    expect(after.ok && after.value.slots.map(x => x.startsAt)).not.toContain(first.startsAt);

    const notes = await t.db.query("SELECT user_id, kind FROM notification WHERE kind LIKE 'consultation_%' AND user_id = ANY($1::uuid[])", [[a, buyer]]);
    expect(notes.rows.map(r => `${r["user_id"] === a ? "agent" : "buyer"}:${r["kind"]}`).sort()).toEqual(["agent:consultation_booked", "buyer:consultation_confirmed"]);

    // Each side sees it; only the client gets the video link; only the agent sees the note.
    const mine = await listMyConsultations(t.db, as(buyer, "buyer"), NOW), theirs = await listMyConsultations(t.db, as(a, "agent"), NOW);
    expect(mine[0]).toMatchObject({ role: "client", counterpart: "Cam Lee", videoUrl: "https://meet.example.test/room" });
    expect(mine[0]).not.toHaveProperty("note");
    expect(theirs[0]).toMatchObject({ role: "agent", note: "Selling in Bulimba" });
    expect(theirs[0]).not.toHaveProperty("videoUrl");
    expect(await listMyConsultations(t.db, as(other, "buyer"), NOW)).toEqual([]);

    // A stranger cannot cancel; a party can, the slot reopens and the other side is told.
    const id = booked.ok ? booked.value.id : "";
    expect(await cancelConsultation(t.db, as(other, "buyer"), id, NOW)).toMatchObject({ ok: false, code: "not_found" });
    expect(await cancelConsultation(t.db, as(buyer, "buyer"), id, NOW)).toMatchObject({ ok: true });
    expect(await cancelConsultation(t.db, as(buyer, "buyer"), id, NOW)).toMatchObject({ ok: false, code: "conflict" });
    const reopened = await getSlots(t.db, a, NOW);
    expect(reopened.ok && reopened.value.slots.map(x => x.startsAt)).toContain(first.startsAt);
    expect((await t.db.query("SELECT 1 FROM notification WHERE user_id = $1 AND kind = 'consultation_cancelled'", [a])).rows).toHaveLength(1);
  });

  it("only lets people who dealt with an agent review them, once, and shows a masked name", async () => {
    const a = await agent("Dee Park"); await publish(a);
    const stranger = await addUser(t.db, "buyer"), client = await addUser(t.db, "buyer");
    await t.db.query("UPDATE app_user SET display_name = 'Jordan Quinn' WHERE id = $1", [client]);
    expect(await submitReview(t.db, as(stranger, "buyer"), a, { rating: 5 }, NOW)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await submitReview(t.db, as(a, "agent"), a, { rating: 5 }, NOW)).toMatchObject({ ok: false, code: "forbidden" });
    // A consultation that has not happened yet does not qualify; one that has, does.
    const s = await getSlots(t.db, a, NOW);
    const slot = s.ok ? s.value.slots[0]!.startsAt : "";
    await bookConsultation(t.db, as(client, "buyer"), a, { startsAt: slot, mode: "video" }, NOW);
    expect(await canReview(t.db, as(client, "buyer"), a, NOW)).toBe(false);
    const later = "2026-11-10T00:00:00.000Z";
    expect(await canReview(t.db, as(client, "buyer"), a, later)).toBe(true);
    expect(await submitReview(t.db, as(client, "buyer"), a, { rating: 4, title: "Clear and calm", body: "Explained the process well." }, later)).toMatchObject({ ok: true });
    expect(await submitReview(t.db, as(client, "buyer"), a, { rating: 5 }, later)).toMatchObject({ ok: false, code: "conflict" });
    expect(await canReview(t.db, as(client, "buyer"), a, later)).toBe(false);
    const p = await getPublicProfile(t.db, a);
    expect(p).toMatchObject({ rating: 4, reviewCount: 1, ratings: { count: 1, average: 4 }, reviews: [{ reviewer: "Jordan Q.", title: "Clear and calm" }] });
    expect(JSON.stringify(p)).not.toContain("Jordan Quinn");
    expect((await browseAgents(t.db, parseBrowse(new URLSearchParams("minRating=4")))).agents.map(x => x.name)).toEqual(["Dee Park"]);
    expect((await t.db.query("SELECT 1 FROM notification WHERE user_id = $1 AND kind = 'review_received'", [a])).rows).toHaveLength(1);
  });

  it("a listing owner or enquirer of an appointed agent may review; portfolio shows platform sales without prices", async () => {
    const a = await agent("Eli Shaw"); await publish(a);
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer");
    const listing = await addListing(t.db, owner, { status: "published", suburb: "Bulimba", jurisdiction: "QLD" });
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3)", [listing, a, owner]);
    await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1,$2)", [listing, buyer]);
    const link = "a".repeat(64);
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [link, listing, buyer]);
    await t.db.query("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status) VALUES ($1,$2,95000000,30,100000,true,$3,'accepted')", [listing, buyer, link]);
    expect(await canReview(t.db, as(owner, "owner"), a, NOW)).toBe(true);
    expect(await canReview(t.db, as(buyer, "buyer"), a, NOW)).toBe(true);

    const added = await addPortfolioItem(t.db, as(a, "agent"), { suburb: "Paddington", soldOn: "2026-03-14", priceCents: 120000000, note: "Auction" }, NOW);
    expect(added).toMatchObject({ ok: true });
    expect(await addPortfolioItem(t.db, as(buyer, "buyer"), { suburb: "X", soldOn: "2026-03-14" }, NOW)).toMatchObject({ ok: false, code: "forbidden" });
    const p = await getPublicProfile(t.db, a);
    expect(p?.sales).toBe(2);
    const platform = p?.portfolio.find(x => x.source === "platform");
    expect(platform).toMatchObject({ suburb: "Bulimba" });
    expect(platform).not.toHaveProperty("priceCents");
    expect(p?.portfolio.find(x => x.source === "agent")).toMatchObject({ suburb: "Paddington", priceCents: 120000000 });
    // Another agent cannot remove it; the owner of the entry can.
    const id = added.ok ? added.value.id : "";
    expect(await removePortfolioItem(t.db, as(await agent("Fay"), "agent"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await removePortfolioItem(t.db, as(a, "agent"), id)).toMatchObject({ ok: true });
    const own = await getOwnMarketplace(t.db, as(a, "agent"));
    expect(own.ok && own.value.portfolio).toEqual([]);
    expect(own.ok && own.value.profile.availability).toHaveLength(2);
  });
});

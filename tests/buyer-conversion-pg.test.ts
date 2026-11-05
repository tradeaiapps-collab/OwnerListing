import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getBuyerConversion } from "../src/domain/buyer-conversion";
import type { Actor } from "../src/domain/listing-service";
import { createConversionDeps } from "../src/server/buyer-conversion-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("buyer conversion on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("reads buyer behaviour for the appointed agent only, snapshots once a day and learns from offers", async () => {
    const owner = await addUser(t.db, "owner"), a1 = await addUser(t.db, "agent"), a2 = await addUser(t.db, "agent");
    const hot = await addUser(t.db, "buyer"), quiet = await addUser(t.db, "buyer");
    for (const a of [a1, a2]) await t.db.query("INSERT INTO agent_licence (user_id, jurisdiction, licence_number, status, verified_by, verified_at) VALUES ($1,'QLD','L-1','verified',$1, now())", [a]);
    const mine = await addListing(t.db, owner, { jurisdiction: "QLD", title: "Mine", price_cents: 100_000_000 });
    const other = await addListing(t.db, owner, { jurisdiction: "QLD", title: "Other", price_cents: 90_000_000 });
    const theirs = await addListing(t.db, owner, { jurisdiction: "QLD", title: "Theirs" });
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3),($4,$2,$3),($5,$6,$3)", [mine, a1, owner, other, theirs, a2]);
    const enq = async (l: string, b: string, ago = "4 days") => String((await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id, created_at) VALUES ($1,$2, now() - $3::interval) RETURNING id", [l, b, ago])).rows[0]!["id"]);
    const eHot = await enq(mine, hot), eQuiet = await enq(mine, quiet, "25 days"); await enq(theirs, hot); await enq(other, hot);

    for (let i = 0; i < 4; i++) await t.db.query("INSERT INTO listing_view (listing_id, viewer_user_id, viewed_at) VALUES ($1,$2, now() - interval '1 day')", [mine, hot]);
    await t.db.query("INSERT INTO saved_listing (buyer_user_id, listing_id) VALUES ($1,$2)", [hot, mine]);
    await t.db.query("INSERT INTO buyer_verification (user_id, id_verified_at) VALUES ($1, now())", [hot]);
    await t.db.query("INSERT INTO enquiry_message (enquiry_id, sender_user_id, body, sent_at) VALUES ($1,$2,'Keen to see it', now() - interval '1 day')", [eHot, hot]);
    await t.db.query("INSERT INTO viewing_booking (listing_id, requester_user_id, kind, starts_at, status) VALUES ($1,$2,'viewing', now() + interval '1 day','confirmed'), ($1,$2,'viewing', now() + interval '2 day','cancelled')", [mine, hot]);
    await t.db.query("INSERT INTO inspection_booking (listing_id, buyer_id, slots) VALUES ($1,$2,'[\"2026-12-01T10:00:00Z\"]')", [mine, hot]);

    const clock = { now: new Date() };
    const d = createConversionDeps(t.db, () => clock.now);
    const me: Actor = { userId: a1, userType: "agent" }, stranger: Actor = { userId: a2, userType: "agent" };
    const r = await getBuyerConversion(d, me);
    if (!r.ok) throw new Error(r.message);
    const lead = r.value.leads.find(l => l.enquiryId === eHot)!;
    expect(r.value.leads.map(l => l.listingTitle).sort()).toEqual(["Mine", "Mine", "Other"]);
    expect(r.value.leads.some(l => l.listingTitle === "Theirs")).toBe(false);
    expect(lead.signals.map(s => s.label)).toEqual(expect.arrayContaining(["Saved the listing", "Viewed the listing 4 times", "Identity verified", "Viewing confirmed", "Asked for a building inspection"]));
    expect(lead.signals.some(s => /cancelled/.test(s.label))).toBe(true);
    expect(lead.profile).toMatchObject({ intent: "motivated", focus: "comparing" });
    expect(lead.followUp.topic).toBe("reply");
    expect(r.value.leads[0]!.enquiryId).toBe(eHot);
    expect(r.value.leads.find(l => l.enquiryId === eQuiet)!.tier).toBe("green");

    // Another agent sees only their own appointments, and a buyer cannot use it.
    const s = await getBuyerConversion(d, stranger);
    expect(s.ok && s.value.leads.map(l => l.listingTitle)).toEqual(["Theirs"]);
    expect(await getBuyerConversion(d, { userId: hot, userType: "buyer" })).toMatchObject({ ok: false, code: "forbidden" });

    // One snapshot per lead per day, however often the page loads.
    await getBuyerConversion(d, me); await getBuyerConversion(d, me);
    const snaps = await t.db.query("SELECT count(*)::int AS n FROM buyer_lead_score WHERE agent_user_id = $1", [a1]);
    expect(snaps.rows[0]!["n"]).toBe(r.value.leads.length);

    // The hot buyer then makes an offer: the snapshot is marked converted and accuracy counts it.
    const link = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [link, mine, hot]);
    await t.db.query("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status) VALUES ($1,$2,100000000,30,1000000,true,$3,'accepted')", [mine, hot, link]);
    const after = await getBuyerConversion(d, me);
    if (!after.ok) throw new Error(after.message);
    const rows = await t.db.query("SELECT outcome FROM buyer_lead_score WHERE enquiry_id = $1", [eHot]);
    expect(rows.rows.map(x => x["outcome"])).toEqual(["accepted"]);
    expect(after.value.accuracy.resolved).toBeGreaterThanOrEqual(1);
    expect(after.value.leads.find(l => l.enquiryId === eHot)).toMatchObject({ closed: true });
    // Once an offer exists no new snapshot is taken for that lead.
    expect((await t.db.query("SELECT count(*)::int AS n FROM buyer_lead_score WHERE enquiry_id = $1", [eHot])).rows[0]!["n"]).toBe(1);
  });
});

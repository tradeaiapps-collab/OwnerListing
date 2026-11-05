import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAMPAIGN_TEMPLATES } from "../src/domain/automation";
import { activityFor, archiveWorkflow, createWorkflow, fireAutomation, listWorkflows, runDueAutomations, updateWorkflow } from "../src/server/automation-db";
import { savePreferencesPg } from "../src/server/notifications-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const T0 = "2026-11-05T00:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const env = {};

describe.skipIf(!DATABASE_URL)("automation on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const nurture = () => CAMPAIGN_TEMPLATES.find(x => x.key === "lead_nurture")!.definition;
  const notices = async (user: string) => (await t.db.query("SELECT title, body FROM notification WHERE user_id = $1::uuid ORDER BY created_at", [user])).rows.map(r => String(r["title"]));
  async function lead(owner: string, buyer: string, listing: string) {
    const r = await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1,$2) RETURNING id", [listing, buyer]);
    return String(r.rows[0]!["id"]);
  }

  it("runs a multi-step campaign over days, once per event, honouring the contact's marketing consent", async () => {
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer");
    const listing = await addListing(t.db, owner, { title: "Beach House", status: "published" });
    const w = await createWorkflow(t.db, owner, { name: "Nurture", definition: nurture() });
    if (!w.ok) throw new Error(w.message);
    expect(w.value.active).toBe(false); // starts off
    const enq = await lead(owner, buyer, listing);

    expect((await fireAutomation(t.db, { trigger: "new_lead", enquiryId: enq }, T0, env)).started).toBe(0); // inactive: nothing happens
    const on = await updateWorkflow(t.db, owner, w.value.id, { active: true });
    expect(on.ok).toBe(true);

    expect((await fireAutomation(t.db, { trigger: "new_lead", enquiryId: enq }, T0, env)).started).toBe(1);
    expect((await fireAutomation(t.db, { trigger: "new_lead", enquiryId: enq }, T0, env)).started).toBe(0); // same event: no second run
    // Step 1 emailed the contact but they never opted in to marketing, so nothing was sent; step 2 told the owner in-app.
    expect(await notices(owner)).toEqual(["New lead"]);
    expect(await notices(buyer)).toEqual([]);
    let a = await activityFor(t.db, owner, w.value.id);
    expect(a?.counts).toEqual({ waiting: 1 });
    expect(a?.log.filter(l => l.kind === "sent").map(l => l.outcome).sort()).toEqual(["sent", "skipped"]);

    await savePreferencesPg(t.db, buyer, { marketing: { inApp: true, email: false, sms: false } }, "settings");
    expect((await runDueAutomations(t.db, at(60), env)).processed).toBe(0); // 2-day wait not over
    expect((await runDueAutomations(t.db, at(2 * 1440 + 1), env)).processed).toBe(1);
    expect((await runDueAutomations(t.db, at(2 * 1440 + 2), env)).processed).toBe(0); // claimed once only
    expect(await notices(buyer)).toEqual([]); // the follow-up is an email step; in-app only would not carry it
    await runDueAutomations(t.db, at(8 * 1440), env);
    a = await activityFor(t.db, owner, w.value.id);
    expect(a?.counts).toEqual({ completed: 1 });
    expect(a?.log.some(l => l.kind === "completed")).toBe(true);
  });

  it("branches on the event's facts and only fires for listings the owner manages", async () => {
    const owner = await addUser(t.db, "owner"), stranger = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer");
    const mine = await addListing(t.db, owner, { title: "Mine", status: "published" }), theirs = await addListing(t.db, stranger, { title: "Theirs", status: "published" });
    const def = CAMPAIGN_TEMPLATES.find(x => x.key === "big_offer")!.definition;
    const w = await createWorkflow(t.db, owner, { name: "Offers", definition: def });
    if (!w.ok) throw new Error(w.message);
    await updateWorkflow(t.db, owner, w.value.id, { active: true });
    const bad = await createWorkflow(t.db, owner, { name: "x", definition: def, listingId: theirs });
    expect(bad.ok).toBe(false);
    const offer = async (listing: string, cents: number) => {
      const h = Math.random().toString(16).slice(2).padEnd(64, "0");
      await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [h, listing, buyer]);
      const r = await t.db.query("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status) VALUES ($1,$2,$3,30,1000,true,$4,'submitted') RETURNING id", [listing, buyer, cents, h]);
      return String(r.rows[0]!["id"]);
    };
    await fireAutomation(t.db, { trigger: "offer_received", offerId: await offer(theirs, 90_000_000) }, T0, env);
    expect(await notices(owner)).toEqual([]);
    await fireAutomation(t.db, { trigger: "offer_received", offerId: await offer(mine, 50_000_000) }, T0, env);
    expect(await notices(owner)).toEqual([]); // $500k: below the $1m alert branch
    await fireAutomation(t.db, { trigger: "offer_received", offerId: await offer(mine, 150_000_000) }, T0, env);
    expect(await notices(owner)).toEqual(["Large offer"]);
  });

  it("listing, inspection triggers; pausing holds runs; archiving stops them; the log is append-only", async () => {
    const owner = await addUser(t.db, "owner");
    const listing = await addListing(t.db, owner, { title: "Villa", status: "published" });
    const launch = await createWorkflow(t.db, owner, { name: "Launch", definition: CAMPAIGN_TEMPLATES.find(x => x.key === "listing_launch")!.definition });
    const insp = await createWorkflow(t.db, owner, { name: "Insp", definition: CAMPAIGN_TEMPLATES.find(x => x.key === "inspection_followup")!.definition });
    if (!launch.ok || !insp.ok) throw new Error("create");
    for (const w of [launch.value, insp.value]) await updateWorkflow(t.db, owner, w.id, { active: true });
    await fireAutomation(t.db, { trigger: "property_listed", listingId: listing }, T0, env);
    expect(await notices(owner)).toEqual(["Listing live"]);

    const inspector = await addUser(t.db, "agent");
    const i = await t.db.query("INSERT INTO inspection (listing_id, requested_by, inspector_user_id, inspection_type, scheduled_at, status, completed_at) VALUES ($1,$2,$3,'building', now(), 'completed', now()) RETURNING id", [listing, owner, inspector]);
    await fireAutomation(t.db, { trigger: "inspection_complete", inspectionId: String(i.rows[0]!["id"]) }, T0, env);
    expect((await notices(owner)).sort()).toEqual(["Inspection complete", "Listing live"]);

    await updateWorkflow(t.db, owner, launch.value.id, { active: false }); // paused: the week-later reminder waits
    await runDueAutomations(t.db, at(8 * 1440), env);
    expect((await notices(owner)).includes("One week on")).toBe(false);
    await updateWorkflow(t.db, owner, launch.value.id, { active: true });
    await runDueAutomations(t.db, at(8 * 1440 + 20), env);
    expect((await notices(owner)).includes("One week on")).toBe(true);

    expect(await archiveWorkflow(t.db, owner, insp.value.id)).toBe(true);
    expect((await listWorkflows(t.db, owner)).map(w => w.name)).toEqual(["Launch"]);
    await expect(t.db.query("DELETE FROM automation_log")).rejects.toThrow();
    await expect(t.db.query("UPDATE automation_log SET detail = 'x'")).rejects.toThrow();
    expect(await activityFor(t.db, await addUser(t.db, "owner"), launch.value.id)).toBeUndefined(); // someone else's workflow is invisible
  });
});

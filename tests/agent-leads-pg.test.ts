import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addLeadNote, getAgentLead, listAgentLeads, scheduleFollowup, sendDueLeadReminders, setLeadStatus } from "../src/server/agent-lead-db";
import type { Queryable } from "../src/server/db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL with every migration applied. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("agent lead CRM (Postgres)", () => {
  let t: TestDb;
  let db: Queryable;
  let owner: string, agent: string, otherAgent: string, listing: string, bareListing: string;
  const now = () => new Date().toISOString();

  const buyer = () => addUser(db, "buyer");
  const enquire = async (b: string, l = listing) => {
    await db.query("INSERT INTO enquiry (id, listing_id, buyer_user_id) VALUES ($1,$2,$3) ON CONFLICT (listing_id, buyer_user_id) DO NOTHING", [randomUUID(), l, b]);
    return String((await db.query("SELECT id FROM enquiry WHERE listing_id = $1 AND buyer_user_id = $2", [l, b])).rows[0]!["id"]);
  };
  const say = (enquiryId: string, sender: string, body = "hello") => db.query("INSERT INTO enquiry_message (enquiry_id, sender_user_id, body) VALUES ($1,$2,$3)", [enquiryId, sender, body]);
  const leadOf = async (b: string) => (await db.query("SELECT * FROM agent_lead WHERE buyer_id = $1 AND listing_id = $2", [b, listing])).rows[0]!;
  const offerFor = async (b: string) => {
    const hash = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    await db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3,'2027-01-01')", [hash, listing, b]);
    return (await db.query("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash) VALUES ($1,$2,100000000,30,1000000,true,$3) RETURNING id", [listing, b, hash])).rows[0]!["id"] as string;
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    owner = await addUser(db, "owner");
    agent = await addUser(db, "agent");
    otherAgent = await addUser(db, "agent");
    listing = await addListing(db, owner, { status: "published", jurisdiction: "QLD" });
    bareListing = await addListing(db, owner, { status: "published", jurisdiction: "QLD" });
    await db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by, scope) VALUES ($1,$2,$3,'full')", [listing, agent, owner]);
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("creates a lead from an enquiry and records the interaction; a second message adds to the same lead", async () => {
    const b = await buyer();
    const e = await enquire(b);
    await say(e, b);
    const l = await leadOf(b);
    expect(l["agent_id"]).toBe(agent);
    expect(l["status"]).toBe("new_inquiry");
    expect(l["first_response_at"]).toBeNull();
    const types = (await db.query("SELECT interaction_type FROM lead_interaction WHERE lead_id = $1 ORDER BY created_at, id", [l["id"]])).rows.map(r => r["interaction_type"]);
    expect(types).toEqual(["inquiry", "message"]);
    expect((await db.query("SELECT count(*)::int AS n FROM agent_lead WHERE buyer_id = $1", [b])).rows[0]!["n"]).toBe(1);
  });

  it("captures nothing for a listing with no appointed agent, or when the buyer is the agent", async () => {
    const b = await buyer();
    await enquire(b, bareListing);
    expect((await db.query("SELECT count(*)::int AS n FROM agent_lead WHERE buyer_id = $1", [b])).rows[0]!["n"]).toBe(0);
    await db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1,$2)", [listing, agent]);
    expect((await db.query("SELECT count(*)::int AS n FROM agent_lead WHERE buyer_id = $1", [agent])).rows[0]!["n"]).toBe(0);
  });

  it("moves to viewing_scheduled from a viewing request or an inspection request, never backwards", async () => {
    const b = await buyer();
    await enquire(b);
    await db.query("INSERT INTO viewing_booking (listing_id, requester_user_id, kind, starts_at) VALUES ($1,$2,'viewing','2027-01-10T01:00:00Z')", [listing, b]);
    expect((await leadOf(b))["status"]).toBe("viewing_scheduled");
    await db.query("INSERT INTO viewing_booking (listing_id, requester_user_id, kind, starts_at) VALUES ($1,$2,'consultation','2027-01-11T01:00:00Z')", [listing, b]);
    await say(await enquire(b), b); // a later chat message must not drop the status
    expect((await leadOf(b))["status"]).toBe("viewing_scheduled");
    const b2 = await buyer(); // a viewing alone creates the lead
    await db.query("INSERT INTO inspection_booking (listing_id, buyer_id, slots) VALUES ($1,$2,'[\"2027-01-12T01:00:00Z\"]'::jsonb)", [listing, b2]);
    expect((await leadOf(b2))["status"]).toBe("viewing_scheduled");
  });

  it("an offer moves an existing lead to offer_pending but never creates one; acceptance converts it", async () => {
    const stranger = await buyer();
    await offerFor(stranger);
    expect((await db.query("SELECT count(*)::int AS n FROM agent_lead WHERE buyer_id = $1", [stranger])).rows[0]!["n"]).toBe(0);

    const b = await buyer();
    await enquire(b);
    const offer = await offerFor(b);
    expect((await leadOf(b))["status"]).toBe("offer_pending");
    await db.query("UPDATE formal_offer SET status = 'accepted' WHERE id = $1", [offer]);
    const l = await leadOf(b);
    expect(l["status"]).toBe("converted");
    expect(l["converted_offer_id"]).toBe(offer);
    expect(await setLeadStatus(db, agent, String(l["id"]), "lost", "budget", "")).toMatchObject({ ok: false });
  });

  it("measures response time from the agent's first reply and ignores the owner's and automated messages", async () => {
    const b = await buyer();
    const e = await enquire(b);
    await say(e, b);
    await say(e, owner, "owner chatting");
    await db.query("INSERT INTO enquiry_message (enquiry_id, automated, body) VALUES ($1,true,'auto reply')", [e]);
    expect((await leadOf(b))["first_response_at"]).toBeNull();
    await say(e, agent, "Hi, happy to help");
    const l = await leadOf(b);
    expect(l["first_response_at"]).not.toBeNull();
    const detail = await getAgentLead(db, agent, String(l["id"]), now());
    expect(detail?.tone).toBe("green"); // the agent has the last word
    await say(e, b, "one more question");
    expect((await getAgentLead(db, agent, String(l["id"]), now()))?.tone).toBe("yellow");
  });

  it("lists only the signed-in agent's own leads, hides them after the appointment is revoked, and 404s for others", async () => {
    const b = await buyer();
    await enquire(b);
    const id = String((await leadOf(b))["id"]);
    expect((await listAgentLeads(db, agent, now())).some(l => l.id === id)).toBe(true);
    expect((await listAgentLeads(db, otherAgent, now())).some(l => l.id === id)).toBe(false);
    expect(await getAgentLead(db, otherAgent, id, now())).toBeUndefined();
    expect(await addLeadNote(db, otherAgent, id, "sneaky", now())).toMatchObject({ ok: false, notFound: true });
    expect(await scheduleFollowup(db, otherAgent, id, 3, "", now())).toMatchObject({ ok: false, notFound: true });
    await db.query("UPDATE listing_agent_appointment SET revoked_at = now(), revoked_by = $2 WHERE listing_id = $1 AND revoked_at IS NULL", [listing, owner]);
    expect((await listAgentLeads(db, agent, now())).some(l => l.id === id)).toBe(false);
    await db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by, scope) VALUES ($1,$2,$3,'full')", [listing, agent, owner]);
  });

  it("adds notes, schedules and sends a follow-up reminder exactly once, and marks lost with a reason", async () => {
    const b = await buyer();
    await enquire(b);
    const id = String((await leadOf(b))["id"]);
    const n = await addLeadNote(db, agent, id, "Concerned about foundation cracks", now());
    expect(n.ok).toBe(true);
    expect((await getAgentLead(db, agent, id, now()))?.notes.map(x => x.text)).toEqual(["Concerned about foundation cracks"]);

    expect(await scheduleFollowup(db, agent, id, 5, "", now())).toMatchObject({ ok: false });
    expect(await scheduleFollowup(db, agent, id, 3, "Ask about the surveyor", now())).toMatchObject({ ok: true });
    expect(await sendDueLeadReminders(db, now())).toBe(0); // not due yet
    const later = new Date(Date.now() + 4 * 86_400_000).toISOString();
    expect(await sendDueLeadReminders(db, later)).toBe(1);
    expect(await sendDueLeadReminders(db, later)).toBe(0); // once only
    const sent = (await db.query("SELECT body, link FROM notification WHERE user_id = $1 AND kind = 'lead_followup_due'", [agent])).rows;
    expect(sent).toHaveLength(1);
    expect(sent[0]!["link"]).toBe(`/agent/leads/${id}`);
    expect(String(sent[0]!["body"])).toContain("Ask about the surveyor");
    expect((await getAgentLead(db, agent, id, later))?.followupDue).toBe(true);

    expect(await setLeadStatus(db, agent, id, "lost", "other", "")).toMatchObject({ ok: false });
    expect(await setLeadStatus(db, agent, id, "lost", "location", "Wants the coast")).toMatchObject({ ok: true });
    const lost = await getAgentLead(db, agent, id, later);
    expect(lost).toMatchObject({ status: "lost", lostReason: "location", nextFollowupAt: null, tone: "closed" });
    expect((await listAgentLeads(db, agent, now())).some(l => l.id === id)).toBe(false);
    expect((await listAgentLeads(db, agent, now(), { status: "lost" })).some(l => l.id === id)).toBe(true);
    // The buyer coming back reopens it.
    await say(await enquire(b), b, "Still interested");
    expect((await getAgentLead(db, agent, id, now()))?.status).toBe("new_inquiry");
  });

  it("never reminds for a lead whose appointment ended", async () => {
    const b = await buyer();
    await enquire(b);
    const id = String((await leadOf(b))["id"]);
    await scheduleFollowup(db, agent, id, 1, "", now());
    await db.query("UPDATE listing_agent_appointment SET revoked_at = now(), revoked_by = $2 WHERE listing_id = $1 AND revoked_at IS NULL", [listing, owner]);
    expect(await sendDueLeadReminders(db, new Date(Date.now() + 2 * 86_400_000).toISOString())).toBe(0);
  });
});

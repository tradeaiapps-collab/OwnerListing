import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addClientNote, askWorkspaceAssistant, clientDetail, getWorkspace, updateLead } from "../src/domain/agent-workspace";
import type { Actor } from "../src/domain/listing-service";
import { createWorkspaceDeps } from "../src/server/agent-workspace-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("agent workspace on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("scopes leads, offers, notes and stages to the appointed agent", async () => {
    const owner = await addUser(t.db, "owner"), a1 = await addUser(t.db, "agent"), a2 = await addUser(t.db, "agent");
    const b1 = await addUser(t.db, "buyer"), b2 = await addUser(t.db, "buyer");
    for (const a of [a1, a2]) await t.db.query("INSERT INTO agent_licence (user_id, jurisdiction, licence_number, status, verified_by, verified_at) VALUES ($1,'QLD','L-1','verified',$1, now())", [a]);
    const mine = await addListing(t.db, owner, { jurisdiction: "QLD", title: "Mine" });
    const theirs = await addListing(t.db, owner, { jurisdiction: "QLD", title: "Theirs" });
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3),($4,$5,$3)", [mine, a1, owner, theirs, a2]);
    const enq = async (listing: string, buyer: string) => String((await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id, created_at) VALUES ($1,$2, now() - interval '5 hours') RETURNING id", [listing, buyer])).rows[0]!["id"]);
    const e1 = await enq(mine, b1); await enq(theirs, b2);
    await t.db.query("INSERT INTO enquiry_message (enquiry_id, sender_user_id, body, sent_at) VALUES ($1,$2,'Hello', now() - interval '3 hours'), ($1,$3,'Hi there', now() - interval '2 hours')", [e1, b1, a1]);
    const link = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [link, mine, b1]);
    await t.db.query("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status) VALUES ($1,$2,90000000,30,1000000,true,$3,'submitted')", [mine, b1, link]);

    const d = createWorkspaceDeps(t.db);
    const me: Actor = { userId: a1, userType: "agent" }, other: Actor = { userId: a2, userType: "agent" };
    const w = await getWorkspace(d, me);
    if (!w.ok) throw new Error(w.message);
    expect(w.value.leads.map(l => l.listingTitle)).toEqual(["Mine"]);
    expect(w.value.leads[0]).toMatchObject({ buyerMessages: 1, agentMessages: 1, offerStatus: "submitted", stage: "offer" });
    expect(w.value.performance).toMatchObject({ openOffers: 1, pipelineCents: 90_000_000, listings: 1 });
    expect(w.value.performance.medianResponseMinutes).toBeGreaterThan(0);

    expect(await addClientNote(d, me, b1, { kind: "preference", body: "Wants a pool" })).toEqual({ ok: true, value: true });
    expect(await addClientNote(d, other, b1, { body: "sneaky" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await updateLead(d, me, e1, { stage: "viewing", followUpAt: "2026-12-01" })).toEqual({ ok: true, value: true });
    expect(await updateLead(d, other, e1, { stage: "lost" })).toMatchObject({ ok: false, code: "not_found" });
    const c = await clientDetail(d, me, b1);
    expect(c.ok && c.value.notes.map(n => n.body)).toEqual(["Wants a pool"]);
    expect(c.ok && c.value.lead).toMatchObject({ stage: "viewing", followUpAt: "2026-12-01", notes: 1 });
    expect(await clientDetail(d, other, b1)).toMatchObject({ ok: false });
    const a = await askWorkspaceAssistant(d, me, { question: "Summarise this client", buyerId: b1 });
    expect(a.ok && a.value.text).toContain("Wants a pool");
    // A second agent sees no trace of the first agent's log.
    const w2 = await getWorkspace(d, other);
    expect(w2.ok && w2.value.leads.every(l => l.notes === 0 && l.listingTitle === "Theirs")).toBe(true);
  }, 60_000);
});

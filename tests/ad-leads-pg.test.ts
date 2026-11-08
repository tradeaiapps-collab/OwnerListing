import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[], configured: true, notices: [] as { to: string; subject: string }[] }));
vi.mock("../src/server/messaging", async orig => ({
  ...(await orig<typeof import("../src/server/messaging")>()),
  getEmailPort: async () => ({ configured: mail.configured, send: async (m: { to: string; subject: string; text: string }) => { if (!mail.configured) return { status: "not_configured" }; mail.sent.push(m); return { status: "sent" }; } }),
  sendNotice: async (_db: unknown, _t: string, to: string, msg: { subject: string }) => { mail.notices.push({ to, subject: msg.subject }); return true; }
}));

import { parseSourceInput, type LeadInput } from "../src/domain/ad-leads";
import {
  assignLead, createSource, getSource, ingestLead, listLeads, recordSpend, rotateGoogleKey, setLeadStatus, sourceForGoogle, sourceForMetaPage,
  sourceReports, updateSource
} from "../src/server/ad-lead-db";
import { createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
const NOW = "2026-11-05T00:00:00.000Z";
const lead = (o: Partial<LeadInput> = {}): LeadInput => ({
  externalId: randomUUID(), name: "Jo Smith", email: `${randomUUID()}@lead.test`, phone: "+61412345678", interest: "buying", suburb: "Paddington", postcode: "4064",
  campaignRef: "Spring", adRef: "A1", isTest: false, ...o
});

describe.skipIf(!DATABASE_URL)("lead ads on PostgreSQL", () => {
  let t: TestDb;
  let staff: string, agent: string, owner: string;
  const user = async (type: string, status = "active") => String((await t.db.query("INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1,$2,$3,$4) RETURNING id", [`${randomUUID()}@t.au`, `${type} user`, type, status])).rows[0]!["id"]);
  const source = async (o: Record<string, unknown> = {}) => {
    const p = parseSourceInput({ provider: "meta", label: "Page", accountRef: String(Math.floor(1e10 + Math.random() * 9e9)), ...o });
    if (!p.ok) throw new Error(p.error);
    const r = await createSource(t.db, staff, p.value, NOW);
    if (!r.ok) throw new Error(r.error);
    return { ...r, src: (await getSource(t.db, r.id))! };
  };

  beforeAll(async () => { t = await createTestDb(); staff = await user("owner"); agent = await user("agent"); owner = await user("owner"); }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("connects sources: Google gets a one-time key stored as a hash; the same account cannot be added twice", async () => {
    const g = await source({ provider: "google", label: "Ads", accountRef: "123-456-7890" });
    expect(g.webhookKey).toMatch(/^[\w-]{30,}$/);
    const raw = await t.db.query("SELECT webhook_key_hash FROM ad_lead_source WHERE id = $1", [g.id]);
    expect(String(raw.rows[0]!["webhook_key_hash"])).not.toContain(g.webhookKey!);
    expect((await sourceForGoogle(t.db, g.id, g.webhookKey!))?.id).toBe(g.id);
    expect(await sourceForGoogle(t.db, g.id, "wrong")).toBeNull();
    expect(await sourceForGoogle(t.db, "not-a-uuid", g.webhookKey!)).toBeNull();
    const again = parseSourceInput({ provider: "google", label: "Ads 2", accountRef: "1234567890" });
    expect(again.ok && await createSource(t.db, staff, again.value, NOW)).toEqual({ ok: false, error: "That account is already connected." });
    const key2 = await rotateGoogleKey(t.db, staff, g.id, NOW);
    expect(await sourceForGoogle(t.db, g.id, g.webhookKey!)).toBeNull();
    expect((await sourceForGoogle(t.db, g.id, key2!))?.id).toBe(g.id);
    const m = await source();
    expect(m.webhookKey).toBeNull();
    expect((await sourceForMetaPage(t.db, m.src.accountRef))?.id).toBe(m.id);
    expect(await sourceForMetaPage(t.db, "999")).toBeNull();
  });

  it("refuses a default agent who is not an active agent account", async () => {
    const p = parseSourceInput({ provider: "meta", label: "Bad", accountRef: "55555", defaultAgentId: owner });
    expect(p.ok && await createSource(t.db, staff, p.value, NOW)).toEqual({ ok: false, error: "That agent is not an active agent account." });
    const suspended = await user("agent", "suspended");
    const { id } = await source();
    expect(await updateSource(t.db, staff, id, { defaultAgentId: suspended }, NOW)).toEqual({ ok: false, error: "That agent is not an active agent account." });
  });

  it("stores a lead once however often the webhook retries, assigns the default agent and tells them", async () => {
    mail.notices.length = 0;
    const { src } = await source({ defaultAgentId: agent });
    const l = lead();
    const a = await ingestLead(t.db, src, l, NOW, {});
    const b = await ingestLead(t.db, src, l, NOW, {});
    expect(a.created).toBe(true);
    expect(b).toEqual({ created: false, leadId: a.leadId, followup: "none" });
    const row = (await listLeads(t.db, { sourceId: src.id })).leads;
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ assignedAgentId: agent, status: "new", stage: "new", followupStatus: "none", interest: "buying" });
    expect(mail.notices).toHaveLength(1);
    const audit = await t.db.query("SELECT event_type FROM audit_event WHERE aggregate_id = $1", [a.leadId]);
    expect(audit.rows.map(r => r["event_type"])).toEqual(["ad_lead.received"]);
  });

  it("sends the follow-up once with property matches in the lead's postcode; never for tests, sellers' matches, or when off", async () => {
    mail.sent.length = 0;
    const { src } = await source({ followupMode: "matches", defaultAgentId: agent });
    const mk = async (postcode: string, type: string, status: string) => t.db.query(
      "INSERT INTO property_listing (owner_user_id, jurisdiction, transaction_type, use_class, property_type, title, address_text, status, suburb, postcode, price_cents) VALUES ($1,'QLD',$2,'residential','house','Nice home','1 Test St',$3,'Paddington',$4,$5)",
      [owner, type, status, postcode, type === "rent" ? 65000 : 90000000]);
    await mk("4064", "sale", "published"); await mk("4064", "rent", "published"); await mk("4064", "sale", "draft"); await mk("4000", "sale", "published");
    const r = await ingestLead(t.db, src, lead({ interest: "buying" }), NOW, { APP_URL: "https://app.test" });
    expect(r.followup).toBe("sent");
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.text.match(/\/listings\//g)).toHaveLength(1); // one published sale in 4064; not the rental, draft or other postcode
    expect(mail.sent[0]!.text).toContain("will be in touch");
    expect((await listLeads(t.db, { sourceId: src.id })).leads[0]!.followupStatus).toBe("sent");

    mail.sent.length = 0;
    expect((await ingestLead(t.db, src, lead({ isTest: true }), NOW, {})).followup).toBe("skipped");
    expect((await ingestLead(t.db, src, lead({ email: null }), NOW, {})).followup).toBe("skipped");
    const seller = await ingestLead(t.db, src, lead({ interest: "selling" }), NOW, {});
    expect(seller.followup).toBe("sent");
    expect(mail.sent.at(-1)!.text).not.toContain("/listings/");
    const off = (await source()).src;
    expect((await ingestLead(t.db, off, lead(), NOW, {})).followup).toBe("skipped");
    expect(mail.sent).toHaveLength(1); // only the seller's contact email went out
  });

  it("records a failed follow-up when email is not configured, and still keeps the lead", async () => {
    mail.configured = false;
    try {
      const { src } = await source({ followupMode: "contact" });
      const r = await ingestLead(t.db, src, lead(), NOW, {});
      expect(r).toMatchObject({ created: true, followup: "failed" });
      expect((await listLeads(t.db, { sourceId: src.id })).leads[0]!.followupStatus).toBe("failed");
    } finally { mail.configured = true; }
  });

  it("assigns and unassigns, tracks status, and needs a reason to mark a lead lost", async () => {
    const { src } = await source();
    const { leadId } = await ingestLead(t.db, src, lead(), NOW, {});
    expect(await assignLead(t.db, staff, leadId, agent, NOW, {})).toEqual({ ok: true });
    expect((await listLeads(t.db, { agentId: agent, sourceId: src.id })).leads[0]!.assignedAgentName).toBe("agent user");
    expect(await assignLead(t.db, staff, leadId, owner, NOW, {})).toEqual({ ok: false, error: "That agent is not an active agent account." });
    expect(await assignLead(t.db, staff, randomUUID(), agent, NOW, {})).toEqual({ ok: false, error: "Lead not found." });
    expect(await assignLead(t.db, staff, leadId, null, NOW, {})).toEqual({ ok: true });
    expect((await listLeads(t.db, { status: "unassigned", sourceId: src.id })).total).toBe(1);
    expect(await setLeadStatus(t.db, staff, leadId, "lost", null, NOW)).toEqual({ ok: false, error: "Say why the lead was lost." });
    expect(await setLeadStatus(t.db, staff, leadId, "lost", "Not answering", NOW)).toEqual({ ok: true });
    expect((await listLeads(t.db, { status: "lost", sourceId: src.id })).leads[0]).toMatchObject({ lostReason: "Not answering", stage: "lost" });
    expect(await setLeadStatus(t.db, staff, leadId, "contacted", null, NOW)).toEqual({ ok: true });
    expect((await listLeads(t.db, { sourceId: src.id })).leads[0]!.lostReason).toBeNull();
  });

  it("derives enquiry and offer from an account with the lead's email, only after the lead arrived", async () => {
    const { src } = await source();
    const buyer = await user("owner");
    const email = String((await t.db.query("SELECT email FROM app_user WHERE id = $1", [buyer])).rows[0]!["email"]);
    const listing = String((await t.db.query(
      "INSERT INTO property_listing (owner_user_id, jurisdiction, transaction_type, use_class, property_type, title, address_text, status) VALUES ($1,'QLD','sale','residential','house','H','1 A St','published') RETURNING id", [owner])).rows[0]!["id"]);
    await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id, created_at) VALUES ($1,$2,'2026-11-01T00:00:00Z')", [listing, buyer]); // before the lead
    const early = await ingestLead(t.db, src, lead({ email }), "2026-11-02T00:00:00.000Z", {});
    expect((await listLeads(t.db, { sourceId: src.id })).leads.find(x => x.id === early.leadId)!.enquired).toBe(false);
    const listing2 = String((await t.db.query(
      "INSERT INTO property_listing (owner_user_id, jurisdiction, transaction_type, use_class, property_type, title, address_text, status) VALUES ($1,'QLD','sale','residential','house','H2','2 A St','published') RETURNING id", [owner])).rows[0]!["id"]);
    await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id, created_at) VALUES ($1,$2,'2026-11-03T00:00:00Z')", [listing2, buyer]);
    expect((await listLeads(t.db, { sourceId: src.id, status: "enquiry" })).leads.map(x => [x.id, x.stage])).toEqual([[early.leadId, "enquiry"]]);
    expect((await listLeads(t.db, { sourceId: src.id, status: "offer" })).total).toBe(0);
    const link = createHashLike();
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3,'2027-01-01')", [link, listing2, buyer]);
    await t.db.query("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, submitted_at) VALUES ($1,$2,80000000,30,1000000,true,$3,'2026-11-04T00:00:00Z')", [listing2, buyer, link]);
    expect((await listLeads(t.db, { sourceId: src.id, status: "offer" })).leads[0]).toMatchObject({ id: early.leadId, stage: "offer", offered: true });
  });

  it("works out per-source figures from leads and recorded spend, leaving test leads out", async () => {
    const { src, id } = await source();
    const a = await ingestLead(t.db, src, lead(), "2026-11-04T00:00:00.000Z", {});
    await ingestLead(t.db, src, lead(), "2026-11-04T00:00:00.000Z", {});
    await ingestLead(t.db, src, lead({ isTest: true }), "2026-11-04T00:00:00.000Z", {});
    await setLeadStatus(t.db, staff, a.leadId, "contacted", null, NOW);
    expect(await recordSpend(t.db, staff, id, [{ day: "2026-11-04", spendCents: 4000 }, { day: "2026-11-03", spendCents: 2000 }], NOW)).toBe(true);
    expect(await recordSpend(t.db, staff, id, [{ day: "2026-11-04", spendCents: 5000 }], NOW)).toBe(true); // a correction replaces the day
    expect(await recordSpend(t.db, staff, randomUUID(), [{ day: "2026-11-04", spendCents: 1 }], NOW)).toBe(false);
    const rep = (await sourceReports(t.db, 30, "2026-11-05T00:00:00.000Z")).find(s => s.id === id)!;
    expect(rep.figures).toMatchObject({ leads: 2, contacted: 1, spendCents: 7000, costPerLeadCents: 3500, contactRate: 0.5 });
    const narrow = (await sourceReports(t.db, 1, "2026-11-05T00:00:00.000Z")).find(s => s.id === id)!;
    expect(narrow.figures.spendCents).toBe(5000); // only 2026-11-04 falls in the last day
    const none = (await sourceReports(t.db, 7, "2026-12-30T00:00:00.000Z")).find(s => s.id === id)!;
    expect(none.figures).toMatchObject({ leads: 0, costPerLeadCents: null, enquiryRate: null });
  });

  it("pages the inbox newest first", async () => {
    const { src } = await source();
    for (let i = 0; i < 3; i++) await ingestLead(t.db, src, lead({ name: `L${i}` }), `2026-11-0${i + 1}T00:00:00.000Z`, {});
    const p1 = await listLeads(t.db, { sourceId: src.id, limit: 2 });
    const p2 = await listLeads(t.db, { sourceId: src.id, limit: 2, offset: 2 });
    expect([p1.total, p1.leads.map(x => x.name), p2.leads.map(x => x.name)]).toEqual([3, ["L2", "L1"], ["L0"]]);
  });
});

const createHashLike = () => randomUUID().replace(/-/g, "").repeat(2);

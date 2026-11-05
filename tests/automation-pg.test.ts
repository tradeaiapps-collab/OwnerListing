import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { emitOfferReceived, createRulePg, deleteRulePg, listRulesPg, recordListingView, scanAgingListings } from "../src/server/automation-db";
import { audienceCountPg, createCampaignPg, getCampaignPg, moveCampaignPg, recordClickPg, recordOpenPg, runDueCampaigns } from "../src/server/campaigns-db";
import { runAutomationTick } from "../src/server/automation-run";
import { getPreferencesPg, savePreferencesPg } from "../src/server/notifications-db";
import { createTaskPg, deleteTaskPg, listTasksPg, runDueTasks, runTaskNowPg, setTaskEnabledPg } from "../src/server/scheduled-tasks-db";
import type { RuleInput } from "../src/domain/automation";
import type { CampaignInput } from "../src/domain/campaigns";
import type { TaskInput } from "../src/domain/scheduled-tasks";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const KEY = "k".repeat(40);
const env = {
  APP_URL: "https://owner.example", SESSION_SECRET: "s".repeat(40), ALERT_UNSUBSCRIBE_KEY: KEY,
  SMTP_HOST: "smtp.mail.example", SMTP_PORT: "587", SMTP_FROM: "hello@owner.example", SMTP_USER: "u", SMTP_PASSWORD: "p",
  SMS_PROVIDER: "twilio", SMS_ACCOUNT_SID: "AC" + "a".repeat(32), SMS_AUTH_TOKEN: "t0ken-secret-value-1234567890abcd", SMS_SENDER: "+61400000001"
};
const rule = (o: Partial<RuleInput> = {}): RuleInput => ({
  name: "Rule", enabled: true, trigger: "offer_received", triggerConfig: {}, recipient: "owner_and_agent", messageKind: "system_notice", title: "Offer on {listing}", body: "Look at {listing}.", link: "/listings/mine", ...o
});
const campaign = (o: Partial<CampaignInput> = {}): CampaignInput => ({
  name: "News", channel: "email", segment: "all_agents", segmentConfig: {}, subject: "Hello", body: "Body text", ctaUrl: "https://owner.example/news", scheduledAt: null, ...o
});
const task = (o: Partial<TaskInput> = {}): TaskInput => ({ name: "Task", kind: "archive_stale_listings", config: { days: 365 }, cadence: "daily", hour: 9, weekday: null, dayOfMonth: null, runAt: null, ...o });
const NOW = new Date().toISOString();

describe.skipIf(!DATABASE_URL)("automation (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  let staff: string;
  beforeAll(async () => { t = await createTestDb(); db = t.db; staff = await addUser(db, "admin"); }, 60_000);
  afterAll(async () => { await t?.close(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const notes = async (uid: string) => (await db.query("SELECT title, body, link FROM notification WHERE user_id = $1::uuid ORDER BY created_at", [uid])).rows;
  async function optIn(uid: string, ch: { email?: boolean; sms?: boolean; inApp?: boolean }) {
    const p = await getPreferencesPg(db, uid);
    await savePreferencesPg(db, uid, { marketing: { inApp: ch.inApp ?? p.marketing.inApp, email: ch.email ?? p.marketing.email, sms: ch.sms ?? p.marketing.sms } }, "settings");
  }
  async function listingWithAgent(o: Record<string, unknown> = {}) {
    const owner = await addUser(db, "owner");
    const agent = await addUser(db, "agent");
    const listingId = await addListing(db, owner, { status: "published", address_text: "5 Rule St", ...o });
    await db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3)", [listingId, agent, owner]);
    return { owner, agent, listingId };
  }

  describe("workflow rules", () => {
    it("tells the owner and the agent once per offer, with the listing in the wording", async () => {
      await createRulePg(db, rule(), staff);
      const l = await listingWithAgent();
      const buyer = await addUser(db, "buyer");
      const offerId = randomUUID();
      await emitOfferReceived(db, { offerId, listingId: l.listingId, buyerUserId: buyer }, env);
      await emitOfferReceived(db, { offerId, listingId: l.listingId, buyerUserId: buyer }, env); // the same event again
      for (const u of [l.owner, l.agent]) {
        const n = (await notes(u)).filter(x => x["title"] === "Offer on 5 Rule St");
        expect(n).toHaveLength(1);
        expect(n[0]).toMatchObject({ body: "Look at 5 Rule St.", link: "/listings/mine" });
      }
      expect((await notes(buyer)).filter(x => String(x["title"]).startsWith("Offer on"))).toHaveLength(0);
      const r = (await listRulesPg(db)).find(x => x.trigger === "offer_received")!;
      expect(r.runs).toBe(1);
      expect(r.lastFiredAt).not.toBeNull();
    });

    it("does nothing for a switched-off rule and keeps history when a used rule is removed", async () => {
      const id = await createRulePg(db, rule({ name: "Off rule", enabled: false, title: "Should not appear" }), staff);
      const l = await listingWithAgent();
      await emitOfferReceived(db, { offerId: randomUUID(), listingId: l.listingId, buyerUserId: await addUser(db, "buyer") }, env);
      expect((await notes(l.owner)).filter(x => x["title"] === "Should not appear")).toHaveLength(0);
      expect(await deleteRulePg(db, id)).toBe("deleted");
      const used = (await listRulesPg(db)).find(x => x.trigger === "offer_received" && x.runs > 0)!;
      expect(await deleteRulePg(db, used.id)).toBe("disabled");
      expect((await listRulesPg(db)).find(x => x.id === used.id)!.enabled).toBe(false);
    });

    it("fires the viewed-N-times rule once per buyer when the count is reached, counting one view an hour and never the owner", async () => {
      await db.query("UPDATE automation_rule SET enabled = false");
      await createRulePg(db, rule({ name: "Views", trigger: "listing_viewed_repeat", triggerConfig: { views: 3, windowDays: 14 }, recipient: "buyer", messageKind: "marketing_news", title: "Still interested?", body: "You viewed {listing} {count} times." }), staff);
      const l = await listingWithAgent();
      const buyer = await addUser(db, "buyer");
      await optIn(buyer, { inApp: true });
      const view = () => recordListingView(db, { listingId: l.listingId, viewerUserId: buyer }, env);
      await view(); await view(); // two refreshes in the same hour are one view
      expect(Number((await db.query("SELECT count(*)::int AS n FROM listing_view WHERE viewer_user_id = $1", [buyer])).rows[0]!["n"])).toBe(1);
      await db.query("UPDATE listing_view SET viewed_at = now() - interval '5 hours' WHERE viewer_user_id = $1", [buyer]);
      await view();
      await db.query("UPDATE listing_view SET viewed_at = now() - interval '3 hours' WHERE viewer_user_id = $1 AND viewed_at > now() - interval '1 hour'", [buyer]);
      expect((await notes(buyer)).filter(x => x["title"] === "Still interested?")).toHaveLength(0);
      await view();
      const got = (await notes(buyer)).filter(x => x["title"] === "Still interested?");
      expect(got).toHaveLength(1);
      expect(got[0]!["body"]).toBe("You viewed 5 Rule St 3 times.");
      await view(); await db.query("UPDATE listing_view SET viewed_at = viewed_at - interval '2 hours'"); await view();
      expect((await notes(buyer)).filter(x => x["title"] === "Still interested?")).toHaveLength(1);
      await recordListingView(db, { listingId: l.listingId, viewerUserId: l.owner }, env);
      expect(Number((await db.query("SELECT count(*)::int AS n FROM listing_view WHERE viewer_user_id = $1", [l.owner])).rows[0]!["n"])).toBe(0);
    });

    it("tells owners of listings live for the set days, once each", async () => {
      await db.query("UPDATE automation_rule SET enabled = false");
      await createRulePg(db, rule({ name: "Aging", trigger: "listing_aging", triggerConfig: { days: 90 }, recipient: "owner", title: "Time to relist {listing}?", body: "Live {days} days." }), staff);
      const old = await listingWithAgent({ created_at: new Date(Date.now() - 100 * 86_400_000).toISOString(), address_text: "9 Old Rd" });
      const fresh = await listingWithAgent({ address_text: "1 New Rd" });
      const draft = await listingWithAgent({ status: "draft", created_at: new Date(Date.now() - 200 * 86_400_000).toISOString() });
      expect(await scanAgingListings(db, env)).toBe(1);
      expect(await scanAgingListings(db, env)).toBe(0);
      expect((await notes(old.owner)).filter(x => x["title"] === "Time to relist 9 Old Rd?")).toHaveLength(1);
      expect((await notes(old.owner)).find(x => x["title"] === "Time to relist 9 Old Rd?")!["body"]).toBe("Live 90 days.");
      expect((await notes(fresh.owner)).filter(x => String(x["title"]).startsWith("Time to relist"))).toHaveLength(0);
      expect((await notes(draft.owner)).filter(x => String(x["title"]).startsWith("Time to relist"))).toHaveLength(0);
      expect((await notes(old.agent)).filter(x => String(x["title"]).startsWith("Time to relist"))).toHaveLength(0);
    });

    it("refuses an off-site link and an unknown trigger in the database", async () => {
      await expect(db.query("INSERT INTO automation_rule (name, trigger, recipient, message_kind, title, body, link, created_by) VALUES ('abc','offer_received','owner','system_notice','t','b','//evil.test',$1)", [staff])).rejects.toThrow();
      await expect(db.query("INSERT INTO automation_rule (name, trigger, recipient, message_kind, title, body, created_by) VALUES ('abc','nope','owner','system_notice','t','b',$1)", [staff])).rejects.toThrow();
    });
  });

  describe("campaigns", () => {
    const sendMail = vi.fn(async (_m: Record<string, unknown>) => ({ messageId: "<m@example.test>" }));
    const deps = { resolve: async () => ["93.184.216.34"], createTransport: (() => ({ sendMail, close() { /* none */ } })) as never };
    async function agent(optedIn = true) { const u = await addUser(db, "agent"); if (optedIn) await optIn(u, { email: true }); return u; }
    const sentTo = () => sendMail.mock.calls.map(c => String(c[0]["to"]));
    const emailOf = async (u: string) => String((await db.query("SELECT email FROM app_user WHERE id = $1", [u])).rows[0]!["email"]);

    it("reaches only opted-in people on the channel and counts them before sending", async () => {
      const a = await agent(), b = await agent(false), s = await agent();
      await db.query("UPDATE app_user SET status = 'suspended' WHERE id = $1", [s]);
      const owner = await addUser(db, "owner"); await optIn(owner, { email: true });
      const before = await audienceCountPg(db, "email", "all_agents", {});
      expect(before).toBeGreaterThanOrEqual(1);
      const ids = (await db.query("SELECT u.id FROM app_user u JOIN notification_preference p ON p.user_id = u.id AND p.category = 'marketing' AND p.email WHERE u.user_type = 'agent' AND u.status = 'active'")).rows.map(r => String(r["id"]));
      expect(ids).toContain(a); expect(ids).not.toContain(b); expect(ids).not.toContain(s); expect(ids).not.toContain(owner);
      expect(await audienceCountPg(db, "sms", "all_agents", {})).toBe(0); // nobody has opted in to SMS with a verified mobile
    });

    it("sends once with an unsubscribe link and an open pixel, tracks opens and clicks, and finishes", async () => {
      const a = await agent();
      const id = await createCampaignPg(db, campaign({ segment: "all_agents" }), staff);
      expect(await moveCampaignPg(db, id, "sending", null)).toEqual({ ok: true });
      sendMail.mockClear();
      const first = await runDueCampaigns(db, NOW, env, deps);
      expect(first.sent).toBeGreaterThanOrEqual(1);
      const again = await runDueCampaigns(db, NOW, env, deps); // a repeat tick sends nothing more
      expect(again.sent).toBe(0);
      expect(sentTo().filter(x => x === sentTo()[0]).length).toBe(1);
      const mine = sendMail.mock.calls[0]!;
      const html = String(mine[0]["html"]);
      expect(html).toContain("https://owner.example/api/campaigns/open/");
      expect(html).toContain("https://owner.example/api/campaigns/click/");
      expect(html).toContain("/api/notifications/unsubscribe?t=");
      expect(String(mine[0]["text"])).toContain("Unsubscribe:");
      const row = (await db.query("SELECT token, status FROM campaign_recipient WHERE campaign_id = $1 AND user_id = $2", [id, a])).rows[0]!;
      expect(row["status"]).toBe("sent");
      await recordOpenPg(db, String(row["token"])); await recordOpenPg(db, String(row["token"]));
      expect(await recordClickPg(db, String(row["token"]))).toBe("https://owner.example/news");
      expect(await recordClickPg(db, "does-not-exist-token-123456")).toBeNull();
      const c = (await getCampaignPg(db, id))!;
      expect(c.status).toBe("sent");
      expect(c.stats.opened).toBeGreaterThanOrEqual(1);
      expect(c.stats.clicked).toBe(1);
      expect(c.stats.openRate).toBeGreaterThan(0);
      expect(Number((await db.query("SELECT open_count FROM campaign_recipient WHERE token = $1", [row["token"]])).rows[0]!["open_count"])).toBe(2);
    });

    it("skips someone who opted out after the list was fixed, and never sends marketing mail without an unsubscribe key", async () => {
      const a = await agent();
      const id = await createCampaignPg(db, campaign({ name: "Optout test" }), staff);
      await moveCampaignPg(db, id, "sending", null);
      await optIn(a, { email: false });
      sendMail.mockClear();
      await runDueCampaigns(db, NOW, env, deps);
      expect(sentTo()).not.toContain(await emailOf(a));
      expect((await db.query("SELECT status FROM campaign_recipient WHERE campaign_id = $1 AND user_id = $2", [id, a])).rows[0]!["status"]).toBe("skipped");

      const b = await agent();
      const id2 = await createCampaignPg(db, campaign({ name: "No key" }), staff);
      await moveCampaignPg(db, id2, "sending", null);
      sendMail.mockClear();
      await runDueCampaigns(db, NOW, { ...env, ALERT_UNSUBSCRIBE_KEY: "" }, deps);
      expect(sendMail).not.toHaveBeenCalled();
      expect((await db.query("SELECT status FROM campaign_recipient WHERE campaign_id = $1 AND user_id = $2", [id2, b])).rows[0]!["status"]).toBe("skipped");
    });

    it("starts a scheduled campaign only when its time comes, and a cancelled one sends nothing", async () => {
      await agent();
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const id = await createCampaignPg(db, campaign({ name: "Later", scheduledAt: future }), staff);
      sendMail.mockClear();
      const early = await runDueCampaigns(db, NOW, env, deps);
      expect(early.started).toBe(0);
      expect((await getCampaignPg(db, id))!.status).toBe("scheduled");
      expect(await moveCampaignPg(db, id, "cancelled", null)).toEqual({ ok: true });
      await runDueCampaigns(db, new Date(Date.now() + 7_200_000).toISOString(), env, deps);
      expect(sendMail).not.toHaveBeenCalled();
      expect(await moveCampaignPg(db, id, "sending", null)).toMatchObject({ ok: false });
      const id2 = await createCampaignPg(db, campaign({ name: "Due", scheduledAt: future }), staff);
      sendMail.mockClear();
      const late = await runDueCampaigns(db, new Date(Date.now() + 7_200_000).toISOString(), env, deps);
      expect(late.started).toBeGreaterThanOrEqual(1);
      expect(["sending", "sent"]).toContain((await getCampaignPg(db, id2))!.status);
    });

    it("holds an email campaign while email is not configured instead of marking it failed", async () => {
      await agent();
      const id = await createCampaignPg(db, campaign({ name: "No SMTP" }), staff);
      await moveCampaignPg(db, id, "sending", null);
      const r = await runDueCampaigns(db, NOW, {}, deps);
      expect(r.notConfigured).toBeGreaterThanOrEqual(1);
      expect((await getCampaignPg(db, id))!.status).toBe("sending");
      expect((await getCampaignPg(db, id))!.stats.pending).toBeGreaterThan(0);
    });

    it("texts opted-in buyers with a verified mobile, in the area they search, with the opt-out wording and tracked link", async () => {
      const inArea = await addUser(db, "buyer"), outArea = await addUser(db, "buyer"), noSms = await addUser(db, "buyer");
      for (const [u, phone] of [[inArea, "+61400000201"], [outArea, "+61400000202"], [noSms, "+61400000203"]] as const) {
        await db.query("INSERT INTO buyer_verification (user_id, phone_verified_at, phone_e164) VALUES ($1, now(), $2)", [u, phone]);
        if (u !== noSms) await optIn(u, { sms: true });
      }
      const search = (jur: string, sub: string[]) => JSON.stringify({ transactionType: "sale", useClass: "residential", jurisdictions: [jur], suburbs: sub, propertyTypes: [] });
      await db.query("INSERT INTO saved_search (buyer_user_id, criteria) VALUES ($1, $2::jsonb), ($3, $4::jsonb), ($5, $2::jsonb)", [inArea, search("QLD", ["Paddington"]), outArea, search("VIC", ["Carlton"]), noSms]);
      expect(await audienceCountPg(db, "sms", "buyers_in_area", { suburbs: ["paddington"] })).toBe(1);
      expect(await audienceCountPg(db, "sms", "buyers_in_area", { state: "QLD" })).toBe(1);
      expect(await audienceCountPg(db, "sms", "buyers_in_area", { state: "VIC" })).toBe(1);
      expect(await audienceCountPg(db, "sms", "buyers_in_area", { state: "NSW" })).toBe(0);
      const id = await createCampaignPg(db, campaign({ name: "Texts", channel: "sms", subject: null, segment: "buyers_in_area", segmentConfig: { state: "QLD" }, body: "New homes in your area." }), staff);
      await moveCampaignPg(db, id, "sending", null);
      const calls: URLSearchParams[] = [];
      vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => { calls.push(new URLSearchParams(init.body)); return new Response(JSON.stringify({ sid: "SM" + randomUUID().replace(/-/g, "") }), { status: 201 }); });
      const r = await runDueCampaigns(db, NOW, env);
      expect(r.sent).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.get("To")).toBe("+61400000201");
      expect(calls[0]!.get("Body")).toContain("Turn texts off");
      expect(calls[0]!.get("Body")).toContain("https://owner.example/api/campaigns/click/");
      expect((await getCampaignPg(db, id))!.status).toBe("sent");
      expect(Number((await db.query("SELECT count(*)::int AS n FROM sms_message WHERE template = 'campaign'")).rows[0]!["n"])).toBe(1);
    });

    it("lets only a draft or scheduled campaign be edited", async () => {
      const id = await createCampaignPg(db, campaign({ name: "Edit me" }), staff);
      const { updateCampaignPg } = await import("../src/server/campaigns-db");
      expect(await updateCampaignPg(db, id, campaign({ name: "Edited" }))).toBe(true);
      await moveCampaignPg(db, id, "cancelled", null);
      expect(await updateCampaignPg(db, id, campaign({ name: "Again" }))).toBe(false);
      expect((await getCampaignPg(db, id))!.name).toBe("Edited");
    });
  });

  describe("scheduled tasks", () => {
    it("archives only old draft and withdrawn listings and writes an audit event for each", async () => {
      const owner = await addUser(db, "owner");
      const old = await addListing(db, owner, { status: "draft" });
      const oldPub = await addListing(db, owner, { status: "published" });
      const recent = await addListing(db, owner, { status: "draft" });
      await db.query("UPDATE property_listing SET updated_at = now() - interval '400 days' WHERE id = ANY($1::uuid[])", [[old, oldPub]]);
      const id = await createTaskPg(db, task({ name: "Archive" }), staff, NOW);
      expect(await runTaskNowPg(db, id, NOW, env)).toBe(true);
      const status = async (l: string) => String((await db.query("SELECT status FROM property_listing WHERE id = $1", [l])).rows[0]!["status"]);
      expect(await status(old)).toBe("archived");
      expect(await status(oldPub)).toBe("published");
      expect(await status(recent)).toBe("draft");
      expect(Number((await db.query("SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'listing.archived_by_schedule' AND aggregate_id = $1", [old])).rows[0]!["n"])).toBe(1);
      const row = (await listTasksPg(db)).find(x => x.id === id)!;
      expect(row).toMatchObject({ lastStatus: "ok" });
      expect(row.lastDetail).toContain("Archived 1");
      expect(await deleteTaskPg(db, id, NOW)).toBe("disabled");
    });

    it("runs a due task once, moves it to its next run, and finishes a one-off", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const daily = await createTaskPg(db, task({ name: "Daily", kind: "invite_reminders", config: {} }), staff, NOW);
      await db.query("UPDATE scheduled_task SET next_run_at = $2 WHERE id = $1", [daily, past]);
      const once = await createTaskPg(db, task({ name: "Once", kind: "invite_reminders", config: {}, cadence: "once", runAt: new Date(Date.now() + 3_600_000).toISOString() }), staff, NOW);
      await db.query("UPDATE scheduled_task SET next_run_at = $2 WHERE id = $1", [once, past]);
      const [a, b] = await Promise.all([runDueTasks(db, NOW, env), runDueTasks(db, NOW, env)]);
      expect(a.due + b.due).toBeGreaterThanOrEqual(2);
      expect(a.ok + b.ok).toBe(2); // each ran exactly once between the two overlapping ticks
      const runs = async (id: string) => Number((await db.query("SELECT count(*)::int AS n FROM scheduled_task_run WHERE task_id = $1", [id])).rows[0]!["n"]);
      expect(await runs(daily)).toBe(1);
      expect(await runs(once)).toBe(1);
      const rows = await listTasksPg(db);
      const d = rows.find(x => x.id === daily)!, o = rows.find(x => x.id === once)!;
      expect(d.enabled).toBe(true);
      expect(Date.parse(d.nextRunAt!)).toBeGreaterThan(Date.now());
      expect(o.enabled).toBe(false);
      expect(o.nextRunAt).toBeNull();
    });

    it("switching a task back on never replays missed runs", async () => {
      const id = await createTaskPg(db, task({ name: "Pause me", kind: "invite_reminders", config: {} }), staff, NOW);
      await setTaskEnabledPg(db, id, false, NOW);
      await db.query("UPDATE scheduled_task SET next_run_at = now() - interval '3 days' WHERE id = $1", [id]);
      await setTaskEnabledPg(db, id, true, NOW);
      expect(Date.parse((await listTasksPg(db)).find(x => x.id === id)!.nextRunAt!)).toBeGreaterThan(Date.now());
    });

    it("emails a summary to the staff member who created it, or records that email is off", async () => {
      const id = await createTaskPg(db, task({ name: "Summary", kind: "platform_summary", config: { days: 7 } }), staff, NOW);
      await runTaskNowPg(db, id, NOW, {});
      const row = (await listTasksPg(db)).find(x => x.id === id)!;
      expect(row.lastStatus).toBe("ok");
      expect(row.lastDetail).toMatch(/Email not sent/);
    });
  });

  it("the 15-minute tick runs rules, campaigns and tasks together and writes one audit event", async () => {
    const r = await runAutomationTick(db, NOW, {});
    expect(r.errors).toEqual([]);
    expect(r.tasks).not.toBeNull();
    expect(Number((await db.query("SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'job.automation_run'")).rows[0]!["n"])).toBe(1);
  });
});

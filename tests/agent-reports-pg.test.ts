import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteReport, listReports, runDueReports, runReport, saveReport, savedReport, templateDefinition } from "../src/domain/agent-reports";
import type { Actor } from "../src/domain/listing-service";
import { createReportDeps } from "../src/server/agent-reports-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("agent reports on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("reports only the agent's own listings, saves and schedules, and emails each due report once", async () => {
    const owner = await addUser(t.db, "owner"), a1 = await addUser(t.db, "agent"), a2 = await addUser(t.db, "agent"), b1 = await addUser(t.db, "buyer");
    for (const a of [a1, a2]) await t.db.query("INSERT INTO agent_licence (user_id, jurisdiction, licence_number, status, verified_by, verified_at) VALUES ($1,'QLD','L-1','verified',$1, now())", [a]);
    const mine = await addListing(t.db, owner, { jurisdiction: "QLD", title: "Mine" }), theirs = await addListing(t.db, owner, { jurisdiction: "QLD", title: "Theirs" });
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3),($4,$5,$3)", [mine, a1, owner, theirs, a2]);
    await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id, created_at) VALUES ($1,$3, now() - interval '3 days'), ($2,$3, now() - interval '3 days')", [mine, theirs, b1]);
    const offer = async (listing: string, status: string, cents: number) => {
      const link = randomUUID().replace(/-/g, "").padEnd(64, "0");
      await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [link, listing, b1]);
      await t.db.query("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status, submitted_at) VALUES ($1,$2,$3,30,1000000,true,$4,$5, now() - interval '2 days')", [listing, b1, cents, link, status]);
    };
    await offer(mine, "accepted", 90_000_000); await offer(theirs, "accepted", 500_000_000);

    const sent: { to: string; subject: string }[] = [];
    const d = { ...createReportDeps(t.db), send: async (_a: string, to: string, subject: string) => { sent.push({ to, subject }); return true; } };
    const me: Actor = { userId: a1, userType: "agent" }, other: Actor = { userId: a2, userType: "agent" };

    const r = await runReport(d, me, { ...templateDefinition("sales"), period: { days: 30 } });
    if (!r.ok) throw new Error(r.message);
    expect(r.value.report.rows.map(x => x.label)).toEqual(["Mine"]);
    expect(r.value.report.totals).toMatchObject({ offers: 1, accepted: 1, accepted_cents: 90_000_000 });

    const saved = await saveReport(d, me, { name: "Sales", definition: { template: "sales" }, schedule: { frequency: "weekly" } });
    if (!saved.ok) throw new Error(saved.message);
    const id = saved.value.id;
    const list = await listReports(d, me);
    expect(list.ok && list.value.reports[0]).toMatchObject({ name: "Sales", schedule: { frequency: "weekly" } });
    expect(await listReports(d, other)).toMatchObject({ ok: true, value: { reports: [] } });
    expect(await savedReport(d, other, id, true)).toMatchObject({ ok: false, code: "not_found" });
    expect(await deleteReport(d, other, "not-a-uuid")).toMatchObject({ ok: false, code: "not_found" });

    const snap = await savedReport(d, me, id, true);
    expect(snap.ok && snap.value.history).toMatchObject([{ trigger: "manual", totals: { offers: 1 } }]);

    // Not due yet; make it due, then two overlapping ticks send exactly one email.
    expect(await runDueReports(d, "https://own.example")).toMatchObject({ due: 0 });
    await t.db.query("UPDATE agent_report_schedule SET next_run_at = now() - interval '1 minute' WHERE report_id = $1::uuid", [id]);
    const ticks = await Promise.all([runDueReports(d, "https://own.example"), runDueReports(d, "https://own.example")]);
    expect(ticks.reduce((s, x) => s + x.sent, 0)).toBe(1);
    expect(sent).toHaveLength(1);
    const row = (await t.db.query("SELECT last_status, next_run_at > now() AS future FROM agent_report_schedule WHERE report_id = $1::uuid", [id])).rows[0]!;
    expect(row).toMatchObject({ last_status: "sent", future: true });
    const hist = await savedReport(d, me, id, false);
    expect(hist.ok && hist.value.history.map(h => h.trigger).sort()).toEqual(["manual", "scheduled"]);

    // A lapsed licence stops the email but still books the next run.
    await t.db.query("UPDATE agent_licence SET status = 'revoked' WHERE user_id = $1", [a1]);
    await t.db.query("UPDATE agent_report_schedule SET next_run_at = now() - interval '1 minute' WHERE report_id = $1::uuid", [id]);
    expect(await runDueReports(d, undefined)).toMatchObject({ skipped: 1, sent: 0 });
    expect(sent).toHaveLength(1);
    await t.db.query("UPDATE agent_licence SET status = 'verified' WHERE user_id = $1", [a1]);

    expect(await deleteReport(d, me, id)).toMatchObject({ ok: true });
    expect((await t.db.query("SELECT count(*)::int AS n FROM agent_report_run WHERE report_id = $1::uuid", [id])).rows[0]!["n"]).toBe(0);
  }, 60_000);
});

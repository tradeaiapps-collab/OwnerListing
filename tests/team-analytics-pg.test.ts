import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, createTeam, recordCommission } from "../src/domain/agency-team";
import type { Actor } from "../src/domain/listing-service";
import { analyticsPeriod, teamAnalytics } from "../src/domain/team-analytics";
import { buildTeamComparison } from "../src/domain/team-compare";
import { parseTeamFilter, runTeamReport, teamDefinitionFromQuery } from "../src/domain/team-reports";
import { createPgAgencyTeamRepository } from "../src/server/agency-team-db";
import { loadInsightFacts } from "../src/server/admin-elena-insights-db";
import { createTeamAnalyticsDeps, loadTeamFacts } from "../src/server/team-analytics-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL with every migration applied. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("team reports and analytics on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });
  const NOW = new Date("2026-11-05T01:00:00Z");
  const ids = { newId: () => randomUUID(), now: () => NOW.toISOString() };
  const range = { from: "2026-10-01", to: "2026-11-05", bucket: "month" as const };

  async function offer(listing: string, buyer: string, status: string, cents: number, at: string) {
    const link = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at, used_at) VALUES ($1,$2,$3, now() + interval '1 day', now())", [link, listing, buyer]);
    await t.db.query("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status, submitted_at) VALUES ($1,$2,$3,30,10,true,$4,$5,$6)", [listing, buyer, cents, link, status, at]);
  }

  it("reports and analyses one team from the database, scoped to its managers and its agents' listings", async () => {
    const repo = createPgAgencyTeamRepository(t.db);
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer"), buyer2 = await addUser(t.db, "buyer");
    const boss = await addUser(t.db, "agent"), amy = await addUser(t.db, "agent"), ben = await addUser(t.db, "agent"), rival = await addUser(t.db, "agent");
    for (const [id, name] of [[boss, "Boss"], [amy, "Amy"], [ben, "Ben"], [rival, "Rival"]]) await t.db.query("UPDATE app_user SET display_name = $2 WHERE id = $1", [id, name]);
    const bossA: Actor = { userId: boss, userType: "agent" };
    const c = await createTeam(repo, bossA, { name: "North office", kind: "office" }, ids);
    if (!c.ok) throw new Error("create");
    const teamId = c.value.id;
    for (const u of [amy, ben]) {
      const email = String((await t.db.query("SELECT email FROM app_user WHERE id = $1", [u])).rows[0]!["email"]);
      expect(await addMember(repo, bossA, teamId, { email, role: "agent" }, ids)).toMatchObject({ ok: true });
    }
    const house = await addListing(t.db, owner, { status: "published", property_type: "house", title: "House" });
    const unit = await addListing(t.db, owner, { status: "published", property_type: "unit", title: "Unit" });
    const elsewhere = await addListing(t.db, owner, { status: "published", property_type: "house", title: "Elsewhere" });
    // One agent per listing: Amy holds the house, Ben the unit, and an agent outside the team holds another listing.
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$5),($3,$4,$5),($6,$7,$5)", [house, amy, unit, ben, owner, elsewhere, rival]);
    await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id, created_at) VALUES ($1,$3,'2026-10-20T02:00:00Z'),($2,$3,'2026-10-21T02:00:00Z'),($4,$3,'2026-10-21T02:00:00Z')", [house, unit, buyer, elsewhere]);
    await offer(house, buyer, "accepted", 90_000_000, "2026-10-22T00:00:00Z");
    await offer(unit, buyer, "rejected", 40_000_000, "2026-10-23T00:00:00Z");
    await offer(unit, buyer2, "submitted", 45_000_000, "2026-10-24T00:00:00Z");
    await offer(elsewhere, buyer, "accepted", 700_000_000, "2026-10-22T00:00:00Z");
    expect(await recordCommission(repo, bossA, teamId, { memberUserId: amy, grossCents: 1_800_000, description: "House" }, ids)).toMatchObject({ ok: true });

    const d = createTeamAnalyticsDeps(t.db, () => NOW);
    const req = (q: string) => (m: Parameters<typeof parseTeamFilter>[2]) => {
      const p = new URLSearchParams(q);
      const def = teamDefinitionFromQuery(p); if (!def.ok) return def;
      const f = parseTeamFilter(p.get("agents"), p.get("propertyType"), m); if (!f.ok) return f;
      return { ok: true as const, value: { definition: def.value, filter: f.value } };
    };

    const r = await runTeamReport(d, bossA, teamId, req("days=90"));
    if (!r.ok) throw new Error(r.message);
    // Only the team's own listings count; the rival's listing never appears.
    expect(r.value.report.totals).toMatchObject({ offers: 3, accepted: 1, accepted_cents: 90_000_000 });
    expect(r.value.report.rows.map(x => x.label).sort()).toEqual(["Amy", "Ben", "Boss"]);
    expect(r.value.report.rows.find(x => x.label === "Ben")!.values).toMatchObject({ offers: 2 });
    expect(JSON.stringify(r.value)).not.toContain("Elsewhere");

    const units = await runTeamReport(d, bossA, teamId, req(`days=90&propertyType=unit&agents=${amy},${ben}`));
    if (!units.ok) throw new Error(units.message);
    expect(units.value.report.totals).toMatchObject({ offers: 2, accepted: 0 });
    expect(units.value.versus!.rows.find(x => x.key === "offers")).toMatchObject({ a: 0, b: 2, leader: "b" });

    const a = await teamAnalytics(d, bossA, teamId, { days: 90 });
    if (!a.ok) throw new Error(a.message);
    expect(a.value.overview).toMatchObject({ listedNow: 2, sold: { current: 1 }, soldCents: { current: 90_000_000 }, commissionGrossCents: 1_800_000 });
    expect(a.value.agents.find(x => x.displayName === "Amy")).toMatchObject({ commissionGrossCents: 1_800_000, activeListings: 1 });

    expect(await teamAnalytics(d, { userId: rival, userType: "agent" }, teamId, { days: 90 })).toMatchObject({ ok: false, code: "not_found" });
    expect(await teamAnalytics(d, { userId: amy, userType: "agent" }, teamId, { days: 90 })).toMatchObject({ ok: false, code: "forbidden" });
    expect(analyticsPeriod(new URLSearchParams("days=90")).ok).toBe(true);

    // Admin side: the same team seen from outside, with its monthly series and counts that match the manager's view.
    const { teams, series } = await loadTeamFacts(t.db, range, NOW);
    const north = teams.find(x => x.id === teamId)!;
    expect(north).toMatchObject({ members: 3, activeListings: 2, current: { enquiries: 2, offers: 3, accepted: 1, acceptedCents: 90_000_000, commissionCents: 1_800_000 } });
    expect(series.rows.filter(x => x.teamId === teamId)).toEqual([{ teamId, bucket: "2026-10-01", accepted: 1, cents: 90_000_000 }]);
    const cmp = buildTeamComparison({ id: "a", role: "super_admin" }, teams, series);
    expect(cmp.rows.map(x => x.name)).toContain("North office");
    const insights = await loadInsightFacts(t.db, { ...range, bucket: "week" }, NOW);
    expect(insights.teams!.find(x => x.id === teamId)!.current).toMatchObject({ offers: 3, accepted: 1 });
  }, 60_000);
});

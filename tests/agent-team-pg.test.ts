import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { archiveTeam, askTeamAssistant, assignTask, createTeam, getMyTeams, getTeam, inviteMember, removeMember, respondToInvitation, updateMember, updateTeam } from "../src/domain/agent-team";
import type { Actor } from "../src/domain/listing-service";
import { createTeamDeps } from "../src/server/agent-team-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("agent teams on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const licensedAgent = async (email: string) => {
    const id = await addUser(t.db, "agent");
    await t.db.query("UPDATE app_user SET email = $2 WHERE id = $1", [id, email]);
    await t.db.query("INSERT INTO agent_licence (user_id, jurisdiction, licence_number, status, verified_by, verified_at) VALUES ($1,'QLD','L-1','verified',$1, now())", [id]);
    return id;
  };
  const as = (userId: string): Actor => ({ userId, userType: "agent" });

  it("runs the whole team flow with real data, and keeps teams apart", async () => {
    const d = createTeamDeps(t.db);
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer");
    const p = await licensedAgent("principal@example.test"), a = await licensedAgent("alex@example.test"), outsider = await licensedAgent("out@example.test");
    const created = await createTeam(d, as(p), { name: "Harbour Realty" });
    if (!created.ok) throw new Error(created.message);
    const id = created.value.id;
    expect(await createTeam(d, as(p), { name: "Again" })).toMatchObject({ ok: false, code: "conflict" });

    // Invite, accept, and the one-team rule.
    expect(await inviteMember(d, as(p), id, { email: "ALEX@example.test" })).toMatchObject({ ok: true });
    expect(await inviteMember(d, as(p), id, { email: "alex@example.test" })).toMatchObject({ ok: false, code: "conflict" });
    expect(await getTeam(d, as(a), id)).toMatchObject({ ok: false, code: "not_found" });
    const mine = await getMyTeams(d, as(a));
    expect(mine.ok && mine.value.invitations).toEqual([{ teamId: id, teamName: "Harbour Realty", role: "agent" }]);
    expect(await respondToInvitation(d, as(a), id, { accept: true })).toEqual({ ok: true, value: { joined: true } });
    expect(await respondToInvitation(d, as(a), id, { accept: true })).toMatchObject({ ok: false, code: "not_found" });
    expect(await inviteMember(d, as(p), id, { email: "alex@example.test" })).toMatchObject({ ok: false, code: "conflict" });

    // Alex is appointed to a listing with an accepted offer; the dashboard and split reflect it.
    const listing = await addListing(t.db, owner, { jurisdiction: "QLD", title: "Queenslander" });
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3)", [listing, a, owner]);
    await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id, created_at) VALUES ($1,$2, now() - interval '5 hours')", [listing, buyer]);
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", ["f".repeat(64), listing, buyer]);
    await t.db.query("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status) VALUES ($1,$2,100000000,30,1000000,true,$3,'accepted')", [listing, buyer, "f".repeat(64)]);
    expect(await updateMember(d, as(p), id, a, { agentSharePercent: 60 })).toEqual({ ok: true, value: true });
    expect(await updateTeam(d, as(p), id, { commissionRatePercent: 2.5 })).toEqual({ ok: true, value: true });
    const view = await getTeam(d, as(p), id);
    if (!view.ok) throw new Error(view.message);
    expect(view.value.dashboard.totals).toMatchObject({ members: 2, listings: 1, closedDeals: 1, closedCents: 100_000_000 });
    expect(view.value.dashboard.totals.commission).toEqual({ grossCents: 2_500_000, agentCents: 1_500_000, teamCents: 1_000_000 });
    expect(view.value.listings.map(l => l.title)).toEqual(["Queenslander"]);
    const alexView = await getTeam(d, as(a), id);
    expect(alexView.ok && alexView.value.dashboard.members.map(m => m.userId)).toEqual([a]);

    // Tasks.
    expect(await assignTask(d, as(p), id, { title: "Prepare open home", assigneeId: a, listingId: listing, dueOn: "2020-01-01" })).toEqual({ ok: true, value: true });
    const withTask = await getTeam(d, as(a), id);
    expect(withTask.ok && withTask.value.tasks).toMatchObject([{ title: "Prepare open home", listingTitle: "Queenslander", status: "open" }]);
    expect(withTask.ok && withTask.value.dashboard.members[0]).toMatchObject({ openTasks: 1, overdueTasks: 1 });
    const answer = await askTeamAssistant(d, as(p), id, { question: "Who has overdue tasks?" });
    expect(answer.ok && answer.value.text).toContain("Test agent (1)");

    // A different team cannot see this one, and its listings cannot be used for tasks.
    const other = await createTeam(d, as(outsider), { name: "Other" });
    if (!other.ok) throw new Error(other.message);
    expect(await getTeam(d, as(outsider), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await assignTask(d, as(outsider), other.value.id, { title: "Steal", listingId: listing })).toMatchObject({ ok: false, code: "invalid" });

    // Leave, be re-invited, and close the team.
    expect(await removeMember(d, as(a), id, a)).toEqual({ ok: true, value: true });
    expect(await getTeam(d, as(a), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await inviteMember(d, as(p), id, { email: "alex@example.test" })).toMatchObject({ ok: true });
    expect(await archiveTeam(d, as(p), id)).toEqual({ ok: true, value: true });
    expect(await getTeam(d, as(p), id)).toMatchObject({ ok: false, code: "not_found" });
    const after = await getMyTeams(d, as(a));
    expect(after.ok && after.value).toEqual({ invitations: [] });
    expect(await createTeam(d, as(p), { name: "Fresh start" })).toMatchObject({ ok: true });
  }, 60_000);

  it("enforces one active team per agent and one principal per team in the schema", async () => {
    const u = await licensedAgent("single@example.test");
    const a = await t.db.query("INSERT INTO agent_team (name, created_by) VALUES ('Team A',$1) RETURNING id", [u]);
    const b = await t.db.query("INSERT INTO agent_team (name, created_by) VALUES ('Team B',$1) RETURNING id", [u]);
    await t.db.query("INSERT INTO agent_team_member (team_id, user_id, role, status) VALUES ($1,$2,'principal','active')", [a.rows[0]!["id"], u]);
    await expect(t.db.query("INSERT INTO agent_team_member (team_id, user_id, role, status) VALUES ($1,$2,'agent','active')", [b.rows[0]!["id"], u])).rejects.toThrow();
    const v = await licensedAgent("second@example.test");
    await expect(t.db.query("INSERT INTO agent_team_member (team_id, user_id, role, status) VALUES ($1,$2,'principal','active')", [a.rows[0]!["id"], v])).rejects.toThrow();
  }, 60_000);
});

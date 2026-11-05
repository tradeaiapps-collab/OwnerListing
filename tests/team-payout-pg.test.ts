import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, advanceCommission, createTeam, recordCommission } from "../src/domain/agency-team";
import type { Actor } from "../src/domain/listing-service";
import { applyProviderEvent, initiatePayout, type PayoutProvider } from "../src/domain/team-payout";
import { createPgAgencyTeamRepository } from "../src/server/agency-team-db";
import { createPgTeamPayoutRepository } from "../src/server/team-payout-db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("team payouts on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });
  const ids = { newId: () => randomUUID(), now: () => new Date().toISOString() };
  const provider: PayoutProvider = {
    enabled: () => true, createAccount: async () => ({ accountId: "acct_x" }), onboardingLink: async () => ({ url: "u" }),
    transfer: async () => ({ transferId: `tr_${randomUUID()}` })
  };
  async function person() {
    const id = await addUser(t.db, "agent", "active");
    const email = String((await t.db.query("SELECT email FROM app_user WHERE id = $1", [id])).rows[0]!["email"]);
    return { actor: { userId: id, userType: "agent" } as Actor, email };
  }

  it("pays an approved commission once, settles on the webhook and marks the commission paid", async () => {
    const teams = createPgAgencyTeamRepository(t.db), repo = createPgTeamPayoutRepository(t.db);
    const boss = await person(), agent = await person();
    const team = await createTeam(teams, boss.actor, { name: "Pay team" }, ids);
    if (!team.ok) throw new Error("team");
    await addMember(teams, boss.actor, team.value.id, { email: agent.email, role: "agent" }, ids);
    const c = await recordCommission(teams, boss.actor, team.value.id, { memberUserId: agent.actor.userId, grossCents: 100_000 }, ids);
    if (!c.ok) throw new Error(`commission ${c.message}`);
    await advanceCommission(teams, boss.actor, team.value.id, c.value.id, { action: "approve" }, ids);

    expect(await initiatePayout(repo, provider, boss.actor, team.value.id, c.value.id, ids)).toMatchObject({ ok: false, code: "conflict" }); // not verified yet
    await repo.saveAccount(agent.actor.userId, "acct_x");
    expect(await applyProviderEvent(repo, { id: "evt_k", kind: "account", providerAccountId: "acct_x", kycStatus: "verified" }, ids)).toBe("applied");

    const r = await initiatePayout(repo, provider, boss.actor, team.value.id, c.value.id, ids);
    if (!r.ok) throw new Error(r.message);
    expect(r.value).toMatchObject({ status: "sent", amountCents: 70_000 });
    expect(await initiatePayout(repo, provider, boss.actor, team.value.id, c.value.id, ids)).toMatchObject({ ok: false, code: "conflict" });

    const ev = { id: "evt_p", kind: "transfer" as const, transferId: r.value.providerTransferId!, outcome: "paid" as const, reason: "" };
    expect(await applyProviderEvent(repo, ev, ids)).toBe("applied");
    expect(await applyProviderEvent(repo, ev, ids)).toBe("duplicate");
    expect((await teams.getCommission(team.value.id, c.value.id))).toMatchObject({ status: "paid", payoutReference: `stripe:${ev.transferId}` });
    expect(await repo.listPayouts(team.value.id, agent.actor.userId)).toMatchObject([{ status: "paid", amountCents: 70_000 }]);
    const audits = await t.db.query("SELECT event_type FROM audit_event WHERE aggregate_type = 'team_payout' ORDER BY occurred_at");
    expect(audits.rows.map(a => a["event_type"])).toEqual(expect.arrayContaining(["team_payout.created", "team_payout.paid"]));
  });
});

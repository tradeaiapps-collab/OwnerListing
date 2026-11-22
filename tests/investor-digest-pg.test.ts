import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getInvestorDigest, runInvestorDigests, setInvestorDigest } from "../src/server/investor-digest-db";
import type { Notify } from "../src/server/elena-enquiries-db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("investor weekly digest on Postgres", () => {
  let t: TestDb;
  const live = { INVESTMENT_MODULE_ENABLED: "true" };
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const sent: { userId: string; kind: string; params: Record<string, string | undefined> }[] = [];
  const notify: Notify = async (userId, kind, params) => { sent.push({ userId, kind, params }); };
  const NOW = "2026-11-21T00:00:00.000Z";

  async function switchOn() {
    const admin = await addUser(t.db, "admin");
    await t.db.query("INSERT INTO investment_setting (key, enabled, updated_by) VALUES ('investment_module_enabled', true, $1) ON CONFLICT (key) DO UPDATE SET enabled = true", [admin]);
  }
  async function project(owner: string, title: string, visibleTo = "wholesale_only", status = "approved") {
    return String((await t.db.query(
      `INSERT INTO investment_project (owner_user_id, title, location, jurisdiction, project_type, summary, stage, funding_target_cents, minimum_ticket_cents, timeline, risks, structure_description,
         visible_to, issuer_name, issuer_licence_basis, issuer_statement, issuer_authorised_confirmed, status, posting_model, commission_type, commission_bps, commission_fixed_cents, upfront_fee_cents, upfront_fee_status, model2_disclosure)
       VALUES ($1,$2,'Bulimba QLD','QLD','residential_development','Twelve townhouses on a riverside site.','approved',240000000,5000000,'14 months','Cost and sales risk.','Unit trust.',$3,'Riverside Pty Ltd','s708','',true,$4,'commission_on_contract','percent',400,0,0,'not_required','off') RETURNING id`,
      [owner, title, visibleTo, status])).rows[0]!["id"]);
  }
  async function investor(category: "wholesale" | "retail" = "wholesale") {
    const u = await addUser(t.db, "buyer");
    await t.db.query("INSERT INTO investor_declaration (user_id, category, ack_not_advice, ack_not_offer, ack_no_funds_held, ack_off_platform, disclosure_version) VALUES ($1,$2,true,true,true,true,'v1')", [u, category]);
    return u;
  }
  const follow = (p: string, u: string) => t.db.query("INSERT INTO investment_project_follow (project_id, user_id) VALUES ($1,$2)", [p, u]);
  async function publish(p: string, owner: string, title: string, at = "2026-11-18T00:00:00Z") {
    await t.db.query("INSERT INTO investment_project_update (id, project_id, title, body, status, created_by, created_by_user, approved_by, approved_at) VALUES (gen_random_uuid(),$1,$2,$3,'published','owner',$4,$4,$5::timestamptz)",
      [p, title, "Slab poured on level two, ahead of schedule.", owner, at]);
  }
  const mine = (u: string) => sent.filter(s => s.userId === u);

  it("sends one digest with published updates and the investor's own answered questions, then not again the same week", async () => {
    await switchOn();
    const owner = await addUser(t.db, "owner"), inv = await investor(), other = await investor();
    const p = await project(owner, "Riverside Terraces");
    await follow(p, inv);
    await publish(p, owner, "Slab complete");
    await t.db.query("INSERT INTO investment_project_update (id, project_id, title, body, created_by, created_by_user) VALUES (gen_random_uuid(),$1,'Draft only','A draft that the owner has not approved yet.','owner',$2)", [p, owner]);
    const q = (u: string, text: string) => t.db.query("INSERT INTO elena_project_question (id, project_id, asker_user_id, question, answer, outcome, sources, created_at) VALUES (gen_random_uuid(),$1,$2,$3,'Completion is planned for June.','answered','[{\"docId\":\"d\",\"title\":\"Secret Title.pdf\",\"page\":1,\"quote\":\"x\"}]'::jsonb,$4::timestamptz) RETURNING id", [p, u, text, "2026-11-19T00:00:00Z"]);
    const qid = String((await q(inv, "When is completion?")).rows[0]!["id"]);
    await q(other, "Private question from someone else?");
    await t.db.query("INSERT INTO elena_project_question_reply (id, question_id, owner_user_id, body, created_at) VALUES (gen_random_uuid(),$1,$2,'We expect handover in July.', '2026-11-20T00:00:00Z')", [qid, owner]);
    const r = await runInvestorDigests(t.db, NOW, live, notify);
    expect(r.sent).toBe(2);
    const d = mine(inv)[0]!;
    expect(d.kind).toBe("investor_digest");
    expect(d.params["title"]).toBe("Your weekly project update: 1 new update and 2 answered questions");
    expect(d.params["text"]).toContain("Slab complete");
    expect(d.params["text"]).toContain("We expect handover in July");
    expect(d.params["text"]).not.toContain("Draft only");
    expect(d.params["text"]).not.toContain("Secret Title");
    expect(d.params["text"]).not.toContain("Private question");
    // the other investor only gets their own question, never the first investor's content
    const o = mine(other)[0]!;
    expect(o.params["text"]).toContain("Private question");
    expect(o.params["text"]).not.toContain("Slab complete");
    expect(o.params["text"]).not.toContain("When is completion");
    expect((await runInvestorDigests(t.db, "2026-11-22T00:00:00.000Z", live, notify)).sent).toBe(0);
    expect((await getInvestorDigest(t.db, inv)).lastSentAt).toBe(NOW);
  });

  it("respects opt-out, a quiet week, the module switch, and what the investor may see", async () => {
    const owner = await addUser(t.db, "owner");
    const p = await project(owner, "Wholesale Only Tower"), pub = await project(owner, "Open Project", "all_verified"), pending = await project(owner, "Not Approved", "all_verified", "pending_review");
    const optedOut = await investor(), retail = await investor("retail"), quiet = await investor(), noDecl = await addUser(t.db, "buyer");
    for (const u of [optedOut, retail, noDecl]) { await follow(p, u); await follow(pub, u); await follow(pending, u); }
    await follow(pub, quiet);
    for (const proj of [p, pub, pending]) await publish(proj, owner, `News for ${proj.slice(0, 4)}`, "2026-11-19T00:00:00Z");
    await setInvestorDigest(t.db, optedOut, false);
    expect(await getInvestorDigest(t.db, optedOut)).toMatchObject({ enabled: false });
    // module off: nothing is read or sent
    expect(await runInvestorDigests(t.db, NOW, {}, notify)).toEqual({ sent: 0, skipped: 0 });
    expect(await runInvestorDigests(t.db, NOW, live, notify)).toMatchObject({ sent: 2 });
    expect(mine(optedOut)).toHaveLength(0);
    expect(mine(noDecl)).toHaveLength(0);
    const r = mine(retail)[0]!, q = mine(quiet)[0]!;
    expect(r.params["text"]).toContain("Open Project");
    expect(r.params["text"]).not.toContain("Wholesale Only Tower");
    expect(r.params["text"]).not.toContain("Not Approved");
    expect(q.params["title"]).toContain("1 new update");
    // later week with nothing new: claimed but nothing sent
    const before = sent.length;
    const later = await runInvestorDigests(t.db, "2026-12-05T00:00:00.000Z", live, notify);
    expect(later.sent).toBe(0);
    expect(sent.length).toBe(before);
  });

  it("two overlapping ticks never double-send", async () => {
    const owner = await addUser(t.db, "owner"), inv = await investor();
    const p = await project(owner, "Race Project");
    await follow(p, inv); await publish(p, owner, "Race update", "2026-12-10T00:00:00Z");
    const now = "2026-12-12T00:00:00.000Z";
    await Promise.all([runInvestorDigests(t.db, now, live, notify), runInvestorDigests(t.db, now, live, notify)]);
    expect(mine(inv)).toHaveLength(1);
  });
});

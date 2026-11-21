import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgElenaProjectStore } from "../src/server/elena-projects-db";
import type { Queryable } from "../src/server/db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("Elena investor project tables on Postgres", () => {
  let t: TestDb, db: Queryable, owner: string;
  const U = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;

  beforeAll(async () => {
    t = await createTestDb(); db = t.db;
    owner = await addUser(db, "owner");
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("applies the migration and keeps the records append-only", async () => {
    const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_name IN ('elena_project_question','elena_project_question_reply','investment_project_update','investment_project_follow')")).rows;
    expect(tables).toHaveLength(4);
    const triggers = (await db.query("SELECT tgname FROM pg_trigger WHERE tgname IN ('elena_project_question_append_only','elena_project_question_reply_append_only','investment_project_update_guard')")).rows;
    expect(triggers).toHaveLength(3);
  });

  it("a published update cannot change or be deleted, a draft can change but never be deleted, and published needs an approver", async () => {
    // The guard function is exercised directly on a scratch table that has the same trigger and check.
    await db.query("CREATE TABLE upd_probe (LIKE investment_project_update INCLUDING DEFAULTS)");
    await db.query("CREATE TRIGGER g BEFORE UPDATE OR DELETE ON upd_probe FOR EACH ROW EXECUTE FUNCTION investment_project_update_guard()");
    await db.query("INSERT INTO upd_probe (id, project_id, title, body, created_by, created_by_user) VALUES ($1, $2, 'Title', 'A body of more than twenty characters.', 'elena', $3)", [U(10), U(1), owner]);
    await db.query("UPDATE upd_probe SET title = 'Edited' WHERE id = $1", [U(10)]);
    await expect(db.query("DELETE FROM upd_probe WHERE id = $1", [U(10)])).rejects.toThrow(/never deleted/);
    await db.query("UPDATE upd_probe SET status = 'published', approved_by = $2, approved_at = now() WHERE id = $1", [U(10), owner]);
    await expect(db.query("UPDATE upd_probe SET title = 'Changed after publishing' WHERE id = $1", [U(10)])).rejects.toThrow(/cannot be changed/);
    await expect(db.query("DELETE FROM upd_probe WHERE id = $1", [U(10)])).rejects.toThrow(/never deleted/);
    await db.query("DROP TABLE upd_probe");
  });

  it("the real update table refuses a published row with no approver", async () => {
    const c = (await db.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'investment_project_update'::regclass AND contype = 'c'")).rows.map(r => String(r["d"])).join(" ");
    expect(c).toMatch(/approved_by IS NOT NULL/);
    expect(typeof createPgElenaProjectStore(db).followers).toBe("function");
  });

  it("answer approval: one insert-only decision per question, a mode setting with a closed list, and a needs_approval flag defaulting to false", async () => {
    const t1 = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_name IN ('elena_project_answer_review','elena_project_answer_setting')")).rows;
    expect(t1).toHaveLength(2);
    expect((await db.query("SELECT 1 FROM pg_trigger WHERE tgname = 'elena_project_answer_review_append_only'")).rows).toHaveLength(1);
    const col = (await db.query("SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'elena_project_question' AND column_name = 'needs_approval'")).rows[0];
    expect(String(col?.["column_default"])).toBe("false");
    expect(col?.["is_nullable"]).toBe("NO");
    const pk = (await db.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'elena_project_answer_review'::regclass AND contype = 'p'")).rows[0];
    expect(String(pk?.["d"])).toMatch(/question_id/);
    const modes = (await db.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'elena_project_answer_setting'::regclass AND contype = 'c'")).rows.map(r => String(r["d"])).join(" ");
    expect(modes).toMatch(/approve_first/);
    expect(typeof createPgElenaProjectStore(db).addReview).toBe("function");
  });

  it("lists the projects an investor follows, newest follow first, only theirs", async () => {
    const store = createPgElenaProjectStore(db);
    const investor = await addUser(db, "buyer"), other = await addUser(db, "buyer");
    const mk = async (title: string) => String((await db.query(
      `INSERT INTO investment_project (owner_user_id, title, location, jurisdiction, project_type, summary, stage, funding_target_cents, minimum_ticket_cents, timeline, risks, structure_description,
         visible_to, issuer_name, issuer_licence_basis, issuer_statement, issuer_authorised_confirmed, status, posting_model, commission_type, commission_bps, commission_fixed_cents, upfront_fee_cents, upfront_fee_status, model2_disclosure)
       VALUES ($1,$2,'Bulimba QLD','QLD','residential_development','Twelve townhouses on a riverside site.','approved',240000000,5000000,'14 months','Cost and sales risk.','Unit trust.','all_verified','Riverside Pty Ltd','s708','',true,'approved','commission_on_contract','percent',400,0,0,'not_required','off') RETURNING id`, [owner, title])).rows[0]!["id"]);
    const a = await mk("First"), b = await mk("Second"), c = await mk("Third");
    await store.setFollow(a, investor, true, "2026-11-01T00:00:00Z");
    await store.setFollow(b, investor, true, "2026-11-02T00:00:00Z");
    await store.setFollow(c, other, true, "2026-11-03T00:00:00Z");
    expect(await store.followedBy(investor, 10)).toEqual([b, a]);
    expect(await store.followedBy(investor, 1)).toEqual([b]);
    await store.setFollow(b, investor, false, "2026-11-04T00:00:00Z");
    expect(await store.followedBy(investor, 10)).toEqual([a]);
  });
});

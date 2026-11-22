import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBulkParams, type BulkParams } from "../src/domain/listing-bulk";
import { searchListings } from "../src/server/admin-moderation-db";
import type { Queryable } from "../src/server/db";
import {
  createJob, exportListingsCsv, getJob, previewBulk, resolveAgent, resolveSelection, runJob, stalledJobIds, startBulk, type BulkIo
} from "../src/server/listing-bulk-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL with every migration applied. Skipped without DATABASE_URL (CI sets it).
const P = (action: string, raw: unknown = {}): BulkParams => {
  const r = parseBulkParams(action, raw);
  if (!r.ok) throw new Error(r.error);
  return r.params;
};
const REASON = "Spring campaign clean-up.";

describe.skipIf(!DATABASE_URL)("bulk listing operations (Postgres)", () => {
  let t: TestDb;
  let db: Queryable;
  let staff: { id: string; role: string };
  const published: string[] = [];
  const io: BulkIo = { publish: async id => { published.push(id); await db.query(`UPDATE property_listing SET status = 'published' WHERE id = $1`, [id]); return null; } };
  const later: (() => Promise<unknown>)[] = [];
  const run = (p: BulkParams, ids: string[]) => startBulk(db, io, staff, p, REASON, ids, w => later.push(w));
  const one = async (id: string) => (await db.query(`SELECT status, outcome, deleted_at, price_cents, property_type FROM property_listing WHERE id = $1`, [id])).rows[0]!;

  beforeAll(async () => { t = await createTestDb(); db = t.db; staff = { id: await addUser(db, "admin"), role: "compliance" }; }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("archives many listings, one audit event each, and reports skips", async () => {
    const owner = await addUser(db, "owner");
    const a = await addListing(db, owner, { status: "published" });
    const b = await addListing(db, owner, { status: "draft" });
    const c = await addListing(db, owner, { status: "archived" });
    const job = await run(P("archive"), [a, b, c]);
    expect(job).toMatchObject({ status: "done", total: 3, processed: 3, succeeded: 2, skipped: 1, failed: 0 });
    expect((await one(a))["status"]).toBe("archived");
    const ev = await db.query(`SELECT payload FROM audit_event WHERE event_type = 'listing.bulk_archive' AND aggregate_id = ANY($1::text[])`, [[a, b, c]]);
    expect(ev.rows).toHaveLength(2);
    expect(ev.rows[0]!["payload"]).toMatchObject({ reason: REASON, role: "compliance", bulkJobId: job.id, moderation: true });
    expect(job.problems).toEqual([{ id: c, outcome: "skipped", message: "Already archived." }]);
  });

  it("soft-deletes, hides from staff search, and refuses with open offers or live bookings", async () => {
    const owner = await addUser(db, "owner"), buyer = await addUser(db, "buyer"), inspector = await addUser(db, "owner");
    const free = await addListing(db, owner, { status: "published", title: "Deletable zebra" });
    const offered = await addListing(db, owner, { status: "published" });
    const booked = await addListing(db, owner, { status: "published" });
    const link = randomUUID().replace(/-/g, "").padEnd(64, "a");
    await db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [link, offered, buyer]);
    await db.query("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status) VALUES ($1,$2,90000000,30,1000000,true,$3,'under_review')", [offered, buyer, link]);
    await db.query("INSERT INTO inspection (listing_id, requested_by, inspector_user_id, inspection_type, scheduled_at, status) VALUES ($1,$2,$3,'building', now() + interval '2 days','accepted')", [booked, owner, inspector]);
    const job = await run(P("delete"), [free, offered, booked]);
    expect(job).toMatchObject({ succeeded: 1, skipped: 2 });
    expect(job.problems.map(p => p.message).sort()).toEqual(["1 inspection booking still on.", "1 open offer."]);
    expect((await one(free))["deleted_at"]).not.toBeNull();
    expect((await one(offered))["deleted_at"]).toBeNull();
    expect((await searchListings(db, { q: "zebra" })).rows).toEqual([]);
    expect(await resolveSelection(db, { ids: [free] })).toEqual({ ids: [] });
  });

  it("changes status to sold or rented and back, only where it fits", async () => {
    const owner = await addUser(db, "owner");
    const sale = await addListing(db, owner, { status: "published" });
    const rent = await addListing(db, owner, { status: "published", transaction_type: "rent" });
    const job = await run(P("set_status", { status: "sold" }), [sale, rent]);
    expect(job).toMatchObject({ succeeded: 1, skipped: 1 });
    expect(await one(sale)).toMatchObject({ status: "archived", outcome: "sold" });
    await run(P("set_status", { status: "available" }), [sale]);
    expect(await one(sale)).toMatchObject({ status: "draft", outcome: null });
  });

  it("adds tags once, changes property type, and adjusts prices within limits", async () => {
    const owner = await addUser(db, "owner");
    const a = await addListing(db, owner, { status: "published", price_cents: 100_000_000 });
    const b = await addListing(db, owner, { status: "published", price_cents: null });
    expect((await run(P("add_tag", { tag: "Spring" }), [a, b])).succeeded).toBe(2);
    expect((await run(P("add_tag", { tag: "spring" }), [a, b])).skipped).toBe(2);
    expect((await db.query(`SELECT tag FROM listing_tag WHERE listing_id = $1`, [a])).rows).toEqual([{ tag: "spring" }]);
    expect((await run(P("set_property_type", { propertyType: "unit" }), [a])).succeeded).toBe(1);
    expect((await one(a))["property_type"]).toBe("unit");
    const job = await run(P("adjust_price", { mode: "percent", value: 10 }), [a, b]);
    expect(job).toMatchObject({ succeeded: 1, skipped: 1 });
    expect(Number((await one(a))["price_cents"])).toBe(110_000_000);
    await run(P("adjust_price", { mode: "amount", value: -50_000 }), [a]);
    expect(Number((await one(a))["price_cents"])).toBe(105_000_000);
  });

  it("reassigns an appointed agent, keeps scope, and refuses own listings, self-assignment and unappointed listings", async () => {
    const owner = await addUser(db, "owner"), oldAgent = await addUser(db, "agent"), newAgent = await addUser(db, "agent");
    const appointed = await addListing(db, owner, { status: "published" });
    const bare = await addListing(db, owner, { status: "published" });
    const mine = await addListing(db, staff.id, { status: "published" });
    for (const l of [appointed, mine]) await db.query(`INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by, scope) VALUES ($1,$2,$3,'full')`, [l, oldAgent, owner]);
    const job = await run(P("assign_agent", { agentId: newAgent }), [appointed, bare, mine]);
    expect(job).toMatchObject({ succeeded: 1, skipped: 2 });
    const rows = (await db.query(`SELECT agent_user_id, scope, revoked_at, appointed_by FROM listing_agent_appointment WHERE listing_id = $1 ORDER BY appointed_at`, [appointed])).rows;
    expect(rows.map(r => [r["agent_user_id"], r["scope"], r["revoked_at"] !== null])).toEqual([[oldAgent, "full", true], [newAgent, "full", false]]);
    expect(rows[1]!["appointed_by"]).toBe(staff.id);
    expect((await run(P("assign_agent", { agentId: staff.id }), [appointed])).skipped).toBe(1);
    expect(await resolveAgent(db, newAgent)).toBe(newAgent);
    expect(await resolveAgent(db, owner)).toBeNull();
  });

  it("publishes through the injected publish gate and skips what it refuses", async () => {
    const owner = await addUser(db, "owner");
    const ok = await addListing(db, owner, { status: "pending_review" });
    const draft = await addListing(db, owner, { status: "draft" });
    const refusing: BulkIo = { publish: async () => "Fails the publish checks: disclosure missing." };
    const job = await startBulk(db, refusing, staff, P("publish"), REASON, [ok, draft], () => undefined);
    expect(job.problems.map(p => p.message)).toEqual(["Fails the publish checks: disclosure missing.", "Only a listing under review or suspended can be published."]);
    const done = await run(P("publish"), [ok]);
    expect(done.succeeded).toBe(1);
    expect(published).toContain(ok);
  });

  it("previews without changing anything and expands a filter", async () => {
    const owner = await addUser(db, "owner");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await addListing(db, owner, { status: "published", jurisdiction: "TAS", title: `Preview ${i}` }));
    await addListing(db, owner, { status: "draft", jurisdiction: "TAS" });
    const picked = await resolveSelection(db, { filter: { jurisdiction: "TAS", status: "published" } });
    expect(picked).toEqual({ ids: expect.arrayContaining(ids) });
    const pv = await previewBulk(db, staff.id, ids, P("archive"));
    expect(pv).toMatchObject({ total: 3, willChange: 3, willSkip: 0 });
    expect(pv.examples).toHaveLength(3);
    expect((await one(ids[0]!))["status"]).toBe("published");
  });

  it("refuses more than 500 listings and queues a run over 100 that finishes with progress", async () => {
    const owner = await addUser(db, "owner");
    const many: string[] = [];
    for (let i = 0; i < 130; i++) many.push(await addListing(db, owner, { status: "published", jurisdiction: "NT" }));
    expect(await resolveSelection(db, { ids: Array.from({ length: 501 }, () => randomUUID()) })).toEqual({ error: "Select at most 500 listings at a time." });
    later.length = 0;
    const queued = await run(P("add_tag", { tag: "big-run" }), many);
    expect(queued).toMatchObject({ status: "queued", total: 130, processed: 0, async: true });
    expect(later).toHaveLength(1);
    const final = await later[0]!() as Awaited<ReturnType<typeof runJob>>;
    expect(final).toMatchObject({ status: "done", processed: 130, succeeded: 130 });
    expect(await runJob(db, io, queued.id)).toMatchObject({ status: "done", succeeded: 130 });
  });

  it("resumes a run whose worker died, without repeating finished listings", async () => {
    const owner = await addUser(db, "owner");
    const ids: string[] = [];
    for (let i = 0; i < 45; i++) ids.push(await addListing(db, owner, { status: "published" }));
    const id = await createJob(db, staff, P("add_tag", { tag: "resume-me" }), REASON, ids);
    expect(await stalledJobIds(db)).not.toContain(id);
    // The first worker handled 20 listings, saved that, then stopped.
    await db.query(`INSERT INTO listing_tag (listing_id, tag, added_by) SELECT unnest($1::uuid[]), 'resume-me', $2`, [ids.slice(0, 20), staff.id]);
    await db.query(`UPDATE listing_bulk_job SET status = 'running', processed = 20, succeeded = 20, heartbeat_at = now() - interval '5 minutes', created_at = now() - interval '5 minutes' WHERE id = $1`, [id]);
    expect(await stalledJobIds(db)).toContain(id);
    const job = await runJob(db, io, id);
    expect(job).toMatchObject({ status: "done", processed: 45, succeeded: 45 });
    expect((await db.query(`SELECT count(*)::int AS n FROM listing_tag WHERE tag = 'resume-me'`)).rows[0]!["n"]).toBe(45);
    expect((await getJob(db, id))!.finishedAt).not.toBeNull();
  });

  it("exports a CSV without owner details and logs it", async () => {
    const owner = await addUser(db, "owner");
    const a = await addListing(db, owner, { status: "published", title: "=SUM(A1)", price_cents: 123_400, suburb: "Bondi, North" });
    const csv = await exportListingsCsv(db, staff, [a]);
    const [head, line] = csv.trim().split("\r\n");
    expect(head).toBe("id,title,status,outcome,sale_or_rent,property_type,use,state,suburb,postcode,price_aud,bedrooms,bathrooms,parking,tags,offers,created_at");
    expect(line).toContain("'=SUM(A1)");
    expect(line).toContain("\"Bondi, North\"");
    expect(line).toContain("1234.00");
    expect(csv).not.toContain(owner);
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'listing.bulk_exported' AND actor_id = $1`, [staff.id])).rows[0]!["n"]).toBe(1);
  });
});

import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ObjectStoragePort } from "../src/adapters/object-storage";
import type { Actor } from "../src/domain/listing-service";
import {
  agentVideos, requestTeamVideo, runVideoQueue, setTeamBudget, startBuyerPurchase, videoForListing, videoPricing, type JobPoll, type VideoProvider
} from "../src/domain/listing-video";
import { createPgVideoRepository, handleVideoStripeWebhook } from "../src/server/listing-video-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("tour videos on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });
  const ids = { newId: () => randomUUID(), now: () => new Date().toISOString() };
  const pricing = videoPricing({});
  const storage: ObjectStoragePort = (() => {
    const m = new Map<string, Uint8Array>();
    return { configured: true, put: async (k, b) => { m.set(k, b); }, get: async k => m.get(k) ?? new Uint8Array([1, 2, 3]) };
  })();
  const provider = (poll: JobPoll): VideoProvider => ({
    configured: true, submit: async () => ({ jobId: `job_${randomUUID()}` }), poll: async () => poll,
    download: async () => ({ bytes: new Uint8Array([7, 7]), contentType: "video/mp4" })
  });

  /** The queue is global, so tests park every other video far in the future and work on just their own. */
  const isolate = (id: string) => t.db.query("UPDATE listing_video SET next_attempt_at = now() + interval '1 day' WHERE id <> $1", [id]);

  async function setup() {
    const owner = await addUser(t.db, "owner"), agentId = await addUser(t.db, "agent"), mgrId = await addUser(t.db, "agent");
    const listing = await addListing(t.db, owner, { status: "published", suburb: "Paddington", title: "12 Palm St" });
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by, scope) VALUES ($1,$2,$3,'full')", [listing, agentId, owner]);
    const team = String((await t.db.query("INSERT INTO agency_team (name, created_by) VALUES ('Video team', $1) RETURNING id", [mgrId])).rows[0]!["id"]);
    await t.db.query("INSERT INTO agency_team_member (team_id, user_id, role, added_by) VALUES ($1,$2,'manager',$2), ($1,$3,'agent',$2)", [team, mgrId, agentId]);
    const photos: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID(); photos.push(id);
      await t.db.query(
        "INSERT INTO listing_photo (id, listing_id, kind, uploaded_by, content_type, width, height, size_bytes, sha256, storage_key) VALUES ($1,$2,'photo',$3,'image/jpeg',100,100,10,$4,$5)",
        [id, listing, owner, "a".repeat(64), `listings/${listing}/p${i}`]
      );
    }
    const entries = [{ photoId: photos[2], hidden: true }, { photoId: photos[1] }, { photoId: photos[0] }];
    await t.db.query("INSERT INTO listing_photo_layout (listing_id, version, entries, changed_by) VALUES ($1,1,$2::jsonb,$3)", [listing, JSON.stringify(entries), owner]);
    return { owner, listing, team, agent: { userId: agentId, userType: "agent" } as Actor, manager: { userId: mgrId, userType: "agent" } as Actor };
  }

  it("charges the budget under a lock: two simultaneous requests for a one-video budget queue exactly one", async () => {
    const repo = createPgVideoRepository(t.db), s = await setup();
    expect((await setTeamBudget(repo, s.manager, s.team, { monthlyBudgetCents: 500 }, ids)).ok).toBe(true);
    const [a, b] = await Promise.all([
      requestTeamVideo(repo, s.agent, s.listing, pricing, provider({ state: "running" }), ids),
      requestTeamVideo(repo, s.agent, s.listing, pricing, provider({ state: "running" }), ids)
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const rows = (await t.db.query("SELECT kind, amount_cents FROM team_video_ledger WHERE team_id = $1", [s.team])).rows;
    expect(rows).toEqual([{ kind: "charge", amount_cents: 500 }]);
    const o = await agentVideos(repo, s.agent, pricing, ids);
    expect(o.ok && o.value.budget).toMatchObject({ monthlyBudgetCents: 500, spentCents: 500, remainingCents: 0 });
    expect(o.ok && o.value.rows.find(r => r.listingId === s.listing)).toMatchObject({ photoCount: 3, video: { status: "queued" } });
  });

  it("runs a video to ready using the visible photos in gallery order, and the file is only playable by the right people", async () => {
    const repo = createPgVideoRepository(t.db), s = await setup();
    await setTeamBudget(repo, s.manager, s.team, { monthlyBudgetCents: 5000 }, ids);
    expect((await repo.photoFiles(s.listing, 5)).map(f => f.storageKey)).toEqual([`listings/${s.listing}/p1`, `listings/${s.listing}/p0`]);
    const r = await requestTeamVideo(repo, s.agent, s.listing, pricing, provider({ state: "running" }), ids);
    if (!r.ok) throw new Error("request");
    await isolate(r.value.id);
    const poll: JobPoll = { state: "ready", downloadUrl: "https://files.example/v.mp4", contentType: "video/mp4" };
    const deps = { repo, provider: provider(poll), storage, ids };
    expect(await runVideoQueue(deps)).toMatchObject({ submitted: 1 });
    await t.db.query("UPDATE listing_video SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [r.value.id]);
    expect(await runVideoQueue(deps)).toMatchObject({ ready: 1 });
    const v = await repo.video(r.value.id);
    expect(v).toMatchObject({ status: "ready", storageKey: `listings/${s.listing}/video-${r.value.id}`, visibility: "private" });
    expect((await videoForListing(repo, null, s.listing)).ok && (await videoForListing(repo, null, s.listing) as { value: { video: unknown } }).value.video).toBeNull();
    await repo.setVisibility(r.value.id, "public", ids.now());
    const pub = await videoForListing(repo, null, s.listing);
    expect(pub.ok && pub.value.video?.playbackUrl).toBe(`/api/videos/${r.value.id}/file`);
  });

  it("a video that fails for good is refunded and the ledger cannot be edited", async () => {
    const repo = createPgVideoRepository(t.db), s = await setup();
    await setTeamBudget(repo, s.manager, s.team, { monthlyBudgetCents: 5000 }, ids);
    const r = await requestTeamVideo(repo, s.agent, s.listing, pricing, provider({ state: "running" }), ids);
    if (!r.ok) throw new Error("request");
    await isolate(r.value.id);
    await t.db.query("UPDATE listing_video SET attempts = 2, deadline_at = now() - interval '1 minute' WHERE id = $1", [r.value.id]);
    expect(await runVideoQueue({ repo, provider: provider({ state: "running" }), storage, ids })).toMatchObject({ failed: 1 });
    expect((await repo.video(r.value.id))!.status).toBe("failed");
    const sum = (await t.db.query("SELECT SUM(amount_cents)::int AS s FROM team_video_ledger WHERE team_id = $1", [s.team])).rows[0]!["s"];
    expect(sum).toBe(0);
    await expect(t.db.query("UPDATE team_video_ledger SET amount_cents = 1 WHERE team_id = $1", [s.team])).rejects.toThrow();
    // A failed video no longer blocks a new one.
    expect((await requestTeamVideo(repo, s.agent, s.listing, pricing, provider({ state: "running" }), ids)).ok).toBe(true);
  });

  it("a buyer payment, repeated webhook and second buyer produce one video", async () => {
    const repo = createPgVideoRepository(t.db), s = await setup();
    const b1 = { userId: await addUser(t.db, "buyer"), userType: "buyer" } as Actor, b2 = { userId: await addUser(t.db, "buyer"), userType: "buyer" } as Actor;
    const pay = { enabled: true, createCheckout: async (i: { purchaseId: string }) => ({ sessionId: `cs_${i.purchaseId}`, url: "https://checkout.stripe.com/x" }) };
    const urls = { success: (id: string) => `https://x/${id}`, cancel: (id: string) => `https://x/${id}` };
    for (const b of [b1, b2]) expect((await startBuyerPurchase(repo, pay, { configured: true }, b, s.listing, pricing, urls, ids)).ok).toBe(true);
    const secret = "whsec_pg";
    const send = async (eventId: string, session: string) => {
      const body = JSON.stringify({ id: eventId, type: "checkout.session.completed", data: { object: { id: session, payment_status: "paid" } } });
      const ts = Math.floor(Date.now() / 1000);
      return handleVideoStripeWebhook(repo, body, `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`, secret, ids);
    };
    const sessions = (await t.db.query("SELECT checkout_session_id AS s FROM video_purchase WHERE listing_id = $1 ORDER BY created_at", [s.listing])).rows.map(r => String(r["s"]));
    expect((await send("evt_pg_1", sessions[0]!)).body).toMatchObject({ result: "done" });
    expect((await send("evt_pg_1", sessions[0]!)).body).toMatchObject({ result: "repeat" });
    expect((await send("evt_pg_2", sessions[1]!)).body).toMatchObject({ result: "done" });
    expect(Number((await t.db.query("SELECT COUNT(*) AS n FROM listing_video WHERE listing_id = $1", [s.listing])).rows[0]!["n"])).toBe(1);
    expect(await repo.hasPaid(s.listing, b1.userId)).toBe(true);
    expect(await repo.hasPaid(s.listing, b2.userId)).toBe(true);
    expect(await repo.hasPaid(s.listing, randomUUID())).toBe(false);
  });
});

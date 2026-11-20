import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  answerTime, dispatchOpenSlots, getSettings, handleInboundJobEmail, listJobsForOwner, ownerAction, proposeTime, runDueElenaJobs, saveSettings, type Sender
} from "../src/server/elena-jobs-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("Elena job handling on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const hours = (base: string, h: number) => new Date(new Date(base).getTime() + h * 3600_000).toISOString();
  const outbox: { userId: string; title: string; body: string }[] = [];
  const sender: Sender = { async send(userId, _k, title, body) { outbox.push({ userId, title, body }); return true; } };
  const emailOf = async (id: string) => String((await t.db.query("SELECT email FROM app_user WHERE id = $1", [id])).rows[0]!["email"]);

  async function setup(settings = { handleJobs: true, autoReply: false, hideNewFiles: false }, status: "proposed" | "approved" = "approved") {
    const ownerId = await addUser(t.db, "owner");
    const contractorId = String((await t.db.query("INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1,'Pat Photo','vendor','active') RETURNING id", [`${randomUUID()}@example.test`])).rows[0]!["id"]);
    const listingId = await addListing(t.db, ownerId, { address_text: "12 Smith St, Newtown", suburb: "Newtown", postcode: "2042" });
    expect(await saveSettings(t.db, ownerId, listingId, settings)).toBe(true);
    const assignmentId = String((await t.db.query("INSERT INTO job_assignment (listing_id, owner_user_id, contractor_user_id, kind, status) VALUES ($1,$2,$3,'photographer',$4) RETURNING id", [listingId, ownerId, contractorId, status])).rows[0]!["id"]);
    return { ownerId, contractorId, listingId, assignmentId };
  }
  const job = async (listingId: string, ownerId: string) => (await listJobsForOwner(t.db, ownerId, listingId))[0]!;

  it("only the listing's owner can change settings; auto-reply needs handling on", async () => {
    const { ownerId, listingId } = await setup({ handleJobs: false, autoReply: true, hideNewFiles: false });
    expect(await getSettings(t.db, listingId)).toEqual({ handleJobs: false, autoReply: false, hideNewFiles: false });
    const stranger = await addUser(t.db, "owner");
    expect(await saveSettings(t.db, stranger, listingId, { handleJobs: true, autoReply: true, hideNewFiles: false })).toBe(false);
    expect((await getSettings(t.db, listingId)).handleJobs).toBe(false);
    expect(ownerId).toBeTruthy();
  });

  it("creates the job without a second request, chases after a day, and asks for a time once the contractor accepted", async () => {
    outbox.length = 0;
    const now = new Date().toISOString();
    const a = await setup({ handleJobs: true, autoReply: false, hideNewFiles: false }, "proposed");
    const r = await runDueElenaJobs(t.db, now, sender);
    expect(r.created).toBeGreaterThanOrEqual(1);
    let j = await job(a.listingId, a.ownerId);
    expect(j).toMatchObject({ state: "requested", kind: "photographer" });
    expect(j.ref).toMatch(/^JOB-\d+$/);
    expect(outbox.filter(o => o.userId === a.contractorId)).toHaveLength(0); // the Jobs page already sent the offer

    await runDueElenaJobs(t.db, hours(now, 25), sender);
    expect(outbox.filter(o => o.userId === a.contractorId)[0]!.title).toContain("Reminder");
    expect(outbox[0]!.body).toContain(j.ref);
    // before they accept, the contractor sees the suburb, never the street address
    expect(outbox[0]!.body).not.toContain("12 Smith St");

    await t.db.query("UPDATE job_assignment SET status = 'approved' WHERE id = $1", [a.assignmentId]);
    await runDueElenaJobs(t.db, hours(now, 26), sender);
    j = await job(a.listingId, a.ownerId);
    expect(j.state).toBe("negotiating");
    expect(outbox.some(o => o.userId === a.contractorId && o.title.startsWith("When can you attend"))).toBe(true);
  });

  it("stays in step with the Jobs page: a proposed time is chased, a confirmed time is recorded, a rejection asks both again", async () => {
    outbox.length = 0;
    const now = new Date().toISOString();
    const a = await setup();
    await runDueElenaJobs(t.db, now, sender);
    const id = (await job(a.listingId, a.ownerId)).id;
    const t1 = hours(now, 72), t2 = hours(now, 96);
    await t.db.query("UPDATE job_assignment SET proposed_time = $2 WHERE id = $1", [a.assignmentId, t1]);
    await runDueElenaJobs(t.db, hours(now, 0.1), sender);
    let j = await job(a.listingId, a.ownerId);
    expect(j).toMatchObject({ state: "negotiating", proposedBy: "contractor", proposedAt: new Date(t1).toISOString() });
    expect(outbox.some(o => o.title.includes("confirm a time"))).toBe(false); // the Jobs page already told the owner

    outbox.length = 0;
    await t.db.query("UPDATE job_assignment SET proposed_time = NULL WHERE id = $1", [a.assignmentId]); // owner rejected there
    await runDueElenaJobs(t.db, hours(now, 0.2), sender);
    expect(outbox.map(o => o.userId).sort()).toEqual([a.ownerId, a.contractorId].sort());
    expect((await job(a.listingId, a.ownerId)).proposedAt).toBeUndefined();

    await t.db.query("UPDATE job_assignment SET scheduled_time = $2 WHERE id = $1", [a.assignmentId, t2]); // agreed there
    await runDueElenaJobs(t.db, hours(now, 0.3), sender);
    j = await job(a.listingId, a.ownerId);
    expect(j).toMatchObject({ state: "scheduled", appointmentAt: new Date(t2).toISOString() });
    expect(id).toBe(j.id);
  });

  it("writes an agreed time back to the job (and approves a still-offered job); a contractor proposal shows on the job", async () => {
    outbox.length = 0;
    const now = new Date().toISOString();
    const a = await setup({ handleJobs: true, autoReply: false, hideNewFiles: false }, "proposed");
    await runDueElenaJobs(t.db, now, sender);
    await t.db.query("UPDATE job_assignment SET status = 'approved' WHERE id = $1", [a.assignmentId]);
    await runDueElenaJobs(t.db, hours(now, 1), sender);
    const id = (await job(a.listingId, a.ownerId)).id;
    const slot = hours(now, 80);
    expect(await proposeTime(t.db, sender, a.contractorId, id, slot, now)).toEqual({ ok: true });
    const row = async () => (await t.db.query("SELECT proposed_time, scheduled_time, status FROM job_assignment WHERE id = $1", [a.assignmentId])).rows[0]!;
    expect((((await row())["proposed_time"]) as Date).toISOString()).toBe(slot);
    expect(await answerTime(t.db, sender, a.ownerId, id, true, now)).toEqual({ ok: true });
    const r = await row();
    expect((r["scheduled_time"] as Date).toISOString()).toBe(slot);
    expect(r["proposed_time"]).toBeNull();
    const audit = await t.db.query("SELECT count(*)::int AS n FROM audit_event WHERE aggregate_id = $1 AND event_type = 'job.time_confirmed_by_elena'", [a.assignmentId]);
    expect(audit.rows[0]!["n"]).toBe(1);
  });

  it("hands the job to the owner when the contractor is suspended, and ignores their emails", async () => {
    outbox.length = 0;
    const now = new Date().toISOString();
    const a = await setup();
    await runDueElenaJobs(t.db, now, sender);
    const j0 = await job(a.listingId, a.ownerId);
    await t.db.query("INSERT INTO contractor_standing (user_id, suspended, reason) VALUES ($1, true, 'test')", [a.contractorId]);
    await t.db.query("UPDATE elena_job SET next_action_at = $2 WHERE id = $1", [j0.id, now]);
    await runDueElenaJobs(t.db, hours(now, 0.1), sender);
    const j = await job(a.listingId, a.ownerId);
    expect(j.state).toBe("needs_owner");
    expect(j.needsOwnerReason).toContain("no longer available");
    expect(await handleInboundJobEmail(t.db, sender, { from: await emailOf(a.contractorId), subject: j.ref, text: "Yes", verified: true }, now)).toBe("ignored");
  });

  it("offers the job to the best verified, insured, unsuspended contractor and never re-asks one who was asked", async () => {
    const ownerId = await addUser(t.db, "owner");
    const listingId = await addListing(t.db, ownerId, { suburb: "Newtown", postcode: "2042", address_text: "9 Dispatch St" });
    await saveSettings(t.db, ownerId, listingId, { handleJobs: true, autoReply: false, hideNewFiles: false });
    const mk = async (name: string, o: { verified: boolean; suspended?: boolean }) => {
      const id = String((await t.db.query("INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1,$2,'vendor','active') RETURNING id", [`${randomUUID()}@example.test`, name])).rows[0]!["id"]);
      await t.db.query("INSERT INTO contractor_page (user_id, is_public) VALUES ($1, true) ON CONFLICT (user_id) DO UPDATE SET is_public = true", [id]);
      await t.db.query("INSERT INTO contractor_profile (user_id, kind, accepting_new, service_postcodes, service_suburbs) VALUES ($1,'photographer',true,'{2042}','{Newtown}') ON CONFLICT (user_id, kind) DO UPDATE SET accepting_new = true", [id]);
      if (o.verified) await t.db.query("INSERT INTO contractor_verification (user_id, business_name, abn, insurer, policy_number, insurance_expiry, status, reviewed_at, reviewed_by) VALUES ($1,'Biz','12345678901','Ins','P1', current_date + 200, 'verified', now(), $2)", [id, ownerId]);
      if (o.suspended) await t.db.query("INSERT INTO contractor_standing (user_id, suspended, reason) VALUES ($1, true, 'test')", [id]);
      return id;
    };
    const unverified = await mk("Una Verified", { verified: false });
    const suspended = await mk("Sue Suspended", { verified: true, suspended: true });
    const good = await mk("Gus Good", { verified: true });
    expect(await dispatchOpenSlots(t.db, [{ id: listingId, owner_user_id: ownerId }])).toBe(1);
    const who = async () => (await t.db.query("SELECT contractor_user_id, offer_source FROM job_assignment WHERE listing_id = $1 AND kind = 'photographer'", [listingId])).rows;
    expect((await who()).map(x => x["contractor_user_id"])).toEqual([good]);
    expect((await who())[0]!["offer_source"]).toBe("elena");
    // a decline frees the slot, but nobody who was already asked is asked again, and the unqualified are never asked
    await t.db.query("UPDATE job_assignment SET status = 'cancelled' WHERE listing_id = $1", [listingId]);
    expect(await dispatchOpenSlots(t.db, [{ id: listingId, owner_user_id: ownerId }])).toBe(0);
    expect((await who()).every(x => x["contractor_user_id"] === good)).toBe(true);
    expect([unverified, suspended]).not.toContain(good);
  });

  it("goes back and forth until a time is agreed, then confirms both and reminds before the visit", async () => {
    outbox.length = 0;
    const now = new Date().toISOString();
    const a = await setup({ handleJobs: true, autoReply: false, hideNewFiles: false });
    await runDueElenaJobs(t.db, now, sender);
    const id = (await job(a.listingId, a.ownerId)).id;
    const slot = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

    expect(await proposeTime(t.db, sender, a.contractorId, id, slot(3), now)).toEqual({ ok: true });
    expect(outbox.at(-1)).toMatchObject({ userId: a.ownerId });
    expect(outbox.at(-1)!.title).toContain("confirm a time");
    // the proposer cannot answer their own proposal
    expect((await answerTime(t.db, sender, a.contractorId, id, true, now)).ok).toBe(false);

    outbox.length = 0;
    expect(await answerTime(t.db, sender, a.ownerId, id, false, now)).toEqual({ ok: true });
    expect(outbox.map(o => o.userId).sort()).toEqual([a.ownerId, a.contractorId].sort());
    expect((await job(a.listingId, a.ownerId)).state).toBe("negotiating");

    expect(await proposeTime(t.db, sender, a.ownerId, id, slot(4), now)).toEqual({ ok: true });
    outbox.length = 0;
    expect(await answerTime(t.db, sender, a.contractorId, id, true, now)).toEqual({ ok: true });
    const j = await job(a.listingId, a.ownerId);
    expect(j.state).toBe("scheduled");
    expect(outbox.filter(o => o.title.startsWith("Confirmed"))).toHaveLength(2);
    // strangers see nothing and change nothing
    const stranger = await addUser(t.db, "owner");
    expect((await proposeTime(t.db, sender, stranger, id, slot(5), now)).ok).toBe(false);
    expect(await listJobsForOwner(t.db, stranger, a.listingId)).toEqual([]);
  });

  it("reminds, then hands back to the owner after three unanswered reminders", async () => {
    outbox.length = 0;
    let now = new Date().toISOString();
    const a = await setup();
    await runDueElenaJobs(t.db, now, sender);
    const id = (await job(a.listingId, a.ownerId)).id;
    await proposeTime(t.db, sender, a.contractorId, id, hours(now, 24 * 10), now);
    for (let i = 0; i < 4; i++) { now = hours(now, 25); await runDueElenaJobs(t.db, now, sender); }
    const j = await job(a.listingId, a.ownerId);
    expect(j.state).toBe("needs_owner");
    expect(j.needsOwnerReason).toContain("not answered");
    expect(outbox.some(o => o.title.startsWith("Elena needs you"))).toBe(true);
  });

  it("follows up for uploads and reports delivery; the owner can hide the photos", async () => {
    outbox.length = 0;
    let now = new Date().toISOString();
    const a = await setup();
    await runDueElenaJobs(t.db, now, sender);
    const id = (await job(a.listingId, a.ownerId)).id;
    const visit = hours(now, 30);
    await proposeTime(t.db, sender, a.contractorId, id, visit, now);
    await answerTime(t.db, sender, a.ownerId, id, true, now);
    for (const h of [1, 40, 60]) { now = hours(visit, h > 30 ? h - 30 + 3 : h - 30 + 6); await runDueElenaJobs(t.db, now, sender).catch(() => undefined); }
    await t.db.query("UPDATE elena_job SET state = 'awaiting_delivery', next_action_at = $2 WHERE id = $1", [id, now]);
    await runDueElenaJobs(t.db, now, sender);
    expect(outbox.some(o => o.userId === a.contractorId && o.title.startsWith("Please upload"))).toBe(true);

    // a photo arrives in the gallery
    const photoId = randomUUID();
    await t.db.query("INSERT INTO listing_photo (id, listing_id, kind, uploaded_by, content_type, width, height, size_bytes, sha256, storage_key) VALUES ($1,$2,'photo',$3,'image/jpeg',100,100,1000,$4,$5)", [photoId, a.listingId, a.contractorId, "a".repeat(64), `k/${photoId}`]);
    await t.db.query("INSERT INTO listing_photo_layout (listing_id, version, entries, changed_by) VALUES ($1,1,$2::jsonb,$3)", [a.listingId, JSON.stringify([{ photoId, caption: "", alt: "", hidden: false }]), a.contractorId]);
    now = hours(now, 25);
    await t.db.query("UPDATE elena_job SET next_action_at = $2 WHERE id = $1", [id, now]);
    await runDueElenaJobs(t.db, now, sender);
    const j = await job(a.listingId, a.ownerId);
    expect(j).toMatchObject({ state: "delivered", filesPulled: 1 });
    expect(outbox.some(o => o.userId === a.ownerId && o.title.startsWith("Work received"))).toBe(true);

    expect(await ownerAction(t.db, a.ownerId, id, "hide_files", now)).toEqual({ ok: true });
    const layout = (await t.db.query("SELECT version, entries FROM listing_photo_layout WHERE listing_id = $1 ORDER BY version DESC LIMIT 1", [a.listingId])).rows[0]!;
    expect(layout["version"]).toBe(2);
    expect((layout["entries"] as { hidden: boolean }[])[0]!.hidden).toBe(true);
    await ownerAction(t.db, a.ownerId, id, "show_files", now);
    expect(((await t.db.query("SELECT entries FROM listing_photo_layout WHERE listing_id = $1 ORDER BY version DESC LIMIT 1", [a.listingId])).rows[0]!["entries"] as { hidden: boolean }[])[0]!.hidden).toBe(false);
  });

  it("the log is permanent", async () => {
    const a = await setup();
    await runDueElenaJobs(t.db, new Date().toISOString(), sender);
    const j = await job(a.listingId, a.ownerId);
    expect(j.log.length).toBeGreaterThan(0);
    await expect(t.db.query("DELETE FROM elena_job_message WHERE job_id = $1", [j.id])).rejects.toThrow();
    await expect(t.db.query("UPDATE elena_job_message SET body = 'x' WHERE job_id = $1", [j.id])).rejects.toThrow();
  });

  it("a resumed job the contractor never accepted goes back to waiting for their answer; a cancelled job takes no actions", async () => {
    const a = await setup({ handleJobs: true, autoReply: false, hideNewFiles: false }, "proposed");
    await runDueElenaJobs(t.db, new Date().toISOString(), sender);
    const id = (await job(a.listingId, a.ownerId)).id;
    await ownerAction(t.db, a.ownerId, id, "stop", new Date().toISOString());
    await ownerAction(t.db, a.ownerId, id, "resume", new Date().toISOString());
    expect((await job(a.listingId, a.ownerId)).state).toBe("requested");
    await t.db.query("UPDATE job_assignment SET status = 'approved' WHERE id = $1", [a.assignmentId]);
    await t.db.query("UPDATE elena_job SET state = 'negotiating' WHERE id = $1", [id]);
    await t.db.query("UPDATE job_assignment SET status = 'cancelled' WHERE id = $1", [a.assignmentId]);
    expect((await proposeTime(t.db, sender, a.contractorId, id, new Date(Date.now() + 3 * 86_400_000).toISOString(), new Date().toISOString())).ok).toBe(false);
  });

  it("stop and resume are owner-only; Elena does nothing on a stopped job", async () => {
    outbox.length = 0;
    const a = await setup();
    await runDueElenaJobs(t.db, new Date().toISOString(), sender);
    const id = (await job(a.listingId, a.ownerId)).id;
    expect((await ownerAction(t.db, a.contractorId, id, "stop", new Date().toISOString())).ok).toBe(false);
    expect(await ownerAction(t.db, a.ownerId, id, "stop", new Date().toISOString())).toEqual({ ok: true });
    const mine = () => outbox.filter(o => o.userId === a.ownerId || o.userId === a.contractorId).length;
    const before = mine();
    await runDueElenaJobs(t.db, hours(new Date().toISOString(), 100), sender);
    expect(mine()).toBe(before);
    expect(await ownerAction(t.db, a.ownerId, id, "resume", new Date().toISOString())).toEqual({ ok: true });
    expect((await job(a.listingId, a.ownerId)).state).toBe("negotiating");
  });

  describe("email replies", () => {
    async function negotiating(settings = { handleJobs: true, autoReply: false, hideNewFiles: false }) {
      const a = await setup(settings);
      await runDueElenaJobs(t.db, new Date().toISOString(), sender);
      const j = await job(a.listingId, a.ownerId);
      return { ...a, ref: j.ref, id: j.id, ownerEmail: await emailOf(a.ownerId), contractorEmail: await emailOf(a.contractorId) };
    }
    const future = () => { const d = new Date(Date.now() + 5 * 86_400_000); return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()} 11:00am`; };

    it("reads a proposed time, asks the owner, and takes their yes", async () => {
      outbox.length = 0;
      const a = await negotiating();
      const now = new Date().toISOString();
      expect(await handleInboundJobEmail(t.db, sender, { from: a.contractorEmail, subject: `Re: ${a.ref}`, text: `I can do ${future()}`, verified: true }, now)).toBe("handled");
      expect(outbox.at(-1)).toMatchObject({ userId: a.ownerId });
      expect(await handleInboundJobEmail(t.db, sender, { from: a.ownerEmail, subject: `Re: ${a.ref}`, text: "Yes, that works", verified: true }, now)).toBe("handled");
      expect((await job(a.listingId, a.ownerId)).state).toBe("scheduled");
    });

    it("ignores unverified senders, strangers and unknown references", async () => {
      const a = await negotiating();
      const now = new Date().toISOString();
      const spoof = { from: a.ownerEmail, subject: a.ref, text: "Yes, that works", verified: false };
      expect(await handleInboundJobEmail(t.db, sender, spoof, now)).toBe("ignored");
      expect(await handleInboundJobEmail(t.db, sender, { ...spoof, from: "nobody@example.test", verified: true }, now)).toBe("ignored");
      expect(await handleInboundJobEmail(t.db, sender, { ...spoof, subject: "JOB-9999999", verified: true }, now)).toBe("ignored");
      expect((await job(a.listingId, a.ownerId)).state).toBe("negotiating");
    });

    it("sends money and questions to the owner and answers only when auto-reply is on", async () => {
      const off = await negotiating();
      outbox.length = 0;
      const now = new Date().toISOString();
      expect(await handleInboundJobEmail(t.db, sender, { from: off.contractorEmail, subject: off.ref, text: "My fee is $300", verified: true }, now)).toBe("owner_only");
      expect(outbox.every(o => o.userId === off.ownerId)).toBe(true);
      expect(outbox.some(o => o.userId === off.contractorId)).toBe(false);

      const on = await negotiating({ handleJobs: true, autoReply: true, hideNewFiles: false });
      outbox.length = 0;
      expect(await handleInboundJobEmail(t.db, sender, { from: on.contractorEmail, subject: on.ref, text: "Is there a lockbox?", verified: true }, now)).toBe("owner_only");
      expect(outbox.some(o => o.userId === on.contractorId && o.title.startsWith("Re:"))).toBe(true);
      expect(outbox.some(o => o.userId === on.ownerId && o.title.startsWith("Reply from"))).toBe(true);
      // a second off-flow mail the same day gets no second note, so two robots cannot keep each other talking
      outbox.length = 0;
      await handleInboundJobEmail(t.db, sender, { from: on.contractorEmail, subject: on.ref, text: "Thanks!", verified: true }, now);
      expect(outbox.some(o => o.userId === on.contractorId)).toBe(false);
      expect(outbox.every(o => !/\$\d/.test(o.body))).toBe(true);
      const m = (await job(on.listingId, on.ownerId)).log.map(x => `${x.direction}:${x.status}`);
      expect(m).toContain("in:received");
    });

    it("does nothing when the owner has not turned Elena on", async () => {
      const a = await setup({ handleJobs: false, autoReply: false, hideNewFiles: false });
      const no = Number((await t.db.query("SELECT job_number FROM job_assignment WHERE id = $1", [a.assignmentId])).rows[0]!['job_number']);
      await t.db.query("INSERT INTO elena_job (assignment_id, listing_id, owner_user_id, contractor_user_id, kind, contact_ref, state) VALUES ($1,$2,$3,$4,'photographer',$5,'negotiating')", [a.assignmentId, a.listingId, a.ownerId, a.contractorId, `JOB-${no}`]);
      outbox.length = 0;
      const r = await handleInboundJobEmail(t.db, sender, { from: await emailOf(a.contractorId), subject: `JOB-${no}`, text: `I can do ${future()}`, verified: true }, new Date().toISOString());
      expect(r).toBe("ignored");
      expect(outbox).toHaveLength(0);
      expect((await t.db.query("SELECT state FROM elena_job WHERE assignment_id = $1", [a.assignmentId])).rows[0]!["state"]).toBe("negotiating");
    });
  });
});

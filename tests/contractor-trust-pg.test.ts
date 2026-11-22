import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertComplaint } from "../src/server/contractor-ops-db";
import { createPgAssignmentRepository } from "../src/server/assignment-db";
import {
  assignmentAccessPg, confirmUsageRightsPg, decideQuotePg, decideReportPg, decideVerificationPg, getStandingPg, getVerificationPg,
  listReportsPg, listVerificationsPg, publicTrustPg, quotesForAssignmentPg, replyToReviewPg, sendQuotePg, setSuspensionPg, submitVerificationPg
} from "../src/server/contractor-trust-db";
import { actorFromRequestChecked } from "../src/server/auth/actor";
import { SESSION_COOKIE, signSession } from "../src/server/auth/session";
import { CANDIDATES_SQL } from "../src/server/contractor-profile-db";
import { INSERT_MESSAGE_SQL } from "../src/server/job-chat-db";
import { PROPOSE_TIME_SQL, MARK_DONE_SQL } from "../src/server/contractor-market-db";
import { verificationState } from "../src/domain/contractor-trust";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const TODAY = "2026-11-20";
const details = { businessName: "Bright Snaps", abn: "51824753556", licenceNumber: null, licenceAuthority: null, licenceExpiry: null, insurer: "Allianz", policyNumber: "PL-1", insuranceExpiry: "2027-03-01" };

describe.skipIf(!DATABASE_URL)("contractor trust and safety (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  const job = async (status = "approved", kind = "photographer") => {
    const owner = await addUser(db, "owner");
    const contractor = await addUser(db, "agent");
    const listing = await addListing(db, owner, { title: "Trust test", address_text: "12 Secret Lane", suburb: "Paddington", postcode: "4064", jurisdiction: "QLD" });
    const id = String((await db.query("INSERT INTO job_assignment (listing_id, owner_user_id, contractor_user_id, kind, status) VALUES ($1,$2,$3,$4,$5) RETURNING id", [listing, owner, contractor, kind, status])).rows[0]!["id"]);
    return { owner, contractor, listing, id };
  };

  it("verification: resubmitting resets to pending, staff decide once, never on themselves", async () => {
    const staff = await addUser(db, "admin");
    const c = await addUser(db, "agent");
    expect(await submitVerificationPg(db, c, details)).toBe(true);
    expect(await decideVerificationPg(db, c, staff, "verify", null)).toBe(true);
    expect(await decideVerificationPg(db, c, staff, "verify", null)).toBe(false);
    let v = (await getVerificationPg(db, c))!;
    expect(verificationState(v, TODAY).badge).toBe(true);
    // The badge goes off when the insurance date passes, with no staff action.
    expect(verificationState(v, "2027-03-02")).toMatchObject({ badge: false, insuranceExpired: true });
    await submitVerificationPg(db, c, { ...details, insurer: "QBE" });
    v = (await getVerificationPg(db, c))!;
    expect(v.status).toBe("pending");
    expect(verificationState(v, TODAY).badge).toBe(false);
    expect((await listVerificationsPg(db, "pending", TODAY)).some(x => x.userId === c)).toBe(true);
    expect(await decideVerificationPg(db, c, c, "verify", null)).toBe(false);
    expect(await decideVerificationPg(db, c, staff, "reject", "Policy number does not match.")).toBe(true);
    const owner = await addUser(db, "owner");
    expect(await submitVerificationPg(db, owner, details)).toBe(false);
    await expect(db.query("DELETE FROM contractor_verification_event")).rejects.toThrow(/permanent/);
  });

  it("address stays hidden from the contractor until the job is accepted", async () => {
    const proposed = await job("proposed");
    const forContractor = (await assignmentAccessPg(db, proposed.id, proposed.contractor))!;
    expect(forContractor).toMatchObject({ addressHidden: true, address: "Paddington QLD 4064" });
    expect(forContractor.address).not.toContain("Secret");
    expect((await assignmentAccessPg(db, proposed.id, proposed.owner))!.address).toBe("12 Secret Lane");
    expect(await assignmentAccessPg(db, proposed.id, await addUser(db, "agent"))).toBeUndefined();
    await db.query("UPDATE job_assignment SET status = 'approved' WHERE id = $1", [proposed.id]);
    expect((await assignmentAccessPg(db, proposed.id, proposed.contractor))).toMatchObject({ addressHidden: false, address: "12 Secret Lane" });
    await setSuspensionPg(db, await addUser(db, "admin"), proposed.contractor, true, "Under review.");
    expect((await assignmentAccessPg(db, proposed.id, proposed.contractor))).toMatchObject({ addressHidden: true, address: "Paddington QLD 4064" });
  });

  it("usage rights: only the accepted photographer, once", async () => {
    const j = await job();
    expect(await confirmUsageRightsPg(db, j.owner, j.id)).toBe(false);
    expect(await confirmUsageRightsPg(db, j.contractor, j.id)).toBe(true);
    expect(await confirmUsageRightsPg(db, j.contractor, j.id)).toBe(false);
    expect((await assignmentAccessPg(db, j.id, j.contractor))!.usageRightsConfirmed).toBe(true);
    const insp = await job("approved", "inspector");
    expect(await confirmUsageRightsPg(db, insp.contractor, insp.id)).toBe(false);
    const proposed = await job("proposed");
    expect(await confirmUsageRightsPg(db, proposed.contractor, proposed.id)).toBe(false);
  });

  it("complaints reach staff; upheld-and-suspended contractors cannot be invited or accept; reinstating restores", async () => {
    const staff = await addUser(db, "admin");
    const j = await job();
    expect(await insertComplaint(db, j.id, j.contractor, "no_show", "Not allowed for the contractor.")).toBe(false);
    expect(await insertComplaint(db, j.id, j.owner, "no_show", "Did not arrive for the 10am shoot.")).toBe(true);
    const row = (await listReportsPg(db, "open")).find(r => r.assignmentId === j.id)!;
    expect(row).toMatchObject({ kind: "no_show", status: "open", contractorSuspended: false });
    expect(await decideReportPg(db, row.id, j.owner, "uphold", "x")).toBe("conflict");
    expect(await decideReportPg(db, row.id, staff, "uphold_and_suspend", "Second no-show this month.")).toBe("ok");
    expect(await decideReportPg(db, row.id, staff, "dismiss", "again")).toBe("conflict");
    expect((await getStandingPg(db, j.contractor)).suspended).toBe(true);
    expect((await listReportsPg(db, "decided")).find(r => r.id === row.id)).toMatchObject({ status: "upheld", contractorSuspended: true });
    await expect(db.query("UPDATE contractor_complaint SET details = 'changed' WHERE id = $1", [row.id])).rejects.toThrow();
    await expect(db.query("DELETE FROM contractor_complaint WHERE id = $1", [row.id])).rejects.toThrow(/permanent/);

    const repo = createPgAssignmentRepository(db);
    const ev = () => ({ id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user" as const, actorId: j.owner, aggregateType: "job_assignment", aggregateId: "x", eventType: "t", correlationId: randomUUID(), payload: {} });
    const newJob = (id: string) => ({ id, listingId: j.listing, ownerUserId: j.owner, contractorUserId: j.contractor, kind: "inspector" as const, status: "proposed" as const });
    expect(await repo.insertProposed(newJob(randomUUID()), ev())).toBe(false);

    // A job proposed before the suspension cannot be accepted either.
    const pending = await job("proposed");
    await setSuspensionPg(db, staff, pending.contractor, true, "Suspended for review.");
    expect(await repo.transition({ id: pending.id, actorId: pending.contractor, side: "contractor", from: ["proposed"], to: "approved" }, ev())).toBe(false);
    expect(await setSuspensionPg(db, staff, pending.contractor, true, "again")).toBe(false);
    expect(await setSuspensionPg(db, staff, pending.contractor, false, "Cleared after review.")).toBe(true);
    expect(await repo.transition({ id: pending.id, actorId: pending.contractor, side: "contractor", from: ["proposed"], to: "approved" }, ev())).toBe(true);
    expect(await setSuspensionPg(db, staff, await addUser(db, "agent"), false, "never suspended")).toBe(false);
    expect(await setSuspensionPg(db, staff, await addUser(db, "owner"), true, "not a contractor")).toBe(false);
    const hist = await db.query("SELECT action FROM contractor_standing_event WHERE contractor_user_id = $1 ORDER BY created_at", [pending.contractor]);
    expect(hist.rows.map(r => r["action"])).toEqual(["suspend", "reinstate"]);
  });

  it("quotes: sent on an accepted job, one at a time, decided by the owner, never edited", async () => {
    const j = await job();
    const q = { amountCents: 45_000, description: "Replace two taps and reseal the basin." };
    expect(await sendQuotePg(db, j.owner, j.id, q)).toBe("not_allowed");
    expect(await sendQuotePg(db, j.contractor, j.id, q)).toBe("created");
    expect(await sendQuotePg(db, j.contractor, j.id, q)).toBe("pending_exists");
    const [quote] = await quotesForAssignmentPg(db, j.id);
    expect(quote).toMatchObject({ status: "sent", amountCents: 45_000 });
    await expect(db.query("UPDATE job_quote SET amount_cents = 1 WHERE id = $1", [quote!.id])).rejects.toThrow(/cannot be edited/);
    expect(await decideQuotePg(db, j.contractor, quote!.id, "accept")).toBe(false);
    expect(await decideQuotePg(db, await addUser(db, "owner"), quote!.id, "accept")).toBe(false);
    expect(await decideQuotePg(db, j.owner, quote!.id, "accept")).toBe(true);
    expect(await decideQuotePg(db, j.owner, quote!.id, "decline")).toBe(false);
    expect((await quotesForAssignmentPg(db, j.id))[0]!.status).toBe("accepted");
    // After a decline or withdrawal a new quote can be sent.
    expect(await sendQuotePg(db, j.contractor, j.id, q)).toBe("created");
    const next = (await quotesForAssignmentPg(db, j.id)).find(x => x.status === "sent")!;
    expect(await decideQuotePg(db, j.contractor, next.id, "withdraw")).toBe(true);
    await expect(db.query("DELETE FROM job_quote WHERE id = $1", [next.id])).rejects.toThrow(/permanent/);
  });

  it("a suspended contractor cannot send quotes", async () => {
    const staff = await addUser(db, "admin");
    const j = await job();
    await setSuspensionPg(db, staff, j.contractor, true, "Under review.");
    expect(await sendQuotePg(db, j.contractor, j.id, { amountCents: 100, description: "Ten characters or more." })).toBe("not_allowed");
  });

  it("reviews: one public contractor reply; hidden reviews are not shown; nothing edited or deleted", async () => {
    const done = await job("completed");
    // The owner's review itself is written by the job board (POST /api/jobs/[id]/review); here it is inserted the same way.
    await db.query("INSERT INTO contractor_review (assignment_id, contractor_user_id, owner_user_id, rating, body) VALUES ($1,$2,$3,4,'Turned up on time.')", [done.id, done.contractor, done.owner]);
    await expect(db.query("INSERT INTO contractor_review (assignment_id, contractor_user_id, owner_user_id, rating) VALUES ($1,$2,$3,1)", [done.id, done.contractor, done.owner])).rejects.toThrow();
    const review = (await publicTrustPg(db, done.contractor, TODAY))!.reviews[0]!;
    expect(review).toMatchObject({ rating: 4, comment: "Turned up on time.", reply: null });
    expect(await replyToReviewPg(db, done.owner, review.id, "hi")).toBe(false);
    expect(await replyToReviewPg(db, done.contractor, review.id, "Thank you!")).toBe(true);
    expect(await replyToReviewPg(db, done.contractor, review.id, "Second reply")).toBe(false);
    await expect(db.query("UPDATE contractor_review SET rating = 1 WHERE id = $1", [review.id])).rejects.toThrow();
    await expect(db.query("DELETE FROM contractor_review WHERE id = $1", [review.id])).rejects.toThrow(/permanent/);
    const trust = (await publicTrustPg(db, done.contractor, TODAY))!;
    expect(trust.rating).toEqual({ average: 4, count: 1 });
    expect(trust.reviews[0]!.reply).toBe("Thank you!");
    expect(JSON.stringify(trust)).not.toMatch(/abn|policy|licence/i);
    await db.query("UPDATE contractor_review SET status = 'hidden' WHERE id = $1", [review.id]);
    expect((await publicTrustPg(db, done.contractor, TODAY))).toMatchObject({ rating: { count: 0 }, reviews: [] });
  });

  it("public trust shows the badge only for a verified, in-date, not-suspended contractor", async () => {
    const staff = await addUser(db, "admin");
    const c = await addUser(db, "agent");
    await submitVerificationPg(db, c, details);
    expect((await publicTrustPg(db, c, TODAY))!.badge).toBe(false);
    await decideVerificationPg(db, c, staff, "verify", null);
    expect((await publicTrustPg(db, c, TODAY))!.badge).toBe(true);
    expect((await publicTrustPg(db, c, "2027-03-02"))!.badge).toBe(false);
    await setSuspensionPg(db, staff, c, true, "Under review.");
    expect((await publicTrustPg(db, c, TODAY))).toMatchObject({ badge: false, suspended: true });
    expect(await publicTrustPg(db, await addUser(db, "owner"), TODAY)).toBeUndefined();
  });

  it("a suspended contractor is shut out everywhere at once, and reinstating restores it", async () => {
    const secret = "s".repeat(40), now = Math.floor(Date.now() / 1000);
    const staff = await addUser(db, "admin");
    const v = String((await db.query("INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1, 'Vee', 'vendor', 'active') RETURNING id", [`${randomUUID()}@example.test`])).rows[0]!["id"]);
    const owner = await addUser(db, "owner");
    const listing = await addListing(db, owner, {});
    const jobId = String((await db.query("INSERT INTO job_assignment (listing_id, owner_user_id, contractor_user_id, kind, status) VALUES ($1,$2,$3,'photographer','approved') RETURNING id", [listing, owner, v])).rows[0]!["id"]);
    const req = () => new Request("http://test/api/jobs", { headers: { cookie: `${SESSION_COOKIE}=${signSession({ uid: v, ut: "vendor", exp: now + 3600 }, secret)}` } });
    const audit = [randomUUID(), new Date().toISOString(), "t", randomUUID(), "{}"];
    expect(await actorFromRequestChecked(db, req(), secret, now)).toEqual({ userId: v, userType: "vendor" });
    expect((await db.query(INSERT_MESSAGE_SQL, [randomUUID(), jobId, v, "hello", new Date().toISOString()])).rows).toHaveLength(1);

    expect(await setSuspensionPg(db, staff, v, true, "Two no-shows.")).toBe(true);
    // Session, sign-in status, chat, job actions and photo access are all closed.
    expect(await actorFromRequestChecked(db, req(), secret, now)).toBeNull();
    expect((await db.query("SELECT status FROM app_user WHERE id = $1", [v])).rows[0]!["status"]).toBe("suspended");
    expect((await db.query(INSERT_MESSAGE_SQL, [randomUUID(), jobId, v, "hello again", new Date().toISOString()])).rows).toHaveLength(0);
    expect((await db.query(INSERT_MESSAGE_SQL, [randomUUID(), jobId, owner, "owner can still write", new Date().toISOString()])).rows).toHaveLength(1);
    expect((await db.query(PROPOSE_TIME_SQL, [jobId, v, new Date(Date.now() + 86_400_000).toISOString(), ...audit])).rows).toHaveLength(0);
    expect((await db.query(MARK_DONE_SQL, [jobId, v, ...audit])).rows).toHaveLength(0);

    expect(await setSuspensionPg(db, staff, v, false, "Cleared.")).toBe(true);
    expect(await actorFromRequestChecked(db, req(), secret, now)).toEqual({ userId: v, userType: "vendor" });
    expect((await db.query(PROPOSE_TIME_SQL, [jobId, v, new Date(Date.now() + 86_400_000).toISOString(), ...audit])).rows).toHaveLength(1);
  });

  it("automatic matching offers jobs only to verified, in-date, not suspended contractors", async () => {
    const staff = await addUser(db, "admin");
    const mk = async () => {
      const id = String((await db.query("INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1, 'Pat', 'vendor', 'active') RETURNING id", [`${randomUUID()}@example.test`])).rows[0]!["id"]);
      await db.query("INSERT INTO contractor_profile (user_id, kind, accepting_new, service_postcodes) VALUES ($1, 'photographer', true, ARRAY['4064'])", [id]);
      return id;
    };
    const ids = async () => (await db.query(CANDIDATES_SQL, ["photographer"])).rows.map(r => String(r["id"]));
    const c = await mk();
    expect(await ids()).not.toContain(c);
    await submitVerificationPg(db, c, details);
    expect(await ids()).not.toContain(c);
    await decideVerificationPg(db, c, staff, "verify", null);
    expect(await ids()).toContain(c);
    await db.query("UPDATE contractor_verification SET insurance_expiry = current_date - 1 WHERE user_id = $1", [c]);
    expect(await ids()).not.toContain(c);
    await db.query("UPDATE contractor_verification SET insurance_expiry = current_date + 30 WHERE user_id = $1", [c]);
    expect(await ids()).toContain(c);
    await setSuspensionPg(db, staff, c, true, "Under review.");
    expect(await ids()).not.toContain(c);
    // New profiles are off until the contractor opts in.
    const fresh = await addUser(db, "agent");
    await db.query("INSERT INTO contractor_profile (user_id, kind) VALUES ($1, 'inspector')", [fresh]);
    expect((await db.query("SELECT accepting_new FROM contractor_profile WHERE user_id = $1", [fresh])).rows[0]!["accepting_new"]).toBe(false);
  });
});

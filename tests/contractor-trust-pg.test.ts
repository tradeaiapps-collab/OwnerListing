import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgAssignmentRepository } from "../src/server/assignment-db";
import {
  assignmentAccessPg, confirmUsageRightsPg, createReportPg, createReviewPg, decideQuotePg, decideReportPg, decideVerificationPg, getStandingPg, getVerificationPg,
  listReportsPg, listVerificationsPg, publicTrustPg, quotesForAssignmentPg, replyToReviewPg, sendQuotePg, setSuspensionPg, submitVerificationPg
} from "../src/server/contractor-trust-db";
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

  it("reports go to staff; upheld-and-suspended contractors cannot be invited or accept; reinstating restores", async () => {
    const staff = await addUser(db, "admin");
    const j = await job();
    expect(await createReportPg(db, j.contractor, j.id, "no_show", "Not allowed for the contractor.")).toBe("not_allowed");
    expect(await createReportPg(db, j.owner, j.id, "no_show", "Did not arrive for the 10am shoot.")).toBe("created");
    expect(await createReportPg(db, j.owner, j.id, "no_show", "Again the same thing.")).toBe("duplicate");
    const row = (await listReportsPg(db, "open")).find(r => r.assignmentId === j.id)!;
    expect(row).toMatchObject({ kind: "no_show", status: "open", contractorSuspended: false });
    expect(await decideReportPg(db, row.id, j.owner, "uphold", "x")).toBe("conflict");
    expect(await decideReportPg(db, row.id, staff, "uphold_and_suspend", "Second no-show this month.")).toBe("ok");
    expect(await decideReportPg(db, row.id, staff, "dismiss", "again")).toBe("conflict");
    expect((await getStandingPg(db, j.contractor)).suspended).toBe(true);
    expect((await listReportsPg(db, "decided")).find(r => r.id === row.id)).toMatchObject({ status: "upheld", contractorSuspended: true });

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

  it("reviews: only the owner of a completed job, once; one public reply; nothing edited or deleted", async () => {
    const open = await job("approved");
    expect(await createReviewPg(db, open.owner, open.id, { rating: 5, comment: null })).toBe("not_allowed");
    const done = await job("completed");
    expect(await createReviewPg(db, done.contractor, done.id, { rating: 5, comment: null })).toBe("not_allowed");
    expect(await createReviewPg(db, await addUser(db, "owner"), done.id, { rating: 5, comment: null })).toBe("not_allowed");
    expect(await createReviewPg(db, done.owner, done.id, { rating: 4, comment: "Turned up on time." })).toBe("created");
    expect(await createReviewPg(db, done.owner, done.id, { rating: 1, comment: null })).toBe("duplicate");
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
});

import { describe, expect, it } from "vitest";
import { actOnJob, bookContractor, chooseForMe, reviewJob, suggestFor } from "../src/domain/job-board";
import type { Actor } from "../src/domain/listing-service";
import { LISTING, U, card, memoryMarket } from "./helpers/market-memory";

const owner: Actor = { userId: U(1), userType: "owner" };
const pat: Actor = { userId: U(2), userType: "vendor" };
const ian: Actor = { userId: U(3), userType: "vendor" };
const SVC = U(900);
const setup = () => memoryMarket({ cards: [card(2, { ratingAvg: 4.5, ratingCount: 3 }), card(3, { trade: "inspector" })], services: [{ id: SVC, userId: U(2), kind: "photographer", name: "Photo package", priceCents: 18000, priceType: "fixed" }] });

describe("booking", () => {
  it("creates a numbered offer with the contractor's own price and tells the contractor", async () => {
    const m = setup();
    const r = await bookContractor(m.deps, owner, LISTING, { kind: "photographer", contractorNo: "CON-2001", serviceId: SVC, note: "Please bring a drone" });
    expect(r.ok && r.value).toMatchObject({ jobNumber: 5001, status: "proposed", priceCents: 18000, serviceName: "Photo package", note: "Please bring a drone", offerSource: "owner" });
    expect(m.sent).toEqual([{ to: U(2), kind: "job_offered", job: "JOB-5001", extra: { price: "Photo package $180" } }]);
  });
  it("refuses other people's listings, other trades' services, closed books and past times", async () => {
    const m = setup();
    expect((await bookContractor(m.deps, pat, LISTING, { kind: "photographer", contractorNo: 2001 })).ok).toBe(false);
    expect((await bookContractor(m.deps, owner, LISTING, { kind: "inspector", contractorUserId: U(2) })).ok).toBe(false);
    expect((await bookContractor(m.deps, owner, LISTING, { kind: "photographer", contractorNo: 2001, serviceId: U(901) })).ok).toBe(false);
    expect((await bookContractor(m.deps, owner, LISTING, { kind: "photographer", contractorNo: 2001, requestedTime: "2020-01-01T00:00:00Z" })).ok).toBe(false);
    const closed = memoryMarket({ cards: [card(2, { acceptingNew: false })] });
    expect((await bookContractor(closed.deps, owner, LISTING, { kind: "photographer", contractorNo: 2001 })).ok).toBe(false);
  });
  it("does not offer the same trade twice to the same contractor", async () => {
    const m = setup();
    await bookContractor(m.deps, owner, LISTING, { kind: "photographer", contractorNo: 2001 });
    expect((await bookContractor(m.deps, owner, LISTING, { kind: "photographer", contractorNo: 2001 })).ok).toBe(false);
  });
});

describe("Elena", () => {
  it("suggests only the owner's own listing's matches and books the best one, marked as Elena's choice", async () => {
    const m = setup();
    expect((await suggestFor(m.deps, pat, LISTING, "photographer")).ok).toBe(false);
    const s = await suggestFor(m.deps, owner, LISTING, "photographer");
    expect(s.ok && s.value.map(x => x.card.name)).toEqual(["Pat Photo"]);
    const r = await chooseForMe(m.deps, owner, LISTING, { kind: "photographer" });
    expect(r.ok && r.value.job).toMatchObject({ offerSource: "elena", status: "proposed" });
    expect(r.ok && r.value.reasons).toContain("Works in your suburb");
  });
  it("does not ask someone who already has a job on this listing, and says so when nobody is left", async () => {
    const m = setup();
    await chooseForMe(m.deps, owner, LISTING, { kind: "photographer" });
    const again = await chooseForMe(m.deps, owner, LISTING, { kind: "photographer" });
    expect(again).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("acting on a job", () => {
  const offered = async () => {
    const m = setup();
    const r = await bookContractor(m.deps, owner, LISTING, { kind: "photographer", contractorNo: 2001 });
    if (!r.ok) throw new Error("setup");
    return { m, id: r.value.id };
  };
  it("rejecting needs a reason, which the owner sees", async () => {
    const { m, id } = await offered();
    expect((await actOnJob(m.deps, pat, id, { action: "decline" })).ok).toBe(false);
    const r = await actOnJob(m.deps, pat, id, { action: "decline", reason: "Fully booked that week" });
    expect(r.ok && r.value).toMatchObject({ status: "cancelled", declineReason: "Fully booked that week" });
    expect(m.sent.at(-1)).toMatchObject({ to: U(1), kind: "job_declined", extra: { reason: "Fully booked that week" } });
  });
  it("lets the contractor propose a time and the owner accept it, which also accepts the job", async () => {
    const { m, id } = await offered();
    const t = "2026-11-25T01:00:00.000Z";
    expect((await actOnJob(m.deps, owner, id, { action: "propose_time", time: t })).ok).toBe(false);
    expect((await actOnJob(m.deps, pat, id, { action: "propose_time", time: "2020-01-01T00:00:00Z" })).ok).toBe(false);
    expect((await actOnJob(m.deps, pat, id, { action: "propose_time", time: t })).ok).toBe(true);
    expect(m.sent.at(-1)).toMatchObject({ to: U(1), kind: "job_time_proposed" });
    expect((await actOnJob(m.deps, pat, id, { action: "accept_time" })).ok).toBe(false);
    const r = await actOnJob(m.deps, owner, id, { action: "accept_time" });
    expect(r.ok && r.value).toMatchObject({ status: "approved", scheduledTime: t });
    expect(m.sent.at(-1)).toMatchObject({ to: U(2), kind: "job_time_confirmed" });
  });
  it("lets the owner turn a time down so the contractor can suggest another", async () => {
    const { m, id } = await offered();
    await actOnJob(m.deps, pat, id, { action: "propose_time", time: "2026-11-25T01:00:00.000Z" });
    const r = await actOnJob(m.deps, owner, id, { action: "reject_time" });
    expect(r.ok && r.value.proposedTime).toBeUndefined();
    expect((await actOnJob(m.deps, owner, id, { action: "reject_time" })).ok).toBe(false);
  });
  it("runs accept, mark done, complete, and then one review from the owner only", async () => {
    const { m, id } = await offered();
    expect((await actOnJob(m.deps, pat, id, { action: "mark_done" })).ok).toBe(false); // not accepted yet
    expect((await actOnJob(m.deps, owner, id, { action: "accept" })).ok).toBe(false); // owner cannot accept for them
    expect((await actOnJob(m.deps, pat, id, { action: "accept" })).ok).toBe(true);
    expect((await actOnJob(m.deps, owner, id, { action: "mark_done" })).ok).toBe(false);
    expect((await actOnJob(m.deps, pat, id, { action: "mark_done" })).ok).toBe(true);
    expect(m.sent.at(-1)).toMatchObject({ to: U(1), kind: "job_done" });
    expect((await reviewJob(m.deps, owner, id, { rating: 5 })).ok).toBe(false); // not complete yet
    expect((await actOnJob(m.deps, pat, id, { action: "complete" })).ok).toBe(false);
    expect((await actOnJob(m.deps, owner, id, { action: "complete" })).ok).toBe(true);
    expect((await reviewJob(m.deps, pat, id, { rating: 5 })).ok).toBe(false);
    expect((await reviewJob(m.deps, owner, id, { rating: 9 })).ok).toBe(false);
    const rv = await reviewJob(m.deps, owner, id, { rating: 5, body: "Great photos" });
    expect(rv.ok && rv.value.review).toEqual({ rating: 5, body: "Great photos" });
    expect((await reviewJob(m.deps, owner, id, { rating: 1 })).ok).toBe(false);
    expect(m.sent.at(-1)).toMatchObject({ to: U(2), kind: "job_reviewed" });
  });
  it("hides jobs from everyone who is not a party", async () => {
    const { m, id } = await offered();
    expect(await actOnJob(m.deps, ian, id, { action: "accept" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await actOnJob(m.deps, owner, "not-a-uuid", { action: "cancel" })).toMatchObject({ ok: false, code: "not_found" });
    expect((await actOnJob(m.deps, pat, id, { action: "explode" })).ok).toBe(false);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryAssignmentRepository, inviteContractor, listAssignments, respondToAssignment } from "../src/domain/assignment-service";
import type { Actor } from "../src/domain/listing-service";

const LISTING = "55555555-5555-4555-8555-555555555555";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const photog: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "agent" };
const agent: Actor = { userId: "66666666-6666-4666-8666-666666666666", userType: "agent" };
const stranger: Actor = { userId: "44444444-4444-4444-8444-444444444444", userType: "owner" };
let n = 0;
const ids = { newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`, now: () => "2026-10-24T00:00:00.000Z" };

function setup(licences: NonNullable<Parameters<typeof createInMemoryAssignmentRepository>[0]>["licences"] = []) {
  return createInMemoryAssignmentRepository({
    listings: [{ id: LISTING, ownerUserId: owner.userId, jurisdiction: "QLD", title: "House" }],
    users: [
      { id: owner.userId, userType: "owner", status: "active", email: "owner@example.com", displayName: "Olive" },
      { id: photog.userId, userType: "vendor", status: "active", email: "Pat@Example.com", displayName: "Pat" },
      { id: agent.userId, userType: "agent", status: "active", email: "agent@example.com", displayName: "Ann" },
      { id: stranger.userId, userType: "owner", status: "active", displayName: "Sam" }
    ],
    licences
  });
}
const invite = (repo: ReturnType<typeof setup>, body: unknown, who: Actor = owner) => inviteContractor(repo, who, LISTING, body, ids);
const act = (repo: ReturnType<typeof setup>, id: string, action: string, who: Actor) => respondToAssignment(repo, who, id, { action }, ids);
const events = (repo: ReturnType<typeof setup>, type: string) => repo.audits.filter(e => e.eventType === type);

describe("inviteContractor", () => {
  let repo: ReturnType<typeof setup>;
  beforeEach(() => { repo = setup(); });

  it("invites by email (case-insensitive) and records the session user as owner, with an audit event", async () => {
    const r = await invite(repo, { kind: "photographer", email: " pat@example.com " });
    expect(r.ok && r.value).toMatchObject({ ownerUserId: owner.userId, contractorUserId: photog.userId, status: "proposed" });
    expect(events(repo, "assignment.invited")).toHaveLength(1);
    expect(events(repo, "assignment.invited")[0]).toMatchObject({ actorId: owner.userId, aggregateType: "job_assignment" });
  });

  it("invites by user id and ignores any owner id in the body", async () => {
    const r = await invite(repo, { kind: "inspector", contractorUserId: photog.userId, ownerUserId: stranger.userId });
    expect(r.ok && r.value.ownerUserId).toBe(owner.userId);
  });

  it("does not leak whether an account exists: unknown, self and wrong-type all fail the same way", async () => {
    const unknown = await invite(repo, { kind: "photographer", email: "nobody@example.com" });
    const self = await invite(repo, { kind: "photographer", contractorUserId: owner.userId });
    const wrongType = await invite(repo, { kind: "agent", contractorUserId: photog.userId });
    expect(unknown).toEqual(self);
    expect(unknown).toEqual(wrongType);
    expect(unknown.ok).toBe(false);
    expect(repo.assignments).toHaveLength(0);
  });

  it("rejects non-owners with not_found and writes nothing", async () => {
    const r = await invite(repo, { kind: "photographer", email: "pat@example.com" }, stranger);
    expect(r).toMatchObject({ ok: false, code: "not_found" });
    expect(repo.assignments).toHaveLength(0);
    expect(repo.audits).toHaveLength(0);
  });

  it("rejects bad input and a duplicate live invite", async () => {
    expect(await invite(repo, null)).toMatchObject({ code: "invalid" });
    expect(await invite(repo, { kind: "plumber", email: "pat@example.com" })).toMatchObject({ code: "invalid" });
    expect(await invite(repo, { kind: "photographer" })).toMatchObject({ code: "invalid" });
    expect(await invite(repo, { kind: "photographer", email: "pat@example.com", contractorUserId: photog.userId })).toMatchObject({ code: "invalid" });
    expect(await invite(repo, { kind: "photographer", email: "pat@example.com" })).toMatchObject({ ok: true });
    expect(await invite(repo, { kind: "photographer", email: "pat@example.com" })).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("respondToAssignment", () => {
  async function invited(repo: ReturnType<typeof setup>, kind = "photographer", who: Actor = photog) {
    const r = await invite(repo, { kind, contractorUserId: who.userId });
    if (!r.ok) throw new Error("setup failed");
    return r.value.id;
  }

  it("contractor accepts: proposed -> approved, audited", async () => {
    const repo = setup();
    const id = await invited(repo);
    expect(await act(repo, id, "accept", photog)).toMatchObject({ ok: true, value: { status: "approved" } });
    expect(repo.assignments[0]?.status).toBe("approved");
    expect(events(repo, "assignment.accepted")[0]).toMatchObject({ actorId: photog.userId, payload: { from: "proposed", to: "approved" } });
  });

  it("contractor declines: proposed -> cancelled, audited", async () => {
    const repo = setup();
    const id = await invited(repo);
    expect(await act(repo, id, "decline", photog)).toMatchObject({ ok: true, value: { status: "cancelled" } });
    expect(events(repo, "assignment.declined")).toHaveLength(1);
  });

  it("owner cannot accept for the contractor; contractor cannot cancel or complete", async () => {
    const repo = setup();
    const id = await invited(repo);
    expect(await act(repo, id, "accept", owner)).toMatchObject({ ok: false, code: "forbidden" });
    await act(repo, id, "accept", photog);
    expect(await act(repo, id, "complete", photog)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await act(repo, id, "cancel", photog)).toMatchObject({ ok: false, code: "forbidden" });
    expect(repo.assignments[0]?.status).toBe("approved");
  });

  it("strangers and malformed ids get not_found", async () => {
    const repo = setup();
    const id = await invited(repo);
    expect(await act(repo, id, "accept", stranger)).toMatchObject({ ok: false, code: "not_found" });
    expect(await act(repo, "not-a-uuid", "accept", photog)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("owner completes an approved job and cancels a proposed one; finished jobs cannot move again", async () => {
    const repo = setup();
    const id = await invited(repo);
    expect(await act(repo, id, "complete", owner)).toMatchObject({ ok: false, code: "conflict" });
    await act(repo, id, "accept", photog);
    expect(await act(repo, id, "complete", owner)).toMatchObject({ ok: true, value: { status: "completed" } });
    expect(await act(repo, id, "cancel", owner)).toMatchObject({ ok: false, code: "conflict" });
    expect(await act(repo, id, "accept", photog)).toMatchObject({ ok: false, code: "conflict" });

    const id2 = await invited(repo, "solicitor");
    expect(await act(repo, id2, "cancel", owner)).toMatchObject({ ok: true, value: { status: "cancelled" } });
    expect(events(repo, "assignment.cancelled")).toHaveLength(1);
  });

  it("rejects unknown actions", async () => {
    const repo = setup();
    const id = await invited(repo);
    expect(await act(repo, id, "delete", owner)).toMatchObject({ ok: false, code: "invalid" });
    expect(await respondToAssignment(repo, owner, id, null, ids)).toMatchObject({ ok: false, code: "invalid" });
  });

  it("agent jobs need a verified, unexpired licence in the listing's state to be accepted", async () => {
    const none = setup();
    const id = await invited(none, "agent", agent);
    expect(await act(none, id, "accept", agent)).toMatchObject({ ok: false, code: "forbidden" });
    expect(none.assignments[0]?.status).toBe("proposed");

    const wrongState = setup([{ userId: agent.userId, jurisdiction: "NSW", status: "verified" }]);
    expect(await act(wrongState, await invited(wrongState, "agent", agent), "accept", agent)).toMatchObject({ ok: false, code: "forbidden" });

    const expired = setup([{ userId: agent.userId, jurisdiction: "QLD", status: "verified", expiresAt: "2026-01-01" }]);
    expect(await act(expired, await invited(expired, "agent", agent), "accept", agent)).toMatchObject({ ok: false, code: "forbidden" });

    const ok = setup([{ userId: agent.userId, jurisdiction: "QLD", status: "verified", expiresAt: "2027-01-01" }]);
    expect(await act(ok, await invited(ok, "agent", agent), "accept", agent)).toMatchObject({ ok: true, value: { status: "approved" } });
  });
});

describe("agent job licence expiry at the QLD midnight boundary", () => {
  const lic = [{ userId: agent.userId, jurisdiction: "QLD" as const, status: "verified" as const, expiresAt: "2026-10-24" }];
  const accept = async (nowIso: string) => {
    const repo = setup(lic);
    const r = await invite(repo, { kind: "agent", contractorUserId: agent.userId });
    if (!r.ok) throw new Error("setup failed");
    return respondToAssignment(repo, agent, r.value.id, { action: "accept" }, { ...ids, now: () => nowIso });
  };
  it("is valid at 13:59Z on expiry day and expired at 14:00Z", async () => {
    expect(await accept("2026-10-24T13:59:00.000Z")).toMatchObject({ ok: true });
    expect(await accept("2026-10-24T14:00:00.000Z")).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("listAssignments", () => {
  it("shows each user only their own side, with the other party's name and no email", async () => {
    const repo = setup();
    await invite(repo, { kind: "photographer", contractorUserId: photog.userId });
    const asOwner = await listAssignments(repo, owner);
    const asContractor = await listAssignments(repo, photog);
    const asStranger = await listAssignments(repo, stranger);
    expect(asOwner.ok && asOwner.value).toMatchObject([{ role: "owner", counterpartName: "Pat" }]);
    expect(asContractor.ok && asContractor.value).toMatchObject([{ role: "contractor", counterpartName: "Olive" }]);
    expect(asStranger.ok && asStranger.value).toEqual([]);
    expect(JSON.stringify(asOwner)).not.toContain("example.com");
  });

  it("per-listing list is owner-only", async () => {
    const repo = setup();
    expect(await listAssignments(repo, stranger, LISTING)).toMatchObject({ ok: false, code: "not_found" });
    expect(await listAssignments(repo, photog, LISTING)).toMatchObject({ ok: false, code: "not_found" });
    expect(await listAssignments(repo, owner, LISTING)).toMatchObject({ ok: true });
  });
});

import { describe, expect, it } from "vitest";
import { applyAsInspector, parseSlots, requestInspection, reviewInspector, type BookingRepository } from "../src/domain/inspection-marketplace";

const NOW = "2026-11-05T00:00:00.000Z";
const at = (h: number) => new Date(Date.parse(NOW) + h * 3600_000).toISOString();
const UID = "11111111-1111-4111-8111-111111111111";
const LID = "22222222-2222-4222-8222-222222222222";
const ids = { newId: () => "33333333-3333-4333-8333-333333333333", now: () => NOW };

describe("parseSlots", () => {
  it("accepts 1 to 3 distinct quarter-hour times 12 hours to 30 days ahead, sorted", () => {
    const r = parseSlots([at(50), at(30)], NOW);
    expect(r).toEqual({ ok: true, value: [at(30), at(50)] });
  });
  it.each([
    ["none", []], ["four", [at(24), at(25), at(26), at(27)]], ["too soon", [at(2)]], ["too far", [at(24 * 31)]],
    ["off the quarter hour", [new Date(Date.parse(at(30)) + 60_000).toISOString()]], ["duplicates", [at(30), at(30)]], ["junk", ["tomorrow"]], ["not an array", "x"]
  ])("rejects %s", (_n, v) => { expect(parseSlots(v, NOW).ok).toBe(false); });
});

function repo(o: Partial<BookingRepository> = {}): BookingRepository {
  const none = async () => { throw new Error("unexpected call"); };
  return {
    bookableListing: async () => ({ id: LID, title: "Home", jurisdiction: "NSW" }),
    buyerVerification: async () => ({ emailVerified: true, phoneVerified: true, idVerified: true }),
    insertBooking: async () => true, bookingsForBuyer: none, cancelBooking: none, profile: async () => undefined, upsertProfile: async () => true,
    openRequests: none, bookingsForInspector: none, accept: none, pass: none, listProfiles: none, reviewProfile: async () => true, listBookings: none, ...o
  } as BookingRepository;
}

describe("requestInspection", () => {
  const buyer = { userId: UID, userType: "buyer" as const };
  it("needs a verified buyer", async () => {
    const r = await requestInspection(repo({ buyerVerification: async () => ({ emailVerified: true, phoneVerified: false, idVerified: false }) }), buyer, LID, { slots: [at(30)] }, ids);
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
  });
  it("creates a request, and a repeat request is a conflict", async () => {
    expect(await requestInspection(repo(), buyer, LID, { slots: [at(30)], notes: " roof please " }, ids)).toMatchObject({ ok: true });
    expect(await requestInspection(repo({ insertBooking: async () => false }), buyer, LID, { slots: [at(30)] }, ids)).toMatchObject({ ok: false, code: "conflict" });
  });
  it("hides unknown, unpublished and own listings behind one not-found", async () => {
    expect(await requestInspection(repo({ bookableListing: async () => undefined }), buyer, LID, { slots: [at(30)] }, ids)).toMatchObject({ code: "not_found" });
    expect(await requestInspection(repo(), buyer, "nope", { slots: [at(30)] }, ids)).toMatchObject({ code: "not_found" });
  });
  it("rejects overlong notes", async () => {
    expect(await requestInspection(repo(), buyer, LID, { slots: [at(30)], notes: "x".repeat(1001) }, ids)).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("applyAsInspector and reviewInspector", () => {
  it("only vendor or agent accounts apply, with valid states", async () => {
    const v = { userId: UID, userType: "vendor" as const };
    expect(await applyAsInspector(repo(), { userId: UID, userType: "buyer" }, {}, ids)).toMatchObject({ code: "forbidden" });
    expect(await applyAsInspector(repo(), v, { businessName: "Sound Checks", jurisdictions: ["XX"] }, ids)).toMatchObject({ code: "invalid" });
    expect(await applyAsInspector(repo(), v, { businessName: "", jurisdictions: ["NSW"] }, ids)).toMatchObject({ code: "invalid" });
    expect(await applyAsInspector(repo(), v, { businessName: "Sound Checks", jurisdictions: ["NSW", "NSW"] }, ids)).toMatchObject({ ok: true });
  });
  it("refuses edits once reviewed", async () => {
    const approved = { userId: UID, businessName: "x", licenceRef: "", jurisdictions: ["NSW" as const], status: "approved" as const, reviewNote: "", createdAt: NOW };
    expect(await applyAsInspector(repo({ profile: async () => approved }), { userId: UID, userType: "agent" }, { businessName: "y", jurisdictions: ["VIC"] }, ids)).toMatchObject({ code: "conflict" });
  });
  it("a rejection or suspension needs a reason", async () => {
    expect(await reviewInspector(repo(), UID, UID, "rejected", "", ids)).toMatchObject({ code: "invalid" });
    expect(await reviewInspector(repo(), UID, UID, "rejected", "Licence not found", ids)).toMatchObject({ ok: true });
    expect(await reviewInspector(repo(), UID, UID, "approved", undefined, ids)).toMatchObject({ ok: true });
    expect(await reviewInspector(repo(), UID, UID, "deleted", "", ids)).toMatchObject({ code: "invalid" });
  });
});

import { describe, expect, it } from "vitest";
import { autoDispatch, parseContractorProfile, pickContractor, type ContractorCandidate, type ContractorProfileStore } from "../src/domain/contractor-dispatch";
import { createInMemoryAssignmentRepository } from "../src/domain/assignment-service";

const U = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const cand = (n: number, suburbs: string[], postcodes: string[] = [], openJobs = 0, acceptingNew = true): ContractorCandidate =>
  ({ userId: U(n), displayName: `Pro ${n}`, openJobs, profile: { acceptingNew, serviceSuburbs: suburbs, servicePostcodes: postcodes } });

describe("pickContractor", () => {
  it("prefers suburb over postcode, then fewer open jobs, and skips closed books", () => {
    const list = [cand(1, [], ["4064"]), cand(2, ["Paddington"], ["4064"], 3), cand(3, ["paddington"], [], 1), cand(4, ["Paddington"], [], 0, false)];
    expect(pickContractor({ suburb: "Paddington", postcode: "4064" }, list)?.userId).toBe(U(2));
    expect(pickContractor({ suburb: "Paddington" }, list)?.userId).toBe(U(3));
    expect(pickContractor({ suburb: "Toowong", postcode: "4066" }, list)).toBeUndefined();
    expect(pickContractor({ suburb: "Paddington" }, list, U(3))?.userId).toBe(U(2));
  });
});

describe("autoDispatch", () => {
  const ids = () => { let i = 100; return { newId: () => `00000000-0000-4000-8000-${String(++i).padStart(12, "0")}`, now: () => "2026-11-19T00:00:00.000Z" }; };
  const owner = { userId: U(9), userType: "owner" } as never;
  it("invites only matching photographers and leaves the rest to the owner", async () => {
    const repo = createInMemoryAssignmentRepository({ listings: [{ id: U(8), ownerUserId: U(9), jurisdiction: "QLD" }], users: [{ id: U(1), userType: "vendor", status: "active", displayName: "Pro 1" }, { id: U(9), userType: "owner", status: "active", displayName: "Owner" }] } as never);
    const store: ContractorProfileStore = { candidates: async k => (k === "photographer" ? [cand(1, ["Paddington"])] : []), get: async () => undefined, save: async () => undefined };
    const r = await autoDispatch(repo, store, owner, U(8), { suburb: "Paddington" }, ids());
    expect(r).toEqual({ ok: true, value: [{ kind: "photographer", result: "invited", name: "Pro 1" }, { kind: "inspector", result: "none_nearby" }] });
    const again = await autoDispatch(repo, store, owner, U(8), { suburb: "Paddington" }, ids());
    expect(again.ok && again.value[0]).toEqual({ kind: "photographer", result: "already" });
  });
});

describe("parseContractorProfile", () => {
  it("validates kind and postcodes", () => {
    expect(parseContractorProfile({ kind: "inspector", servicePostcodes: ["4064"], serviceSuburbs: ["Paddington"] }).ok).toBe(true);
    expect(parseContractorProfile({ kind: "solicitor" }).ok).toBe(false);
    expect(parseContractorProfile({ kind: "inspector", servicePostcodes: ["40"] }).ok).toBe(false);
  });
});

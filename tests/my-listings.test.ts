import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDraft, createInMemoryListingRepository, listMyListings,
  type Actor, type DraftInput, type ListingServiceDeps
} from "../src/domain/listing-service";

const state = vi.hoisted(() => ({ actor: null as Actor | null, deps: null as ListingServiceDeps | null }));

vi.mock("../src/server/context", () => ({
  getActor: () => state.actor,
  getDeps: () => state.deps
}));

import { GET as mineRoute } from "../app/api/listings/mine/route";

const owner: Actor = { userId: "owner-1", userType: "owner" };
const other: Actor = { userId: "owner-2", userType: "owner" };
const agent: Actor = { userId: "agent-1", userType: "agent" };
const vendor = { userId: "vendor-1", userType: "vendor" } as unknown as Actor;
const input: DraftInput = {
  title: "Family home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD",
  transactionType: "sale", useClass: "residential", propertyType: "house"
};

let n: number;

beforeEach(() => {
  n = 0;
  state.actor = null;
  state.deps = {
    repo: createInMemoryListingRepository(),
    appendAudit: async () => {},
    now: () => `2026-10-24T00:00:${String(n).padStart(2, "0")}.000Z`,
    newId: () => `id-${++n}`,
    requiredDisclosures: () => []
  };
});

const get = (query = "") => mineRoute(new Request(`http://test/api/listings/mine${query}`));

describe("listMyListings", () => {
  it("returns only the actor's listings, newest first", async () => {
    const first = await createDraft(state.deps!, owner, { ...input, title: "First" });
    await createDraft(state.deps!, other, { ...input, title: "Not mine" });
    const last = await createDraft(state.deps!, owner, { ...input, title: "Last" });
    const mine = await listMyListings(state.deps!, owner);
    expect(mine.map(l => l.id)).toEqual([last.id, first.id]);
  });
  it("returns an empty list for a user with no listings", async () => {
    await createDraft(state.deps!, owner, input);
    expect(await listMyListings(state.deps!, other)).toEqual([]);
  });
});

describe("GET /api/listings/mine", () => {
  it("returns 401 when signed out", async () => {
    expect((await get()).status).toBe(401);
  });
  it("returns 403 for agents and other roles", async () => {
    for (const a of [agent, vendor]) {
      state.actor = a;
      expect((await get()).status).toBe(403);
    }
  });
  it("returns 200 with the owner's own listings only", async () => {
    const mine = await createDraft(state.deps!, owner, { ...input, title: "Mine" });
    await createDraft(state.deps!, other, { ...input, title: "Theirs" });
    state.actor = owner;
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { listings: { id: string }[] };
    expect(body.listings.map(l => l.id)).toEqual([mine.id]);
  });
  it("ignores an owner id supplied in the query string", async () => {
    await createDraft(state.deps!, other, { ...input, title: "Theirs" });
    state.actor = owner;
    const body = (await (await get("?ownerUserId=owner-2&owner=owner-2")).json()) as { listings: unknown[] };
    expect(body.listings).toEqual([]);
  });
});

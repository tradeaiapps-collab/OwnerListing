import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDraft, createInMemoryListingRepository,
  type Actor, type DraftInput, type ListingServiceDeps
} from "../src/domain/listing-service";

const state = vi.hoisted(() => ({ actor: null as Actor | null, deps: null as ListingServiceDeps | null }));

vi.mock("../src/server/context", () => ({
  getActor: () => state.actor,
  getDeps: () => state.deps
}));

import { GET as searchRoute, POST as createRoute } from "../app/api/listings/route";
import { POST as publishRoute } from "../app/api/listings/[id]/publish/route";
import { GET as getRoute, PATCH as patchRoute } from "../app/api/listings/[id]/route";
process.env["APP_URL"] = "http://test";


const owner: Actor = { userId: "owner-1", userType: "owner" };
const agent: Actor = { userId: "agent-1", userType: "agent" };
const vendor = { userId: "vendor-1", userType: "vendor" } as unknown as Actor;
const input: DraftInput = {
  title: "Family home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD",
  transactionType: "sale", useClass: "residential", propertyType: "house"
};

let n: number;

let termsOk = true;
beforeEach(() => {
  termsOk = true;
  n = 0;
  state.actor = null;
  state.deps = {
    repo: createInMemoryListingRepository(),
    appendAudit: async () => {},
    now: () => "2026-10-24T00:00:00.000Z",
    newId: () => `id-${++n}`,
    requiredDisclosures: () => [],
    termsCurrentFor: async () => termsOk
  };
});

const post = (url: string, body?: unknown) =>
  new Request(`http://test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://test" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

describe("POST /api/listings (create)", () => {
  it("returns 401 when signed out", async () => {
    expect((await createRoute(post("/api/listings", input))).status).toBe(401);
  });
  it("returns 403 for agents and other roles", async () => {
    for (const a of [agent, vendor]) {
      state.actor = a;
      expect((await createRoute(post("/api/listings", input))).status).toBe(403);
    }
  });
  it("returns 403 and creates no draft until the owner has accepted the current terms", async () => {
    state.actor = owner;
    termsOk = false;
    expect((await createRoute(post("/api/listings", input))).status).toBe(403);
    delete (state.deps as { termsCurrentFor?: unknown }).termsCurrentFor; // gate not wired: fails closed
    termsOk = true;
    expect((await createRoute(post("/api/listings", input))).status).toBe(403);
  });
  it("returns 400 for an owner with an invalid body", async () => {
    state.actor = owner;
    expect((await createRoute(post("/api/listings", { title: "" }))).status).toBe(400);
  });
  it("returns 201 for an owner with a valid body", async () => {
    state.actor = owner;
    expect((await createRoute(post("/api/listings", input))).status).toBe(201);
  });
});

describe("POST /api/listings/[id]/publish", () => {
  const call = (id: string, query = "?dryRun=1") =>
    publishRoute(post(`/api/listings/${id}/publish${query}`), { params: Promise.resolve({ id }) });

  it("returns 401 when signed out", async () => {
    expect((await call("x")).status).toBe(401);
  });
  it("returns 403 for roles other than owner and agent", async () => {
    state.actor = vendor;
    expect((await call("x")).status).toBe(403);
  });
  it("returns 404 for an agent with no appointment on the listing", async () => {
    const draft = await createDraft(state.deps!, owner, input);
    state.actor = agent;
    expect((await call(draft.id)).status).toBe(404);
  });
  it("returns 404 for a different owner", async () => {
    const draft = await createDraft(state.deps!, owner, input);
    state.actor = { userId: "owner-2", userType: "owner" };
    expect((await call(draft.id)).status).toBe(404);
  });
  it("refuses a real publish without a recent second-factor check (403 mfa_required), leaving the draft as it was", async () => {
    const draft = await createDraft(state.deps!, owner, input);
    state.actor = owner;
    const res = await call(draft.id, "");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("mfa_required");
    expect((await state.deps!.repo.get(draft.id))?.listing.status).toBe("draft");
  });
  it("returns 200 for the owner's dry run, without publishing", async () => {
    const draft = await createDraft(state.deps!, owner, input);
    state.actor = owner;
    expect((await call(draft.id)).status).toBe(200);
    expect((await state.deps!.repo.get(draft.id))?.listing.status).toBe("draft");
  });
});

describe("PATCH /api/listings/[id] (edit draft)", () => {
  const patch = (id: string, body: unknown) =>
    patchRoute(
      new Request(`http://test/api/listings/${id}`, { method: "PATCH", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ id }) }
    );

  it("returns 401 when signed out", async () => {
    expect((await patch("x", { title: "New" })).status).toBe(401);
  });
  it("returns 400 for an empty or invalid patch", async () => {
    const draft = await createDraft(state.deps!, owner, input);
    state.actor = owner;
    expect((await patch(draft.id, {})).status).toBe(400);
    expect((await patch(draft.id, { jurisdiction: "ZZ" })).status).toBe(400);
  });
  it("returns 404 for a different user", async () => {
    const draft = await createDraft(state.deps!, owner, input);
    state.actor = { userId: "owner-2", userType: "owner" };
    expect((await patch(draft.id, { title: "Hijack" })).status).toBe(404);
  });
  it("returns 200 and saves the owner's changes", async () => {
    const draft = await createDraft(state.deps!, owner, input);
    state.actor = owner;
    expect((await patch(draft.id, { title: "Renamed", transactionType: "rent" })).status).toBe(200);
    const saved = (await state.deps!.repo.get(draft.id))?.listing;
    expect(saved?.title).toBe("Renamed");
    expect(saved?.transactionType).toBe("rent");
  });
  it("returns 409 once the listing is no longer a draft", async () => {
    const draft = await createDraft(state.deps!, owner, input);
    const rec = (await state.deps!.repo.get(draft.id))!;
    await state.deps!.repo.save({ ...rec, listing: { ...rec.listing, status: "published" } });
    state.actor = owner;
    expect((await patch(draft.id, { title: "Late" })).status).toBe(409);
  });
  it("GET returns a draft to its owner and 404 to anyone else", async () => {
    const draft = await createDraft(state.deps!, owner, input);
    const get = () => getRoute(new Request(`http://test/api/listings/${draft.id}`), { params: Promise.resolve({ id: draft.id }) });
    state.actor = owner;
    expect((await get()).status).toBe(200);
    state.actor = null;
    expect((await get()).status).toBe(404);
  });
});

describe("GET /api/listings/[id] (owner-only bond pathway)", () => {
  const rental: DraftInput = { ...input, transactionType: "rent" };
  const get = (id: string) => getRoute(new Request(`http://test/api/listings/${id}`), { params: Promise.resolve({ id }) });
  const saveWithBond = async (publish: boolean) => {
    const draft = await createDraft(state.deps!, owner, rental);
    const rec = (await state.deps!.repo.get(draft.id))!;
    await state.deps!.repo.save({
      ...rec,
      listing: publish ? { ...rec.listing, status: "published" } : rec.listing,
      rentalBondPathway: "solicitor_trust"
    });
    return draft.id;
  };

  it("returns the saved bond pathway to the owner", async () => {
    const id = await saveWithBond(false);
    state.actor = owner;
    const body = await (await get(id)).json();
    expect(body.rentalBondPathway).toBe("solicitor_trust");
  });
  it("omits the field when no bond pathway has been saved yet", async () => {
    const draft = await createDraft(state.deps!, owner, rental);
    state.actor = owner;
    expect(Object.keys(await (await get(draft.id)).json())).toEqual(["listing", "isOwner"]);
  });
  it("never returns it to another user or a signed-out visitor, even on a published listing", async () => {
    const id = await saveWithBond(true);
    for (const a of [null, { userId: "owner-2", userType: "owner" } as Actor, agent]) {
      state.actor = a;
      const res = await get(id);
      expect(res.status).toBe(200);
      expect(Object.keys(await res.json())).toEqual(["listing", "isOwner"]);
    }
  });
});

describe("public listing responses never expose internal ownership fields", () => {
  const publishDirect = async () => {
    const draft = await createDraft(state.deps!, owner, input);
    const rec = (await state.deps!.repo.get(draft.id))!;
    await state.deps!.repo.save({ ...rec, listing: { ...rec.listing, status: "published" } });
    return draft.id;
  };
  const get = (id: string) => getRoute(new Request(`http://test/api/listings/${id}`), { params: Promise.resolve({ id }) });

  it("GET omits ownerUserId and ownerUserType for signed-out visitors and other users, with isOwner false", async () => {
    const id = await publishDirect();
    for (const a of [null, { userId: "owner-2", userType: "owner" } as Actor, agent]) {
      state.actor = a;
      const body = await (await get(id)).json();
      expect(body.isOwner).toBe(false);
      expect(body.listing).not.toHaveProperty("ownerUserId");
      expect(body.listing).not.toHaveProperty("ownerUserType");
      expect(JSON.stringify(body)).not.toContain("owner-1");
    }
  });
  it("GET gives the owner isOwner true and still no ownerUserId", async () => {
    const id = await publishDirect();
    state.actor = owner;
    const body = await (await get(id)).json();
    expect(body.isOwner).toBe(true);
    expect(body.listing).not.toHaveProperty("ownerUserId");
    expect(body.listing.title).toBe("Family home");
  });
  it("GET still returns the owner-only bond pathway alongside isOwner", async () => {
    const draft = await createDraft(state.deps!, owner, { ...input, transactionType: "rent" });
    const rec = (await state.deps!.repo.get(draft.id))!;
    await state.deps!.repo.save({ ...rec, rentalBondPathway: "solicitor_trust" });
    state.actor = owner;
    const body = await (await get(draft.id)).json();
    expect(body.isOwner).toBe(true);
    expect(body.rentalBondPathway).toBe("solicitor_trust");
  });
  it("search results omit ownerUserId and ownerUserType", async () => {
    await publishDirect();
    state.actor = null;
    const res = await searchRoute(new Request("http://test/api/listings"));
    const body = await res.json();
    expect(body.listings).toHaveLength(1);
    expect(body.listings[0]).not.toHaveProperty("ownerUserId");
    expect(body.listings[0]).not.toHaveProperty("ownerUserType");
    expect(JSON.stringify(body)).not.toContain("owner-1");
  });
});

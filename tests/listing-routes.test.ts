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

import { POST as createRoute } from "../app/api/listings/route";
import { POST as publishRoute } from "../app/api/listings/[id]/publish/route";

const owner: Actor = { userId: "owner-1", userType: "owner" };
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
    now: () => "2026-10-24T00:00:00.000Z",
    newId: () => `id-${++n}`,
    requiredDisclosures: () => []
  };
});

const post = (url: string, body?: unknown) =>
  new Request(`http://test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
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
  it("returns 200 for the owner's dry run, without publishing", async () => {
    const draft = await createDraft(state.deps!, owner, input);
    state.actor = owner;
    expect((await call(draft.id)).status).toBe(200);
    expect((await state.deps!.repo.get(draft.id))?.listing.status).toBe("draft");
  });
});

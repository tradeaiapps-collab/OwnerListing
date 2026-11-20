import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/domain/listing-service";
import { LISTING, U, card, memoryMarket } from "./helpers/market-memory";

const state = vi.hoisted(() => ({ actor: null as Actor | null, m: null as ReturnType<typeof import("./helpers/market-memory").memoryMarket> | null }));
vi.mock("../src/server/context", () => ({ getActor: () => state.actor, getDb: () => ({}) }));
vi.mock("../src/server/assignment-db", () => ({ getAssignmentRepo: () => state.m!.assignments, assignmentIds: { newId: () => state.m!.ids.newId(), now: () => state.m!.ids.now() } }));
vi.mock("../src/server/contractor-market-db", () => ({ createPgMarketStore: () => state.m!.store }));
vi.mock("../src/server/job-notify", () => ({ makeJobNotify: () => state.m!.notify }));

import * as bookRoute from "../app/api/listings/[id]/jobs/route";
import * as jobRoute from "../app/api/jobs/[id]/route";
import * as reviewRoute from "../app/api/jobs/[id]/review/route";
import * as listRoute from "../app/api/jobs/route";
process.env["APP_URL"] = "http://test";

const owner: Actor = { userId: U(1), userType: "owner" };
const pat: Actor = { userId: U(2), userType: "vendor" };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) => new Request("http://test/x", { method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(body) });

describe("job routes", () => {
  beforeEach(() => { state.m = memoryMarket({ cards: [card(2)] }); state.actor = owner; });

  it("returns 401 signed out on every route", async () => {
    state.actor = null;
    expect((await bookRoute.POST(post({}), ctx(LISTING))).status).toBe(401);
    expect((await jobRoute.POST(post({}), ctx(U(7)))).status).toBe(401);
    expect((await jobRoute.GET(new Request("http://test/x"), ctx(U(7)))).status).toBe(401);
    expect((await reviewRoute.POST(post({}), ctx(U(7)))).status).toBe(401);
    expect((await listRoute.GET(new Request("http://test/x"))).status).toBe(401);
  });
  it("books, lets only the contractor accept, and lists the job for both sides", async () => {
    const booked = await bookRoute.POST(post({ kind: "photographer", contractorNo: 2001 }), ctx(LISTING));
    expect(booked.status).toBe(201);
    const { job } = await booked.json();
    expect(job.jobNumber).toBe(5001);
    expect((await jobRoute.POST(post({ action: "accept" }), ctx(job.id))).status).toBe(403);
    state.actor = pat;
    expect((await jobRoute.POST(post({ action: "accept" }), ctx(job.id))).status).toBe(200);
    const mine = await (await listRoute.GET(new Request("http://test/x"))).json();
    expect(mine.jobs).toHaveLength(1);
    expect(mine.jobs[0]).toMatchObject({ role: "contractor", status: "approved" });
  });
  it("hides a job from a stranger and refuses a review before completion", async () => {
    const { job } = await (await bookRoute.POST(post({ kind: "photographer", contractorNo: 2001 }), ctx(LISTING))).json();
    state.actor = { userId: U(3), userType: "vendor" };
    expect((await jobRoute.GET(new Request("http://test/x"), ctx(job.id))).status).toBe(404);
    state.actor = owner;
    expect((await reviewRoute.POST(post({ rating: 5 }), ctx(job.id))).status).toBe(409);
  });
});

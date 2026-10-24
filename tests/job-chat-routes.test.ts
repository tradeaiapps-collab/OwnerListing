import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobAssignment } from "../src/domain/job-chat";
import { createInMemoryChatRepository, type ChatRepository } from "../src/domain/job-chat-service";
import type { Actor } from "../src/domain/listing-service";

const state = vi.hoisted(() => ({ actor: null as Actor | null, repo: null as ChatRepository | null }));

vi.mock("../src/server/context", () => ({ getActor: () => state.actor, getDb: () => ({}) }));
vi.mock("../src/server/job-chat-db", () => {
  let n = 0;
  return {
    getChatRepo: () => state.repo,
    chatIds: { newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`, now: () => "2026-10-24T00:00:00.000Z" }
  };
});

import * as route from "../app/api/jobs/[id]/messages/route";

const A = "11111111-1111-4111-8111-111111111111";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const contractor: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "agent" };
const stranger: Actor = { userId: "44444444-4444-4444-8444-444444444444", userType: "owner" };

const assignment = (status: JobAssignment["status"]): JobAssignment => ({
  id: A, listingId: "55555555-5555-4555-8555-555555555555",
  ownerUserId: owner.userId, contractorUserId: contractor.userId, kind: "photographer", status
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id = A) => route.GET(new Request(`http://test/api/jobs/${id}/messages`), ctx(id));
const post = (body: unknown, id = A) =>
  route.POST(new Request(`http://test/api/jobs/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ctx(id));

beforeEach(() => {
  state.actor = null;
  state.repo = createInMemoryChatRepository([assignment("approved"), { ...assignment("completed"), id: "88888888-8888-4888-8888-888888888888" }]);
});

describe("/api/jobs/[id]/messages", () => {
  it("exports only GET and POST, so edit and delete do not exist", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "POST"]);
  });
  it("returns 401 when signed out", async () => {
    expect((await get()).status).toBe(401);
    expect((await post({ body: "hi" })).status).toBe(401);
  });
  it("returns 404 to a stranger on read and post", async () => {
    state.actor = stranger;
    expect((await get()).status).toBe(404);
    expect((await post({ body: "hi" })).status).toBe(404);
  });
  it("returns 404 for a malformed id", async () => {
    state.actor = owner;
    expect((await get("nope")).status).toBe(404);
  });
  it("lets the owner and contractor exchange messages", async () => {
    state.actor = owner;
    const sent = await post({ body: "When can you shoot?" });
    expect(sent.status).toBe(201);
    state.actor = contractor;
    expect((await post({ body: "Friday" })).status).toBe(201);
    const read = await get();
    expect(read.status).toBe(200);
    expect(((await read.json()) as { messages: { body: string }[] }).messages.map(m => m.body)).toEqual(["When can you shoot?", "Friday"]);
  });
  it("returns 400 for an empty body and for attachments", async () => {
    state.actor = owner;
    expect((await post({ body: " " })).status).toBe(400);
    expect((await post({ body: "x", attachmentRefs: ["f"] })).status).toBe(400);
  });
  it("returns 409 on a completed job but keeps it readable", async () => {
    state.actor = owner;
    const done = "88888888-8888-4888-8888-888888888888";
    expect((await post({ body: "late" }, done)).status).toBe(409);
    expect((await get(done)).status).toBe(200);
  });
});

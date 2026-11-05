import { describe, expect, it } from "vitest";
import { ApiError } from "../mobile/src/lib/api-client";
import { awaitingDecision, inspectionActions, pendingActions, stageLine } from "../mobile/src/lib/agent-today";
import { hrefFor, routeForLink } from "../mobile/src/lib/links";
import { cachedLoad, createCache, createOutbox, sendOrQueue, type KeyValueStore } from "../mobile/src/lib/offline";

const memory = () => {
  const m = new Map<string, string>();
  const s: KeyValueStore = { get: async k => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, remove: async k => { m.delete(k); }, keys: async () => [...m.keys()] };
  return { s, m };
};
const U = "11111111-1111-4111-8111-111111111111";
const SETTLE = `/api/settlements/${U}`;
const MSG = `/api/agent-appointments/${U}/messages`;
const offline = () => new TypeError("Network request failed");
let n = 0;
const id = () => `id${++n}`;

describe("saved copies", () => {
  it("returns fresh data and saves it, then falls back to the saved copy offline", async () => {
    const { s } = memory();
    const cache = createCache(s, "u1", () => new Date("2026-11-05T01:00:00Z"));
    expect(await cachedLoad(cache, "k", async () => [1, 2])).toEqual({ data: [1, 2], stale: false, savedAt: null });
    expect(await cachedLoad(cache, "k", async () => { throw offline(); })).toEqual({ data: [1, 2], stale: true, savedAt: "2026-11-05T01:00:00.000Z" });
  });
  it("shows a real server error instead of old data, and rethrows offline with nothing saved", async () => {
    const cache = createCache(memory().s, "u1");
    await cache.write("k", "old");
    await expect(cachedLoad(cache, "k", async () => { throw new ApiError(403, "No."); })).rejects.toThrow("No.");
    await expect(cachedLoad(cache, "other", async () => { throw offline(); })).rejects.toThrow("Network");
  });
  it("keeps people apart and clearAll wipes every saved copy but not the outbox", async () => {
    const { s, m } = memory();
    await createCache(s, "a").write("k", 1);
    expect(await createCache(s, "b").read("k")).toBeNull();
    await createOutbox(s, "a", id).add({ kind: "message", path: MSG, body: { body: "hi" }, label: "m" });
    await createCache(s, "a").clearAll();
    expect([...m.keys()]).toEqual(["ol.outbox.a"]);
  });
  it("ignores corrupt saved data", async () => {
    const { s } = memory();
    await s.set("ol.cache.a.k", "{not json");
    expect(await createCache(s, "a").read("k")).toBeNull();
  });
});

describe("outbox", () => {
  it("only accepts the three allowed action paths", async () => {
    const ob = createOutbox(memory().s, "a", id);
    await expect(ob.add({ kind: "message", path: "/api/staff/users", body: {}, label: "x" })).rejects.toThrow();
    await expect(ob.add({ kind: "settlement", path: `${SETTLE}/../../x`, body: {}, label: "x" })).rejects.toThrow();
    await ob.add({ kind: "inspection", path: "/api/agent/open-inspections", body: { ids: [U], action: "complete" }, label: "x" });
    expect(await ob.list()).toHaveLength(1);
  });
  it("sends in order, removes what was sent, and survives a restart (new outbox on the same storage)", async () => {
    const { s } = memory();
    const ob = createOutbox(s, "a", id);
    await ob.add({ kind: "message", path: MSG, body: { body: "1" }, label: "1" });
    await ob.add({ kind: "message", path: MSG, body: { body: "2" }, label: "2" });
    const sent: unknown[] = [];
    const r = await createOutbox(s, "a", id).flush({ post: async (_p: string, b?: unknown) => { sent.push(b); return {} as never; } });
    expect(sent).toEqual([{ body: "1" }, { body: "2" }]);
    expect(r).toMatchObject({ remaining: 0, rejected: [] });
    expect(await ob.list()).toEqual([]);
  });
  it("stops at the first connection or server failure and keeps the rest", async () => {
    const ob = createOutbox(memory().s, "a", id);
    for (const t of ["1", "2", "3"]) await ob.add({ kind: "message", path: MSG, body: { body: t }, label: t });
    let calls = 0;
    const r = await ob.flush({ post: async () => { calls++; if (calls === 2) throw offline(); return {} as never; } });
    expect(r.sent).toHaveLength(1);
    expect(r.remaining).toBe(2);
    expect((await ob.list()).map(a => a.label)).toEqual(["2", "3"]);
    const r2 = await ob.flush({ post: async () => { throw new ApiError(503, "down"); } });
    expect(r2.remaining).toBe(2);
  });
  it("drops an action the server refuses (4xx), reports it and carries on", async () => {
    const ob = createOutbox(memory().s, "a", id);
    await ob.add({ kind: "settlement", path: SETTLE, body: { a: 1 }, label: "bad" });
    await ob.add({ kind: "message", path: MSG, body: { body: "ok" }, label: "ok" });
    const r = await ob.flush({ post: async (p: string) => { if (p === SETTLE) throw new ApiError(403, "Not allowed."); return {} as never; } });
    expect(r.rejected.map(x => [x.action.label, x.reason])).toEqual([["bad", "Not allowed."]]);
    expect(r.sent).toHaveLength(1);
    expect(r.remaining).toBe(0);
  });
  it("429 and 408 are retried, and parallel flushes share one run", async () => {
    const ob = createOutbox(memory().s, "a", id);
    await ob.add({ kind: "message", path: MSG, body: {}, label: "1" });
    expect((await ob.flush({ post: async () => { throw new ApiError(429, "slow"); } })).remaining).toBe(1);
    let calls = 0;
    const api = { post: async () => { calls++; await Promise.resolve(); return {} as never; } };
    const [a, b] = await Promise.all([ob.flush(api), ob.flush(api)]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });
  it("one person's queue is never sent for another", async () => {
    const { s } = memory();
    await createOutbox(s, "a", id).add({ kind: "message", path: MSG, body: {}, label: "a" });
    expect(await createOutbox(s, "b", id).list()).toEqual([]);
  });
  it("caps the queue", async () => {
    const ob = createOutbox(memory().s, "a", id);
    for (let i = 0; i < 100; i++) await ob.add({ kind: "message", path: MSG, body: {}, label: String(i) });
    await expect(ob.add({ kind: "message", path: MSG, body: {}, label: "x" })).rejects.toThrow("Too many");
  });
  it("sendOrQueue sends when online, queues when offline, and shows real refusals", async () => {
    const ob = createOutbox(memory().s, "a", id);
    const a = { kind: "inspection" as const, path: "/api/agent/open-inspections", body: {}, label: "x" };
    expect(await sendOrQueue({ post: async () => ({}) as never }, ob, a)).toBe("sent");
    expect(await ob.list()).toHaveLength(0);
    expect(await sendOrQueue({ post: async () => { throw offline(); } }, ob, a)).toBe("queued");
    expect(await ob.list()).toHaveLength(1);
    await expect(sendOrQueue({ post: async () => { throw new ApiError(400, "Bad."); } }, ob, a)).rejects.toThrow("Bad.");
    expect(await ob.list()).toHaveLength(1);
  });
});

describe("what needs the agent today", () => {
  const now = new Date("2026-11-05T10:00:00Z");
  const st = (o: object) => ({ id: "s", listingTitle: "L", currentStage: "finance", completed: false, fellThrough: false, stuck: { stuck: false, days: 0, blocked: false }, nextTarget: null, ...o });
  it("counts offers waiting for a decision", () => {
    expect(awaitingDecision([{ id: "1", status: "submitted" }, { id: "2", status: "accepted" }, { id: "3", status: "buyer_countered" }])).toBe(2);
  });
  it("orders offers, then stuck settlements (longest first), then due soon, then finished inspections", () => {
    const r = pendingActions({
      now,
      offers: [{ listingId: "l1", title: "A", offers: [{ id: "o", status: "submitted" }] }, { listingId: "l2", title: "B", offers: [{ id: "o2", status: "rejected" }] }],
      settlements: [st({ id: "a", stuck: { stuck: true, days: 3, blocked: false } }), st({ id: "b", stuck: { stuck: true, days: 9, blocked: false } }), st({ id: "c", nextTarget: "2026-11-07" }), st({ id: "d", nextTarget: "2026-12-30" }), st({ id: "e", completed: true, stuck: { stuck: true, days: 50, blocked: false } })],
      bookings: [{ id: "x", title: "T", startsAt: "2026-11-05T07:00:00Z", endsAt: "2026-11-05T07:30:00Z", status: "booked", buyerName: "Sam" }, { id: "y", title: "T", startsAt: "2026-11-06T07:00:00Z", endsAt: "2026-11-06T07:30:00Z", status: "booked", buyerName: "Kim" }]
    });
    expect(r.map(p => p.key)).toEqual(["offer:l1", "settlement:b", "settlement:a", "due:c", "inspection:x"]);
  });
  it("offers actions by inspection state", () => {
    const b = { id: "x", title: "T", startsAt: "2026-11-05T11:00:00Z", endsAt: "2026-11-05T11:30:00Z", status: "booked", buyerName: "S" };
    expect(inspectionActions(b, now)).toEqual(["remind"]);
    expect(inspectionActions(b, new Date("2026-11-05T11:10:00Z"))).toEqual(["complete", "no_show"]);
    expect(inspectionActions({ ...b, status: "completed" }, now)).toEqual([]);
  });
  it("words a settlement's status", () => {
    expect(stageLine({ currentStage: "finance", completed: false, fellThrough: false, stuck: { stuck: true, days: 6, blocked: false } })).toBe("Stuck 6d · finance");
    expect(stageLine({ currentStage: "finance", completed: false, fellThrough: false, stuck: { stuck: true, days: 6, blocked: true } })).toBe("Blocked · finance");
    expect(stageLine({ currentStage: "settlement", completed: true, fellThrough: false, stuck: { stuck: false, days: 0, blocked: false } })).toBe("Settled");
  });
});

describe("push links into the agent screens", () => {
  it("routes offers, settlements, inspections and the owner's listings", () => {
    expect(hrefFor(routeForLink(`/listings/${U}/offers/${U}`))).toBe(`/listing-offers/${U}`);
    expect(hrefFor(routeForLink(`/settlements/${U}/messages`))).toBe(`/settlement/${U}`);
    expect(hrefFor(routeForLink("https://x.example/agent/inspections?a=1"))).toBe("/inspections");
    expect(hrefFor(routeForLink("/listings/mine"))).toBe("/today");
    expect(hrefFor(routeForLink("/settlements/not-an-id"))).toBe("/notifications");
  });
});

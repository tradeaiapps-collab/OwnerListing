import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientPortalRepository } from "../src/domain/client-portal";
import type { Actor } from "../src/domain/listing-service";

const state = vi.hoisted(() => ({ actor: null as Actor | null, repo: null as ClientPortalRepository | null }));
vi.mock("../src/server/context", () => ({ getActor: () => state.actor, getDb: () => ({}) }));
vi.mock("../src/server/client-portal-db", () => ({
  getClientPortalRepo: () => state.repo,
  portalIds: { newId: () => "22222222-2222-4222-8222-222222222222", now: () => "2026-11-05T00:00:00.000Z" }
}));
vi.mock("../src/server/enquiry-db", () => ({ getEnquiryDeps: () => ({}) }));
vi.mock("../src/domain/enquiry-service", () => ({ inbox: async () => [{ enquiry: { id: "e1", createdAt: "2026-11-01T00:00:00.000Z" }, listingTitle: "Cottage", role: "buyer", unread: 2 }] }));
vi.mock("../src/server/inspection-db", () => ({ getInspectionRepo: () => ({}) }));
vi.mock("../src/server/csrf", () => ({ csrfGuard: () => null }));

import * as portal from "../app/api/client/portal/route";
import * as docs from "../app/api/client/portal/documents/[kind]/[id]/route";
import * as bookings from "../app/api/client/portal/bookings/route";
import * as booking from "../app/api/client/portal/bookings/[id]/route";

const OFFER = "11111111-1111-4111-8111-111111111111";
const repo = (over: Partial<ClientPortalRepository> = {}): ClientPortalRepository => ({
  documentsFor: async () => [], offerFor: async () => undefined, bookingsFor: async () => [], createBooking: async () => "created", transitionBooking: async () => true, ...over
});
const get = (url: string) => new Request(`http://test${url}`);
const post = (url: string, body: unknown) => new Request(`http://test${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = <T extends object>(p: T) => ({ params: Promise.resolve(p) });

describe("client portal routes", () => {
  beforeEach(() => { state.actor = { userId: "b1", userType: "buyer" }; state.repo = repo(); });

  it("answers 401 to everyone signed out", async () => {
    state.actor = null;
    expect((await portal.GET(get("/api/client/portal"))).status).toBe(401);
    expect((await docs.GET(get("/x"), ctx({ kind: "offer", id: OFFER }))).status).toBe(401);
    expect((await bookings.POST(post("/b", {}))).status).toBe(401);
    expect((await booking.POST(post("/b", { action: "cancel" }), ctx({ id: OFFER }))).status).toBe(401);
  });

  it("returns documents, bookings and threads, uncached", async () => {
    const res = await portal.GET(get("/api/client/portal"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toMatchObject({ documents: [], bookings: [], threads: [{ id: "e1", unread: 2 }], role: "buyer" });
  });

  it("keeps vendors out", async () => {
    state.actor = { userId: "v", userType: "vendor" };
    expect((await portal.GET(get("/api/client/portal"))).status).toBe(403);
    expect((await docs.GET(get("/x"), ctx({ kind: "offer", id: OFFER }))).status).toBe(403);
  });

  it("downloads an offer as a PDF attachment, and gives 404 for someone else's offer or an unknown kind", async () => {
    state.repo = repo({ offerFor: async (u, id) => (u === "b1" && id === OFFER ? {
      id: OFFER, listingTitle: "Cottage", address: "1 Test St", priceCents: 1_000_000, depositCents: 100_000, settlementDays: 30, conditions: [], status: "submitted", submittedAt: "2026-11-01T00:00:00.000Z", viewer: "buyer", events: []
    } : undefined) });
    const ok = await docs.GET(get("/x"), ctx({ kind: "offer", id: OFFER }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect(ok.headers.get("content-disposition")).toContain("attachment");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await ok.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    state.actor = { userId: "someone-else", userType: "buyer" };
    expect((await docs.GET(get("/x"), ctx({ kind: "offer", id: OFFER }))).status).toBe(404);
    expect((await docs.GET(get("/x"), ctx({ kind: "signed", id: OFFER }))).status).toBe(404);
    expect((await docs.GET(get("/x"), ctx({ kind: "../etc", id: OFFER }))).status).toBe(404);
  });

  it("creates a booking (201) and rejects a bad request (400)", async () => {
    const good = { listingId: OFFER, kind: "viewing", startsAt: new Date(Date.parse("2026-11-05T00:00:00.000Z") + 7200_000).toISOString() };
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T00:00:00.000Z"));
    try {
      const ok = await bookings.POST(post("/b", good));
      expect(ok.status).toBe(201);
      expect(await ok.json()).toEqual({ booking: { id: "22222222-2222-4222-8222-222222222222" } });
      expect((await bookings.POST(post("/b", { ...good, kind: "tour" }))).status).toBe(400);
    } finally { vi.useRealTimers(); }
  });

  it("changes a booking, or answers 404 when it is not the caller's to change", async () => {
    expect((await booking.POST(post("/b", { action: "cancel" }), ctx({ id: OFFER }))).status).toBe(200);
    state.repo = repo({ transitionBooking: async () => false });
    expect((await booking.POST(post("/b", { action: "confirm" }), ctx({ id: OFFER }))).status).toBe(404);
    expect((await booking.POST(post("/b", { action: "nope" }), ctx({ id: OFFER }))).status).toBe(400);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ID_IMAGE_CONSENT_VERSION } from "../src/domain/id-image";
import type { IdSubmission } from "../src/domain/id-verification";
import type { Actor } from "../src/domain/listing-service";
import type { StaffActor } from "../src/domain/staff-access";
import type { IdImageDeps } from "../src/server/id-image";
import { RETENTION_SECRET, deps, jpegWithExif, memStorage, memStore } from "./helpers/id-image-fakes";

const state = vi.hoisted(() => ({
  actor: null as Actor | null, staff: null as StaffActor | null, deps: null as IdImageDeps | null,
  sub: null as object | null, saved: [] as unknown[], audits: [] as string[]
}));
vi.mock("../src/server/context", () => ({ getActor: () => state.actor, getStaff: async () => state.staff, getDb: () => ({ query: async () => ({ rows: [] }) }) }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_db: unknown, e: { eventType: string }) => { state.audits.push(e.eventType); } }));
vi.mock("../src/server/verification-context", () => ({ getIdImageDeps: () => state.deps, idImagesAvailable: () => state.deps !== null }));
vi.mock("../src/server/staff-admin-db", () => ({
  listIdQueue: async () => [], getIdSubmission: async () => state.sub,
  saveIdReview: async (_db: unknown, _b: unknown, after: unknown) => { state.saved.push(after); return true; }
}));
vi.mock("../src/server/id-image-db", () => ({ createPgIdImageStore: () => state.deps!.store }));

import * as upload from "../app/api/buyer/verification/id/images/route";
import * as claim from "../app/api/staff/id-review/[id]/claim/route";
import * as image from "../app/api/staff/id-review/[id]/image/[part]/route";
import * as decision from "../app/api/staff/id-review/[id]/decision/route";
import * as retention from "../app/api/internal/id-images/retention/route";

const BUYER: Actor = { userId: "b0000000-0000-4000-8000-000000000001", userType: "buyer" };
const comp: StaffActor = { id: "a0000000-0000-4000-8000-000000000001", role: "compliance" };
const comp2: StaffActor = { id: "a0000000-0000-4000-8000-000000000002", role: "super_admin" };
const support: StaffActor = { id: "a0000000-0000-4000-8000-000000000003", role: "support" };
const ORIGIN = "http://test";
process.env["APP_URL"] = ORIGIN;

function form(o: { consent?: boolean } = {}) {
  const fd = new FormData();
  fd.set("consent", o.consent === false ? "false" : "true"); fd.set("consentVersion", ID_IMAGE_CONSENT_VERSION);
  fd.set("documentKind", "drivers_licence"); fd.set("documentCountry", "AU"); fd.set("expiryDate", "2030-01-01"); fd.set("selfieSource", "camera");
  for (const p of ["front", "back", "selfie"]) fd.set(p, new Blob([jpegWithExif() as BlobPart], { type: "image/jpeg" }), "x.jpg");
  return fd;
}
async function uploadReq(o: { origin?: string; body?: BodyInit; contentType?: string } = {}) {
  const r = new Request(`${ORIGIN}/api/buyer/verification/id/images`, { method: "POST", body: o.body ?? form() });
  const headers = new Headers(r.headers);
  headers.set("origin", o.origin ?? ORIGIN);
  if (o.contentType) headers.set("content-type", o.contentType);
  const buf = await r.arrayBuffer();
  headers.set("content-length", String(buf.byteLength));
  return new Request(r.url, { method: "POST", headers, body: buf });
}
const staffPost = (route: { POST: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> }, id: string, body: unknown = {}, origin = ORIGIN) =>
  route.POST(new Request(`${ORIGIN}/x`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const view = (id: string, part: string) => image.GET(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ id, part }) });

let m: ReturnType<typeof memStore>;
let s: ReturnType<typeof memStorage>;
beforeEach(() => {
  const clock = { now: Date.now() };
  m = memStore(clock); s = memStorage();
  state.deps = deps({ clock, store: m.store, storage: s.port });
  state.actor = BUYER; state.staff = null; state.sub = null; state.saved = []; state.audits = [];
});
const pendingId = () => [...m.rows.keys()][0]!;

describe("buyer upload route", () => {
  it("csrf first, then sign-in, then buyers only, then multipart only", async () => {
    expect((await upload.POST(await uploadReq({ origin: "http://evil" }))).status).toBe(403);
    state.actor = null;
    expect((await upload.POST(await uploadReq())).status).toBe(401);
    for (const userType of ["owner", "agent", "admin", "vendor"]) {
      state.actor = { userId: "u", userType } as unknown as Actor;
      expect((await upload.POST(await uploadReq())).status).toBe(403);
    }
    state.actor = BUYER;
    expect((await upload.POST(await uploadReq({ body: "{}", contentType: "application/json" }))).status).toBe(415);
    expect(m.rows.size).toBe(0);
  });
  it("accepts a valid upload (201), then a double submit is 409", async () => {
    expect((await upload.POST(await uploadReq())).status).toBe(201);
    expect(m.rows.size).toBe(1);
    expect((await upload.POST(await uploadReq())).status).toBe(409);
    const st = await upload.GET(new Request(`${ORIGIN}/x`));
    expect(await st.json()).toEqual({ status: "pending" });
    expect(st.headers.get("cache-control")).toMatch(/no-store/);
  });
  it("missing key or storage: 503 'not available yet', nothing stored", async () => {
    state.deps = deps({ key: undefined, store: m.store, storage: s.port });
    const r = await upload.POST(await uploadReq());
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatch(/not available yet/);
    expect(s.objects.size).toBe(0);
  });
  it("without consent: 400 and nothing stored", async () => {
    expect((await upload.POST(await uploadReq({ body: form({ consent: false }) }))).status).toBe(400);
    expect(s.objects.size).toBe(0);
  });
});

describe("staff claim and image routes", () => {
  beforeEach(async () => { expect((await upload.POST(await uploadReq())).status).toBe(201); });
  it("no staff session is 401 (a buyer session is not staff); a role without identity.review is 403", async () => {
    expect((await view(pendingId(), "front")).status).toBe(401);
    expect((await staffPost(claim, pendingId())).status).toBe(401);
    state.staff = support;
    expect((await view(pendingId(), "front")).status).toBe(403);
    expect((await staffPost(claim, pendingId())).status).toBe(403);
    expect(m.views).toEqual([]);
  });
  it("claim needs same-origin; a non-assigned reviewer gets 404; the claim holder gets the image with no-store headers", async () => {
    state.staff = comp;
    expect((await staffPost(claim, pendingId(), {}, "http://evil")).status).toBe(403);
    expect((await view(pendingId(), "front")).status).toBe(404);
    expect((await staffPost(claim, pendingId())).status).toBe(200);
    expect(state.audits).toContain("staff.id_claimed");
    state.staff = comp2;
    expect((await staffPost(claim, pendingId())).status).toBe(409);
    expect((await view(pendingId(), "front")).status).toBe(404);
    state.staff = comp;
    const r = await view(pendingId(), "front");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("cache-control")).toMatch(/no-store/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toMatch(/sandbox/);
    const body = new Uint8Array(await r.arrayBuffer());
    expect([body[0], body[1]]).toEqual([0xff, 0xd8]);
    expect(m.views.map(v => v.staffId)).toEqual([comp.id]);
    expect((await view("not-a-uuid", "front")).status).toBe(404);
    expect((await view(pendingId(), "passport")).status).toBe(404);
  });
  it("a reviewer cannot claim or view their own submission (other user's submission rules)", async () => {
    m.rows.get(pendingId())!.userId = comp.id;
    state.staff = comp;
    expect((await staffPost(claim, pendingId())).status).toBe(403);
    expect((await view(pendingId(), "front")).status).toBe(404);
  });
  it("approval: blocked without claim and without viewing every image; allowed after; sets the manual method via saveIdReview", async () => {
    const id = pendingId();
    const sub: IdSubmission = { id, userId: BUYER.userId, documentKind: "drivers_licence", documentCountry: "AU", expiryDate: "2030-01-01", selfieCapturedInApp: true, submittedAt: "", status: "pending", approvals: [] };
    state.sub = sub;
    state.staff = comp;
    const body = { outcome: "approve", reason: "All four checks done carefully.", checklist: { documentLooksGenuine: true, photoMatchesSelfie: true, nameMatchesAccount: true, notExpired: true, officialStatusCheck: "done" } };
    let r = await staffPost(decision, id, body);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/Claim/);
    await staffPost(claim, id);
    await view(id, "front");
    r = await staffPost(decision, id, body);
    expect((await r.json()).error).toMatch(/every image/);
    await view(id, "back"); await view(id, "selfie");
    r = await staffPost(decision, id, body);
    expect(r.status).toBe(200);
    expect(state.saved).toEqual([expect.objectContaining({ status: "approved", approvals: [comp.id] })]);
  });
});

describe("retention route", () => {
  const call = (secret?: string) => retention.POST(new Request(`${ORIGIN}/x`, { method: "POST", headers: secret === undefined ? {} : { "x-cron-secret": secret } }));
  it("fails closed without the secret, refuses a wrong one and runs with the right one", async () => {
    delete process.env["ID_RETENTION_CRON_SECRET"];
    expect((await call(RETENTION_SECRET)).status).toBe(503);
    process.env["ID_RETENTION_CRON_SECRET"] = "short";
    expect((await call("short")).status).toBe(503);
    process.env["ID_RETENTION_CRON_SECRET"] = RETENTION_SECRET;
    expect((await call()).status).toBe(401);
    expect((await call("x".repeat(40))).status).toBe(401);
    delete process.env["STORAGE_DRIVER"];
    expect((await call(RETENTION_SECRET)).status).toBe(503);
    delete process.env["ID_RETENTION_CRON_SECRET"];
  });
});

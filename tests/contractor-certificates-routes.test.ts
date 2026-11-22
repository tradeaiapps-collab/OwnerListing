import { beforeEach, describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({
  actor: null as { userId: string; userType: string } | null,
  staff: null as { id: string; role: string } | null,
  ports: { storage: { configured: true, put: async () => undefined, get: async () => Uint8Array.from([37, 80, 68, 70]) }, scanner: { configured: true, scan: async () => "clean" } } as { storage: Record<string, unknown>; scanner: Record<string, unknown> },
  uploads: [] as unknown[][],
  file: undefined as { storageKey: string; contentType: string } | undefined,
  fileArgs: [] as unknown[][]
}));
vi.mock("../src/server/context", () => ({
  getActor: async () => S.actor, getStaff: async () => S.staff, getDb: () => ({ query: async () => ({ rows: [] }) }), getDeps: () => ({ now: () => "2026-11-21T00:00:00.000Z" }), getUploadPorts: () => S.ports
}));
vi.mock("../src/server/contractor-certificate-service", () => ({ uploadCertificate: async (...a: unknown[]) => { S.uploads.push(a); return { ok: true, value: { id: "c1" } }; } }));
vi.mock("../src/server/contractor-certificates-db", () => ({
  listCertificatesPg: async () => [], currentCertificatesPg: async () => new Map(), certDates: () => ({}),
  certificateFilePg: async (...a: unknown[]) => { S.fileArgs.push(a); return S.file; }
}));
vi.mock("../src/server/csrf", () => ({ csrfGuard: () => null }));

import * as certs from "../app/api/contractor/certificates/route";
import * as ownFile from "../app/api/contractor/certificates/[id]/file/route";
import * as staffFile from "../app/api/staff/contractors/certificates/[id]/file/route";

const FUTURE = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
const ID = "55555555-5555-4555-8555-555555555555";
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });
const pdf = () => new File([Uint8Array.from([37, 80, 68, 70, 45])], "../../etc/passwd.pdf", { type: "application/pdf" });
const post = (fields: Record<string, string | File>, len = "500") => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return new Request("http://test/x", { method: "POST", headers: { origin: "http://test", "content-length": len }, body: f });
};

beforeEach(() => { S.actor = null; S.staff = null; S.uploads = []; S.fileArgs = []; S.file = undefined; S.ports.storage["configured"] = true; });

describe("certificate upload route", () => {
  it("needs a signed-in contractor account", async () => {
    expect((await certs.POST(post({ file: pdf(), kind: "insurance", expiry: FUTURE }))).status).toBe(401);
    S.actor = { userId: ID, userType: "owner" };
    expect((await certs.POST(post({ file: pdf(), kind: "insurance", expiry: FUTURE }))).status).toBe(403);
    expect((await certs.GET(new Request("http://test/x"))).status).toBe(403);
    expect(S.uploads).toHaveLength(0);
  });
  it("passes the session's id, the checked kind and date, and the file bytes; the request body never names the user", async () => {
    S.actor = { userId: ID, userType: "vendor" };
    const res = await certs.POST(post({ file: pdf(), kind: "insurance", expiry: FUTURE, userId: "someone-else" }));
    expect(res.status).toBe(201);
    expect(S.uploads[0]!.slice(1, 5)).toEqual([ID, "insurance", FUTURE, expect.any(Uint8Array)]);
  });
  it("refuses a bad kind, a past date, a missing file, a huge body and an unconfigured store before reading anything", async () => {
    S.actor = { userId: ID, userType: "vendor" };
    expect((await certs.POST(post({ file: pdf(), kind: "passport", expiry: FUTURE }))).status).toBe(400);
    expect((await certs.POST(post({ file: pdf(), kind: "licence", expiry: "2001-01-01" }))).status).toBe(400);
    expect((await certs.POST(post({ kind: "licence", expiry: FUTURE }))).status).toBe(400);
    expect((await certs.POST(post({ file: pdf(), kind: "licence", expiry: FUTURE }, "99999999"))).status).toBe(413);
    S.ports.storage["configured"] = false;
    expect((await certs.POST(post({ file: pdf(), kind: "licence", expiry: FUTURE }))).status).toBe(503);
    expect(S.uploads).toHaveLength(0);
  });
});

describe("certificate file routes", () => {
  it("a contractor downloads only their own file, as an attachment that cannot run in our origin", async () => {
    S.actor = { userId: ID, userType: "vendor" };
    S.file = { storageKey: "cert/a/b", contentType: "application/pdf" };
    const res = await ownFile.GET(new Request("http://test/x"), ctx());
    expect(res.status).toBe(200);
    expect(S.fileArgs[0]!.slice(1)).toEqual([ID, ID]);
    expect(res.headers.get("content-disposition")).toBe("attachment");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    S.file = undefined;
    expect((await ownFile.GET(new Request("http://test/x"), ctx())).status).toBe(404);
    expect((await ownFile.GET(new Request("http://test/x"), ctx("not-a-uuid"))).status).toBe(404);
    S.actor = { userId: ID, userType: "buyer" };
    expect((await ownFile.GET(new Request("http://test/x"), ctx())).status).toBe(403);
  });
  it("staff need the licence check permission; without a session or permission nothing is read", async () => {
    S.file = { storageKey: "cert/a/b", contentType: "image/png" };
    expect((await staffFile.GET(new Request("http://test/x"), ctx())).status).toBe(401);
    S.staff = { id: ID, role: "support" };
    expect((await staffFile.GET(new Request("http://test/x"), ctx())).status).toBe(403);
    expect(S.fileArgs).toHaveLength(0);
    S.staff = { id: ID, role: "compliance" };
    const res = await staffFile.GET(new Request("http://test/x"), ctx());
    expect(res.status).toBe(200);
    expect(S.fileArgs[0]!.slice(1)).toEqual([ID, null]);
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ staff: null as null | { id: string; role: string }, saved: [] as string[][], removed: 0, tested: 0, saveOk: true }));
vi.mock("../src/server/context", () => ({ getDb: () => ({}), getStaff: async () => state.staff }));
vi.mock("../src/server/csrf", () => ({ csrfGuard: () => null }));
vi.mock("../src/adapters/feed-providers", () => ({ testDomainConnection: async () => { state.tested++; return { ok: false, error: "Domain refused the client id or secret." }; } }));
vi.mock("../src/server/provider-credentials-db", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/provider-credentials-db")>()),
  getCredentialStatus: async () => ({ source: "stored", clientIdHint: "••••1234", lastTestOk: null, canStore: true }),
  saveDomainCredentials: async (_d: unknown, _s: string, id: string, secret: string) => { state.saved.push([id, secret]); return state.saveOk ? { ok: true } : { ok: false, error: "Storing keys is not available: set PROVIDER_CREDENTIAL_KEY (or MFA_SECRET_KEY) on the server first." }; },
  deleteDomainCredentials: async () => { state.removed++; return true; },
  recordTestResult: async () => undefined,
  resolveDomainConfig: async () => ({ clientId: "x", clientSecret: "y", apiUrl: "", authUrl: "" })
}));
import { GET, POST } from "../app/api/staff/feeds/domain/route";

const post = (b: unknown) => POST(new Request("http://test/api/staff/feeds/domain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));

describe("staff Domain credentials route", () => {
  afterEach(() => { state.staff = null; state.saved = []; state.removed = 0; state.tested = 0; state.saveOk = true; });

  it("needs staff with feeds.manage for every method", async () => {
    expect((await GET(new Request("http://test/api/staff/feeds/domain"))).status).toBe(401);
    expect((await post({ action: "test" })).status).toBe(401);
    state.staff = { id: "s1", role: "support" };
    expect((await GET(new Request("http://test/api/staff/feeds/domain"))).status).toBe(403);
    expect((await post({ action: "disconnect" })).status).toBe(403);
    expect(state.removed + state.saved.length + state.tested).toBe(0);
  });

  it("saves, checks the keys right away, and never answers with the secret", async () => {
    state.staff = { id: "s1", role: "super_admin" };
    const r = await post({ action: "save", clientId: "id1234", clientSecret: "topsecret" });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain("topsecret");
    expect(JSON.parse(text)).toMatchObject({ test: { ok: false, error: "Domain refused the client id or secret." } });
    expect(state.saved).toEqual([["id1234", "topsecret"]]);
    expect(state.tested).toBe(1);
  });

  it("rejects bad input without storing, and says so when the server has no storage key", async () => {
    state.staff = { id: "s1", role: "super_admin" };
    expect((await post({ action: "save", clientId: "a b", clientSecret: "x" })).status).toBe(400);
    expect(state.saved).toHaveLength(0);
    state.saveOk = false;
    expect((await post({ action: "save", clientId: "a", clientSecret: "x" })).status).toBe(503);
    expect(state.tested).toBe(0);
  });

  it("tests, disconnects and refuses unknown actions", async () => {
    state.staff = { id: "s1", role: "super_admin" };
    expect((await post({ action: "test" })).status).toBe(200);
    expect(state.tested).toBe(1);
    expect((await post({ action: "disconnect" })).status).toBe(200);
    expect(state.removed).toBe(1);
    expect((await post({ action: "nope" })).status).toBe(400);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTeam, addMember } from "../src/domain/agency-team";
import type { Actor } from "../src/domain/listing-service";
import { createPgAgencyTeamRepository } from "../src/server/agency-team-db";
import { buildTenantSettings } from "../src/domain/white-label";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const state = vi.hoisted(() => ({ db: null as unknown, actor: null as null | { userId: string; userType: string }, staff: null as null | { id: string; role: string } }));
vi.mock("../src/server/context", () => ({ getActor: async () => state.actor, getDb: () => state.db, getStaff: async () => state.staff }));

import * as brandRoute from "../app/api/agency/white-label/route";
import * as domainsRoute from "../app/api/agency/white-label/domains/route";
import * as assetRoute from "../app/api/agency/white-label/asset/route";
import * as staffRoute from "../app/api/staff/white-label/route";
import * as tenantAsset from "../app/api/tenant/asset/[slot]/route";
import { clearTenantCache, requestHost, tenantForHost } from "../src/server/white-label";
import * as repo from "../src/server/white-label-db";

const brand = { name: "Harbour Realty", tagline: "Homes by the water", primary: "#7a3e00", secondary: "#10243f", footerText: "" };
const H = { "content-type": "application/json", origin: "http://test" };
const call = (fn: (r: Request) => Promise<Response>, method: string, body?: unknown, url = "http://test/x") =>
  fn(new Request(url, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
const png = () => {
  const b = Buffer.alloc(120);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
  b.writeUInt32BE(200, 16); b.writeUInt32BE(60, 20);
  return b.toString("base64");
};

describe.skipIf(!DATABASE_URL)("white-label on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); state.db = t.db; process.env["APP_URL"] = "http://test"; }, 60_000);
  afterAll(async () => { await t?.close(); });
  beforeEach(() => { clearTenantCache(); state.actor = null; state.staff = null; });
  const ids = { newId: () => randomUUID(), now: () => new Date().toISOString() };

  async function agency() {
    const teams = createPgAgencyTeamRepository(t.db);
    const bossId = await addUser(t.db, "agent");
    const boss = { userId: bossId, userType: "agent" } as Actor;
    const c = await createTeam(teams, boss, { name: "Harbour office", kind: "office" }, ids);
    if (!c.ok) throw new Error("team");
    const agentId = await addUser(t.db, "agent");
    const email = String((await t.db.query("SELECT email FROM app_user WHERE id = $1", [agentId])).rows[0]!["email"]);
    await addMember(teams, boss, c.value.id, { email, role: "agent" }, ids);
    return { teamId: c.value.id, boss: { userId: bossId, userType: "agent" }, agent: { userId: agentId, userType: "agent" } };
  }
  const staffId = () => addUser(t.db, "admin");
  const withDomain = async (a: Awaited<ReturnType<typeof agency>>, host: string) => {
    state.actor = a.boss;
    await call(brandRoute.PUT, "PUT", { teamId: a.teamId, ...brand });
    await call(domainsRoute.POST, "POST", { teamId: a.teamId, host });
    const tenant = (await repo.getTenantForTeam(t.db, a.teamId))!;
    await repo.markVerified(t.db, tenant.id, host, a.boss.userId);
    return tenant;
  };

  it("only a manager of the team can read or change the brand; others get 401/403/404", async () => {
    const a = await agency();
    const url = `http://test/x?teamId=${a.teamId}`;
    expect((await call(brandRoute.GET, "GET", undefined, url)).status).toBe(401);
    state.actor = a.agent;
    expect((await call(brandRoute.GET, "GET", undefined, url)).status).toBe(403);
    expect((await call(brandRoute.PUT, "PUT", { teamId: a.teamId, ...brand })).status).toBe(403);
    state.actor = { userId: await addUser(t.db, "agent"), userType: "agent" };
    expect((await call(brandRoute.GET, "GET", undefined, url)).status).toBe(404);
    expect((await call(brandRoute.GET, "GET", undefined, "http://test/x?teamId=nope")).status).toBe(400);
    state.actor = a.boss;
    expect((await call(brandRoute.PUT, "PUT", { teamId: a.teamId, ...brand }, "http://test/x")).status).toBe(200);
    const bad = await call(brandRoute.PUT, "PUT", { teamId: a.teamId, ...brand, primary: "red" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).errors.primary).toBeTruthy();
    const noOrigin = await brandRoute.PUT(new Request("http://test/x", { method: "PUT", headers: { "content-type": "application/json", origin: "http://evil.test" }, body: JSON.stringify({ teamId: a.teamId, ...brand }) }));
    expect(noOrigin.status).toBe(403);
  });

  it("a brand stays unused until the domain is verified AND staff activate it", async () => {
    const a = await agency();
    state.actor = a.boss;
    const put = await call(brandRoute.PUT, "PUT", { teamId: a.teamId, ...brand });
    expect((await put.json()).tenant).toMatchObject({ status: "draft", domains: [] });
    const add = await call(domainsRoute.POST, "POST", { teamId: a.teamId, host: "Homes.Harbour-A.com.au" });
    expect(add.status).toBe(201);
    const j = await add.json();
    expect(j.tenant.domains[0]).toMatchObject({ host: "homes.harbour-a.com.au", verified: false, dns: { type: "TXT", name: "_wl-verify.homes.harbour-a.com.au" } });
    // Not verified yet (no DNS in tests): the check fails and the host resolves to nothing.
    expect((await call(domainsRoute.PUT, "PUT", { teamId: a.teamId, host: "homes.harbour-a.com.au" })).status).toBe(422);
    const tenant = (await repo.getTenantForTeam(t.db, a.teamId))!;
    expect(await repo.resolveByHost(t.db, "homes.harbour-a.com.au")).toBeNull();
    // Staff cannot activate without a verified domain.
    state.staff = { id: await staffId(), role: "designer" };
    expect((await call(staffRoute.POST, "POST", { tenantId: tenant.id, status: "active" })).status).toBe(409);
    await repo.markVerified(t.db, tenant.id, "homes.harbour-a.com.au", a.boss.userId);
    expect(await repo.resolveByHost(t.db, "homes.harbour-a.com.au")).toBeNull(); // still draft
    expect((await call(staffRoute.POST, "POST", { tenantId: tenant.id, status: "active", note: "checked" })).status).toBe(200);
    const live = await repo.resolveByHost(t.db, "homes.harbour-a.com.au");
    expect(live?.settings.brand.siteName).toBe("Harbour Realty");
    expect(await repo.resolveByHost(t.db, "other.harbour-a.com.au")).toBeNull();
    // Suspending switches it off at once.
    await call(staffRoute.POST, "POST", { tenantId: tenant.id, status: "suspended" });
    expect(await repo.resolveByHost(t.db, "homes.harbour-a.com.au")).toBeNull();
    const audit = await t.db.query("SELECT event_type FROM audit_event WHERE aggregate_id = $1 ORDER BY occurred_at", [tenant.id]);
    expect(audit.rows.map(r => r["event_type"])).toEqual(expect.arrayContaining(["white_label.created", "white_label.domain_added", "white_label.domain_verified", "white_label.status_set"]));
  });

  it("staff routes need theme.edit; agents cannot approve their own brand", async () => {
    const a = await agency();
    const tenant = await withDomain(a, "own.approve-a.com.au");
    state.actor = a.boss;
    expect((await call(staffRoute.POST, "POST", { tenantId: tenant.id, status: "active" })).status).toBe(401);
    state.staff = { id: await staffId(), role: "support" };
    expect((await call(staffRoute.GET, "GET")).status).toBe(403);
    expect((await call(staffRoute.POST, "POST", { tenantId: tenant.id, status: "active" })).status).toBe(403);
    state.staff = { id: await staffId(), role: "designer" };
    expect((await call(staffRoute.POST, "POST", { tenantId: tenant.id, status: "bogus" })).status).toBe(400);
    expect((await call(staffRoute.POST, "POST", { tenantId: randomUUID(), status: "active" })).status).toBe(404);
    const list = await (await call(staffRoute.GET, "GET")).json();
    expect(list.tenants.find((x: { id: string }) => x.id === tenant.id)).toMatchObject({ teamName: "Harbour office", status: "draft" });
  });

  it("a domain can belong to one agency only; reserved and platform hosts are refused; five at most", async () => {
    const a = await agency(), b = await agency();
    state.actor = a.boss;
    await call(brandRoute.PUT, "PUT", { teamId: a.teamId, ...brand });
    expect((await call(domainsRoute.POST, "POST", { teamId: a.teamId, host: "taken.example-a.com.au" })).status).toBe(201);
    expect((await call(domainsRoute.POST, "POST", { teamId: a.teamId, host: "https://x.com" })).status).toBe(400);
    expect((await call(domainsRoute.POST, "POST", { teamId: a.teamId, host: "site.vercel.app" })).status).toBe(400);
    for (let i = 0; i < 4; i++) expect((await call(domainsRoute.POST, "POST", { teamId: a.teamId, host: `d${i}.example-a.com.au` })).status).toBe(201);
    expect((await call(domainsRoute.POST, "POST", { teamId: a.teamId, host: "d9.example-a.com.au" })).status).toBe(400);
    state.actor = b.boss;
    await call(brandRoute.PUT, "PUT", { teamId: b.teamId, ...brand });
    expect((await call(domainsRoute.POST, "POST", { teamId: b.teamId, host: "taken.example-a.com.au" })).status).toBe(409);
    // b cannot verify or remove a's domain.
    expect((await call(domainsRoute.PUT, "PUT", { teamId: b.teamId, host: "taken.example-a.com.au" })).status).toBe(404);
    expect((await call(domainsRoute.DELETE, "DELETE", { teamId: b.teamId, host: "taken.example-a.com.au" })).status).toBe(404);
    state.actor = a.boss;
    expect((await call(domainsRoute.DELETE, "DELETE", { teamId: a.teamId, host: "taken.example-a.com.au" })).status).toBe(200);
  });

  it("renaming or changing the logo of an active brand sends it back for review; colours do not", async () => {
    const a = await agency();
    const tenant = await withDomain(a, "review.rename-a.com.au");
    const staff = await staffId();
    await repo.setStatus(t.db, staff, tenant.id, "active", "");
    state.actor = a.boss;
    const colours = await (await call(brandRoute.PUT, "PUT", { teamId: a.teamId, ...brand, primary: "#6b3700" })).json();
    expect(colours.tenant.status).toBe("active");
    const renamed = await (await call(brandRoute.PUT, "PUT", { teamId: a.teamId, ...brand, name: "Someone Else Bank" })).json();
    expect(renamed.tenant.status).toBe("draft");
    expect(await repo.resolveByHost(t.db, "review.rename-a.com.au")).toBeNull();
    await repo.setStatus(t.db, staff, tenant.id, "active", "");
    const up = await call(assetRoute.POST, "POST", { teamId: a.teamId, slot: "logo-light", contentType: "image/png", data: png() });
    expect(up.status).toBe(201);
    expect((await repo.getTenantForTeam(t.db, a.teamId))!.status).toBe("draft");
  });

  it("serves the logo only on the tenant's own host, only while it is current and active", async () => {
    const a = await agency();
    const tenant = await withDomain(a, "logo.serve-a.com.au");
    const other = await agency();
    await withDomain(other, "logo.serve-b.com.au");
    state.actor = a.boss;
    const up = await (await call(assetRoute.POST, "POST", { teamId: a.teamId, slot: "logo-light", contentType: "image/png", data: png() })).json();
    const svg = await call(assetRoute.POST, "POST", { teamId: a.teamId, slot: "logo-light", contentType: "image/svg+xml", data: Buffer.from("<svg/>").toString("base64") });
    expect(svg.status).toBe(400);
    const get = (host: string, slot: string, v: number | string) =>
      tenantAsset.GET(new Request(`http://${host}/x?v=${v}`, { headers: { host } }), { params: Promise.resolve({ slot }) });
    // Draft: nothing is public.
    expect((await get("logo.serve-a.com.au", "logo-light", up.id)).status).toBe(404);
    await repo.setStatus(t.db, await staffId(), tenant.id, "active", "");
    clearTenantCache();
    const ok = await get("logo.serve-a.com.au", "logo-light", up.id);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("content-security-policy")).toContain("sandbox");
    expect(ok.headers.get("cache-control")).toContain("immutable");
    expect((await get("logo.serve-a.com.au", "logo-light", up.id + 1)).status).toBe(404);   // not the current image
    expect((await get("logo.serve-a.com.au", "favicon", up.id)).status).toBe(404);          // no favicon
    expect((await get("logo.serve-b.com.au", "logo-light", up.id)).status).toBe(404);       // another agency's host
    expect((await get("www.unknown.example", "logo-light", up.id)).status).toBe(404);
    expect((await get("logo.serve-a.com.au", "hero", up.id)).status).toBe(404);
    expect((await get("logo.serve-a.com.au", "logo-light", "1; DROP")).status).toBe(404);
  });

  it("the request host resolves to the tenant brand with its logo", async () => {
    const a = await agency();
    const tenant = await withDomain(a, "brand.resolve-a.com.au");
    state.actor = a.boss;
    const up = await (await call(assetRoute.POST, "POST", { teamId: a.teamId, slot: "logo-light", contentType: "image/png", data: png() })).json();
    await repo.setStatus(t.db, await staffId(), tenant.id, "active", "");
    clearTenantCache();
    const view = await tenantForHost(requestHost({ get: (n: string) => (n === "host" ? "Brand.Resolve-A.com.au:443" : null) }), () => t.db, {});
    expect(view).toMatchObject({ id: tenant.id, logoLightId: up.id });
    expect(view?.settings.brand).toMatchObject({ siteName: "Harbour Realty", logoLight: up.id });
    expect(buildTenantSettings({ ...brand }).ok).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { isAllowed } from "../src/config/app-mode";
import { contrastRatio } from "../src/domain/site-theme";
import { brandInputOf, buildTenantSettings, hostProblem, normaliseHost, platformHostsFrom, tenantAssetUrl, verifyRecordName, verifyRecordValue } from "../src/domain/white-label";
import { clearTenantCache, dnsVerified, requestHost, tenantForHost } from "../src/server/white-label";
import type { Queryable } from "../src/server/db";

const ok = { name: "Harbour Realty", tagline: "Homes by the water", primary: "#7a3e00", secondary: "#10243f", footerText: "ABN 12 345 678 901" };

describe("normaliseHost", () => {
  it("lower-cases and strips port and trailing dot", () => {
    expect(normaliseHost("Homes.Harbour.com.au:8443")).toBe("homes.harbour.com.au");
    expect(normaliseHost("homes.harbour.com.au.")).toBe("homes.harbour.com.au");
  });
  it("refuses anything that is not a plain DNS name", () => {
    for (const bad of ["", "localhost", "10.0.0.1", "1.2.3", "https://a.com", "a.com/path", "user@a.com", "a b.com", "-a.com", "a..com", "a.com?x=1", "exa_mple.com", 5, null, undefined, "a".repeat(64) + ".com"]) {
      expect(normaliseHost(bad), String(bad)).toBeNull();
    }
  });
});

describe("hostProblem", () => {
  it("blocks reserved and platform hosts and their subdomains", () => {
    expect(hostProblem("evil.localhost")).not.toBeNull();
    expect(hostProblem("app.platform.example.net", ["platform.example.net"])).not.toBeNull();
    expect(hostProblem("x.vercel.app")).not.toBeNull();
    expect(hostProblem("www.platform.test2.io", ["platform.test2.io"])).not.toBeNull();
    expect(hostProblem("homes.harbour.com.au", ["platform.test2.io"])).toBeNull();
  });
  it("reads PLATFORM_HOSTS", () => expect(platformHostsFrom({ PLATFORM_HOSTS: "A.com, b.org:3000 ,bad host" })).toEqual(["a.com", "b.org"]));
});

describe("buildTenantSettings", () => {
  it("builds a full valid theme from the agency's choices", () => {
    const r = buildTenantSettings(ok);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.brand).toMatchObject({ siteName: "Harbour Realty", tagline: "Homes by the water", logoLight: null });
    expect(r.settings.colours.light).toMatchObject({ primary: "#7a3e00", link: "#7a3e00", buttonBg: "#10243f", heading: "#10243f" });
    expect(r.settings.footer.text).toBe("ABN 12 345 678 901");
    expect(brandInputOf(r.settings)).toEqual(ok);
  });
  it("normalises hex case and trims text", () => {
    const r = buildTenantSettings({ ...ok, name: "  Harbour  ", primary: "#7A3E00" });
    expect(r.ok && r.settings.brand.siteName).toBe("Harbour");
  });
  it("reports field errors instead of changing values", () => {
    const r = buildTenantSettings({ ...ok, name: "", primary: "blue", secondary: "#12", tagline: "x".repeat(121) });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["name", "primary", "secondary", "tagline"]);
  });
  it("rejects HTML or braces in text through the platform rules", () => {
    for (const name of ["<script>x</script>", "a{b}"]) expect(buildTenantSettings({ ...ok, name }).ok, name).toBe(false);
  });
  it("rejects colours that fail the platform contrast rules", () => {
    const light = buildTenantSettings({ ...ok, primary: "#ffee99" });
    expect(light.ok).toBe(false);
    expect(contrastRatio("#ffee99", "#fbfaf7")).toBeLessThan(3);
  });
  it("refuses non-objects and unknown keys do not leak into settings", () => {
    expect(buildTenantSettings(null).ok).toBe(false);
    expect(buildTenantSettings([]).ok).toBe(false);
    const r = buildTenantSettings({ ...ok, css: "body{display:none}" });
    expect(r.ok && JSON.stringify(r.settings)).not.toContain("display:none");
  });
});

describe("DNS verification", () => {
  const token = "tok123";
  it("names the record and value", () => {
    expect(verifyRecordName("homes.a.com")).toBe("_wl-verify.homes.a.com");
    expect(verifyRecordValue(token)).toBe("wl-verify=tok123");
  });
  it("accepts the exact record, including a record split into chunks", async () => {
    expect(await dnsVerified("a.com", token, async () => [["x"], ["wl-verify=tok123"]])).toBe(true);
    expect(await dnsVerified("a.com", token, async () => [["wl-verify=", "tok123"]])).toBe(true);
  });
  it("rejects another token, a partial match and lookup failures", async () => {
    expect(await dnsVerified("a.com", token, async () => [["wl-verify=other"]])).toBe(false);
    expect(await dnsVerified("a.com", token, async () => [["wl-verify=tok1234"]])).toBe(false);
    expect(await dnsVerified("a.com", token, async () => { throw new Error("ENOTFOUND"); })).toBe(false);
  });
});

describe("tenantForHost", () => {
  const built = buildTenantSettings(ok);
  if (!built.ok) throw new Error("fixture");
  const view = { id: "t1", settings: built.settings, logoLightId: 4, faviconId: null };
  const dbWith = (rows: Record<string, unknown>[], counter = { n: 0 }): { db: () => Queryable; counter: { n: number } } =>
    ({ counter, db: () => ({ query: async () => { counter.n++; return { rows }; } }) });
  const row = () => ({ id: "t1", settings: view.settings, logo_light_id: 4, favicon_id: null });

  it("returns the brand for a verified, active host and sets the logo from the tenant", async () => {
    clearTenantCache();
    const { db } = dbWith([row()]);
    const t = await tenantForHost("homes.harbour.com.au", db, {});
    expect(t?.id).toBe("t1");
    expect(t?.settings.brand).toMatchObject({ siteName: "Harbour Realty", logoLight: 4, favicon: null });
  });
  it("skips the database for localhost, missing hosts and platform hosts", async () => {
    clearTenantCache();
    const { db, counter } = dbWith([row()]);
    for (const h of [null, "localhost", "app.example.org"]) expect(await tenantForHost(h, db, { PLATFORM_HOSTS: "app.example.org" })).toBeNull();
    expect(counter.n).toBe(0);
  });
  it("caches hits and misses for 45 seconds", async () => {
    clearTenantCache();
    const { db, counter } = dbWith([]);
    expect(await tenantForHost("who.example.com", db, {}, 1000)).toBeNull();
    expect(await tenantForHost("who.example.com", db, {}, 40_000)).toBeNull();
    expect(counter.n).toBe(1);
    await tenantForHost("who.example.com", db, {}, 50_000);
    expect(counter.n).toBe(2);
  });
  it("falls back to the platform brand when the database fails", async () => {
    clearTenantCache();
    const t = await tenantForHost("down.example.com", () => ({ query: async () => { throw new Error("down"); } }), {});
    expect(t).toBeNull();
  });
  it("requestHost reads Host, then X-Forwarded-Host, and ignores IPs", () => {
    const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
    expect(requestHost(h({ host: "Homes.A.com:443" }))).toBe("homes.a.com");
    expect(requestHost(h({ "x-forwarded-host": "b.com" }))).toBe("b.com");
    expect(requestHost(h({ host: "127.0.0.1:3004" }))).toBeNull();
  });
});

describe("routing", () => {
  it("serves the tenant image route on the public site and keeps agency/staff APIs in their modes", () => {
    expect(tenantAssetUrl("logo-light", 4)).toBe("/api/tenant/asset/logo-light?v=4");
    expect(isAllowed("public", "/api/tenant/asset/logo-light", null, undefined)).toBe(true);
    expect(isAllowed("public", "/api/agency/white-label", null, undefined)).toBe(true);
    expect(isAllowed("public", "/api/staff/white-label", null, undefined)).toBe(false);
    expect(isAllowed("admin", "/api/staff/white-label", null, undefined)).toBe(true);
  });
});

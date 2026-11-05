import { describe, expect, it, vi } from "vitest";
import { baseSecurityHeaders, pageCsp, securityHeaderRules } from "../next.config.mjs";
import { imageHeaders } from "../src/server/photo-route";
import { withinRates } from "../src/server/rate-guard";
import { staffCan } from "../src/domain/staff-access";

describe("site-wide security headers", () => {
  it("sends the four base headers on every path and the page CSP on every path except /api", () => {
    const rules = securityHeaderRules(false);
    const get = (k: string) => baseSecurityHeaders.find(h => h.key === k)?.value;
    expect(get("Strict-Transport-Security")).toBe("max-age=31536000");
    expect(get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(get("X-Content-Type-Options")).toBe("nosniff");
    expect(get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(rules[0]).toMatchObject({ source: "/:path*", headers: baseSecurityHeaders });
    const csp = rules[1]!;
    expect(new RegExp(`^${csp.source.replace(/\//g, "\\/")}$`).test("/api/photos/x")).toBe(false);
    expect(csp.headers[0]!.value).toBe(pageCsp(false));
  });

  it("keeps the CSP closed: own origin, no plugins, no framing, no unsafe-eval outside development", () => {
    const csp = pageCsp(false);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(pageCsp(true)).toContain("'unsafe-eval'");
  });
});

describe("imageHeaders", () => {
  it("sandboxes every image and never caches a private one", () => {
    const h = imageHeaders("image/jpeg", 12, false);
    expect(h).toMatchObject({ "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cross-origin-resource-policy": "same-origin", "cache-control": "private, no-store", "content-length": "12" });
    expect(imageHeaders("image/jpeg", 1, true)["cache-control"]).toBe("public, max-age=600");
  });
});

describe("withinRates", () => {
  const fakeDb = (hits: number | "throw") => ({ query: vi.fn(async () => { if (hits === "throw") throw new Error("down"); return { rows: [{ hits }] }; }) });
  const rule = { windowMs: 60_000, limit: 3 };
  it("allows up to the limit, refuses above it, and fails closed on a database error", async () => {
    expect(await withinRates(fakeDb(3) as never, "x", ["a"], rule)).toBe(true);
    expect(await withinRates(fakeDb(4) as never, "x", ["a"], rule)).toBe(false);
    expect(await withinRates(fakeDb("throw") as never, "x", ["a"], rule)).toBe(false);
  });
  it("counts every bucket even when the first is already over, and stores only hashes", async () => {
    const db = fakeDb(9);
    await withinRates(db as never, "x", ["1.2.3.4", "user-1"], rule);
    expect(db.query).toHaveBeenCalledTimes(2);
    const buckets = db.query.mock.calls.map(c => (c as unknown as [string, string[]])[1][0]!);
    expect(buckets.every(b => /^[0-9a-f]{64}$/.test(b))).toBe(true);
    expect(new Set(buckets).size).toBe(2);
  });
});

describe("support access to signing documents", () => {
  it("is held by support, compliance and super admin, and not by technical, reporting or accounting staff", () => {
    for (const role of ["support", "compliance", "super_admin"] as const) expect(staffCan({ id: "s", role }, "signing.support_view")).toBe(true);
    for (const role of ["technical", "reporting", "accountant", "designer"] as const) expect(staffCan({ id: "s", role }, "signing.support_view")).toBe(false);
  });
});

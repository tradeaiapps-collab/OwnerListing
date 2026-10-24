import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { csrfGuard } from "../src/server/csrf";
import { POST as logoutPost } from "../app/api/auth/logout/route";

const APP = "https://app.example.com";
const req = (method: string, headers: Record<string, string> = {}) =>
  new Request(`${APP}/api/x`, { method, headers });
const json = { "content-type": "application/json" };

let saved: string | undefined;
beforeEach(() => { saved = process.env["APP_URL"]; process.env["APP_URL"] = `${APP}/`; });
afterEach(() => { if (saved === undefined) delete process.env["APP_URL"]; else process.env["APP_URL"] = saved; });

describe("csrfGuard", () => {
  it("denies a cross-origin POST with 403", () => {
    expect(csrfGuard(req("POST", { ...json, origin: "https://evil.example" }))?.status).toBe(403);
  });
  it("denies a look-alike origin (subdomain, port, scheme)", () => {
    for (const origin of ["https://app.example.com.evil.io", "https://app.example.com:8443", "http://app.example.com", "null"]) {
      expect(csrfGuard(req("PUT", { ...json, origin }))?.status).toBe(403);
    }
  });
  it("denies when Origin and Referer are both missing", () => {
    expect(csrfGuard(req("POST", json))?.status).toBe(403);
  });
  it("allows a same-origin request", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(csrfGuard(req(m, { ...json, origin: APP }))).toBeNull();
  });
  it("falls back to Referer only when Origin is absent", () => {
    expect(csrfGuard(req("POST", { ...json, referer: `${APP}/listings/new` }))).toBeNull();
    expect(csrfGuard(req("POST", { ...json, referer: "https://evil.example/x" }))?.status).toBe(403);
    expect(csrfGuard(req("POST", { ...json, origin: "https://evil.example", referer: `${APP}/x` }))?.status).toBe(403);
  });
  it("denies a wrong or missing content type on JSON routes", () => {
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      expect(csrfGuard(req("POST", { "content-type": ct, origin: APP }))?.status).toBe(403);
    }
    expect(csrfGuard(req("POST", { origin: APP }))?.status).toBe(403);
  });
  it("accepts application/json with a charset parameter, and skips the type check when json is false", () => {
    expect(csrfGuard(req("POST", { "content-type": "application/json; charset=utf-8", origin: APP }))).toBeNull();
    expect(csrfGuard(req("POST", { origin: APP }), { json: false })).toBeNull();
    expect(csrfGuard(req("POST", { origin: "https://evil.example" }), { json: false })?.status).toBe(403);
  });
  it("leaves GET and HEAD unaffected", () => {
    expect(csrfGuard(req("GET"))).toBeNull();
    expect(csrfGuard(req("HEAD", { origin: "https://evil.example" }))).toBeNull();
  });
  it("fails closed when APP_URL is not configured", () => {
    delete process.env["APP_URL"];
    expect(csrfGuard(req("POST", { ...json, origin: APP }))?.status).toBe(403);
  });
});

describe("csrfGuard wired into a route (logout)", () => {
  it("denies cross-origin and missing Origin, allows same-origin", async () => {
    expect((await logoutPost(req("POST", { origin: "https://evil.example" }))).status).toBe(403);
    expect((await logoutPost(req("POST"))).status).toBe(403);
    expect((await logoutPost(req("POST", { origin: APP }))).status).toBe(200);
  });
});

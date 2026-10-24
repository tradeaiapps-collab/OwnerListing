import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, parseSettingsInput } from "../src/domain/account-settings";
import { dashboardLinks, dashboardRole, type DashboardRole } from "../src/domain/dashboard";
import { createDraft, createInMemoryListingRepository, publishListing, type Actor, type ListingServiceDeps } from "../src/domain/listing-service";
import { currentTermsVersion, parseTermsAcceptance, termsGate, type TermsVersionRow } from "../src/domain/terms";

const state = vi.hoisted(() => ({
  actor: null as Actor | null,
  versions: [] as Record<string, unknown>[],
  accepted: [] as Record<string, unknown>[],
  prefs: new Map<string, Record<string, unknown>>(),
  calls: [] as { text: string; params: unknown[] | undefined }[]
}));

const fakeDb = {
  async query(text: string, params?: unknown[]) {
    state.calls.push({ text, params });
    if (text.startsWith("SELECT version")) return { rows: state.versions };
    if (text.startsWith("SELECT user_id, version")) return { rows: state.accepted.filter(a => a["user_id"] === params?.[0]) };
    if (text.startsWith("INSERT INTO terms_acceptance")) {
      state.accepted.push({ user_id: params?.[0], version: params?.[1] });
      return { rows: [] };
    }
    if (text.startsWith("SELECT locale")) { const p = state.prefs.get(String(params?.[0])); return { rows: p ? [p] : [] }; }
    if (text.startsWith("INSERT INTO user_preference")) {
      state.prefs.set(String(params?.[0]), { locale: params?.[1], time_zone: params?.[2] });
      return { rows: [] };
    }
    return { rows: [] };
  }
};

vi.mock("../src/server/context", () => ({ getActor: () => state.actor, getDb: () => fakeDb }));

import * as termsRoute from "../app/api/terms/route";
import * as settingsRoute from "../app/api/settings/route";
process.env["APP_URL"] = "http://test";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const owner: Actor = { userId: A, userType: "owner" };
const V1: TermsVersionRow = { version: "2026-10-24", includesAiLearningClause: false, textReference: "/terms", effectiveAt: "2026-10-24T00:00:00.000Z" };
const NOW = "2026-10-25T00:00:00.000Z";
const body = (method: string, b: unknown, headers: Record<string, string> = {}) =>
  new Request("http://test/api/x", { method, headers: { "content-type": "application/json", origin: "http://test", ...headers }, body: JSON.stringify(b) });
const get = () => new Request("http://test/api/x");

beforeEach(() => {
  state.actor = null;
  state.versions = [{ version: V1.version, includes_ai_learning_clause: false, text_reference: "/terms", effective_at: new Date(V1.effectiveAt) }];
  state.accepted = [];
  state.prefs.clear();
  state.calls = [];
});

describe("terms domain", () => {
  it("picks the latest version already in force, and none before the first", () => {
    const v2 = { ...V1, version: "2026-12-01", effectiveAt: "2026-12-01T00:00:00.000Z" };
    expect(currentTermsVersion([V1, v2], NOW)?.version).toBe("2026-10-24");
    expect(currentTermsVersion([V1, v2], "2027-01-01T00:00:00.000Z")?.version).toBe("2026-12-01");
    expect(currentTermsVersion([V1], "2026-10-01T00:00:00.000Z")).toBeUndefined();
    expect(currentTermsVersion([V1], "not a date")).toBeUndefined();
  });

  it("gate denies a user with no acceptance, an old version, another user's acceptance, or no version in force", () => {
    expect(termsGate([], A, V1)?.code).toBe("forbidden");
    expect(termsGate([{ userId: A, version: "2025-01-01" }], A, V1)?.code).toBe("forbidden");
    expect(termsGate([{ userId: B, version: V1.version }], A, V1)?.code).toBe("forbidden");
    expect(termsGate([{ userId: A, version: V1.version }], A, undefined)?.code).toBe("forbidden");
    expect(termsGate([{ userId: A, version: V1.version }], A, V1)).toBeNull();
  });

  it("acceptance parsing refuses a missing agreement, a stale version, extra keys and non-objects", () => {
    expect(parseTermsAcceptance({ version: V1.version, agree: true }, V1)).toEqual({ ok: true, value: { version: V1.version } });
    for (const bad of [{ version: V1.version }, { version: V1.version, agree: "true" }, { version: "old", agree: true },
      { version: V1.version, agree: true, userId: B }, null, [], "x"]) {
      expect(parseTermsAcceptance(bad, V1).ok).toBe(false);
    }
    expect(parseTermsAcceptance({ version: V1.version, agree: true }, undefined).ok).toBe(false);
  });
});

describe("settings domain", () => {
  it("defaults to en-AU and Australia/Sydney", () => {
    expect(DEFAULT_SETTINGS).toEqual({ locale: "en-AU", timeZone: "Australia/Sydney" });
  });
  it("accepts a supported language and a real zone", () => {
    expect(parseSettingsInput({ locale: "fa", timeZone: "Australia/Perth" })).toEqual({ ok: true, value: { locale: "fa", timeZone: "Australia/Perth" } });
  });
  it("refuses unknown languages, bad or odd zones, extra keys and non-objects", () => {
    for (const bad of [
      { locale: "xx", timeZone: "UTC" }, { locale: "en-AU", timeZone: "Mars/Base" }, { locale: "en-AU", timeZone: "+05:00" },
      { locale: "en-AU", timeZone: "A/".repeat(40) }, { locale: "en-AU" }, { timeZone: "UTC" }, { locale: 1, timeZone: "UTC" },
      { locale: "en-AU", timeZone: "UTC", userId: B }, null, [], "x"
    ]) expect(parseSettingsInput(bad).ok).toBe(false);
  });
});

describe("terms route", () => {
  it("exports only GET and POST", () => expect(Object.keys(termsRoute).sort()).toEqual(["GET", "POST"]));

  it("denies signed-out reads and writes, and a cross-origin or non-JSON POST", async () => {
    expect((await termsRoute.GET(get())).status).toBe(401);
    expect((await termsRoute.POST(body("POST", { version: V1.version, agree: true }))).status).toBe(401);
    state.actor = owner;
    expect((await termsRoute.POST(body("POST", { version: V1.version, agree: true }, { origin: "http://evil" }))).status).toBe(403);
    expect((await termsRoute.POST(body("POST", { version: V1.version, agree: true }, { "content-type": "text/plain" }))).status).toBe(403);
    expect(state.accepted).toHaveLength(0);
  });

  it("refuses a stale version or no agreement and records nothing", async () => {
    state.actor = owner;
    expect((await termsRoute.POST(body("POST", { version: "old", agree: true }))).status).toBe(400);
    expect((await termsRoute.POST(body("POST", { version: V1.version, agree: false }))).status).toBe(400);
    expect(state.accepted).toHaveLength(0);
  });

  it("records acceptance for the signed-in user only (client-sent user id is refused) and reports it", async () => {
    state.actor = owner;
    expect(await (await termsRoute.GET(get())).json()).toMatchObject({ accepted: false, current: { version: V1.version } });
    expect((await termsRoute.POST(body("POST", { version: V1.version, agree: true, userId: B }))).status).toBe(400);
    expect((await termsRoute.POST(body("POST", { version: V1.version, agree: true }))).status).toBe(200);
    expect(state.accepted).toEqual([{ user_id: A, version: V1.version }]);
    expect(await (await termsRoute.GET(get())).json()).toMatchObject({ accepted: true });
    state.actor = { userId: B, userType: "buyer" };
    expect(await (await termsRoute.GET(get())).json()).toMatchObject({ accepted: false });
  });

  it("uses bound parameters and never updates or deletes the acceptance log", async () => {
    state.actor = owner;
    await termsRoute.POST(body("POST", { version: V1.version, agree: true }));
    const sql = state.calls.map(c => c.text).join("\n");
    expect(sql).not.toMatch(/UPDATE terms_acceptance|DELETE FROM terms_acceptance/i);
    for (const c of state.calls) expect(c.text).not.toContain(A);
  });
});

describe("settings route", () => {
  it("exports only GET and PUT", () => expect(Object.keys(settingsRoute).sort()).toEqual(["GET", "PUT"]));

  it("denies signed-out access and cross-origin writes", async () => {
    expect((await settingsRoute.GET(get())).status).toBe(401);
    expect((await settingsRoute.PUT(body("PUT", DEFAULT_SETTINGS))).status).toBe(401);
    state.actor = owner;
    expect((await settingsRoute.PUT(body("PUT", DEFAULT_SETTINGS, { origin: "http://evil" }))).status).toBe(403);
    expect(state.prefs.size).toBe(0);
  });

  it("returns defaults, then saves per user without touching anyone else", async () => {
    state.actor = owner;
    expect(await (await settingsRoute.GET(get())).json()).toEqual({ settings: DEFAULT_SETTINGS });
    expect((await settingsRoute.PUT(body("PUT", { locale: "it", timeZone: "Australia/Perth" }))).status).toBe(200);
    expect(await (await settingsRoute.GET(get())).json()).toEqual({ settings: { locale: "it", timeZone: "Australia/Perth" } });
    state.actor = { userId: B, userType: "buyer" };
    expect(await (await settingsRoute.GET(get())).json()).toEqual({ settings: DEFAULT_SETTINGS });
  });

  it("refuses invalid input and a client-sent user id", async () => {
    state.actor = owner;
    expect((await settingsRoute.PUT(body("PUT", { locale: "zz", timeZone: "UTC" }))).status).toBe(400);
    expect((await settingsRoute.PUT(body("PUT", { locale: "en-AU", timeZone: "UTC", userId: B }))).status).toBe(400);
    expect(state.prefs.size).toBe(0);
  });
});

describe("publish needs the current terms", () => {
  const input = { title: "Home", address: "1 Test St, Brisbane QLD", jurisdiction: "QLD", transactionType: "sale", useClass: "residential", propertyType: "house" } as const;
  const run = async (termsCurrentFor: ListingServiceDeps["termsCurrentFor"]) => {
    let n = 0;
    const deps: ListingServiceDeps = {
      repo: createInMemoryListingRepository(), appendAudit: async () => {}, now: () => NOW, newId: () => `id-${++n}`,
      requiredDisclosures: () => [], ...(termsCurrentFor ? { termsCurrentFor } : {})
    };
    const l = await createDraft(deps, owner, input);
    const rec = (await deps.repo.get(l.id))!;
    await deps.repo.save({ ...rec, termsAccepted: false, listingFeePaid: true });
    const r = await publishListing(deps, owner, l.id, true);
    return r.ok ? r.value.decision.reasons.join(" ") : "";
  };

  it("blocks when the owner has not accepted the current terms", async () => {
    expect(await run(async () => false)).toContain("terms and conditions have not been accepted");
  });
  it("does not report a terms problem once accepted", async () => {
    expect(await run(async () => true)).not.toContain("terms and conditions");
  });
});

describe("dashboard", () => {
  const roles: DashboardRole[] = ["owner", "agent", "buyer", "staff"];
  const pageFor = (href: string) => existsSync(`app${href}/page.tsx`);

  it("every dashboard link and the required routes resolve to a page", () => {
    for (const r of roles) for (const l of dashboardLinks(r)) expect(pageFor(l.href), `${r}: ${l.href}`).toBe(true);
    for (const href of ["/plans", "/offers/new", "/enquiries", "/buyer/verification", "/settings", "/terms", "/dashboard"]) expect(pageFor(href), href).toBe(true);
  });

  it("is role-aware: buyers do not get owner tasks and owners do not get buyer tasks", () => {
    const hrefs = (r: DashboardRole) => dashboardLinks(r).map(l => l.href);
    expect(hrefs("buyer")).toContain("/buyer/verification");
    expect(hrefs("buyer")).not.toContain("/listings/new");
    expect(hrefs("owner")).toContain("/listings/new");
    expect(hrefs("owner")).not.toContain("/buyer/verification");
    expect(hrefs("owner")).not.toContain("/staff");
    expect(hrefs("staff")).toEqual(["/staff"]);
  });

  it("resolves the role: staff first, unknown or missing types are signed out", () => {
    expect(dashboardRole(true, "buyer")).toBe("staff");
    expect(dashboardRole(false, "buyer")).toBe("buyer");
    expect(dashboardRole(false, "vendor")).toBeNull();
    expect(dashboardRole(false, undefined)).toBeNull();
  });
});

describe("migration", () => {
  const sql = readFileSync("db/20261024160000_terms_settings.sql", "utf8");
  it("makes acceptances and published versions immutable and seeds a version", () => {
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON terms_acceptance/);
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON terms_version/);
    expect(sql).toMatch(/INSERT INTO terms_version/);
  });
});

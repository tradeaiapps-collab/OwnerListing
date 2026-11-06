import { beforeEach, describe, expect, it, vi } from "vitest";
import { mayAlert, type AlertPreference, type SavedSearch } from "../src/domain/buyer";
import {
  MAX_SEARCHES_PER_BUYER, createSavedSearch, parseAlertConsentInput, parseSavedSearchInput, setAlertConsent,
  type SavedSearchInput, type SavedSearchRepository
} from "../src/domain/saved-search-service";
import type { Actor } from "../src/domain/listing-service";
import type { Queryable } from "../src/server/db";
import { createPgSavedSearchRepository } from "../src/server/saved-search-db";

const state = vi.hoisted(() => ({ actor: null as Actor | null, repo: null as unknown }));

vi.mock("../src/server/context", () => ({ getActor: () => state.actor }));
vi.mock("../src/server/saved-search-context", () => ({ getSavedSearchRepo: () => state.repo }));

import { GET as listRoute, POST as createRoute } from "../app/api/buyer/saved-searches/route";
import { DELETE as deleteRoute } from "../app/api/buyer/saved-searches/[searchId]/route";
import { GET as prefsGet, PUT as prefsPut } from "../app/api/buyer/alert-preferences/route";
process.env["APP_URL"] = "http://test";


const valid = { transactionType: "sale", useClass: "residential" };

function memoryRepo(): SavedSearchRepository & { prefs: AlertPreference[]; searches: SavedSearch[] } {
  const searches: SavedSearch[] = [];
  const prefs: AlertPreference[] = [];
  let n = 0;
  return {
    searches, prefs,
    async list(buyer) { return searches.filter(s => s.buyerUserId === buyer); },
    async insert(buyer, input) { const s: SavedSearch = { id: `s-${++n}`, buyerUserId: buyer, active: true, ...input }; searches.push(s); return s; },
    async remove(buyer, id) { const i = searches.findIndex(s => s.id === id && s.buyerUserId === buyer); if (i < 0) return false; searches.splice(i, 1); return true; },
    async listPreferences() { return [...prefs]; },
    async giveConsent(_b, channel, now) {
      const i = prefs.findIndex(p => p.channel === channel);
      prefs[i >= 0 ? i : prefs.length] = { channel, consentGivenAt: now };
    },
    async unsubscribe(_b, channel, now) {
      const i = prefs.findIndex(p => p.channel === channel);
      const prev = i >= 0 ? prefs[i] : undefined;
      prefs[i >= 0 ? i : prefs.length] = { channel, ...(prev?.consentGivenAt ? { consentGivenAt: prev.consentGivenAt } : {}), unsubscribedAt: now };
    }
  };
}

describe("parseSavedSearchInput", () => {
  it("accepts a minimal search and a full one", () => {
    expect(parseSavedSearchInput(valid)).toEqual({
      ok: true, value: { transactionType: "sale", useClass: "residential", jurisdictions: [], suburbs: [], propertyTypes: [] }
    });
    const full = parseSavedSearchInput({
      ...valid, jurisdictions: ["QLD", "QLD"], suburbs: [" Paddington ", "paddington", "Milton"],
      propertyTypes: ["house"], minPriceCents: 50_000_000, maxPriceCents: 90_000_000, minBedrooms: 3
    });
    expect(full).toEqual({
      ok: true,
      value: {
        transactionType: "sale", useClass: "residential", jurisdictions: ["QLD"], suburbs: ["Paddington", "Milton"],
        propertyTypes: ["house"], minPriceCents: 50_000_000, maxPriceCents: 90_000_000, minBedrooms: 3
      }
    });
  });

  it("rejects any field outside the property facts, so demographic data cannot be stored", () => {
    for (const key of ["age", "gender", "religion", "familyStatus", "nationality", "income", "buyerUserId", "active"]) {
      const r = parseSavedSearchInput({ ...valid, [key]: "x" });
      expect(r.ok).toBe(false);
    }
  });

  it("rejects bad values", () => {
    const bad: unknown[] = [
      null, [], "x", {}, { ...valid, transactionType: "swap" }, { ...valid, useClass: "farm" },
      { ...valid, jurisdictions: ["ZZ"] }, { ...valid, jurisdictions: "QLD" }, { ...valid, propertyTypes: ["castle"] },
      { ...valid, suburbs: [""] }, { ...valid, suburbs: [1] }, { ...valid, suburbs: Array.from({ length: 11 }, (_, i) => `S${i}`) },
      { ...valid, minPriceCents: -1 }, { ...valid, minPriceCents: 1.5 }, { ...valid, minPriceCents: "10" },
      { ...valid, minPriceCents: 200, maxPriceCents: 100 }, { ...valid, minBedrooms: 21 }
    ];
    for (const b of bad) expect(parseSavedSearchInput(b).ok).toBe(false);
  });
});

describe("alert consent", () => {
  it("needs an explicit boolean and a known channel", () => {
    expect(parseAlertConsentInput({ channel: "email", consent: true })).toEqual({ ok: true, value: { channel: "email", consent: true } });
    for (const b of [null, {}, { channel: "email" }, { channel: "email", consent: "yes" }, { channel: "fax", consent: true }, { channel: "sms", consent: true, extra: 1 }]) {
      expect(parseAlertConsentInput(b).ok).toBe(false);
    }
  });

  it("saving a search does not turn alerts on", async () => {
    const repo = memoryRepo();
    const r = await createSavedSearch(repo, "u1", { transactionType: "sale", useClass: "residential", jurisdictions: [], suburbs: [], propertyTypes: [] });
    expect(r.ok).toBe(true);
    expect(mayAlert((await repo.listPreferences("u1"))[0])).toBe(false);
  });

  it("opting in then out records both, and mayAlert follows", async () => {
    const repo = memoryRepo();
    const on = await setAlertConsent(repo, "u1", { channel: "email", consent: true }, "2026-10-24T00:00:00.000Z");
    expect(mayAlert(on.find(p => p.channel === "email"))).toBe(true);
    const off = await setAlertConsent(repo, "u1", { channel: "email", consent: false }, "2026-10-24T01:00:00.000Z");
    const email = off.find(p => p.channel === "email");
    expect(email?.consentGivenAt).toBe("2026-10-24T00:00:00.000Z");
    expect(email?.unsubscribedAt).toBe("2026-10-24T01:00:00.000Z");
    expect(mayAlert(email)).toBe(false);
  });

  it("caps saved searches per buyer", async () => {
    const repo = memoryRepo();
    const input: SavedSearchInput = { transactionType: "rent", useClass: "residential", jurisdictions: [], suburbs: [], propertyTypes: [] };
    for (let i = 0; i < MAX_SEARCHES_PER_BUYER; i++) expect((await createSavedSearch(repo, "u1", input)).ok).toBe(true);
    const over = await createSavedSearch(repo, "u1", input);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe("conflict");
    expect((await createSavedSearch(repo, "u2", input)).ok).toBe(true);
  });
});

describe("createPgSavedSearchRepository", () => {
  const calls: { text: string; params: unknown[] | undefined }[] = [];
  let rows: Record<string, unknown>[] = [];
  const db: Queryable = { async query(text, params) { calls.push({ text, params }); return { rows }; } };
  beforeEach(() => { calls.length = 0; rows = []; });

  it("scopes every query to the buyer with parameters, never string-built SQL", async () => {
    const repo = createPgSavedSearchRepository(db);
    rows = [{ id: "s1" }];
    await repo.insert("u1", { transactionType: "sale", useClass: "residential", jurisdictions: ["QLD"], suburbs: [], propertyTypes: [] });
    await repo.list("u1");
    await repo.listPreferences("u1");
    await repo.giveConsent("u1", "email", "2026-10-24T00:00:00.000Z");
    await repo.unsubscribe("u1", "sms", "2026-10-24T00:00:00.000Z");
    await repo.remove("u1", "s1");
    expect(calls).toHaveLength(6);
    for (const c of calls) {
      expect(c.params?.[0]).toBe("u1");
      expect(c.text).not.toContain("u1");
      expect(c.text).toMatch(/\$1/);
    }
    expect(JSON.parse(String(calls[0]?.params?.[1]))).toEqual({ transactionType: "sale", useClass: "residential", jurisdictions: ["QLD"], suburbs: [], propertyTypes: [] });
  });

  it("skips stored rows whose criteria no longer validate, and maps timestamps", async () => {
    const repo = createPgSavedSearchRepository(db);
    rows = [
      { id: "ok", buyer_user_id: "u1", active: true, criteria: { transactionType: "rent", useClass: "commercial" } },
      { id: "bad", buyer_user_id: "u1", active: true, criteria: { transactionType: "rent", useClass: "commercial", age: 40 } }
    ];
    const list = await repo.list("u1");
    expect(list.map(s => s.id)).toEqual(["ok"]);
    rows = [{ channel: "email", consent_given_at: new Date("2026-10-24T00:00:00.000Z"), unsubscribed_at: null }, { channel: "fax" }];
    expect(await repo.listPreferences("u1")).toEqual([{ channel: "email", consentGivenAt: "2026-10-24T00:00:00.000Z" }]);
  });
});

describe("buyer routes", () => {
  const req = (method: string, body?: unknown) =>
    new Request("http://test/api/buyer", {
      method, headers: { "content-type": "application/json", origin: "http://test" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

  beforeEach(() => { state.actor = null; state.repo = memoryRepo(); });

  it("returns 401 when signed out", async () => {
    expect((await listRoute(req("GET"))).status).toBe(401);
    expect((await createRoute(req("POST", valid))).status).toBe(401);
    expect((await prefsGet(req("GET"))).status).toBe(401);
    expect((await prefsPut(req("PUT", { channel: "email", consent: true }))).status).toBe(401);
  });

  it("creates and lists only the signed-in user's searches", async () => {
    state.actor = { userId: "u1", userType: "owner" };
    expect((await createRoute(req("POST", valid))).status).toBe(201);
    expect((await createRoute(req("POST", { ...valid, age: 30 }))).status).toBe(400);
    expect(((await (await listRoute(req("GET"))).json()) as { searches: unknown[] }).searches).toHaveLength(1);
    state.actor = { userId: "u2", userType: "agent" };
    expect(((await (await listRoute(req("GET"))).json()) as { searches: unknown[] }).searches).toHaveLength(0);
  });

  it("deletes only the signed-in user's own search", async () => {
    const ctx = (id: string) => ({ params: Promise.resolve({ searchId: id }) });
    expect((await deleteRoute(req("DELETE"), ctx("s-1"))).status).toBe(401);
    state.actor = { userId: "u1", userType: "owner" };
    await createRoute(req("POST", valid));
    state.actor = { userId: "u2", userType: "agent" };
    expect((await deleteRoute(req("DELETE"), ctx("s-1"))).status).toBe(404);
    state.actor = { userId: "u1", userType: "owner" };
    expect((await deleteRoute(req("DELETE"), ctx("s-1"))).status).toBe(200);
    expect((await deleteRoute(req("DELETE"), ctx("s-1"))).status).toBe(404);
    expect(((await (await listRoute(req("GET"))).json()) as { searches: unknown[] }).searches).toHaveLength(0);
  });

  it("records alert consent and unsubscribe, and rejects a non-boolean", async () => {
    state.actor = { userId: "u1", userType: "owner" };
    expect((await prefsPut(req("PUT", { channel: "email", consent: "yes" }))).status).toBe(400);
    const on = (await (await prefsPut(req("PUT", { channel: "email", consent: true }))).json()) as { preferences: AlertPreference[] };
    expect(mayAlert(on.preferences[0])).toBe(true);
    const off = (await (await prefsPut(req("PUT", { channel: "email", consent: false }))).json()) as { preferences: AlertPreference[] };
    expect(mayAlert(off.preferences[0])).toBe(false);
  });
});

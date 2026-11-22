import { beforeEach, describe, expect, it, vi } from "vitest";
import { annualCents, parseRates, toRatesView } from "../src/domain/listing-rates";
import { createInMemoryListingRepository, type Actor, type ListingServiceDeps } from "../src/domain/listing-service";
import type { PropertyListing } from "../src/domain/listing";
import type { ListingRates } from "../src/domain/listing-rates";

const TODAY = "2026-11-18";

describe("parseRates", () => {
  it("accepts council and water with a notice date and returns only what was sent", () => {
    const r = parseRates({ council: { cents: 52040, period: "quarter" }, water: { cents: 120000, period: "year" }, waterUsageBilledSeparately: true, asAt: "2026-07-01" }, TODAY);
    expect(r).toEqual({ ok: true, value: { council: { cents: 52040, period: "quarter" }, water: { cents: 120000, period: "year" }, waterUsageBilledSeparately: true, asAt: "2026-07-01" } });
  });
  it("accepts an empty body (clears) and a usage-only answer without a date", () => {
    expect(parseRates({}, TODAY)).toEqual({ ok: true, value: {} });
    expect(parseRates({ waterUsageBilledSeparately: false }, TODAY)).toEqual({ ok: true, value: { waterUsageBilledSeparately: false } });
  });
  it.each([
    [{ council: { cents: 0, period: "year" }, asAt: "2026-07-01" }, "between"],
    [{ council: { cents: 100_000_001, period: "year" }, asAt: "2026-07-01" }, "between"],
    [{ council: { cents: 10.5, period: "year" }, asAt: "2026-07-01" }, "between"],
    [{ council: { cents: 5000, period: "month" }, asAt: "2026-07-01" }, "period"],
    [{ council: "500" }, "amount and a period"],
    [{ council: { cents: 5000, period: "year" } }, "date of the rates notice"],
    [{ council: { cents: 5000, period: "year" }, asAt: "2026-02-30" }, "real date"],
    [{ council: { cents: 5000, period: "year" }, asAt: "2026-11-19" }, "future"],
    [{ council: { cents: 5000, period: "year" }, asAt: "2023-11-17" }, "3 years"],
    [{ waterUsageBilledSeparately: "yes" }, "yes or no"],
    [[], "object"]
  ])("rejects %j", (body, text) => {
    const r = parseRates(body, TODAY);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.message).toContain(text);
  });
  it("allows a notice exactly 3 years old and today", () => {
    expect(parseRates({ water: { cents: 1, period: "year" }, asAt: "2023-11-18" }, TODAY).ok).toBe(true);
    expect(parseRates({ water: { cents: 1, period: "year" }, asAt: TODAY }, TODAY).ok).toBe(true);
  });
});

describe("toRatesView", () => {
  it("annualises quarterly charges and totals only when both are stated", () => {
    expect(annualCents({ cents: 52040, period: "quarter" })).toBe(208160);
    const v = toRatesView({ council: { cents: 52040, period: "quarter" }, water: { cents: 120000, period: "year" }, asAt: "2026-07-01" })!;
    expect(v.lines).toEqual([
      { label: "Council rates", amount: "$520.40 per quarter", yearly: "$2,081.60 per year" },
      { label: "Water rates", amount: "$1,200 per year", yearly: "$1,200 per year" }
    ]);
    expect(v.totalYearly).toBe("$3,281.60 per year");
    expect(toRatesView({ council: { cents: 100000, period: "year" }, asAt: "2026-07-01" })!.totalYearly).toBeNull();
  });
  it("returns null when nothing is stated and a note for the usage flag", () => {
    expect(toRatesView({})).toBeNull();
    expect(toRatesView({ waterUsageBilledSeparately: true })!.waterUsageNote).toContain("billed separately");
    expect(toRatesView({ waterUsageBilledSeparately: false })!.waterUsageNote).toContain("included");
  });
});

const state = vi.hoisted(() => ({ actor: null as Actor | null, deps: null as unknown, stored: null as unknown, saved: [] as unknown[], audits: [] as string[] }));
vi.mock("../src/server/context", () => ({
  getActor: async () => state.actor, getDeps: () => state.deps, getDb: () => ({ query: async () => ({ rows: [] }) })
}));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_d: unknown, e: { eventType: string }) => { state.audits.push(e.eventType); } }));
vi.mock("../src/server/listing-rates-db", () => ({
  getRatesPg: async () => state.stored,
  saveRatesPg: async (_d: unknown, id: string, rates: unknown, user: string) => { state.saved.push([id, rates, user]); }
}));
import * as route from "../app/api/listings/[id]/rates/route";
process.env["APP_URL"] = "http://test";

const owner: Actor = { userId: "owner-1", userType: "owner" };
const other: Actor = { userId: "owner-2", userType: "owner" };
const SALE = "00000000-0000-4000-8000-0000000000a1", RENT = "00000000-0000-4000-8000-0000000000a2";
const mk = (id: string, o: Partial<PropertyListing>): PropertyListing => ({
  id, ownerUserId: owner.userId, ownerUserType: "owner", jurisdiction: "NSW", status: "draft", title: "Home", propertyType: "house",
  useClass: "residential", transactionType: "sale", address: "1 St", disclosures: [], createdAt: "2026-11-01", updatedAt: "2026-11-01", ...o
});
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const put = (body: unknown) => new Request("http://test/x", { method: "PUT", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(body) });
const get = () => new Request("http://test/x");
const RATES: ListingRates = { council: { cents: 52040, period: "quarter" }, asAt: "2026-07-01" };

beforeEach(async () => {
  const repo = createInMemoryListingRepository();
  await repo.insert({ listing: mk(SALE, {}), listingFeePaid: false, termsAccepted: true });
  await repo.insert({ listing: mk(RENT, { transactionType: "rent" }), listingFeePaid: false, termsAccepted: true });
  state.deps = { repo, now: () => "2026-11-18T01:00:00.000Z", newId: () => "x" } as unknown as ListingServiceDeps;
  state.actor = owner; state.stored = RATES; state.saved = []; state.audits = [];
});

describe("/api/listings/[id]/rates", () => {
  it("lets the owner save, audits without amounts, and returns the buyer view", async () => {
    const res = await route.PUT(put({ council: { cents: 52040, period: "quarter" }, asAt: "2026-07-01" }), ctx(SALE));
    expect(res.status).toBe(200);
    expect(state.saved).toEqual([[SALE, RATES, "owner-1"]]);
    expect(state.audits).toEqual(["listing.rates_saved"]);
    expect((await res.json()).view.lines[0].amount).toBe("$520.40 per quarter");
  });
  it("rejects bad input with 400 and saves nothing", async () => {
    const res = await route.PUT(put({ council: { cents: -1, period: "year" }, asAt: "2026-07-01" }), ctx(SALE));
    expect(res.status).toBe(400);
    expect(state.saved).toEqual([]);
  });
  it("refuses a rental with 422", async () => {
    expect((await route.PUT(put(RATES), ctx(RENT))).status).toBe(422);
  });
  it("hides the listing from other owners and signed-out users on write (404 / 401)", async () => {
    state.actor = other;
    expect((await route.PUT(put(RATES), ctx(SALE))).status).toBe(404);
    state.actor = null;
    expect((await route.PUT(put(RATES), ctx(SALE))).status).toBe(401);
    expect(state.saved).toEqual([]);
  });
  it("refuses a cross-site write", async () => {
    const r = new Request("http://test/x", { method: "PUT", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: "{}" });
    expect((await route.PUT(r, ctx(SALE))).status).toBe(403);
  });
  it("shows rates publicly only for a published sale listing", async () => {
    state.actor = null;
    expect((await route.GET(get(), ctx(SALE))).status).toBeGreaterThanOrEqual(401);
    const repo = (state.deps as { repo: ReturnType<typeof createInMemoryListingRepository> }).repo;
    const rec = (await repo.get(SALE))!;
    await repo.save({ ...rec, listing: { ...rec.listing, status: "published" } });
    const res = await route.GET(get(), ctx(SALE));
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.editable).toBe(false);
    expect(d.view.lines).toHaveLength(1);
    expect(res.headers.get("cache-control")).toContain("public");
  });
  it("lets the owner read a draft and marks it editable; other owners get 404", async () => {
    const d = await (await route.GET(get(), ctx(SALE))).json();
    expect(d.editable).toBe(true);
    expect(d.rates).toEqual(RATES);
    state.actor = other;
    expect((await route.GET(get(), ctx(SALE))).status).toBe(404);
  });
  it("404s a rental on read", async () => {
    expect((await route.GET(get(), ctx(RENT))).status).toBe(404);
  });
});

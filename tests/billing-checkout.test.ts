import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isListingFeePaid, type Invoice, type PaymentEvent } from "../src/domain/billing";
import type { BillingStore, PriceRow } from "../src/domain/billing-service";
import { parsePriceInput } from "../src/domain/billing-service";
import type { Actor } from "../src/domain/listing-service";
import type { StaffActor } from "../src/domain/staff-access";
import { createPgBillingStore } from "../src/server/billing-db";
import type { Queryable } from "../src/server/db";

const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const LISTING = "00000000-0000-4000-8000-0000000000a1";
const APP = "https://app.example.com";
const SECRET = "test-secret-not-real";

class MemStore implements BillingStore {
  prices: Record<string, number> = {};
  history: PriceRow[] = [];
  invoices: Invoice[] = [];
  events = new Map<string, PaymentEvent>();
  cases: string[] = [];
  feePaid = false;
  async listingOwner(id: string) { return id === LISTING ? OWNER : undefined; }
  async currentPrices() { return { ...this.prices }; }
  async priceHistory() { return this.history; }
  async addPrice(r: { planId: string; priceCents: number; reason: string; setBy: string }) {
    this.prices[r.planId] = r.priceCents;
    this.history.unshift({ id: String(this.history.length), effectiveFrom: "2026-10-24T00:00:00.000Z", ...r });
  }
  async invoicesForListing(id: string) { return this.invoices.filter(i => i.listingId === id && i.status !== "failed"); }
  async getInvoice(id: string) { return this.invoices.find(i => i.id === id); }
  async replaceInvoices(ids: readonly string[], inv: Invoice) {
    this.invoices = this.invoices.map(i => (ids.includes(i.id) ? { ...i, status: "failed" as const } : i));
    this.invoices.push(inv);
  }
  async eventSeen(id: string) { return this.events.has(id); }
  async settle(inv: Invoice, e: PaymentEvent) {
    this.invoices = this.invoices.map(i => (i.id === inv.id ? inv : i));
    if (inv.status === "paid") this.feePaid = true;
    this.events.set(e.eventId, e);
  }
  async flagMismatch(inv: Invoice, e: PaymentEvent, reason: string) { this.events.set(e.eventId, e); this.cases.push(`${inv.id}:${reason}`); }
}

const state = vi.hoisted(() => ({ store: null as unknown, actor: null as Actor | null, staff: null as StaffActor | null }));
vi.mock("../src/server/context", () => ({
  getActor: async () => state.actor,
  getStaff: async () => state.staff,
  getBilling: () => state.store,
  getDeps: () => null,
  getDb: () => null
}));

import * as checkoutRoute from "../app/api/listings/[id]/checkout/route";
import * as plansRoute from "../app/api/plans/route";
import * as pricingRoute from "../app/api/staff/pricing/route";
import * as webhookRoute from "../app/api/webhooks/payway/route";

let store: MemStore;
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  store = new MemStore();
  state.store = store;
  state.actor = { userId: OWNER, userType: "owner" };
  state.staff = { id: "s1", role: "super_admin" };
  savedEnv = { APP_URL: process.env["APP_URL"], PAYWAY_WEBHOOK_SECRET: process.env["PAYWAY_WEBHOOK_SECRET"], PAYWAY_MERCHANT_ID: process.env["PAYWAY_MERCHANT_ID"], PAYWAY_API_KEY: process.env["PAYWAY_API_KEY"] };
  process.env["APP_URL"] = APP;
  delete process.env["PAYWAY_WEBHOOK_SECRET"]; delete process.env["PAYWAY_MERCHANT_ID"]; delete process.env["PAYWAY_API_KEY"];
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const post = (url: string, body: unknown, headers: Record<string, string> = { origin: APP }) =>
  new Request(`${APP}${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const checkout = (planId: string, headers?: Record<string, string>) =>
  checkoutRoute.POST(post(`/api/listings/${LISTING}/checkout`, { planId }, headers), { params: Promise.resolve({ id: LISTING }) });
const setPrice = (planId: string, priceCents: number) => store.addPrice({ planId, priceCents, reason: "test", setBy: "s1" });

describe("public plans", () => {
  it("shows entitlements, price excluding GST with GST, and null for an unpriced plan", async () => {
    await setPrice("standard", 10000);
    const d = await (await plansRoute.GET()).json();
    expect(d.gstPercent).toBe(10);
    const by = Object.fromEntries(d.plans.map((p: { id: string }) => [p.id, p]));
    expect(by.standard.price).toEqual({ exGstCents: 10000, gstCents: 1000, totalCents: 11000 });
    expect(by.basic.price).toBeNull();
    expect(by.premium.price).toBeNull();
    expect(by.standard.features).toContain("video");
    expect(by.basic.maxPhotos).toBe(15);
  });
});

describe("pricing API", () => {
  const body = { planId: "basic", priceCents: 5000, reason: "Launch price" };
  it("lets only pricing.manage (super admin) set or read prices", async () => {
    for (const role of ["compliance", "accountant", "support", "technical", "reporting"] as const) {
      state.staff = { id: "s2", role };
      expect((await pricingRoute.POST(post("/api/staff/pricing", body))).status).toBe(403);
      expect((await pricingRoute.GET(new Request(`${APP}/api/staff/pricing`))).status).toBe(403);
    }
    state.staff = null;
    expect((await pricingRoute.POST(post("/api/staff/pricing", body))).status).toBe(401);
    expect(store.history).toHaveLength(0);
    state.staff = { id: "s1", role: "super_admin" };
    expect((await pricingRoute.POST(post("/api/staff/pricing", body))).status).toBe(201);
    const d = await (await pricingRoute.GET(new Request(`${APP}/api/staff/pricing`))).json();
    expect(d.current).toEqual({ basic: 5000 });
    expect(d.history[0].reason).toBe("Launch price");
  });
  it("requires a same-origin JSON request (csrfGuard)", async () => {
    expect((await pricingRoute.POST(post("/api/staff/pricing", body, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await pricingRoute.POST(post("/api/staff/pricing", body, {}))).status).toBe(403);
    expect(store.history).toHaveLength(0);
  });
  it("rejects a missing reason, bad plan and bad price; a new price is a new row with history kept", async () => {
    for (const bad of [{ ...body, reason: "" }, { ...body, reason: "  x " }, { ...body, planId: "gold" }, { ...body, priceCents: 0 },
      { ...body, priceCents: 10.5 }, { ...body, priceCents: -1 }, { ...body, priceCents: "5" }, null]) {
      expect((await pricingRoute.POST(post("/api/staff/pricing", bad))).status).toBe(400);
    }
    expect(parsePriceInput({ ...body, reason: " ok reason " })).toMatchObject({ ok: true, value: { reason: "ok reason" } });
    await pricingRoute.POST(post("/api/staff/pricing", body));
    await pricingRoute.POST(post("/api/staff/pricing", { ...body, priceCents: 6000, reason: "Raised" }));
    expect(store.history.map(h => h.priceCents)).toEqual([6000, 5000]);
  });
});

describe("owner checkout", () => {
  it("cannot buy an unpriced plan, and no invoice is made", async () => {
    const r = await checkout("standard");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/not been set/);
    expect(store.invoices).toHaveLength(0);
  });
  it("rejects an unknown plan", async () => {
    expect((await checkout("gold")).status).toBe(400);
  });
  it("requires sign-in and a same-origin request", async () => {
    await setPrice("standard", 10000);
    state.actor = null;
    expect((await checkout("standard")).status).toBe(401);
    state.actor = { userId: OWNER, userType: "owner" };
    expect((await checkout("standard", { origin: "https://evil.example" })).status).toBe(403);
    expect(store.invoices).toHaveLength(0);
  });
  it("another user cannot check out someone else's listing, and a missing listing looks the same", async () => {
    await setPrice("standard", 10000);
    state.actor = { userId: OTHER, userType: "owner" };
    expect((await checkout("standard")).status).toBe(404);
    state.actor = { userId: OWNER, userType: "owner" };
    const r = await checkoutRoute.POST(post("/api/listings/x/checkout", { planId: "standard" }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000ff" }) });
    expect(r.status).toBe(404);
    expect(store.invoices).toHaveLength(0);
  });
  it("creates a GST invoice, answers 'not available yet' while PayWay is unconfigured, and leaves the listing unpaid", async () => {
    await setPrice("standard", 10000);
    const r = await checkout("standard");
    expect(r.status).toBe(503);
    const d = await r.json();
    expect(d.error).toBe("Online payment is not available yet.");
    expect(d.invoice).toMatchObject({ amountExGstCents: 10000, gstCents: 1000, totalCents: 11000, status: "pending", listingId: LISTING, planId: "standard" });
    expect(isListingFeePaid(store.invoices, LISTING, OWNER)).toBe(false);
    expect(store.feePaid).toBe(false);
  });
  it("stays unavailable when PayWay settings are set, because the adapter is fail-closed", async () => {
    await setPrice("standard", 10000);
    process.env["PAYWAY_MERCHANT_ID"] = "m"; process.env["PAYWAY_API_KEY"] = "k"; process.env["PAYWAY_WEBHOOK_SECRET"] = SECRET;
    expect((await checkout("standard")).status).toBe(503);
    expect(store.invoices[0]?.status).toBe("pending");
  });
  it("is idempotent: repeating checkout reuses the same invoice", async () => {
    await setPrice("standard", 10000);
    await checkout("standard"); await checkout("standard");
    expect(store.invoices).toHaveLength(1);
  });
  it("keeps the locked price when the admin changes the price afterwards", async () => {
    await setPrice("standard", 10000);
    await checkout("standard");
    await setPrice("standard", 99900);
    const d = await (await checkout("standard")).json();
    expect(d.invoice.amountExGstCents).toBe(10000);
    expect(store.invoices).toHaveLength(1);
  });
  it("choosing another plan replaces the pending invoice, so only one is live", async () => {
    await setPrice("standard", 10000); await setPrice("premium", 20000);
    await checkout("standard"); await checkout("premium");
    expect(store.invoices.map(i => `${i.planId}:${i.status}`)).toEqual(["standard:failed", "premium:pending"]);
  });
  it("redirects to the hosted page when a provider is connected, and returns paid invoices as already paid", async () => {
    await setPrice("standard", 10000);
    vi.resetModules();
    vi.doMock("../src/adapters/westpac-payway", () => ({
      paywayConfigFromEnv: () => ({}),
      createWestpacPayway: () => ({ createHostedCheckout: async () => ({ redirectUrl: "https://pay.example/hosted/1" }) })
    }));
    const fresh = await import("../app/api/listings/[id]/checkout/route");
    const r = await fresh.POST(post(`/api/listings/${LISTING}/checkout`, { planId: "standard" }), { params: Promise.resolve({ id: LISTING }) });
    expect((await r.json()).redirectUrl).toBe("https://pay.example/hosted/1");
    store.invoices = store.invoices.map(i => ({ ...i, status: "paid" as const }));
    const again = await fresh.POST(post(`/api/listings/${LISTING}/checkout`, { planId: "standard" }), { params: Promise.resolve({ id: LISTING }) });
    expect((await again.json()).alreadyPaid).toBe(true);
    vi.doUnmock("../src/adapters/westpac-payway");
  });
});

describe("payment webhook", () => {
  const INVOICE = "00000000-0000-4000-8000-0000000000b1";
  const invoice = (over: Partial<Invoice> = {}): Invoice =>
    ({ id: INVOICE, ownerUserId: OWNER, amountExGstCents: 10000, gstCents: 1000, totalCents: 11000, status: "pending", listingId: LISTING, planId: "standard", ...over });
  const event = (over: Partial<PaymentEvent> = {}): PaymentEvent =>
    ({ eventId: "evt-1", invoiceId: INVOICE, amountCents: 11000, outcome: "succeeded", providerRef: "ref-1", ...over });
  const sign = (raw: string, secret = SECRET) => createHmac("sha256", secret).update(raw).digest("hex");
  const hook = (e: unknown, opts: { secret?: string; sig?: string | null; raw?: string } = {}) => {
    const raw = opts.raw ?? JSON.stringify(e);
    const headers: Record<string, string> = {};
    const sig = opts.sig === undefined ? sign(raw, opts.secret) : opts.sig;
    if (sig !== null) headers["x-payway-signature"] = sig;
    return webhookRoute.POST(new Request(`${APP}/api/webhooks/payway`, { method: "POST", headers, body: raw }));
  };
  beforeEach(() => { store.invoices = [invoice()]; process.env["PAYWAY_WEBHOOK_SECRET"] = SECRET; });

  it("rejects everything while the secret is unset, even a correctly signed event", async () => {
    delete process.env["PAYWAY_WEBHOOK_SECRET"];
    for (const s of [undefined, "", SECRET]) {
      const r = await hook(event(), { sig: sign(JSON.stringify(event()), s || "") });
      expect(r.status).toBe(503);
    }
    expect(store.invoices[0]?.status).toBe("pending");
    expect(store.feePaid).toBe(false);
  });
  it("rejects a missing, wrong, malformed or wrong-secret signature", async () => {
    for (const sig of [null, "", "abc", "z".repeat(64), "0".repeat(64), sign(JSON.stringify(event()), "other-secret")]) {
      expect((await hook(event(), { sig })).status).toBe(401);
    }
    expect((await hook(event(), { raw: JSON.stringify(event()) + " ", sig: sign(JSON.stringify(event())) })).status).toBe(401);
    expect(store.invoices[0]?.status).toBe("pending");
    expect(store.events.size).toBe(0);
  });
  it("rejects a signed but malformed event", async () => {
    for (const bad of [{}, { ...event(), amountCents: "11000" }, { ...event(), amountCents: -1 }, { ...event(), outcome: "maybe" }, { ...event(), eventId: "" }]) {
      expect((await hook(bad)).status).toBe(400);
    }
    expect((await hook(null, { raw: "not json" })).status).toBe(400);
  });
  it("marks the invoice paid on a good event, and only then is the listing fee paid", async () => {
    expect(isListingFeePaid(store.invoices, LISTING, OWNER)).toBe(false);
    const r = await hook(event());
    expect(r.status).toBe(200);
    expect(store.invoices[0]).toMatchObject({ status: "paid", providerRef: "ref-1" });
    expect(isListingFeePaid(store.invoices, LISTING, OWNER)).toBe(true);
    expect(store.feePaid).toBe(true);
  });
  it("ignores a replayed event (idempotent) and never changes a paid invoice", async () => {
    await hook(event());
    const replay = await hook(event());
    expect(replay.status).toBe(200);
    expect((await replay.json()).note).toMatch(/Duplicate/);
    const lateFailure = await hook(event({ eventId: "evt-2", outcome: "failed" }));
    expect(lateFailure.status).toBe(200);
    expect(store.invoices[0]?.status).toBe("paid");
    expect(store.cases).toHaveLength(0);
  });
  it("does not pay on the wrong amount, and opens an admin case", async () => {
    for (const amountCents of [10000, 11001, 0]) {
      const r = await hook(event({ eventId: `evt-${amountCents}`, amountCents }));
      expect(r.status).toBe(409);
    }
    expect(store.invoices[0]?.status).toBe("pending");
    expect(store.feePaid).toBe(false);
    expect(store.cases).toHaveLength(3);
    expect(store.cases[0]).toMatch(/does not match/);
    expect((await hook(event({ eventId: "evt-10000", amountCents: 10000 }))).status).toBe(200);
    expect(store.cases).toHaveLength(3);
  });
  it("returns 404 for an unknown or non-UUID invoice and changes nothing", async () => {
    expect((await hook(event({ invoiceId: "00000000-0000-4000-8000-0000000000ee" }))).status).toBe(404);
    expect((await hook(event({ invoiceId: "'; DROP TABLE invoice;--" }))).status).toBe(404);
    expect(store.invoices[0]?.status).toBe("pending");
  });
  it("flags a payment for an invoice that was replaced, instead of marking it paid", async () => {
    store.invoices = [invoice({ status: "failed" })];
    expect((await hook(event())).status).toBe(409);
    expect(store.invoices[0]?.status).toBe("failed");
    expect(store.feePaid).toBe(false);
    expect(store.cases).toHaveLength(1);
  });
  it("records a failed payment without paying", async () => {
    expect((await hook(event({ outcome: "failed" }))).status).toBe(200);
    expect(store.invoices[0]?.status).toBe("failed");
    expect(store.feePaid).toBe(false);
  });
  it("has no csrf requirement: the signature is the authentication", async () => {
    const raw = JSON.stringify(event());
    const r = await webhookRoute.POST(new Request(`${APP}/api/webhooks/payway`, { method: "POST", headers: { "x-payway-signature": sign(raw), origin: "https://provider.example" }, body: raw }));
    expect(r.status).toBe(200);
  });
});

describe("pg billing store", () => {
  function fakeDb(rows: Record<string, unknown>[] = []) {
    const calls: { text: string; params: unknown[] }[] = [];
    const db: Queryable = { async query(text, params) { calls.push({ text, params: params ?? [] }); return { rows: /^\s*(SELECT|INSERT INTO plan_price)/.test(text) ? rows : [] }; } };
    return { db, calls };
  }
  it("inserts a new price row with its reason and never updates old rows", async () => {
    const { db, calls } = fakeDb([{ id: "p1" }]);
    await createPgBillingStore(db).addPrice({ planId: "basic", priceCents: 500, reason: "why", setBy: "s1" });
    expect(calls[0]?.text).toMatch(/^INSERT INTO plan_price/);
    expect(calls[0]?.params).toEqual(["basic", 500, "s1", "why"]);
    expect(calls.some(c => /UPDATE plan_price|DELETE/.test(c.text))).toBe(false);
  });
  it("settles a paid event: pending invoice only, then the listing fee for that owner, then the event row", async () => {
    const { db, calls } = fakeDb();
    await createPgBillingStore(db).settle(invoiceFor("paid"), { eventId: "e", invoiceId: "i", amountCents: 11000, outcome: "succeeded", providerRef: "r" });
    expect(calls[0]?.text).toMatch(/WHERE id = \$1 AND status = 'pending'/);
    expect(calls[1]?.text).toMatch(/SET listing_fee_paid = true.*owner_user_id = \$2/s);
    expect(calls[1]?.params).toEqual([LISTING, OWNER]);
    expect(calls[2]?.text).toMatch(/ON CONFLICT \(event_id\) DO NOTHING/);
  });
  it("reads bigint cents (strings from pg) as numbers", async () => {
    const { db } = fakeDb([{ id: "i", owner_user_id: OWNER, amount_ex_gst_cents: "10000", gst_cents: "1000", total_cents: "11000", status: "pending", provider_ref: null, listing_id: LISTING, plan_id: "standard" }]);
    expect(await createPgBillingStore(db).getInvoice("i")).toMatchObject({ totalCents: 11000, amountExGstCents: 10000 });
  });
});

function invoiceFor(status: Invoice["status"]): Invoice {
  return { id: "i", ownerUserId: OWNER, amountExGstCents: 10000, gstCents: 1000, totalCents: 11000, status, listingId: LISTING, planId: "standard" };
}

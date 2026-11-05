import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/domain/listing-service";
import type { StaffActor } from "../src/domain/staff-access";
import type { Queryable } from "../src/server/db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const APP = "https://app.example.com";
const state = vi.hoisted(() => ({ db: null as unknown, actor: null as Actor | null, staff: null as StaffActor | null }));
vi.mock("../src/server/context", () => ({
  getActor: async () => state.actor,
  getStaff: async () => state.staff,
  getDb: () => state.db,
  getBilling: () => null,
  getDeps: () => null
}));

import * as billingRoute from "../app/api/billing/route";
import * as subscribeRoute from "../app/api/billing/subscribe/route";
import * as subscriptionRoute from "../app/api/billing/subscription/route";
import * as invoiceRoute from "../app/api/billing/invoices/[id]/route";
import * as payRoute from "../app/api/billing/invoices/[id]/pay/route";
import * as disputeRoute from "../app/api/billing/invoices/[id]/dispute/route";
import * as assistantRoute from "../app/api/billing/assistant/route";
import * as financeRoute from "../app/api/staff/finance/route";
import * as financeInvoices from "../app/api/staff/finance/invoices/route";
import * as bankRoute from "../app/api/staff/finance/invoices/[id]/bank-transfer/route";
import * as disputesRoute from "../app/api/staff/finance/disputes/route";
import * as disputeResolveRoute from "../app/api/staff/finance/disputes/[id]/route";
import * as runRoute from "../app/api/internal/billing/run/route";

const post = (url: string, body: unknown, headers: Record<string, string> = { origin: APP }) =>
  new Request(`${APP}${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const get = (url: string) => new Request(`${APP}${url}`);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(!DATABASE_URL)("billing routes (Postgres)", () => {
  let t: TestDb;
  let owner: string, other: string, agent: string, admin: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ["APP_URL", "PAYWAY_MERCHANT_ID", "PAYWAY_API_KEY", "PAYWAY_WEBHOOK_SECRET", "BANK_TRANSFER_ACCOUNT_NAME", "BANK_TRANSFER_BSB", "BANK_TRANSFER_ACCOUNT_NUMBER", "BILLING_RUN_CRON_SECRET"];

  beforeAll(async () => {
    t = await createTestDb();
    state.db = t.db as Queryable;
    [owner, other, agent, admin] = [await addUser(t.db, "owner"), await addUser(t.db, "owner"), await addUser(t.db, "agent"), await addUser(t.db, "admin")] as [string, string, string, string];
    await t.db.query("INSERT INTO plan_price (plan_id, price_cents, set_by, reason) VALUES ('owner_plus', 5000, $1, 'x'), ('agent_pro', 10000, $1, 'x')", [admin]);
  }, 60_000);
  afterAll(async () => { await t?.close(); });
  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env["APP_URL"] = APP;
    for (const k of ENV.slice(1)) delete process.env[k];
    state.actor = { userId: owner, userType: "owner" };
    state.staff = { id: admin, role: "accountant" };
  });
  afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("every customer route answers 401 when signed out", async () => {
    state.actor = null;
    const bodies = await Promise.all([
      billingRoute.GET(get("/api/billing")), subscribeRoute.POST(post("/api/billing/subscribe", { planId: "owner_plus", interval: "monthly" })),
      subscriptionRoute.POST(post("/api/billing/subscription", { cancel: true })), invoiceRoute.GET(get("/api/billing/invoices/x"), ctx("x")),
      payRoute.POST(post("/api/billing/invoices/x/pay", {}), ctx("x")), disputeRoute.POST(post("/api/billing/invoices/x/dispute", { reason: "long enough reason" }), ctx("x")),
      assistantRoute.POST(post("/api/billing/assistant", { text: "hi" }))
    ]);
    expect(bodies.map(r => r.status)).toEqual([401, 401, 401, 401, 401, 401, 401]);
  });

  it("every state-changing customer route rejects a cross-origin request", async () => {
    const evil = { origin: "https://evil.example" };
    const rs = await Promise.all([
      subscribeRoute.POST(post("/api/billing/subscribe", { planId: "owner_plus", interval: "monthly" }, evil)),
      subscriptionRoute.POST(post("/api/billing/subscription", { cancel: true }, evil)),
      payRoute.POST(post("/api/billing/invoices/x/pay", {}, evil), ctx("x")),
      disputeRoute.POST(post("/api/billing/invoices/x/dispute", { reason: "long enough reason" }, evil), ctx("x")),
      assistantRoute.POST(post("/api/billing/assistant", { text: "hi" }, evil)),
      bankRoute.POST(post("/api/staff/finance/invoices/x/bank-transfer", { amountCents: 1, reference: "abc" }, evil), ctx("x")),
      disputeResolveRoute.POST(post("/api/staff/finance/disputes/x", { outcome: "resolved", resolution: "long enough text" }, evil), ctx("x"))
    ]);
    expect(rs.map(r => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
  });

  it("shows an owner only owner plans, with GST, and an unpriced plan as null", async () => {
    const d = await (await billingRoute.GET(get("/api/billing"))).json();
    expect(d.plans.map((p: { id: string }) => p.id)).toEqual(["owner_plus"]);
    expect(d.plans[0].monthly).toEqual({ exGstCents: 5_000, gstCents: 500, totalCents: 5_500 });
    expect(d.plans[0].yearly.exGstCents).toBe(50_000);
    expect(d.cardAvailable).toBe(false);
    expect(d.bankTransferAvailable).toBe(false);
    state.actor = { userId: agent, userType: "agent" };
    const a = await (await billingRoute.GET(get("/api/billing"))).json();
    expect(a.plans.map((p: { id: string }) => p.id)).toEqual(["agent_pro", "agent_team"]);
    expect(a.plans[1].monthly).toBeNull();
  });

  it("subscribes, validates input, and keeps invoices private", async () => {
    expect((await subscribeRoute.POST(post("/api/billing/subscribe", { planId: "owner_plus", interval: "weekly" }))).status).toBe(400);
    expect((await subscribeRoute.POST(post("/api/billing/subscribe", { planId: "agent_pro", interval: "monthly" }))).status).toBe(400);
    const ok = await subscribeRoute.POST(post("/api/billing/subscribe", { planId: "owner_plus", interval: "monthly" }));
    expect(ok.status).toBe(201);
    const { invoice } = await ok.json();
    expect(invoice).toMatchObject({ totalCents: 5_500, kind: "subscription" });

    expect((await invoiceRoute.GET(get(`/api/billing/invoices/${invoice.id}`), ctx(invoice.id))).status).toBe(200);
    state.actor = { userId: other, userType: "owner" };
    expect((await invoiceRoute.GET(get(`/api/billing/invoices/${invoice.id}`), ctx(invoice.id))).status).toBe(404);
    expect((await payRoute.POST(post("/api/billing/invoices/x/pay", {}), ctx(invoice.id))).status).toBe(404);
    expect((await disputeRoute.POST(post("/x", { reason: "this is not my invoice!" }), ctx(invoice.id))).status).toBe(404);
    expect((await invoiceRoute.GET(get("/api/billing/invoices/not-a-uuid"), ctx("not-a-uuid"))).status).toBe(404);
  });

  it("shows bank details on an unpaid invoice only when all three settings are valid, never on a paid one", async () => {
    const inv = (await t.db.query("SELECT id FROM invoice WHERE owner_user_id = $1 LIMIT 1", [owner])).rows[0]!["id"] as string;
    expect((await (await invoiceRoute.GET(get("/x"), ctx(inv))).json()).bank).toBeNull();
    process.env["BANK_TRANSFER_ACCOUNT_NAME"] = "OwnerListing Pty Ltd"; process.env["BANK_TRANSFER_BSB"] = "034-123"; process.env["BANK_TRANSFER_ACCOUNT_NUMBER"] = "123456789";
    expect((await (await invoiceRoute.GET(get("/x"), ctx(inv))).json()).bank).toEqual({ accountName: "OwnerListing Pty Ltd", bsb: "034-123", accountNumber: "123456789" });
    process.env["BANK_TRANSFER_BSB"] = "12";
    expect((await (await invoiceRoute.GET(get("/x"), ctx(inv))).json()).bank).toBeNull();
    process.env["BANK_TRANSFER_BSB"] = "034123";
    await t.db.query("UPDATE invoice SET status = 'paid', paid_at = now() WHERE id = $1", [inv]);
    expect((await (await invoiceRoute.GET(get("/x"), ctx(inv))).json()).bank).toBeNull();
    await t.db.query("UPDATE invoice SET status = 'pending', paid_at = NULL WHERE id = $1", [inv]);
  });

  it("card payment answers 503 until PayWay is connected", async () => {
    const inv = (await t.db.query("SELECT id FROM invoice WHERE owner_user_id = $1 LIMIT 1", [owner])).rows[0]!["id"] as string;
    const r = await payRoute.POST(post("/x", {}), ctx(inv));
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatch(/not available yet/);
  });

  it("cancels and resumes a plan", async () => {
    expect((await subscriptionRoute.POST(post("/x", { cancel: "yes" }))).status).toBe(400);
    expect((await subscriptionRoute.POST(post("/x", { cancel: true }))).status).toBe(200); // pending plan is cancelled at once
    expect((await subscriptionRoute.POST(post("/x", { cancel: true }))).status).toBe(404);
  });

  it("raises a payment issue with validation", async () => {
    const id = (await t.db.query("INSERT INTO invoice (owner_user_id, amount_ex_gst_cents, gst_cents, total_cents) VALUES ($1,100,10,110) RETURNING id", [owner])).rows[0]!["id"] as string;
    expect((await disputeRoute.POST(post("/x", { reason: "short" }), ctx(id))).status).toBe(400);
    expect((await disputeRoute.POST(post("/x", { reason: "card 4111111111111111 was charged" }), ctx(id))).status).toBe(400);
    expect((await disputeRoute.POST(post("/x", { reason: "I was charged twice in May" }), ctx(id))).status).toBe(201);
    expect((await disputeRoute.POST(post("/x", { reason: "I was charged twice in May" }), ctx(id))).status).toBe(409);
  });

  it("Elena answers from the signed-in person's own data and drops the typed text", async () => {
    const r = await assistantRoute.POST(post("/api/billing/assistant", { text: "what do I owe, anything overdue?" }));
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.topic).toBe("overdue");
    expect(d.text).toMatch(/unpaid invoice/);
    expect(d.disclaimer).toBeTruthy();
    expect(JSON.stringify(await (await t.db.query("SELECT payload FROM audit_event")).rows)).not.toMatch(/anything overdue/);
    state.actor = { userId: other, userType: "owner" };
    expect((await (await assistantRoute.POST(post("/x", { text: "what do I owe" }))).json()).text).toMatch(/no unpaid invoices/);
    expect((await assistantRoute.POST(post("/x", { text: "x".repeat(301) }))).status).toBe(400);
    expect((await assistantRoute.POST(post("/x", { topic: "gst" }))).status).toBe(200);
    expect((await assistantRoute.POST(new Request(`${APP}/x`, { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: "{nope" }))).status).toBe(400);
  });

  describe("staff finance", () => {
    it("is open to report.financial only, and 401 when signed out", async () => {
      state.staff = null;
      expect((await financeRoute.GET(get("/api/staff/finance"))).status).toBe(401);
      for (const role of ["compliance", "support", "technical", "reporting", "designer"] as const) {
        state.staff = { id: admin, role };
        expect((await financeRoute.GET(get("/api/staff/finance"))).status, role).toBe(403);
        expect((await financeInvoices.GET(get("/api/staff/finance/invoices"))).status, role).toBe(403);
      }
      for (const role of ["accountant", "super_admin"] as const) {
        state.staff = { id: admin, role };
        expect((await financeRoute.GET(get("/api/staff/finance"))).status, role).toBe(200);
      }
    });

    it("returns the report with insights, validates days and filter, and exports CSV", async () => {
      const d = await (await financeRoute.GET(get("/api/staff/finance?days=90"))).json();
      expect(d.report.days).toBe(90);
      expect(d.report.trend).toHaveLength(12);
      expect(d.insights.length).toBeGreaterThan(0);
      expect(d.canManage).toBe(true);
      expect((await financeRoute.GET(get("/api/staff/finance?days=5"))).status).toBe(400);
      expect((await financeInvoices.GET(get("/api/staff/finance/invoices?filter=bogus"))).status).toBe(400);
      const csv = await financeRoute.GET(get("/api/staff/finance?format=csv"));
      expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
      expect(await csv.text()).toMatch(/^month,revenue_ex_gst_cents,paid_invoices\n/);
      const list = await (await financeInvoices.GET(get("/api/staff/finance/invoices?filter=pending"))).json();
      expect(JSON.stringify(list)).not.toMatch(/@example\.test|Test owner/);
    });

    it("bank transfer and payment issues need billing.manage (accountant and super admin, not reporting)", async () => {
      const inv = (await t.db.query("INSERT INTO invoice (owner_user_id, amount_ex_gst_cents, gst_cents, total_cents, due_at) VALUES ($1,1000,100,1100, now()) RETURNING id", [owner])).rows[0]!["id"] as string;
      state.staff = { id: admin, role: "reporting" };
      expect((await bankRoute.POST(post("/x", { amountCents: 1100, reference: "TFR 9" }), ctx(inv))).status).toBe(403);
      expect((await disputesRoute.GET(get("/api/staff/finance/disputes"))).status).toBe(403);
      state.staff = { id: admin, role: "accountant" };
      expect((await bankRoute.POST(post("/x", { amountCents: "1100", reference: "TFR 9" }), ctx(inv))).status).toBe(400);
      expect((await bankRoute.POST(post("/x", { amountCents: 1000, reference: "TFR 9" }), ctx(inv))).status).toBe(409);
      expect((await bankRoute.POST(post("/x", { amountCents: 1100, reference: "TFR 9" }), ctx(inv))).status).toBe(200);
      expect((await t.db.query("SELECT status FROM invoice WHERE id = $1", [inv])).rows[0]!["status"]).toBe("paid");
    });

    it("lists and answers payment issues", async () => {
      const list = await (await disputesRoute.GET(get("/api/staff/finance/disputes"))).json();
      expect(list.disputes.length).toBeGreaterThan(0);
      expect((await disputesRoute.GET(get("/api/staff/finance/disputes?status=weird"))).status).toBe(400);
      const id = list.disputes[0].id as string;
      expect((await disputeResolveRoute.POST(post("/x", { outcome: "maybe", resolution: "long enough text" }), ctx(id))).status).toBe(400);
      expect((await disputeResolveRoute.POST(post("/x", { outcome: "resolved", resolution: "Refunded by the bank on 3 Nov." }), ctx(id))).status).toBe(200);
      expect((await disputeResolveRoute.POST(post("/x", { outcome: "resolved", resolution: "Refunded by the bank on 3 Nov." }), ctx(id))).status).toBe(409);
      expect((await (await disputesRoute.GET(get("/api/staff/finance/disputes?status=closed"))).json()).disputes.some((d: { id: string }) => d.id === id)).toBe(true);
    });
  });

  describe("daily billing run", () => {
    const run = (secret?: string) => runRoute.POST(new Request(`${APP}/api/internal/billing/run`, { method: "POST", headers: secret === undefined ? {} : { "x-cron-secret": secret } }));
    it("fails closed without a secret of 32+ characters and rejects a wrong one", async () => {
      expect((await run("anything")).status).toBe(503);
      process.env["BILLING_RUN_CRON_SECRET"] = "short";
      expect((await run("short")).status).toBe(503);
      process.env["BILLING_RUN_CRON_SECRET"] = "s".repeat(40);
      expect((await run()).status).toBe(401);
      expect((await run("wrong")).status).toBe(401);
    });
    it("runs with the right secret and reports counts", async () => {
      process.env["BILLING_RUN_CRON_SECRET"] = "s".repeat(40);
      const r = await run("s".repeat(40));
      expect(r.status).toBe(200);
      expect(Object.keys((await r.json()).counts).sort()).toEqual(["ended", "expired", "pastDue", "remindersSent", "remindersSkipped", "renewalInvoices"]);
    });
  });
});

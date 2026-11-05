import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage, EmailPort } from "../src/adapters/email";
import { createPgBillingStore } from "../src/server/billing-db";
import { buildFinanceReport } from "../src/domain/finance-report";
import { confirmBankTransfer, listDisputes, listStaffInvoices, loadFinanceRaw, resolveDispute } from "../src/server/finance-db";
import { getMyInvoice, loadMyBilling, raiseDispute, runBillingCycle, setCancelAtPeriodEnd, startSubscription } from "../src/server/subscription-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const day = (n: number, from = Date.now()) => new Date(from + n * 86_400_000).toISOString();

function fakeEmail(configured = true): EmailPort & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return { configured, sent, async send(m) { sent.push(m); return { status: "sent" }; } };
}

// Real PostgreSQL with every migration applied. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("billing system (Postgres)", () => {
  let t: TestDb;
  const setPrice = async (planId: string, cents: number, by: string) =>
    t.db.query("INSERT INTO plan_price (plan_id, price_cents, set_by, reason) VALUES ($1,$2,$3,'test price')", [planId, cents, by]);
  const pay = async (invoiceId: string, total: number, id = `evt-${invoiceId}`) => {
    const store = createPgBillingStore(t.db);
    const inv = (await store.getInvoice(invoiceId))!;
    await store.settle({ ...inv, status: "paid" }, { eventId: id, invoiceId, amountCents: total, outcome: "succeeded", providerRef: "ref" });
  };
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("migrates: numbered invoices, new statuses, and the three subscription plans exist", async () => {
    const plans = (await t.db.query("SELECT id FROM plan ORDER BY id")).rows.map(r => r["id"]);
    expect(plans).toEqual(expect.arrayContaining(["agent_pro", "agent_team", "owner_plus", "basic"]));
    const owner = await addUser(t.db, "owner");
    const a = (await t.db.query("INSERT INTO invoice (owner_user_id, amount_ex_gst_cents, gst_cents, total_cents) VALUES ($1,100,10,110) RETURNING invoice_number, kind", [owner])).rows[0]!;
    const b = (await t.db.query("INSERT INTO invoice (owner_user_id, amount_ex_gst_cents, gst_cents, total_cents) VALUES ($1,100,10,110) RETURNING invoice_number", [owner])).rows[0]!;
    expect(String(a["invoice_number"])).toMatch(/^INV-\d{6}$/);
    expect(a["invoice_number"]).not.toBe(b["invoice_number"]);
    await expect(t.db.query("UPDATE invoice SET status = 'bogus'")).rejects.toThrow();
  });

  describe("subscribing", () => {
    it("refuses an unpriced plan, the wrong account type, and unknown plans", async () => {
      const agent = await addUser(t.db, "agent");
      const owner = await addUser(t.db, "owner");
      expect(await startSubscription(t.db, agent, "agent", "agent_pro", "monthly", day(0))).toMatchObject({ ok: false, code: "invalid", message: expect.stringMatching(/price has not been set/) });
      const admin = await addUser(t.db, "admin");
      await setPrice("agent_pro", 10_000, admin);
      expect(await startSubscription(t.db, owner, "owner", "agent_pro", "monthly", day(0))).toMatchObject({ ok: false, message: expect.stringMatching(/not available for your account type/) });
      expect(await startSubscription(t.db, agent, "agent", "premium", "monthly", day(0))).toMatchObject({ ok: false });
    });

    it("creates a pending plan and a numbered invoice with GST; nothing is active until paid", async () => {
      const admin = await addUser(t.db, "admin");
      await setPrice("agent_pro", 10_000, admin);
      const agent = await addUser(t.db, "agent");
      const r = await startSubscription(t.db, agent, "agent", "agent_pro", "yearly", day(0));
      if (!r.ok) throw new Error(r.message);
      expect(r.invoice).toMatchObject({ amountExGstCents: 100_000, gstCents: 10_000, totalCents: 110_000, kind: "subscription", status: "pending" });
      expect(r.subscription.status).toBe("pending");
      const mine = await loadMyBilling(t.db, agent);
      expect(mine.subscription?.status).toBe("pending");
      expect(mine.invoices[0]).toMatchObject({ kind: "subscription", status: "pending", invoiceNumber: expect.stringMatching(/^INV-/) });
      expect(mine.invoices[0]?.dueAt).toBeTruthy();
    });

    it("is idempotent for the same choice, replaces a pending one for another, and blocks a second live plan", async () => {
      const admin = await addUser(t.db, "admin");
      await setPrice("agent_pro", 10_000, admin); await setPrice("agent_team", 30_000, admin);
      const agent = await addUser(t.db, "agent");
      const a = await startSubscription(t.db, agent, "agent", "agent_pro", "monthly", day(0));
      const again = await startSubscription(t.db, agent, "agent", "agent_pro", "monthly", day(0));
      if (!a.ok || !again.ok) throw new Error("expected ok");
      expect(again.invoice.id).toBe(a.invoice.id);
      const b = await startSubscription(t.db, agent, "agent", "agent_team", "monthly", day(0));
      if (!b.ok) throw new Error(b.message);
      expect(b.invoice.id).not.toBe(a.invoice.id);
      expect((await createPgBillingStore(t.db).getInvoice(a.invoice.id))?.status).toBe("void");
      await pay(b.invoice.id, b.invoice.totalCents);
      expect(await startSubscription(t.db, agent, "agent", "agent_pro", "monthly", day(0))).toMatchObject({ ok: false, code: "conflict" });
    });

    it("keeps the locked price when the admin changes it later", async () => {
      const admin = await addUser(t.db, "admin");
      await setPrice("owner_plus", 5_000, admin);
      const owner = await addUser(t.db, "owner");
      const r = await startSubscription(t.db, owner, "owner", "owner_plus", "monthly", day(0));
      if (!r.ok) throw new Error(r.message);
      await pay(r.invoice.id, r.invoice.totalCents);
      await setPrice("owner_plus", 9_000, admin);
      const sub = (await loadMyBilling(t.db, owner)).subscription!;
      expect(sub.priceSnapshotCents).toBe(5_000);
    });
  });

  describe("paying, renewing, cancelling", () => {
    it("starts the plan when the first invoice is paid, then renews by invoice and extends the period", async () => {
      const admin = await addUser(t.db, "admin");
      await setPrice("agent_pro", 10_000, admin);
      const agent = await addUser(t.db, "agent");
      const start = await startSubscription(t.db, agent, "agent", "agent_pro", "monthly", day(0));
      if (!start.ok) throw new Error(start.message);
      await pay(start.invoice.id, 11_000);
      let sub = (await loadMyBilling(t.db, agent)).subscription!;
      expect(sub.status).toBe("active");
      const firstEnd = Date.parse(sub.endsAt);
      expect(firstEnd).toBeGreaterThan(Date.now() + 27 * 86_400_000);

      // Not yet in the renewal window: nothing happens.
      const email = fakeEmail();
      const deps = { email, siteName: "OwnerListing", baseUrl: "https://example.test" };
      expect(await runBillingCycle(t.db, day(0), deps)).toMatchObject({ renewalInvoices: 0 });

      // Inside the window: one renewal invoice, and a second run does not make another.
      const near = new Date(firstEnd - 3 * 86_400_000).toISOString();
      expect((await runBillingCycle(t.db, near, deps)).renewalInvoices).toBeGreaterThanOrEqual(1);
      expect((await runBillingCycle(t.db, near, deps)).renewalInvoices).toBe(0);
      const renewal = (await loadMyBilling(t.db, agent)).invoices.find(i => i.status === "pending")!;
      expect(renewal).toMatchObject({ kind: "subscription", totalCents: 11_000 });
      await pay(renewal.id, 11_000);
      sub = (await loadMyBilling(t.db, agent)).subscription!;
      expect(Date.parse(sub.endsAt)).toBeGreaterThan(firstEnd + 27 * 86_400_000);
    });

    it("marks an unpaid plan past due, then expires it and voids the open invoice", async () => {
      const admin = await addUser(t.db, "admin");
      await setPrice("owner_plus", 5_000, admin);
      const owner = await addUser(t.db, "owner");
      const s = await startSubscription(t.db, owner, "owner", "owner_plus", "monthly", day(0));
      if (!s.ok) throw new Error(s.message);
      await pay(s.invoice.id, s.invoice.totalCents);
      const end = Date.parse((await loadMyBilling(t.db, owner)).subscription!.endsAt);
      const deps = { email: fakeEmail(), siteName: "X", baseUrl: "https://example.test" };
      await runBillingCycle(t.db, new Date(end - 2 * 86_400_000).toISOString(), deps); // renewal invoice issued
      const c1 = await runBillingCycle(t.db, new Date(end + 86_400_000).toISOString(), deps);
      expect(c1.pastDue).toBeGreaterThanOrEqual(1);
      expect((await loadMyBilling(t.db, owner)).subscription?.status).toBe("past_due");
      const c2 = await runBillingCycle(t.db, new Date(end + 8 * 86_400_000).toISOString(), deps);
      expect(c2.expired).toBeGreaterThanOrEqual(1);
      const after = await loadMyBilling(t.db, owner);
      expect(after.subscription).toBeUndefined();
      expect(after.invoices.filter(i => i.kind === "subscription" && i.status === "pending")).toHaveLength(0);
    });

    it("does not bring an expired plan back when its old invoice is paid late; it opens a case instead", async () => {
      const admin = await addUser(t.db, "admin");
      await setPrice("owner_plus", 5_000, admin);
      const owner = await addUser(t.db, "owner");
      const s = await startSubscription(t.db, owner, "owner", "owner_plus", "monthly", day(0));
      if (!s.ok) throw new Error(s.message);
      await t.db.query("UPDATE subscription SET status = 'expired' WHERE owner_user_id = $1", [owner]);
      await pay(s.invoice.id, s.invoice.totalCents);
      expect((await t.db.query("SELECT status FROM subscription WHERE owner_user_id = $1", [owner])).rows[0]?.["status"]).toBe("expired");
      expect((await t.db.query("SELECT count(*)::int AS n FROM admin_case WHERE subject_id = $1", [s.invoice.id])).rows[0]?.["n"]).toBe(1);
    });

    it("cancel at period end keeps the plan until then, is reversible, and the run ends it without invoicing", async () => {
      const admin = await addUser(t.db, "admin");
      await setPrice("owner_plus", 5_000, admin);
      const owner = await addUser(t.db, "owner");
      const s = await startSubscription(t.db, owner, "owner", "owner_plus", "monthly", day(0));
      if (!s.ok) throw new Error(s.message);
      await pay(s.invoice.id, s.invoice.totalCents);
      expect(await setCancelAtPeriodEnd(t.db, owner, true)).toEqual({ ok: true });
      let sub = (await loadMyBilling(t.db, owner)).subscription!;
      expect(sub).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
      expect(await setCancelAtPeriodEnd(t.db, owner, false)).toEqual({ ok: true });
      await setCancelAtPeriodEnd(t.db, owner, true);
      const end = Date.parse(sub.endsAt);
      const deps = { email: fakeEmail(), siteName: "X", baseUrl: "https://example.test" };
      expect((await runBillingCycle(t.db, new Date(end - 2 * 86_400_000).toISOString(), deps)).renewalInvoices).toBe(0);
      expect((await runBillingCycle(t.db, new Date(end + 1000).toISOString(), deps)).ended).toBeGreaterThanOrEqual(1);
      expect((await loadMyBilling(t.db, owner)).subscription).toBeUndefined();
      expect(await setCancelAtPeriodEnd(t.db, owner, true)).toMatchObject({ ok: false, code: "not_found" });
    });

    it("cancelling a plan that was never paid cancels it at once and voids its invoice", async () => {
      const admin = await addUser(t.db, "admin");
      await setPrice("agent_pro", 10_000, admin);
      const agent = await addUser(t.db, "agent");
      const s = await startSubscription(t.db, agent, "agent", "agent_pro", "monthly", day(0));
      if (!s.ok) throw new Error(s.message);
      expect(await setCancelAtPeriodEnd(t.db, agent, true)).toEqual({ ok: true });
      expect((await createPgBillingStore(t.db).getInvoice(s.invoice.id))?.status).toBe("void");
      expect((await loadMyBilling(t.db, agent)).subscription).toBeUndefined();
    });
  });

  describe("reminders", () => {
    it("send each stage once, only for unpaid invoices, only to the owner, and skip when email is off", async () => {
      const owner = await addUser(t.db, "owner");
      const email = (await t.db.query("SELECT email FROM app_user WHERE id = $1", [owner])).rows[0]!["email"] as string;
      const listing = await addListing(t.db, owner);
      const inv = (await t.db.query(
        `INSERT INTO invoice (owner_user_id, listing_id, amount_ex_gst_cents, gst_cents, total_cents, kind, due_at)
         VALUES ($1,$2,10000,1000,11000,'listing_fee',$3) RETURNING id`, [owner, listing, day(1)])).rows[0]!["id"] as string;
      const paid = (await t.db.query(
        `INSERT INTO invoice (owner_user_id, amount_ex_gst_cents, gst_cents, total_cents, status, kind, due_at, paid_at)
         VALUES ($1,100,10,110,'paid','other',$2,now()) RETURNING id`, [owner, day(-5)])).rows[0]!["id"] as string;

      const off = fakeEmail(false);
      const c0 = await runBillingCycle(t.db, day(0), { email: off, siteName: "OwnerListing", baseUrl: "https://example.test" });
      expect(off.sent).toHaveLength(0);
      expect(c0.remindersSkipped).toBeGreaterThanOrEqual(1);

      const on = fakeEmail();
      const deps = { email: on, siteName: "OwnerListing", baseUrl: "https://example.test" };
      await runBillingCycle(t.db, day(0), deps);
      const mine = on.sent.filter(m => m.to === email);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.text).toContain("$110.00");
      expect(mine[0]?.text).toContain("https://example.test/billing");
      await runBillingCycle(t.db, day(0), deps);
      expect(on.sent.filter(m => m.to === email)).toHaveLength(1); // upcoming stage is not repeated
      await runBillingCycle(t.db, day(1.5), deps);
      expect(on.sent.filter(m => m.to === email)).toHaveLength(2); // due
      await runBillingCycle(t.db, day(20), deps);
      expect(on.sent.filter(m => m.to === email)).toHaveLength(3); // final only, no burst of the stages in between
      const row = (await t.db.query("SELECT reminders_sent FROM invoice WHERE id = $1", [inv])).rows[0]!;
      expect(row["reminders_sent"]).toBe(3);
      expect((await t.db.query("SELECT reminders_sent FROM invoice WHERE id = $1", [paid])).rows[0]!["reminders_sent"]).toBe(0);
    });

    it("do not email suspended accounts", async () => {
      const owner = await addUser(t.db, "owner", "suspended");
      await t.db.query("INSERT INTO invoice (owner_user_id, amount_ex_gst_cents, gst_cents, total_cents, due_at) VALUES ($1,100,10,110,$2)", [owner, day(-1)]);
      const email = fakeEmail();
      await runBillingCycle(t.db, day(0), { email, siteName: "X", baseUrl: "https://example.test" });
      const to = (await t.db.query("SELECT email FROM app_user WHERE id = $1", [owner])).rows[0]!["email"];
      expect(email.sent.some(m => m.to === to)).toBe(false);
    });
  });

  describe("bank transfer", () => {
    it("needs the exact amount, marks the invoice paid once, and is audited", async () => {
      const staff = await addUser(t.db, "admin");
      const owner = await addUser(t.db, "owner");
      const listing = await addListing(t.db, owner);
      const id = (await t.db.query(
        `INSERT INTO invoice (owner_user_id, listing_id, amount_ex_gst_cents, gst_cents, total_cents, kind, due_at)
         VALUES ($1,$2,10000,1000,11000,'listing_fee',now() + interval '5 days') RETURNING id`, [owner, listing])).rows[0]!["id"] as string;
      expect(await confirmBankTransfer(t.db, staff, id, 10_999, "TFR 1")).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/does not match/) });
      expect(await confirmBankTransfer(t.db, staff, id, 11_000, "ab")).toMatchObject({ ok: false, status: 400 });
      expect(await confirmBankTransfer(t.db, staff, "not-a-uuid", 11_000, "TFR 1")).toMatchObject({ ok: false, status: 404 });
      expect(await confirmBankTransfer(t.db, staff, id, 11_000, "TFR 1")).toEqual({ ok: true, note: "Marked paid." });
      expect(await confirmBankTransfer(t.db, staff, id, 11_000, "TFR 1")).toEqual({ ok: true, note: "Already paid." });
      const inv = (await t.db.query("SELECT status, payment_method, provider_ref FROM invoice WHERE id = $1", [id])).rows[0]!;
      expect(inv).toMatchObject({ status: "paid", payment_method: "bank_transfer", provider_ref: "bank:TFR 1" });
      expect((await t.db.query("SELECT listing_fee_paid FROM property_listing WHERE id = $1", [listing])).rows[0]!["listing_fee_paid"]).toBe(true);
      expect((await t.db.query("SELECT provider FROM payment_event WHERE invoice_id = $1", [id])).rows[0]!["provider"]).toBe("bank_transfer");
      const audit = (await t.db.query("SELECT actor_id FROM audit_event WHERE aggregate_id = $1 AND event_type = 'invoice.bank_transfer_confirmed'", [id])).rows;
      expect(audit).toHaveLength(1);
    });

    it("refuses a void invoice and starts a pending subscription", async () => {
      const staff = await addUser(t.db, "admin");
      const admin = await addUser(t.db, "admin");
      await setPrice("agent_pro", 10_000, admin);
      const agent = await addUser(t.db, "agent");
      const s = await startSubscription(t.db, agent, "agent", "agent_pro", "monthly", day(0));
      if (!s.ok) throw new Error(s.message);
      expect(await confirmBankTransfer(t.db, staff, s.invoice.id, 11_000, "TFR 2")).toMatchObject({ ok: true });
      expect((await loadMyBilling(t.db, agent)).subscription?.status).toBe("active");
      await t.db.query("UPDATE invoice SET status = 'void' WHERE id = (SELECT id FROM invoice WHERE owner_user_id = $1 LIMIT 1) AND status = 'pending'", [agent]);
      const owner = await addUser(t.db, "owner");
      const v = (await t.db.query("INSERT INTO invoice (owner_user_id, amount_ex_gst_cents, gst_cents, total_cents, status) VALUES ($1,100,10,110,'void') RETURNING id", [owner])).rows[0]!["id"] as string;
      expect(await confirmBankTransfer(t.db, staff, v, 110, "TFR 3")).toMatchObject({ ok: false, status: 409 });
    });
  });

  describe("payment issues", () => {
    it("can only be raised on your own invoice, once while open, and staff answer them", async () => {
      const staff = await addUser(t.db, "admin");
      const owner = await addUser(t.db, "owner");
      const other = await addUser(t.db, "owner");
      const id = (await t.db.query("INSERT INTO invoice (owner_user_id, amount_ex_gst_cents, gst_cents, total_cents) VALUES ($1,100,10,110) RETURNING id", [owner])).rows[0]!["id"] as string;
      expect(await raiseDispute(t.db, other, id, "This is not my invoice at all")).toMatchObject({ ok: false, code: "not_found" });
      expect(await getMyInvoice(t.db, other, id)).toBeUndefined();
      const d = await raiseDispute(t.db, owner, id, "I was charged twice for this");
      if (!d.ok) throw new Error(d.message);
      expect(await raiseDispute(t.db, owner, id, "Raising it again right now")).toMatchObject({ ok: false, code: "invalid" });
      expect((await listDisputes(t.db, "open")).some(x => x.id === d.id && x.invoiceId === id)).toBe(true);
      expect((await t.db.query("SELECT count(*)::int AS n FROM admin_case WHERE subject_id = $1", [id])).rows[0]!["n"]).toBe(1);

      expect(await resolveDispute(t.db, staff, d.id, "resolved", "short")).toMatchObject({ ok: false, status: 400 });
      expect(await resolveDispute(t.db, staff, d.id, "resolved", "Checked: one charge was reversed by the bank.")).toEqual({ ok: true });
      expect(await resolveDispute(t.db, staff, d.id, "rejected", "Trying to close it a second time.")).toMatchObject({ ok: false, status: 409 });
      expect(await resolveDispute(t.db, staff, "9ec1e1a0-0000-4000-8000-000000000000", "resolved", "Nothing like this exists here.")).toMatchObject({ ok: false, status: 404 });
      const mine = (await loadMyBilling(t.db, owner)).disputes[0]!;
      expect(mine).toMatchObject({ status: "resolved", resolution: "Checked: one charge was reversed by the bank." });
      // After it is closed a new issue can be raised.
      expect(await raiseDispute(t.db, owner, id, "A different problem has come up")).toMatchObject({ ok: true });
    });
  });

  describe("finance figures", () => {
    it("add up revenue, methods, overdue money, failures and subscriptions without any personal data", async () => {
      const db = (await createTestDb());
      try {
        const admin = await addUser(db.db, "admin");
        await db.db.query("INSERT INTO plan_price (plan_id, price_cents, set_by, reason) VALUES ('owner_plus', 5000, $1, 'x'), ('agent_pro', 10000, $1, 'x')", [admin]);
        const owner = await addUser(db.db, "owner");
        const agent = await addUser(db.db, "agent");
        const listing = await addListing(db.db, owner);
        const listing2 = await addListing(db.db, owner);
        const ins = (cols: string, vals: unknown[]) => db.db.query(`INSERT INTO invoice (${cols}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(",")})`, vals);
        const C = "owner_user_id, listing_id, amount_ex_gst_cents, gst_cents, total_cents, status, kind, paid_at, payment_method";
        await ins(C, [owner, listing, 10_000, 1_000, 11_000, "paid", "listing_fee", day(-2), "card"]);
        await ins(C, [owner, listing2, 20_000, 2_000, 22_000, "paid", "listing_fee", day(-3), "bank_transfer"]);
        await ins(C, [owner, null, 5_000, 500, 5_500, "paid", "other", day(-40), "card"]); // previous window
        await ins("owner_user_id, amount_ex_gst_cents, gst_cents, total_cents, status, due_at", [owner, 1_000, 100, 1_100, "pending", day(-4)]);
        await ins("owner_user_id, amount_ex_gst_cents, gst_cents, total_cents, status, due_at", [owner, 2_000, 200, 2_200, "pending", day(4)]);
        const fail = (await db.db.query("INSERT INTO invoice (owner_user_id, amount_ex_gst_cents, gst_cents, total_cents, status) VALUES ($1,1,0,1,'failed') RETURNING id", [owner])).rows[0]!["id"];
        await db.db.query("INSERT INTO payment_event (event_id, invoice_id, provider, outcome, amount_cents) VALUES ('e1',$1,'payway','failed',1), ('e2',$1,'payway','succeeded',1), ('e3',$1,'bank_transfer','succeeded',1)", [fail]);
        await db.db.query(
          `INSERT INTO subscription (owner_user_id, plan_id, price_snapshot_cents, status, starts_at, ends_at, billing_interval)
           VALUES ($1,'agent_pro',10000,'active',now(),now() + interval '20 days','monthly'), ($2,'owner_plus',60000,'active',now(),now() + interval '300 days','yearly')`, [agent, await addUser(db.db, "owner")]);
        await raiseDispute(db.db, owner, fail as string, "Charged but still unpaid here");

        const raw = await loadFinanceRaw(db.db, 30);
        expect(raw.current).toMatchObject({ exGstCents: 30_000, gstCents: 3_000, totalCents: 33_000, count: 2 });
        expect(raw.previous).toMatchObject({ exGstCents: 5_000, count: 1 });
        expect(raw.byMethod.map(m => [m.key, m.totalCents])).toEqual([["bank_transfer", 22_000], ["card", 11_000]]);
        expect(raw.byKind[0]).toMatchObject({ key: "listing_fee", count: 2 });
        expect(raw.attempts).toMatchObject({ succeeded: 1, failed: 1 }); // the bank transfer event is not a card attempt
        expect(raw.outstanding).toMatchObject({ count: 2, totalCents: 3_300 });
        expect(raw.overdue).toMatchObject({ count: 1, totalCents: 1_100, oldestDays: 4 });
        expect(raw.openDisputes).toBe(1);
        expect(raw.repeatListers).toEqual({ owners: 1, avgSpentExGstCents: 30_000 });
        const report = buildFinanceReport(raw, new Date().toISOString());
        expect(report.mrrCents).toBe(10_000 + 5_000);
        expect(report.activeSubscribers).toBe(2);
        expect(JSON.stringify(raw)).not.toMatch(/@example\.test/);

        const pending = await listStaffInvoices(db.db, "pending");
        expect(pending).toHaveLength(2);
        expect(pending.every(r => /^[0-9a-f]{8}$/.test(r.ownerRef))).toBe(true);
        expect((await listStaffInvoices(db.db, "overdue"))).toHaveLength(1);
        expect((await listStaffInvoices(db.db, "paid"))).toHaveLength(3);
        expect((await listStaffInvoices(db.db, "failed")).some(r => r.disputeOpen)).toBe(true);
      } finally {
        await db.close();
      }
    });
  });
});

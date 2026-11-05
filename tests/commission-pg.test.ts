import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseNewDeal } from "../src/domain/commission";
import {
  agentCommissions, allCommissions, createDeal, getDeal, markPayoutPaid, overrideDeal, replaceSchedule, setDealStatus, type StaffRef
} from "../src/server/commission-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("agent commissions on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const setup = async () => {
    const agent = await addUser(t.db, "agent"), other = await addUser(t.db, "agent"), staffId = await addUser(t.db, "admin");
    const owner = await addUser(t.db, "owner");
    const listingId = await addListing(t.db, owner, { title: "Reef St" });
    const staff: StaffRef = { id: staffId, role: "accountant" };
    return { agent, other, staff, listingId };
  };
  const input = (agentUserId: string, extra: Record<string, unknown> = {}) => {
    const r = parseNewDeal({ agentUserId, title: "12 Reef St", salePriceCents: 100_000_000, terms: { kind: "percentage", bps: 200 }, dealDate: "2026-10-01", ...extra });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const audits = async (type: string) =>
    Number((await t.db.query("SELECT count(*) AS n FROM audit_event WHERE event_type = $1 AND aggregate_type = 'commission_deal'", [type])).rows[0]!["n"]);

  it("creates a deal with its dated payments, calculates the commission and audits it", async () => {
    const { agent, staff, listingId } = await setup();
    const before = await audits("commission.deal_created");
    const r = await createDeal(t.db, staff, input(agent, { listingId, schedule: [{ dueDate: "2026-12-01", amountCents: 1_000_000 }, { dueDate: "2027-01-01", amountCents: 1_000_000 }] }));
    if (!r.ok) throw new Error(r.error);
    const d = await getDeal(t.db, r.value.id);
    expect(d?.deal).toMatchObject({ calculatedCents: 2_000_000, status: "expected", dealDate: "2026-10-01", listingId, agentName: "Test agent" });
    expect(d?.payouts.map(p => [p.dueDate, p.amountCents, p.status])).toEqual([["2026-12-01", 1_000_000, "scheduled"], ["2027-01-01", 1_000_000, "scheduled"]]);
    expect(await audits("commission.deal_created")).toBe(before + 1);
  });

  it("stores tiered and fixed terms and reads them back", async () => {
    const { agent, staff } = await setup();
    const tiered = await createDeal(t.db, staff, input(agent, { terms: { kind: "tiered", tiers: [{ upToCents: 50_000_000, bps: 300 }, { upToCents: null, bps: 100 }] } }));
    const fixed = await createDeal(t.db, staff, input(agent, { terms: { kind: "fixed", fixedCents: 750_000 } }));
    if (!tiered.ok || !fixed.ok) throw new Error("create failed");
    expect((await getDeal(t.db, tiered.value.id))?.deal).toMatchObject({ calculatedCents: 1_500_000 + 500_000, terms: { kind: "tiered" } });
    expect((await getDeal(t.db, fixed.value.id))?.deal).toMatchObject({ calculatedCents: 750_000, terms: { kind: "fixed", fixedCents: 750_000 } });
  });

  it("refuses an unknown or non-agent account, and an unknown listing", async () => {
    const { staff, agent } = await setup();
    const owner = await addUser(t.db, "owner");
    expect(await createDeal(t.db, staff, input(owner))).toMatchObject({ ok: false, status: 404 });
    expect(await createDeal(t.db, staff, input(agent, { listingId: "00000000-0000-4000-8000-000000000001" }))).toMatchObject({ ok: false, status: 404 });
  });

  it("override needs a live deal, is logged, cannot go below what is paid, and can be cleared", async () => {
    const { agent, staff } = await setup();
    const r = await createDeal(t.db, staff, input(agent, { schedule: [{ dueDate: "2026-12-01", amountCents: 2_000_000 }] }));
    if (!r.ok) throw new Error(r.error);
    const id = r.value.id;
    const o = await overrideDeal(t.db, staff, id, 1_500_000, "Agreed reduction with the owner");
    expect(o).toEqual({ ok: true, value: { effectiveCents: 1_500_000 } });
    const d = await getDeal(t.db, id);
    expect(d?.deal).toMatchObject({ overrideCents: 1_500_000, overrideReason: "Agreed reduction with the owner" });
    expect(await audits("commission.override_set")).toBeGreaterThan(0);
    expect(await setDealStatus(t.db, staff, id, "earned", null)).toMatchObject({ ok: true });
    expect(await replaceSchedule(t.db, staff, id, [{ dueDate: "2026-12-05", amountCents: 1_500_000 }])).toMatchObject({ ok: true });
    const p = (await getDeal(t.db, id))!.payouts.find(x => x.status === "scheduled")!;
    expect(await markPayoutPaid(t.db, staff, p.id, "EFT 7")).toMatchObject({ ok: true });
    expect(await overrideDeal(t.db, staff, id, 1_000_000, "Trying to go under what was paid")).toMatchObject({ ok: false, status: 409 });
    expect(await overrideDeal(t.db, staff, id, null, "Back to the calculated amount")).toEqual({ ok: true, value: { effectiveCents: 2_000_000 } });
    expect((await getDeal(t.db, id))?.deal.overrideCents).toBeNull();
  });

  it("schedule replacement must add up to the commission not yet paid, and keeps paid payments", async () => {
    const { agent, staff } = await setup();
    const r = await createDeal(t.db, staff, input(agent));
    if (!r.ok) throw new Error(r.error);
    const id = r.value.id;
    expect(await replaceSchedule(t.db, staff, id, [{ dueDate: "2026-12-01", amountCents: 1 }])).toMatchObject({ ok: false, status: 400 });
    expect(await replaceSchedule(t.db, staff, id, [{ dueDate: "2026-12-01", amountCents: 500_000 }, { dueDate: "2027-01-01", amountCents: 1_500_000 }])).toMatchObject({ ok: true });
    await setDealStatus(t.db, staff, id, "earned", null);
    const first = (await getDeal(t.db, id))!.payouts[0]!;
    await markPayoutPaid(t.db, staff, first.id, null);
    expect(await replaceSchedule(t.db, staff, id, [{ dueDate: "2027-02-01", amountCents: 1_500_000 }])).toMatchObject({ ok: true });
    const after = (await getDeal(t.db, id))!.payouts;
    expect(after.filter(p => p.status === "cancelled")).toHaveLength(1);
    expect(after.filter(p => p.status === "paid").map(p => p.amountCents)).toEqual([500_000]);
    expect(after.filter(p => p.status === "scheduled").map(p => p.amountCents)).toEqual([1_500_000]);
  });

  it("a payment can be recorded only once the deal is earned, and only once", async () => {
    const { agent, staff } = await setup();
    const r = await createDeal(t.db, staff, input(agent, { schedule: [{ dueDate: "2026-12-01", amountCents: 2_000_000 }] }));
    if (!r.ok) throw new Error(r.error);
    const p = (await getDeal(t.db, r.value.id))!.payouts[0]!;
    expect(await markPayoutPaid(t.db, staff, p.id, null)).toMatchObject({ ok: false, status: 409 });
    await setDealStatus(t.db, staff, r.value.id, "earned", null);
    expect(await markPayoutPaid(t.db, staff, p.id, "EFT 1")).toMatchObject({ ok: true });
    expect(await markPayoutPaid(t.db, staff, p.id, "EFT 2")).toMatchObject({ ok: false, status: 409 });
    const paid = (await getDeal(t.db, r.value.id))!.payouts[0]!;
    expect(paid).toMatchObject({ status: "paid", paymentReference: "EFT 1" });
    expect(paid.paidAt).not.toBeNull();
    expect(await markPayoutPaid(t.db, staff, "00000000-0000-4000-8000-000000000002", null)).toMatchObject({ ok: false, status: 404 });
  });

  it("cancelling cancels unpaid payments, is blocked once something is paid, and cancelled deals are frozen", async () => {
    const { agent, staff } = await setup();
    const a = await createDeal(t.db, staff, input(agent, { schedule: [{ dueDate: "2026-12-01", amountCents: 2_000_000 }] }));
    const b = await createDeal(t.db, staff, input(agent, { schedule: [{ dueDate: "2026-12-01", amountCents: 2_000_000 }] }));
    if (!a.ok || !b.ok) throw new Error("create failed");
    expect(await setDealStatus(t.db, staff, a.value.id, "cancelled", "Sale fell through")).toMatchObject({ ok: true });
    expect((await getDeal(t.db, a.value.id))!.payouts.map(p => p.status)).toEqual(["cancelled"]);
    expect(await overrideDeal(t.db, staff, a.value.id, 5, "Cancelled deals cannot change")).toMatchObject({ ok: false, status: 409 });
    expect(await setDealStatus(t.db, staff, a.value.id, "earned", null)).toMatchObject({ ok: false, status: 409 });
    await setDealStatus(t.db, staff, b.value.id, "earned", null);
    await markPayoutPaid(t.db, staff, (await getDeal(t.db, b.value.id))!.payouts[0]!.id, null);
    expect(await setDealStatus(t.db, staff, b.value.id, "cancelled", "Too late")).toMatchObject({ ok: false, status: 409 });
  });

  it("an agent sees only their own deals and payments; staff can filter by agent and status", async () => {
    const { agent, other, staff } = await setup();
    const mine = await createDeal(t.db, staff, input(agent, { title: "Mine", schedule: [{ dueDate: "2026-12-01", amountCents: 2_000_000 }] }));
    const theirs = await createDeal(t.db, staff, input(other, { title: "Theirs" }));
    if (!mine.ok || !theirs.ok) throw new Error("create failed");
    const view = await agentCommissions(t.db, agent);
    expect(view.deals.map(d => d.title)).toEqual(["Mine"]);
    expect(view.payouts).toHaveLength(1);
    expect((await agentCommissions(t.db, other)).payouts).toEqual([]);
    expect((await allCommissions(t.db, { agentUserId: other })).deals.map(d => d.title)).toEqual(["Theirs"]);
    expect((await allCommissions(t.db, { status: "cancelled", agentUserId: agent })).deals).toEqual([]);
  });

  it("rows are a permanent record: deletes are refused", async () => {
    const { agent, staff } = await setup();
    const r = await createDeal(t.db, staff, input(agent, { schedule: [{ dueDate: "2026-12-01", amountCents: 2_000_000 }] }));
    if (!r.ok) throw new Error(r.error);
    await expect(t.db.query("DELETE FROM commission_payout WHERE deal_id = $1", [r.value.id])).rejects.toThrow(/permanent record/);
    await expect(t.db.query("DELETE FROM commission_deal WHERE id = $1", [r.value.id])).rejects.toThrow(/permanent record/);
  });
});

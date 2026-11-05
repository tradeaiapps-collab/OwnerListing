import { beforeEach, describe, expect, it, vi } from "vitest";
import { KINDS, defaultPreferences, planChannels, renderNotification, resolvePreferences, type Kind } from "../src/domain/notifications";

const state = vi.hoisted(() => ({
  mails: [] as { to: string; subject?: string; text?: string; html?: string }[],
  inApp: [] as { userId: string; title: string; body: string; link: string | null }[],
  optOut: new Set<string>(), noEmail: new Set<string>(), sms: 0, rows: [] as Record<string, unknown>[], throwDb: false
}));
vi.mock("../src/server/notifications-db", async () => {
  const dom = await import("../src/domain/notifications");
  return {
    getPreferencesPg: async (_db: unknown, userId: string) => (state.optOut.has(userId)
      ? dom.resolvePreferences([{ category: "offers", inApp: true, email: false, sms: false }])
      : dom.defaultPreferences()),
    recipientPg: async (_db: unknown, userId: string) => ({ email: state.noEmail.has(userId) ? null : `${userId}@x.test`, phone: "+61400000000" }),
    createNotificationPg: async (_db: unknown, userId: string, n: { title: string; body: string; link: string | null }) => { state.inApp.push({ userId, title: n.title, body: n.body, link: n.link }); return "n1"; },
    makeNotificationUnsubscribeToken: () => null
  };
});
vi.mock("../src/server/messaging", () => ({
  getEmailPort: async () => ({ configured: true, send: async (m: { to: string; subject?: string; text?: string; html?: string }) => { state.mails.push(m); return { status: "sent" }; } }),
  getSmsPort: async () => ({ configured: true, sendText: async () => { state.sms++; return { status: "sent" }; } })
}));
vi.mock("../src/server/push", () => ({ pushToUser: async () => ({ status: "skipped" }) }));
vi.mock("../src/server/sms-log", () => ({ recordSmsMessage: async () => undefined, smsWithinRate: async () => true }));

import { aud, notifyDeposit, splitText } from "../src/server/deposit-notify";

const BUYER = "b0000000-0000-4000-8000-000000000001", OWNER = "a0000000-0000-4000-8000-000000000002", OFFER = "c0000000-0000-4000-8000-000000000003";
const ROW = { offer_id: OFFER, buyer_user_id: BUYER, listing_id: "d0000000-0000-4000-8000-000000000004", owner_user_id: OWNER, address_text: "12 Wattle St <b>Brisbane</b>", reference: "DEP-ABC123" };
const db = { query: async (_t: string, _p: unknown[]) => { if (state.throwDb) throw new Error("db down"); return { rows: state.rows }; } } as never;
const env = { APP_URL: "http://test" };
const DEPOSIT_KINDS = ["deposit_held", "deposit_payout_pending", "deposit_released", "deposit_refunded", "deposit_split", "deposit_dispute_resolved"] as const satisfies readonly Kind[];

beforeEach(() => { state.mails = []; state.inApp = []; state.optOut.clear(); state.noEmail.clear(); state.sms = 0; state.rows = [ROW]; state.throwDb = false; });

describe("deposit notification wording", () => {
  it("every deposit kind is an offers notice with a title, a body and no text message", () => {
    for (const k of DEPOSIT_KINDS) {
      expect(KINDS[k]).toBe("offers");
      const n = renderNotification(k, { listing: "1 A St", amount: "$1,000.00", reference: "DEP-1", text: "x", link: "/offers/1" });
      expect(n.title.length).toBeGreaterThan(3);
      expect(n.body).toContain("DEP-1");
      expect(n.smsText).toBeNull();
      const plan = planChannels(k, { ...defaultPreferences(), offers: { inApp: true, email: true, sms: true } }, true);
      expect(plan.sms).toBe(false);
    }
  });
  it("tells the buyer to pay by the due date and the owner to wait; never says the platform holds money", () => {
    const buyer = renderNotification("deposit_held", { listing: "1 A St", amount: "$10,000.00", reference: "DEP-9", due: "2026-12-01", party: "buyer" });
    const owner = renderNotification("deposit_held", { listing: "1 A St", amount: "$10,000.00", reference: "DEP-9", due: "2026-12-01", party: "owner" });
    expect(buyer.body).toContain("Pay it into the trust account quoting DEP-9 by 2026-12-01");
    expect(owner.body).toContain("until 2026-12-01");
    expect(buyer.body).toContain("solicitor's trust account");
  });
  it("falls back when amount, reference or text are missing", () => {
    expect(renderNotification("deposit_split").body).toContain("see the offer for the amounts");
    expect(renderNotification("deposit_refunded").body).toContain("the deposit");
  });
  it("formats amounts and splits", () => {
    expect(aud(1234567)).toBe("$12,345.67");
    expect(splitText(500_00, 0)).toBe("$500.00 back to the buyer");
    expect(splitText(250_00, 750_00)).toBe("$250.00 back to the buyer and $750.00 to the seller");
    expect(splitText(0, 0)).toBe("no payment");
  });
  it("respects an opt-out of offer emails while keeping in-app", () => {
    const prefs = resolvePreferences([{ category: "offers", inApp: true, email: false, sms: false }]);
    expect(planChannels("deposit_released", prefs, false)).toEqual({ inApp: true, email: false, sms: false });
  });
});

describe("notifyDeposit", () => {
  it("held: emails and notifies both sides with their own link, personalised by side", async () => {
    await notifyDeposit(db, { holdingId: "h1" }, { kind: "held", amountCents: 1_000_000, dueDate: "2026-12-01" }, env);
    expect(state.mails.map(m => m.to).sort()).toEqual([`${BUYER}@x.test`, `${OWNER}@x.test`].sort());
    const buyerMail = state.mails.find(m => m.to.startsWith(BUYER))!;
    expect(buyerMail.text).toContain("$10,000.00");
    expect(buyerMail.text).toContain("DEP-ABC123");
    expect(buyerMail.text).toContain(`http://test/offers/${OFFER}`);
    expect(state.mails.find(m => m.to.startsWith(OWNER))!.text).toContain(`/listings/${ROW.listing_id}/offers/${OFFER}`);
    expect(state.inApp).toHaveLength(2);
    expect(state.sms).toBe(0);
  });
  it("escapes the address in the HTML part", async () => {
    await notifyDeposit(db, { offerId: OFFER }, { kind: "held", amountCents: 100, dueDate: null }, env);
    for (const m of state.mails) { expect(m.html).not.toContain("<b>Brisbane"); expect(m.html).toContain("&lt;b&gt;"); }
  });
  it("paid: release and refund use their own wording for both sides", async () => {
    await notifyDeposit(db, { holdingId: "h1" }, { kind: "paid", payout: "release", amountCents: 50_000_00 }, env);
    await notifyDeposit(db, { holdingId: "h1" }, { kind: "paid", payout: "refund", amountCents: 2_500_00 }, env);
    expect(state.inApp.map(n => n.title)).toEqual(["Deposit released to the seller", "Deposit released to the seller", "Deposit refunded to the buyer", "Deposit refunded to the buyer"]);
  });
  it("payout pending, split and resolved carry the amounts", async () => {
    await notifyDeposit(db, { holdingId: "h1" }, { kind: "payout_pending", payout: "refund", amountCents: 100_00 }, env);
    await notifyDeposit(db, { offerId: OFFER }, { kind: "split", refundCents: 300_00, releaseCents: 700_00 }, env);
    await notifyDeposit(db, { offerId: OFFER }, { kind: "resolved", refundCents: 1_000_00, releaseCents: 0 }, env);
    const all = state.inApp.map(n => n.body).join("\n");
    expect(all).toContain("refund to the buyer of $100.00");
    expect(all).toContain("$300.00 back to the buyer and $700.00 to the seller");
    expect(all).toContain("$1,000.00 back to the buyer.");
  });
  it("a zero-amount payout sends nothing", async () => {
    await notifyDeposit(db, { holdingId: "h1" }, { kind: "paid", payout: "refund", amountCents: 0 }, env);
    await notifyDeposit(db, { holdingId: "h1" }, { kind: "payout_pending", payout: "release", amountCents: 0 }, env);
    expect(state.inApp).toEqual([]);
    expect(state.mails).toEqual([]);
  });
  it("honours one person's email opt-out and a missing address without stopping the other side", async () => {
    state.optOut.add(BUYER); state.noEmail.add(OWNER);
    await notifyDeposit(db, { holdingId: "h1" }, { kind: "paid", payout: "refund", amountCents: 100_00 }, env);
    expect(state.mails).toEqual([]);
    expect(state.inApp.map(n => n.userId).sort()).toEqual([BUYER, OWNER].sort());
  });
  it("does nothing for an unknown deposit and never throws when the database fails", async () => {
    state.rows = [];
    await expect(notifyDeposit(db, { holdingId: "none" }, { kind: "held", amountCents: 1, dueDate: null }, env)).resolves.toBeUndefined();
    expect(state.inApp).toEqual([]);
    state.throwDb = true;
    await expect(notifyDeposit(db, { offerId: OFFER }, { kind: "held", amountCents: 1, dueDate: null }, env)).resolves.toBeUndefined();
  });
  it("uses the offer without a deposit record (blank reference) without failing", async () => {
    state.rows = [{ ...ROW, reference: null }];
    await notifyDeposit(db, { offerId: OFFER }, { kind: "split", refundCents: 1_00, releaseCents: 1_00 }, env);
    expect(state.inApp).toHaveLength(2);
    expect(state.inApp[0]!.body).toContain("reference on file");
  });
});

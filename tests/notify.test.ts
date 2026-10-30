import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "../src/server/db";

const sent = vi.hoisted(() => [] as { template: string; to: string; subject: string; html?: string }[]);
vi.mock("../src/server/messaging", () => ({
  sendNotice: async (_db: unknown, template: string, to: string, msg: { subject: string; html?: string }) => { sent.push({ template, to, ...msg }); return true; }
}));

import { notifyAdmins, notifyOfferOutcome, notifyOfferReceived, notifyStaffInvite } from "../src/server/notify";

const ENV = { APP_URL: "https://app.example.com/", NEXT_PUBLIC_SITE_NAME: "OwnerListing" };
const OWNER = "11111111-1111-4111-8111-111111111111";
const BUYER = "22222222-2222-4222-8222-222222222222";
const OFFER = "33333333-3333-4333-8333-333333333333";

/** Answers by the table the query reads. */
function fakeDb(rows: { users?: Record<string, string>; admins?: { email: string; id: string }[] } = {}): Queryable & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    async query(text: string, params?: unknown[]) {
      sql.push(text);
      if (text.includes("FROM formal_offer")) return { rows: params?.[0] === OFFER ? [{ buyer_user_id: BUYER, listing_id: "L1", title: "12 Rose St" }] : [] };
      if (text.includes("FROM staff_invite")) return { rows: rows.admins ?? [] };
      if (text.includes("FROM app_user")) { const e = rows.users?.[String(params?.[0])]; return { rows: e ? [{ email: e }] : [] }; }
      return { rows: [] };
    }
  } as never;
}

beforeEach(() => { sent.length = 0; });

describe("notification emails", () => {
  it("tells the owner about a new offer, linking to the listing's offers", async () => {
    expect(await notifyOfferReceived(fakeDb({ users: { [OWNER]: "owner@example.com" } }), OWNER, "L1", "12 Rose St", 90_000_000, ENV)).toBe(true);
    expect(sent).toEqual([expect.objectContaining({ template: "offer_received", to: "owner@example.com", subject: "New offer on 12 Rose St" })]);
    expect(sent[0]!.html).toContain('href="https://app.example.com/listings/L1/offers"');
  });

  it("sends nothing to a closed or deleted account", async () => {
    const db = fakeDb();
    expect(await notifyOfferReceived(db, OWNER, "L1", "x", 1, ENV)).toBe(false);
    expect(sent).toHaveLength(0);
    expect(db.sql[0]).toContain("deleted_at IS NULL");
  });

  it("tells the buyer the owner's decision, with one template per outcome", async () => {
    const db = fakeDb({ users: { [BUYER]: "buyer@example.com" } });
    for (const o of ["accepted", "rejected", "counter_requested", "countered"] as const) await notifyOfferOutcome(db, OFFER, o, ENV);
    expect(sent.map(s => s.template)).toEqual(["offer_accepted", "offer_rejected", "offer_counter_requested", "offer_countered"]);
    expect(sent.every(s => s.to === "buyer@example.com")).toBe(true);
    expect(sent[0]!.html).toContain(`/offers/${OFFER}`);
    expect(sent[1]!.html).toContain("/listings/L1\"");
    expect(await notifyOfferOutcome(db, "44444444-4444-4444-8444-444444444444", "accepted", ENV)).toBe(false);
  });

  it("emails a new staff member and every other super admin", async () => {
    await notifyStaffInvite(fakeDb(), "new@example.com", "support", ENV);
    const admins = [{ email: "a@example.com", id: "A" }, { email: "b@example.com", id: "B" }];
    expect(await notifyAdmins(fakeDb({ admins }), "staff_invite_created", "A staff invite was created.", { exceptUserId: "A" }, ENV)).toBe(1);
    expect(sent.map(s => [s.template, s.to])).toEqual([["staff_invite", "new@example.com"], ["admin_alert", "b@example.com"]]);
    expect(sent[1]!.subject).toBe("[OwnerListing] New staff invite");
  });

  it("template names fit the email log's format", () => {
    for (const t of ["offer_received", "offer_accepted", "offer_rejected", "offer_counter_requested", "offer_countered", "staff_invite", "admin_alert"]) {
      expect(t).toMatch(/^[a-z_]{1,40}$/);
    }
  });
});

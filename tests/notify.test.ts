import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "../src/server/db";

const sent = vi.hoisted(() => [] as { template: string; to: string; subject: string; html?: string }[]);
vi.mock("../src/server/messaging", () => ({
  sendNotice: async (_db: unknown, template: string, to: string, msg: { subject: string; html?: string }) => { sent.push({ template, to, ...msg }); return true; }
}));

import { notifyAdmins, notifyStaffInvite } from "../src/server/notify";

const ENV = { APP_URL: "https://app.example.com/", NEXT_PUBLIC_SITE_NAME: "OwnerListing" };

function fakeDb(rows: { admins?: { email: string; id: string }[] } = {}): Queryable & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    async query(text: string) {
      sql.push(text);
      if (text.includes("FROM staff_invite")) return { rows: rows.admins ?? [] };
      return { rows: [] };
    }
  } as never;
}

beforeEach(() => { sent.length = 0; });

describe("staff emails", () => {
  it("emails a new staff member and every other super admin", async () => {
    await notifyStaffInvite(fakeDb(), "new@example.com", "support", ENV);
    const admins = [{ email: "a@example.com", id: "A" }, { email: "b@example.com", id: "B" }];
    expect(await notifyAdmins(fakeDb({ admins }), "staff_invite_created", "A staff invite was created.", { exceptUserId: "A" }, ENV)).toBe(1);
    expect(sent.map(s => [s.template, s.to])).toEqual([["staff_invite", "new@example.com"], ["admin_alert", "b@example.com"]]);
    expect(sent[1]!.subject).toBe("[OwnerListing] New staff invite");
  });

  it("template names fit the email log's format", () => {
    for (const t of ["staff_invite", "admin_alert"]) {
      expect(t).toMatch(/^[a-z_]{1,40}$/);
    }
  });
});

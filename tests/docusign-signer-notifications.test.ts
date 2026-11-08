import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPreferences, planChannels, renderNotification } from "../src/domain/notifications";

const state = vi.hoisted(() => ({ mails: [] as { to: string; subject: string; text?: string; html?: string }[], claimed: [] as Record<string, unknown>[], count: 0, sqls: [] as { sql: string; params: unknown[] }[], sentTo: [] as string[] }));
const fakeDb = {
  async query(text: string, params: unknown[] = []) {
    state.sqls.push({ sql: text, params });
    if (text.startsWith("SELECT count")) return { rows: [{ n: state.count }] };
    return { rows: text.startsWith("UPDATE signing_signer") ? state.claimed : [] };
  }
};
vi.mock("../src/server/notifications-db", async orig => ({
  ...(await orig<typeof import("../src/server/notifications-db")>()),
  getPreferencesPg: async () => defaultPreferences(),
  recipientPg: async (_db: unknown, id: string) => ({ email: `${id}@signer.test`, phone: null }),
  createNotificationPg: async () => "n1"
}));
vi.mock("../src/server/push", () => ({ pushToUser: async () => ({ status: "skipped" }) }));
vi.mock("../src/server/messaging", () => ({
  getEmailPort: async () => ({ configured: true, send: async (m: { to: string; subject: string; text?: string; html?: string }) => { state.mails.push(m); return { status: "sent" }; } }),
  getSmsPort: async () => ({ configured: false })
}));

import { runSigningReminders, sendSigningRequests } from "../src/server/notifier";
import * as cron from "../app/api/internal/signing/reminders/route";

const env = { APP_URL: "https://ol.test" };
const row = (u: string) => ({ user_id: u, document_id: "d1", title: "Inspection access", owner_name: "Olive" });
beforeEach(() => { state.mails = []; state.claimed = []; state.sqls = []; state.count = 0; });

describe("signer notification wording", () => {
  it("names the document and the sender, and is a required account notice without SMS", () => {
    const n = renderNotification("signature_requested", { document: "Inspection access", name: "Olive", link: "/signing/d1" });
    expect(n).toMatchObject({ category: "account", link: "/signing/d1", smsText: null });
    expect(n.body).toContain('"Inspection access"');
    expect(n.body).toContain("Olive");
    expect(renderNotification("signature_reminder", { document: "X", name: "Olive" }).title).toMatch(/Reminder/);
    const plan = planChannels("signature_requested", defaultPreferences(), true);
    expect(plan).toMatchObject({ inApp: true, email: true, sms: false });
  });
});

describe("sendSigningRequests", () => {
  it("emails each claimed pending signer a link to the document and reports who was skipped", async () => {
    state.count = 3; state.claimed = [row("u1"), row("u2")];
    expect(await sendSigningRequests(fakeDb, "d1", "2026-11-05T00:00:00.000Z", env)).toEqual({ sent: 2, skipped: 1 });
    expect(state.mails.map(m => m.to)).toEqual(["u1@signer.test", "u2@signer.test"]);
    expect(state.mails[0]!.subject).toMatch(/Signature requested/);
    expect(state.mails[0]!.text).toContain("https://ol.test/signing/d1");
    expect(state.mails[0]!.html).toContain("Review and sign");
    const claim = state.sqls.find(s => s.sql.startsWith("UPDATE signing_signer"))!;
    expect(claim.sql).toMatch(/provider = 'docusign'.*status = 'out_for_signature'.*s\.status = 'pending'/s);
    expect(claim.sql).toMatch(/notified_at IS NULL OR s\.notified_at <=/);
  });
  it("sends nothing and never throws when everyone was asked recently or the database fails", async () => {
    state.count = 2;
    expect(await sendSigningRequests(fakeDb, "d1", "2026-11-05T00:00:00.000Z", env)).toEqual({ sent: 0, skipped: 2 });
    expect(state.mails).toEqual([]);
    expect(await sendSigningRequests({ query: async () => { throw new Error("down"); } }, "d1", "2026-11-05T00:00:00.000Z", env)).toEqual({ sent: 0, skipped: 0 });
  });
});

describe("runSigningReminders", () => {
  it("claims pending signers after 72 hours once, then sends a reminder to each", async () => {
    state.claimed = [row("u1")];
    expect(await runSigningReminders(fakeDb, "2026-11-08T00:00:00.000Z", env)).toEqual({ reminded: 1 });
    expect(state.mails).toHaveLength(1);
    expect(state.mails[0]!.subject).toMatch(/Reminder/);
    const claim = state.sqls[0]!;
    expect(claim.sql).toMatch(/reminded_at IS NULL/);
    expect(claim.sql).toMatch(/status = 'pending'/);
    expect(claim.params).toEqual(["2026-11-08T00:00:00.000Z", 72]);
  });
});

describe("reminder cron route", () => {
  const req = (secret?: string) => new Request("http://test/x", { method: "POST", headers: secret ? { "x-cron-secret": secret } : {} });
  it("fails closed without a long secret and rejects a wrong one", async () => {
    delete process.env["SIGNING_REMINDER_CRON_SECRET"];
    expect((await cron.POST(req("a".repeat(32)))).status).toBe(503);
    process.env["SIGNING_REMINDER_CRON_SECRET"] = "s".repeat(32);
    expect((await cron.POST(req("wrong"))).status).toBe(401);
    expect((await cron.POST(req())).status).toBe(401);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryAgentAppointmentRepository, type AgentAppointmentRepository } from "../src/domain/agent-appointment-service";
import type { Actor } from "../src/domain/listing-service";
import { APPOINTMENT_KINDS, answerNotificationQuestion, explainAppointment, planChannels, renderNotification, defaultPreferences } from "../src/domain/notifications";

const state = vi.hoisted(() => ({ actor: null as Actor | null, repo: null as AgentAppointmentRepository | null, sent: [] as { fn: string; args: unknown[] }[], claimed: [] as Record<string, unknown>[], sqls: [] as string[] }));
const fakeDb = { async query(text: string) { state.sqls.push(text); return { rows: text.startsWith("UPDATE agent_appointment_invite") ? state.claimed : [] }; } };

vi.mock("../src/server/context", () => ({ getActor: () => state.actor, getDb: () => fakeDb }));
vi.mock("../src/server/agent-appointment-db", () => ({
  getAgentAppointmentRepo: () => state.repo,
  appointmentIds: (() => { let n = 0; return { newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`, now: () => "2026-11-05T00:00:00.000Z" }; })()
}));
vi.mock("../src/server/notifier", async orig => ({
  ...(await orig<typeof import("../src/server/notifier")>()),
  notifyAgentInvited: async (...args: unknown[]) => { state.sent.push({ fn: "invited", args }); },
  notifyInviteAnswered: async (...args: unknown[]) => { state.sent.push({ fn: "answered", args }); }
}));

import * as listingRoute from "../app/api/listings/[id]/agent-appointments/route";
import * as inviteRoute from "../app/api/agent-invites/[id]/route";
import * as reminderRoute from "../app/api/internal/appointments/reminders/route";
import * as elena from "../app/api/notifications/assistant/route";
process.env["APP_URL"] = "http://test";

const LISTING = "55555555-5555-4555-8555-555555555555";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const agent: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "agent" };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown, url = "http://test/x") => new Request(url, { method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(body) });

beforeEach(() => {
  state.sent = []; state.sqls = []; state.claimed = [];
  state.repo = createInMemoryAgentAppointmentRepository({
    listings: [{ id: LISTING, ownerUserId: owner.userId, jurisdiction: "QLD", title: "House" }],
    users: [
      { id: owner.userId, userType: "owner", status: "active", displayName: "Olive" },
      { id: agent.userId, userType: "agent", status: "active", email: "amy@agency.test", displayName: "Amy" }
    ],
    licences: [{ userId: agent.userId, jurisdiction: "QLD", status: "verified" }]
  });
  state.actor = owner;
});

describe("appointment notifications over HTTP", () => {
  it("notifies the agent on invite, the owner on accept, and the owner on decline; nothing on a failed or withdrawn action", async () => {
    expect((await listingRoute.POST(post({ email: "nobody@x.test" }), ctx(LISTING))).status).toBe(400);
    expect(state.sent).toEqual([]);
    const { invite } = await (await listingRoute.POST(post({ email: "amy@agency.test" }), ctx(LISTING))).json();
    expect(state.sent).toMatchObject([{ fn: "invited", args: [fakeDb, invite.id] }]);

    state.actor = agent;
    expect((await inviteRoute.POST(post({ action: "accept" }), ctx(invite.id))).status).toBe(200);
    expect(state.sent[1]).toMatchObject({ fn: "answered", args: [fakeDb, invite.id, "appointment_accepted"] });
    expect((await inviteRoute.POST(post({ action: "accept" }), ctx(invite.id))).status).toBe(409);
    expect(state.sent).toHaveLength(2);
  });

  it("notifies the owner of a decline but not of an owner withdrawal", async () => {
    const a = await (await listingRoute.POST(post({ email: "amy@agency.test" }), ctx(LISTING))).json();
    state.actor = agent;
    await inviteRoute.POST(post({ action: "decline" }), ctx(a.invite.id));
    expect(state.sent[1]).toMatchObject({ fn: "answered", args: [fakeDb, a.invite.id, "appointment_declined"] });
    state.actor = owner;
    const b = await (await listingRoute.POST(post({ email: "amy@agency.test" }), ctx(LISTING))).json();
    await inviteRoute.POST(post({ action: "withdraw" }), ctx(b.invite.id));
    expect(state.sent).toHaveLength(3); // the new invite only
  });
});

describe("wording, channels and Elena", () => {
  it("every appointment kind renders in the appointments category with a link-safe body", () => {
    for (const k of APPOINTMENT_KINDS) expect(renderNotification(k, { listing: "1 Main St", name: "Amy", link: "/x" })).toMatchObject({ category: "appointments", link: "/x" });
  });
  it("invites and reminders may go by text; answers may not; SMS still needs the opt-in and a verified phone", () => {
    const prefs = defaultPreferences();
    prefs.appointments.sms = true;
    expect(planChannels("appointment_invited", prefs, true).sms).toBe(true);
    expect(planChannels("appointment_reminder", prefs, true).sms).toBe(true);
    expect(planChannels("appointment_accepted", prefs, true).sms).toBe(false);
    expect(planChannels("appointment_invited", prefs, false).sms).toBe(false);
    expect(planChannels("appointment_invited", defaultPreferences(), true).sms).toBe(false);
  });
  it("Elena explains each appointment kind and answers appointment questions without advice on money or law", () => {
    for (const k of APPOINTMENT_KINDS) expect(explainAppointment(k).text.length).toBeGreaterThan(40);
    expect(explainAppointment("appointment_invited").text).toMatch(/until you accept/);
    expect(answerNotificationQuestion("what is an agent appointment?").text).toMatch(/nothing is granted until the agent accepts/);
  });
  it("the assistant route explains appointment kinds only", async () => {
    state.actor = owner;
    const ok = await elena.POST(post({ action: "explain", kind: "appointment_declined" }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).reply.text).toMatch(/declined/);
    expect((await elena.POST(post({ action: "explain", kind: "offer_received" }))).status).toBe(400);
  });
});

describe("reminder job", () => {
  const SECRET = "s".repeat(40);
  const call = (secret?: string) => reminderRoute.POST(new Request("http://test/api/internal/appointments/reminders", { method: "POST", headers: secret === undefined ? {} : { "x-cron-secret": secret } }));
  afterEach(() => { delete process.env["APPOINTMENT_REMINDER_CRON_SECRET"]; });

  it("fails closed without a secret and rejects a wrong one, running nothing", async () => {
    expect((await call("x")).status).toBe(503);
    process.env["APPOINTMENT_REMINDER_CRON_SECRET"] = SECRET;
    expect((await call()).status).toBe(401);
    expect((await call(SECRET + "x")).status).toBe(401);
    expect(state.sqls).toEqual([]);
  });
  it("claims open invitations older than 48 hours once and reports the count", async () => {
    process.env["APPOINTMENT_REMINDER_CRON_SECRET"] = SECRET;
    state.claimed = [{ agent_user_id: agent.userId, address_text: "1 Main St", title: "House", owner_name: "Olive" }];
    const res = await call(SECRET);
    expect(await res.json()).toEqual({ reminded: 1 });
    const claim = state.sqls.find(s => s.startsWith("UPDATE agent_appointment_invite"))!;
    expect(claim).toContain("reminded_at IS NULL");
    expect(claim).toContain("status = 'proposed'");
  });
  it("is scheduled hourly with the secret header", () => {
    const wf = readFileSync(path.join(__dirname, "..", ".github", "workflows", "agent-invite-reminders.yml"), "utf8");
    expect(wf).toContain('cron: "15 * * * *"');
    expect(wf).toContain('"$APP_URL/api/internal/appointments/reminders"');
  });
});

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/domain/listing-service";

type Row = Record<string, unknown>;
const OWNER: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const PRO: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "vendor" };
const OTHER: Actor = { userId: "44444444-4444-4444-8444-444444444444", userType: "owner" };
const J1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const J2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const h = vi.hoisted(() => ({
  actor: null as Actor | null,
  db: { query: async (_s: string, _p?: unknown[]) => ({ rows: [] as Row[] }) },
  notify: vi.fn(async () => ({})),
  emails: [] as { to: string; text: string }[],
  emailConfigured: true
}));
vi.mock("../src/server/context", () => ({ getActor: () => h.actor, getDb: () => h.db }));
vi.mock("../src/server/notifier", () => ({ notifyUser: h.notify }));
vi.mock("../src/server/rate-guard", () => ({ withinRates: async () => true }));
vi.mock("../src/server/messaging", () => ({
  getEmailPort: async () => ({ configured: h.emailConfigured, send: async (m: { to: string; text: string }) => { h.emails.push(m); return { status: "sent" }; } })
}));

import * as access from "../app/api/assignments/[id]/access/route";
import * as visit from "../app/api/assignments/[id]/visit/route";
import * as notice from "../app/api/assignments/[id]/tenant-notice/route";
import * as complaint from "../app/api/assignments/[id]/complaint/route";
import * as accept from "../app/api/assignments/[id]/route";
import * as calendar from "../app/api/contractor/calendar/route";
import { CALENDAR_SQL, COMMITTED_SLOTS_SQL, CONFIRM_VISIT_SQL, INSERT_COMPLAINT_SQL, JOB_CONTEXT_SQL, SAVE_ACCESS_SQL, UPSERT_VISIT_SQL } from "../src/server/contractor-ops-db";
import { CLAIM_REMINDER_SQL, REMINDERS_SQL, runJobReminders } from "../src/server/contractor-ops-notify";

process.env["APP_URL"] = "http://test";
process.env["MESSAGING_SETTINGS_KEY"] = randomBytes(32).toString("base64");

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, url: string, body?: unknown) => new Request(url, { method, headers: { "content-type": "application/json", origin: "http://test" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const future = (days: number, hour: number) => { const d = new Date(Date.now() + days * 86_400_000); d.setUTCHours(hour, 0, 0, 0); return d; };
const iso = (d: Date) => d.toISOString();

/** A tiny in-memory stand-in for the SQL these routes run, keyed on the exported statement text. */
function fakeDb(status: Record<string, string>) {
  const visits = new Map<string, Row>();
  const accessRows = new Map<string, Row>();
  const audits: string[] = [];
  const complaints: Row[] = [];
  const notices: Row[] = [];
  const jobs: Record<string, Row> = {
    [J1]: { id: J1, listing_id: "l1", owner_user_id: OWNER.userId, contractor_user_id: PRO.userId, kind: "photographer", status: status[J1] ?? "approved", address_text: "1 Main St", jurisdiction: "QLD", owner_name: "Olive", contractor_name: "Pat" },
    [J2]: { id: J2, listing_id: "l2", owner_user_id: OWNER.userId, contractor_user_id: PRO.userId, kind: "inspector", status: status[J2] ?? "proposed", address_text: "2 High St", jurisdiction: "QLD", owner_name: "Olive", contractor_name: "Pat" }
  };
  return {
    visits, accessRows, audits, complaints, notices, jobs,
    async query(sql: string, p: unknown[] = []) {
      const rows = (r: Row[]) => ({ rows: r });
      if (sql === JOB_CONTEXT_SQL) { const j = jobs[String(p[0])]; return rows(j && (j["owner_user_id"] === p[1] || j["contractor_user_id"] === p[1]) ? [j] : []); }
      if (sql.startsWith("SELECT assignment_id, starts_at, ends_at, state")) { const v = visits.get(String(p[0])); return rows(v ? [v] : []); }
      if (sql === UPSERT_VISIT_SQL) {
        const j = jobs[String(p[0])]!;
        if (!["proposed", "approved"].includes(String(j["status"]))) return rows([]);
        visits.set(String(p[0]), { assignment_id: p[0], starts_at: new Date(String(p[1])), ends_at: new Date(String(p[2])), state: "proposed", proposed_by: p[3], attendees: p[4] });
        return rows([{ assignment_id: p[0] }]);
      }
      if (sql === CONFIRM_VISIT_SQL) { const v = visits.get(String(p[0])); if (!v || v["state"] !== "proposed" || v["proposed_by"] === p[1]) return rows([]); v["state"] = "confirmed"; return rows([{ assignment_id: p[0] }]); }
      if (sql === COMMITTED_SLOTS_SQL) return rows([...visits.values()].filter(v => jobs[String(v["assignment_id"])]!["status"] === "approved").map(v => ({ assignment_id: v["assignment_id"], starts_at: v["starts_at"], ends_at: v["ends_at"] })));
      if (sql === CALENDAR_SQL) return rows([...visits.values()].map(v => ({ ...jobs[String(v["assignment_id"])]!, id: v["assignment_id"], title: "House", starts_at: v["starts_at"], ends_at: v["ends_at"], state: v["state"], attendees: v["attendees"] })));
      if (sql === SAVE_ACCESS_SQL) { accessRows.set(String(p[0]), { method: p[1], sealed_details: p[2] }); return rows([{ assignment_id: p[0] }]); }
      if (sql.startsWith("SELECT method, sealed_details")) { const a = accessRows.get(String(p[0])); return rows(a ? [a] : []); }
      if (sql.startsWith("INSERT INTO audit_event")) { audits.push(String(p[3])); return rows([]); }
      if (sql === INSERT_COMPLAINT_SQL) { if (!["approved", "completed"].includes(String(jobs[String(p[0])]!["status"]))) return rows([]); complaints.push({ kind: p[2] }); return rows([{ id: "c" }]); }
      if (sql.startsWith("SELECT count(*)::int AS n FROM job_tenant_notice")) return rows([{ n: notices.length }]);
      if (sql.startsWith("INSERT INTO job_tenant_notice")) { notices.push({ name: p[1], status: p[6] }); return rows([]); }
      if (sql.startsWith("SELECT id, tenant_name")) return rows([]);
      if (sql === REMINDERS_SQL) return rows([{ assignment_id: J1, starts_at: future(1, 1), ends_at: future(1, 2), contractor_user_id: PRO.userId, kind: "photographer", address_text: "1 Main St", jurisdiction: "QLD" }]);
      if (sql === CLAIM_REMINDER_SQL) return rows(visits.has("claimed") ? [] : (visits.set("claimed", {}), [{ assignment_id: p[0] }]));
      if (sql.startsWith("SELECT email, sms, reminder_hours")) return rows([]);
      if (sql.startsWith("SELECT 1 FROM job_assignment")) { const j = jobs[String(p[0])]; return rows(j && j["contractor_user_id"] === p[1] ? [{ x: 1 }] : []); }
      if (sql.startsWith("SELECT id, listing_id, owner_user_id, contractor_user_id")) return rows([]); // the assignment service finds nothing
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    }
  };
}

let db: ReturnType<typeof fakeDb>;
const setup = (status: Record<string, string> = {}) => { db = fakeDb(status); h.db = db as never; h.notify.mockClear(); h.emails.length = 0; h.emailConfigured = true; };
beforeEach(() => setup());

const window = (day: number, startHour: number, endHour: number) => ({ startsAt: iso(future(day, startHour)), endsAt: iso(future(day, endHour)) });

describe("access details", () => {
  const put = (a: Actor | null, body: unknown, id = J1) => { h.actor = a; return access.PUT(req("PUT", `http://test/api/assignments/${id}/access`, body), ctx(id)); };
  const get = (a: Actor | null, id = J1) => { h.actor = a; return access.GET(req("GET", `http://test/api/assignments/${id}/access`), ctx(id)); };

  it("seals the code at rest and shows it to the owner and to the accepted contractor", async () => {
    expect((await put(OWNER, { method: "lockbox", details: "4821 by the gate" })).status).toBe(200);
    expect(String(db.accessRows.get(J1)!["sealed_details"])).not.toContain("4821");
    expect((await (await get(OWNER)).json()).access.details).toBe("4821 by the gate");
    expect((await (await get(PRO)).json()).access.details).toBe("4821 by the gate");
    expect(db.audits).toContain("access.viewed");
  });
  it("hides the code from a contractor who has not accepted, and after the job is over", async () => {
    await put(OWNER, { method: "key_handover", details: "Key with neighbour at 12" }, J2);
    const proposed = await (await get(PRO, J2)).json();
    expect(proposed.access).toMatchObject({ details: null, masked: true, hasDetails: true });
    expect(JSON.stringify(proposed)).not.toContain("neighbour");
    await put(OWNER, { method: "lockbox", details: "9999" });
    db.jobs[J1]!["status"] = "completed";
    expect((await (await get(PRO)).json()).access.details).toBeNull();
  });
  it("lets only the owner set it, and answers a stranger 404", async () => {
    expect((await put(PRO, { method: "open_site" })).status).toBe(403);
    expect((await put(OTHER, { method: "open_site" })).status).toBe(404);
    expect((await get(OTHER)).status).toBe(404);
    expect((await get(null)).status).toBe(401);
  });
  it("refuses to store a secret when the encryption key is missing", async () => {
    const key = process.env["MESSAGING_SETTINGS_KEY"];
    delete process.env["MESSAGING_SETTINGS_KEY"];
    try { expect((await put(OWNER, { method: "lockbox", details: "1234" })).status).toBe(503); expect(db.accessRows.size).toBe(0); }
    finally { process.env["MESSAGING_SETTINGS_KEY"] = key; }
  });
});

describe("visit time and double booking", () => {
  const propose = (a: Actor, id: string, body: unknown) => { h.actor = a; return visit.PUT(req("PUT", `http://test/api/assignments/${id}/visit`, body), ctx(id)); };
  const confirm = (a: Actor, id: string, extra: object = {}) => { h.actor = a; return visit.POST(req("POST", `http://test/api/assignments/${id}/visit`, { action: "confirm", ...extra }), ctx(id)); };

  it("owner proposes, contractor confirms, and the proposer cannot confirm their own time", async () => {
    expect((await propose(OWNER, J1, { ...window(3, 1, 2), attendees: ["owner"] })).status).toBe(200);
    expect(h.notify).toHaveBeenCalled();
    expect((await confirm(OWNER, J1)).status).toBe(409);
    expect((await confirm(PRO, J1)).status).toBe(200);
    expect(db.visits.get(J1)!["state"]).toBe("confirmed");
  });
  it("warns a contractor before confirming a time that overlaps an accepted job, then lets them go ahead", async () => {
    await propose(OWNER, J1, window(3, 1, 3));
    await confirm(PRO, J1);
    db.jobs[J2]!["status"] = "approved";
    await propose(OWNER, J2, window(3, 2, 4));
    const warned = await confirm(PRO, J2);
    expect(warned.status).toBe(409);
    expect(await warned.json()).toMatchObject({ code: "overlap", overlaps: [{ }] });
    expect(db.visits.get(J2)!["state"]).toBe("proposed");
    expect((await confirm(PRO, J2, { acknowledgeOverlap: true })).status).toBe(200);
    const cal = await (await (async () => { h.actor = PRO; return calendar.GET(req("GET", "http://test/api/contractor/calendar")); })()).json();
    expect(cal.items.every((i: { clashesWith: string[] }) => i.clashesWith.length === 1)).toBe(true);
  });
  it("warns on accept when the job's proposed time overlaps an accepted job, and ignores a stranger", async () => {
    await propose(OWNER, J1, window(3, 1, 3));
    await confirm(PRO, J1);
    await propose(OWNER, J2, window(3, 2, 4));
    const act = (a: Actor, body: object) => { h.actor = a; return accept.POST(req("POST", `http://test/api/assignments/${J2}`, body), ctx(J2)); };
    const warned = await act(PRO, { action: "accept" });
    expect(warned.status).toBe(409);
    expect((await warned.json()).code).toBe("overlap");
    // A stranger gets no overlap details: the guard stays quiet and the assignment service answers 404.
    const stranger = await act(OTHER, { action: "accept" });
    expect(stranger.status).toBe(404);
  });
  it("refuses a time in the past and a change after the job is finished", async () => {
    expect((await propose(OWNER, J1, { startsAt: "2020-01-01T09:00:00Z", endsAt: "2020-01-01T10:00:00Z" })).status).toBe(400);
    db.jobs[J1]!["status"] = "completed";
    expect((await propose(OWNER, J1, window(3, 1, 2))).status).toBe(409);
  });
  it("hides the street address from a contractor who has not accepted", async () => {
    h.actor = PRO;
    const r = await visit.GET(req("GET", `http://test/api/assignments/${J2}/visit`), ctx(J2));
    expect((await r.json()).address).toBeNull();
  });
});

describe("tenant notice", () => {
  const send = (a: Actor, body: unknown, id = J1) => { h.actor = a; return notice.POST(req("POST", `http://test/api/assignments/${id}/tenant-notice`, body), ctx(id)); };
  const body = () => ({ tenantName: "Sam", tenantEmail: "sam@example.com", ...window(4, 1, 3) });

  it("emails the tenant the window without any access code and logs it", async () => {
    const r = await send(OWNER, body());
    expect(r.status).toBe(201);
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0]).toMatchObject({ to: "sam@example.com" });
    expect(h.emails[0]!.text).toContain("1 Main St");
    expect(db.notices).toEqual([{ name: "Sam", status: "sent" }]);
    expect(db.audits).toContain("tenant_notice.sent");
  });
  it("is owner only, accepted jobs only, 24 hours ahead, and not logged as sent when email is off", async () => {
    expect((await send(PRO, body())).status).toBe(403);
    expect((await send(OTHER, body())).status).toBe(404);
    expect((await send(OWNER, body(), J2)).status).toBe(409);
    expect((await send(OWNER, { ...body(), ...window(0, 23, 23.5 as never) })).status).toBe(400);
    h.emailConfigured = false;
    expect((await send(OWNER, body())).status).toBe(503);
    expect(db.notices).toHaveLength(0);
  });
  it("stops after three notices in a day", async () => {
    db.notices.push({}, {}, {});
    expect((await send(OWNER, body())).status).toBe(429);
    expect(h.emails).toHaveLength(0);
  });
});

describe("complaints", () => {
  const report = (a: Actor, body: unknown, id = J1) => { h.actor = a; return complaint.POST(req("POST", `http://test/api/assignments/${id}/complaint`, body), ctx(id)); };
  it("lets the owner report after acceptance, and nobody else", async () => {
    expect((await report(OWNER, { kind: "no_show", details: "Never came" })).status).toBe(201);
    expect(db.complaints).toEqual([{ kind: "no_show" }]);
    expect((await report(PRO, { kind: "no_show", details: "x" })).status).toBe(403);
    expect((await report(OWNER, { kind: "no_show", details: "x" }, J2)).status).toBe(409);
  });
});

describe("reminders", () => {
  it("sends one reminder and does not repeat when the claim is already taken", async () => {
    expect(await runJobReminders(db as never, new Date().toISOString())).toEqual({ sent: 1 });
    expect(await runJobReminders(db as never, new Date().toISOString())).toEqual({ sent: 0 });
  });
});

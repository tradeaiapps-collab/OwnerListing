import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/domain/listing-service";
import type { StaffActor } from "../src/domain/staff-access";
import { sectionsFor } from "../src/domain/staff-admin";
import {
  buildOwnerReport, buildStaffReport, neutraliseCell, ownerReportCsv, staffReportCsv, toCsv, type RawStaffReport
} from "../src/domain/reports";
import { checksToPerform, verifyTrustAccount, type VerificationPorts } from "../src/domain/trust-verification";
import { recordTrustVerification, runAndRecordTrustVerification } from "../src/server/trust-verification-db";

const state = vi.hoisted(() => ({
  staff: null as StaffActor | null,
  actor: null as Actor | null,
  listingOwner: "owner-1",
  queries: [] as { text: string; params: unknown[] }[]
}));

vi.mock("../src/server/context", () => ({
  getStaff: async () => state.staff,
  getActor: async () => state.actor,
  getDeps: () => ({ repo: { get: async (id: string) => (id === LISTING ? { listing: { ownerUserId: state.listingOwner } } : null) } }),
  getDb: () => ({
    query: async (text: string, params: unknown[] = []) => {
      state.queries.push({ text, params });
      if (text.includes("FROM property_listing l WHERE l.owner_user_id")) {
        return { rows: [{ id: LISTING, title: "=HYPERLINK(\"http://evil\")", status: "published", enquiries: 3, offers: 1 }] };
      }
      return { rows: [] };
    }
  })
}));
vi.mock("../src/server/db", () => ({ appendAuditPg: async () => undefined }));

import * as staffReportRoute from "../app/api/staff/reports/route";
import * as mineReport from "../app/api/listings/mine/report/route";
import * as listingReport from "../app/api/listings/[id]/report/route";

const LISTING = "11111111-1111-4111-8111-111111111111";
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const admin: StaffActor = { id: U(1), role: "super_admin" };
const accountant: StaffActor = { id: U(2), role: "accountant" };
const reporting: StaffActor = { id: U(3), role: "reporting" };
const support: StaffActor = { id: U(4), role: "support" };
const tech: StaffActor = { id: U(5), role: "technical" };
const compliance: StaffActor = { id: U(6), role: "compliance" };

const raw: RawStaffReport = {
  listingsByStatus: [{ key: "published", count: 4 }, { key: "draft", count: 2 }],
  paidInvoices: { count: 3, totalCents: 33000, gstCents: 3000, last30DaysCents: 11000 },
  openCases: [{ kind: "trust_account_verification", status: "open", count: 2 }, { kind: "other", status: "in_progress", count: 1 }, { kind: "other", status: "resolved", count: 9 }],
  buyers: { accounts: 10, emailVerified: 8, phoneVerified: 6, idVerified: 3 },
  idSubmissions: [{ key: "pending", count: 2 }],
  trustChecks: [{ key: "awaiting_human_approval", count: 1 }]
};

describe("pure aggregation", () => {
  it("fills every status, adds revenue from paid invoices only and excludes resolved cases", () => {
    const r = buildStaffReport(admin, raw);
    expect(r.listings).toEqual([{ status: "draft", count: 2 }, { status: "pending_review", count: 0 }, { status: "published", count: 4 }, { status: "suspended", count: 0 }, { status: "withdrawn", count: 0 }, { status: "archived", count: 0 }]);
    expect(r.revenue).toEqual({ paidInvoices: 3, totalCents: 33000, gstCents: 3000, exGstCents: 30000, last30DaysCents: 11000 });
    expect(r.openCases).toEqual({ total: 3, byKind: [{ kind: "trust_account_verification", count: 2 }, { kind: "other", count: 1 }] });
    expect(r.verificationFunnel?.buyers.map(b => b.count)).toEqual([10, 8, 6, 3]);
    expect(r.verificationFunnel?.trustAccountChecks.find(t => t.decision === "awaiting_human_approval")?.count).toBe(1);
  });

  it("limits sections by role", () => {
    expect(Object.keys(buildStaffReport(accountant, raw)).sort()).toEqual(["listings", "revenue"]);
    expect(Object.keys(buildStaffReport(reporting, raw)).sort()).toEqual(["listings", "openCases", "verificationFunnel"]);
    expect(buildStaffReport(compliance, raw)).toEqual({});
  });

  it("ignores negative or non-finite numbers", () => {
    const r = buildStaffReport(admin, { ...raw, paidInvoices: { count: -1, totalCents: Number.NaN, gstCents: 5, last30DaysCents: 0 } });
    expect(r.revenue).toMatchObject({ paidInvoices: 0, totalCents: 0, exGstCents: 0 });
  });

  it("owner totals add up", () => {
    const r = buildOwnerReport([{ id: "a", title: "A", status: "draft", enquiries: 2, offers: 1 }, { id: "b", title: "B", status: "published", enquiries: 3, offers: 0 }]);
    expect(r.totals).toEqual({ enquiries: 5, offers: 1 });
    expect(r.viewsTracked).toBe(false);
  });
});

describe("CSV formula injection", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tcmd", "\rcmd"])("prefixes %j with an apostrophe", v => {
    expect(neutraliseCell(v).startsWith("'")).toBe(true);
  });
  it("leaves safe text alone and quotes commas and quotes", () => {
    expect(neutraliseCell("Family home")).toBe("Family home");
    expect(toCsv(["a"], [['say "hi", ok']])).toBe('a\r\n"say ""hi"", ok"\r\n');
  });
  it("neutralises user-controlled listing titles in the owner CSV", () => {
    const csv = ownerReportCsv(buildOwnerReport([{ id: "a", title: "=cmd|' /C calc'!A0", status: "draft", enquiries: 0, offers: 0 }]));
    expect(csv).toContain("'=cmd");
    expect(csv.split("\r\n")[1]).not.toMatch(/^=/);
  });
  it("staff CSV has a header and formatted dollars", () => {
    const csv = staffReportCsv(buildStaffReport(admin, raw));
    expect(csv.startsWith("Section,Metric,Value\r\n")).toBe(true);
    expect(csv).toContain("Total incl. GST,330.00");
  });
});

const O = { origin: "http://test" };
const staffGet = (q = "") => staffReportRoute.GET(new Request(`http://test/api/staff/reports${q}`, { headers: O }));
beforeEach(() => { state.staff = null; state.actor = null; state.listingOwner = "owner-1"; state.queries = []; });

describe("staff report route", () => {
  it("401 without a session", async () => { expect((await staffGet()).status).toBe(401); expect(state.queries).toHaveLength(0); });
  it.each([["support", support], ["technical", tech], ["compliance", compliance]])("403 for %s and runs no query", async (_n, s) => {
    state.staff = s;
    expect((await staffGet()).status).toBe(403);
    expect(state.queries).toHaveLength(0);
  });
  it("returns only allowed sections", async () => {
    state.staff = accountant;
    const body = await (await staffGet()).json();
    expect(Object.keys(body.report).sort()).toEqual(["listings", "revenue"]);
  });
  it("exports CSV as an attachment", async () => {
    state.staff = admin;
    const res = await staffGet("?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });
  it("lists Reports only for roles that may open it", () => {
    expect(sectionsFor(admin).map(s => s.href)).toContain("/staff/reports");
    expect(sectionsFor(reporting).map(s => s.href)).toContain("/staff/reports");
    expect(sectionsFor(support).map(s => s.href)).not.toContain("/staff/reports");
    expect(sectionsFor(compliance).map(s => s.href)).not.toContain("/staff/reports");
  });
});

const listingCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const getListing = (id = LISTING) => listingReport.GET(new Request(`http://test/api/listings/${id}/report`), listingCtx(id));

describe("owner reports", () => {
  it("401 when signed out", async () => {
    expect((await mineReport.GET(new Request("http://test/api/listings/mine/report"))).status).toBe(401);
    expect((await getListing()).status).toBe(401);
  });
  it("buyers and agents get no owner report", async () => {
    state.actor = { userId: "buyer-1", userType: "buyer" } as Actor;
    expect((await mineReport.GET(new Request("http://test/api/listings/mine/report"))).status).toBeGreaterThanOrEqual(403);
    expect(state.queries).toHaveLength(0);
    state.actor = { userId: "owner-1", userType: "agent" } as Actor;
    expect((await getListing()).status).toBe(404);
  });
  it("another owner gets 404 for a listing that is not theirs, and nothing is queried", async () => {
    state.actor = { userId: "owner-2", userType: "owner" };
    expect((await getListing()).status).toBe(404);
    expect(state.queries).toHaveLength(0);
  });
  it("404 for an unknown or malformed id", async () => {
    state.actor = { userId: "owner-1", userType: "owner" };
    expect((await getListing("22222222-2222-4222-8222-222222222222")).status).toBe(404);
    expect((await getListing("1; DROP TABLE x")).status).toBe(404);
  });
  it("the owner id in the query comes from the session", async () => {
    state.actor = { userId: "owner-1", userType: "owner" };
    const res = await getListing();
    expect(res.status).toBe(200);
    expect((await res.json()).report.totals).toEqual({ enquiries: 3, offers: 1 });
    expect(state.queries[0]?.params).toEqual(["owner-1", LISTING]);
    await mineReport.GET(new Request("http://test/api/listings/mine/report?owner=owner-2"));
    expect(state.queries[1]?.params).toEqual(["owner-1", null]);
  });
  it("owner CSV neutralises a hostile title", async () => {
    state.actor = { userId: "owner-1", userType: "owner" };
    const text = await (await mineReport.GET(new Request("http://test/api/listings/mine/report?format=csv"))).text();
    expect(text).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});

// ---- Trust account verification wired to admin cases ----

const evidenceOk = { practisingCertificateCurrent: true, firmEmailVerified: true, accountNameMatches: true, bankLetterOnFile: true, callbackCompleted: false };
const input = { id: U(70), firmId: U(71), tier: "unregistered" as const, jurisdiction: "QLD" as const, accountName: "Firm Trust", bsb: "064000", accountNumber: "12345678" };
const portsFor = (o: Partial<{ cert: boolean; email: boolean; name: boolean | null; letter: boolean; throwOn: boolean }> = {}): VerificationPorts => ({
  registry: { lookup: async () => { if (o.throwOn) throw new Error("registry down"); return { practisingCertificateCurrent: o.cert ?? true, registryEmail: "firm@example.com" }; } },
  email: { isConfirmed: async () => o.email ?? true, sendVerification: async () => undefined },
  nameCheck: { check: async () => (o.name === undefined ? true : o.name) },
  documents: { hasBankLetter: async () => o.letter ?? true },
  callbacks: { isCompleted: async () => false }
});
const fakeDb = () => {
  const calls: { text: string; params: unknown[] }[] = [];
  return { calls, db: { query: async (text: string, params: unknown[] = []) => { calls.push({ text, params }); return { rows: [{ id: U(80) }] }; } } };
};

describe("trust verification runner to admin cases", () => {
  it("lists the checks a person still has to do", () => {
    expect(checksToPerform("approved", evidenceOk)).toEqual([]);
    const todo = checksToPerform("needs_more_evidence", { ...evidenceOk, firmEmailVerified: false, bankLetterOnFile: false, accountNameMatches: null });
    expect(todo.join(" ")).toMatch(/verification email/);
    expect(todo.join(" ")).toMatch(/call-back/);
    expect(todo.join(" ")).toMatch(/bank letter/i);
    expect(checksToPerform("flagged_for_admin", { automationError: "registry down" })[0]).toMatch(/registry down/);
    expect(checksToPerform("awaiting_human_approval", evidenceOk).at(-1)).toMatch(/approve or reject/);
  });

  it("opens a trust_account_verification case keyed to the new check when a person must act", async () => {
    const { db, calls } = fakeDb();
    const result = await verifyTrustAccount(input, portsFor());
    expect(result.decision.kind).toBe("awaiting_human_approval");
    const id = await recordTrustVerification(db, LISTING, input.id, result);
    expect(id).toBe(U(80));
    const q = calls[0]!;
    expect(q.text).toContain("'trust_account_verification', id");
    expect(q.params[2]).toBe("awaiting_human_approval");
    expect(q.params[6]).toBe(true);
    expect(JSON.stringify(q.params)).not.toContain("12345678");
  });

  it("a failed run is recorded as flagged_for_admin with a case (fail closed)", async () => {
    const { db, calls } = fakeDb();
    const r = await runAndRecordTrustVerification(db, LISTING, input, portsFor({ throwOn: true }));
    expect(r.decision.kind).toBe("flagged_for_admin");
    expect(calls[0]!.params[2]).toBe("flagged_for_admin");
    expect(calls[0]!.params[6]).toBe(true);
    expect(String(calls[0]!.params[5])).toContain("registry down");
  });

  it("a mismatched account name is stored as rejected, never approved", async () => {
    const { db, calls } = fakeDb();
    await runAndRecordTrustVerification(db, LISTING, input, portsFor({ name: false }));
    expect(calls[0]!.params[2]).toBe("rejected");
  });

  it("only an auto-approvable check opens no case, and a new firm is never auto-approved", async () => {
    const { db, calls } = fakeDb();
    const fp = await (await import("../src/domain/trust-verification")).detailsFingerprint(input.accountName, input.bsb, input.accountNumber);
    await runAndRecordTrustVerification(db, LISTING, { ...input, tier: "registered", lastHumanApprovedFingerprint: fp }, portsFor());
    expect(calls[0]!.params[2]).toBe("approved");
    expect(calls[0]!.params[6]).toBe(false);
    await runAndRecordTrustVerification(db, LISTING, input, portsFor());
    expect(calls[1]!.params[2]).not.toBe("approved");
  });
});

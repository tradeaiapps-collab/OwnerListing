import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INVESTMENT_DISCLOSURE } from "../src/config/investment-disclosure";
import { createInMemoryInvestmentRepository, type InvestmentDeps } from "../src/domain/investment-service";
import { contactsDisclosed, contractTransition, DEFAULT_POSTING, feeAmount, feeTransition, maskContacts, posterText, termsFrom, validatePostingSettings, type PostingSettings } from "../src/domain/investment-terms";
import { decideToggle, envMasterOn, moduleState, validateProject } from "../src/domain/investor-projects";
import type { Actor } from "../src/domain/listing-service";
import { staffCan, type StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ actor: null as Actor | null, staff: null as StaffActor | null, deps: null as InvestmentDeps | null }));
vi.mock("../src/server/context", () => ({ getActor: async () => state.actor, getStaff: async () => state.staff, getDb: () => ({ query: async () => ({ rows: [] }) }) }));
vi.mock("../src/server/investments-db", () => ({ getInvestmentDeps: () => state.deps }));

import * as statusRoute from "../app/api/investments/status/route";
import * as projectsRoute from "../app/api/investments/projects/route";
import * as projectRoute from "../app/api/investments/projects/[id]/route";
import * as interestRoute from "../app/api/investments/projects/[id]/interest/route";
import * as upfrontRoute from "../app/api/investments/projects/[id]/upfront-fee/route";
import * as threadsRoute from "../app/api/investments/threads/route";
import * as threadRoute from "../app/api/investments/threads/[id]/route";
import * as contractRoute from "../app/api/investments/threads/[id]/contract/route";
import * as templateRoute from "../app/api/investments/contract-template/route";
import * as declRoute from "../app/api/investments/investor/declaration/route";
import * as queueRoute from "../app/api/staff/investments/route";
import * as decideRoute from "../app/api/staff/investments/[id]/route";
import * as staffContractRoute from "../app/api/staff/investments/contracts/[id]/route";
import * as feeRoute from "../app/api/staff/investments/fees/[id]/route";

process.env["APP_URL"] = "http://test";
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: Actor = { userId: U(1), userType: "owner" };
const wholesale: Actor = { userId: U(2), userType: "buyer" };
const retail: Actor = { userId: U(3), userType: "buyer" };
const unverified: Actor = { userId: U(4), userType: "buyer" };
const other: Actor = { userId: U(5), userType: "owner" };
const admin: StaffActor = { id: U(90), role: "super_admin" };
const compliance: StaffActor = { id: U(91), role: "compliance" };
const support: StaffActor = { id: U(92), role: "support" };
const FULL = { emailVerified: true, phoneVerified: true, idVerified: true };
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");

const project = (o: Record<string, unknown> = {}) => ({
  title: "Riverside townhouses", location: "Bulimba", jurisdiction: "QLD", projectType: "residential_development", stage: "planning",
  summary: "Six townhouses on a 1,200 square metre lot close to the river.", fundingTargetCents: 250_000_000, minimumTicketCents: 5_000_000,
  timeline: "DA lodged; build 18 months.", risks: "Planning, construction cost and sales risk. You can lose money.", structureDescription: "Unit trust with a corporate trustee.",
  issuerName: "Riverside Dev Pty Ltd", issuerLicenceBasis: "Wholesale-only offer under s708", issuerStatement: "", issuerAuthorisedConfirmed: true, ...o
});

let mem: ReturnType<typeof createInMemoryInvestmentRepository>;
let live = { envOn: true, dbOn: true };
let hits: () => Promise<number | undefined>;
let settings: PostingSettings;
let files: { configured: boolean; stored: string[]; verdict: "clean" | "infected" };
let notices: string[];
let n = 0;

beforeEach(async () => {
  n = 0; live = { envOn: true, dbOn: true }; hits = async () => 1; settings = { ...DEFAULT_POSTING, commissionBps: 200 };
  files = { configured: true, stored: [], verdict: "clean" }; notices = [];
  state.actor = null; state.staff = null;
  mem = createInMemoryInvestmentRepository();
  state.deps = {
    repo: mem.repo,
    moduleState: async () => moduleState(live.envOn, live.dbOn),
    postingSettings: async () => settings,
    verification: async id => (id === unverified.userId ? { emailVerified: true, phoneVerified: false, idVerified: false } : FULL),
    countHit: () => hits(),
    contactFor: async id => ({ name: `Name ${id}`, email: `${id}@example.test` }),
    notify: async (id, template, _s, text) => { notices.push(`${template}:${id}:${text}`); },
    files: {
      storage: { get configured() { return files.configured; }, async put(k) { files.stored.push(k); }, async get() { return PDF; } },
      scanner: { get configured() { return files.configured; }, async scan() { return files.verdict; } }
    },
    startUpfrontCheckout: async () => { throw new Error("Westpac PayWay is not connected yet."); },
    sha256: async () => "a".repeat(64),
    appUrl: "http://test",
    appendAudit: async () => {},
    now: () => "2026-10-25T00:00:00.000Z",
    newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`
  };
  await mem.repo.addDeclaration({ id: U(200), userId: wholesale.userId, category: "wholesale", disclosureVersion: INVESTMENT_DISCLOSURE.version, declaredAt: "2026-10-25T00:00:00.000Z" });
  await mem.repo.addDeclaration({ id: U(201), userId: retail.userId, category: "retail", disclosureVersion: INVESTMENT_DISCLOSURE.version, declaredAt: "2026-10-25T00:00:00.000Z" });
});

const H = { "content-type": "application/json", origin: "http://test" };
const req = (method: string, body?: unknown, headers: Record<string, string> = H) =>
  new Request("http://test/api/x", { method, headers, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const as = (a: Actor | null) => { state.actor = a; };
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => ({})) as Record<string, any> });

async function posted(o: Record<string, unknown> = {}) {
  as(owner);
  const r = await json(await projectsRoute.POST(req("POST", project(o))));
  expect(r.status).toBe(201);
  return r.body["project"] as { id: string; version: number };
}
async function approved(o: Record<string, unknown> = {}) {
  const p = await posted(o);
  state.staff = admin;
  expect((await decideRoute.POST(req("POST", { outcome: "approve", reason: "Checked issuer and risks.", version: p.version }), ctx(p.id))).status).toBe(200);
  return p;
}
async function interested(o: Record<string, unknown> = {}) {
  const p = await approved(o);
  as(wholesale);
  const r = await json(await interestRoute.POST(req("POST", { message: "Keen to talk.", amountMinCents: 10_000_000, amountMaxCents: 20_000_000 }), ctx(p.id)));
  expect(r.status).toBe(201);
  return { p, interestId: r.body["interest"].id as string };
}

describe("two-key kill switch", () => {
  it("env master key is on only for the exact string true", () => {
    for (const v of [undefined, "", "TRUE", "1", "yes", " true", "false"]) expect(envMasterOn({ INVESTMENT_MODULE_ENABLED: v })).toBe(false);
    expect(envMasterOn({ INVESTMENT_MODULE_ENABLED: "true" })).toBe(true);
    expect(moduleState(true, false).live).toBe(false);
    expect(moduleState(false, true).live).toBe(false);
    expect(moduleState(true, true).live).toBe(true);
  });

  for (const [name, keys] of [["off by env", { envOn: false, dbOn: true }], ["off by database", { envOn: true, dbOn: false }]] as const) {
    it(`${name}: every investor and staff review route answers 404, even signed out, cross-origin or as staff`, async () => {
      const p = await approved();
      live = { ...keys };
      for (const a of [null, owner, wholesale]) {
        as(a);
        expect((await statusRoute.GET()).status).toBe(404);
        expect((await projectsRoute.GET(req("GET"))).status).toBe(404);
        expect((await projectsRoute.POST(req("POST", project(), { ...H, origin: "http://evil.test" }))).status).toBe(404);
        expect((await projectRoute.GET(req("GET"), ctx(p.id))).status).toBe(404);
        expect((await threadsRoute.GET(req("GET"))).status).toBe(404);
        expect((await templateRoute.GET(req("GET"))).status).toBe(404);
      }
      state.staff = admin;
      expect((await queueRoute.GET(req("GET"))).status).toBe(404);
      expect((await decideRoute.POST(req("POST", { outcome: "approve", reason: "x".repeat(20), version: 1 }), ctx(p.id))).status).toBe(404);
    });
  }

  it("turning on needs investment.manage, the counsel confirmation and the current disclosure version; turning off needs only the permission", () => {
    const on = { enabled: true, counselConfirmed: true, disclosureVersion: INVESTMENT_DISCLOSURE.version };
    expect(decideToggle(compliance, on)).toMatchObject({ ok: false, status: 403 });
    expect(decideToggle(support, { enabled: false })).toMatchObject({ ok: false, status: 403 });
    expect(decideToggle(admin, { ...on, counselConfirmed: false })).toMatchObject({ ok: false, status: 400 });
    expect(decideToggle(admin, { ...on, counselConfirmed: "true" })).toMatchObject({ ok: false, status: 400 });
    expect(decideToggle(admin, { ...on, disclosureVersion: "old" })).toMatchObject({ ok: false, status: 400 });
    expect(decideToggle(admin, { enabled: "yes" })).toMatchObject({ ok: false, status: 400 });
    expect(decideToggle(admin, on)).toEqual({ ok: true, value: on });
    expect(decideToggle(admin, { enabled: false })).toMatchObject({ ok: true, value: { enabled: false, counselConfirmed: false } });
  });

  it("investment.manage is super admin only; investment.review is super admin and compliance", () => {
    for (const role of ["compliance", "accountant", "support", "technical", "reporting"] as const) expect(staffCan({ id: "x", role }, "investment.manage")).toBe(false);
    expect(staffCan(admin, "investment.manage")).toBe(true);
    expect(staffCan(compliance, "investment.review")).toBe(true);
    expect(staffCan(support, "investment.review")).toBe(false);
  });
});

describe("posting and moderation", () => {
  it("nothing is visible to investors until staff approve; the owner sees it", async () => {
    const p = await posted();
    as(wholesale);
    expect((await json(await projectsRoute.GET(req("GET")))).body["items"]).toEqual([]);
    expect((await projectRoute.GET(req("GET"), ctx(p.id))).status).toBe(404);
    as(other);
    expect((await projectRoute.GET(req("GET"), ctx(p.id))).status).toBe(404);
    as(owner);
    expect((await json(await projectRoute.GET(req("GET"), ctx(p.id)))).body["mine"]).toBe(true);
  });

  it("a non-owner cannot edit (404) and an owner edit after approval returns the project to review", async () => {
    const p = await approved();
    as(other);
    expect((await projectRoute.PUT(req("PUT", project({ title: "Hijacked title" })), ctx(p.id))).status).toBe(404);
    as(owner);
    const r = await json(await projectRoute.PUT(req("PUT", project({ title: "Riverside townhouses stage 2" })), ctx(p.id)));
    expect(r.body["project"]).toMatchObject({ status: "pending_review", version: 2 });
    as(wholesale);
    expect((await projectRoute.GET(req("GET"), ctx(p.id))).status).toBe(404);
  });

  it("staff decisions need investment.review, a reason and the current version; support is refused", async () => {
    const p = await posted();
    state.staff = support;
    expect((await decideRoute.POST(req("POST", { outcome: "approve", reason: "Looks fine to me.", version: 1 }), ctx(p.id))).status).toBe(403);
    state.staff = compliance;
    expect((await decideRoute.POST(req("POST", { outcome: "approve", reason: "short", version: 1 }), ctx(p.id))).status).toBe(400);
    expect((await decideRoute.POST(req("POST", { outcome: "approve", reason: "Checked issuer and risks.", version: 7 }), ctx(p.id))).status).toBe(409);
    expect((await json(await decideRoute.POST(req("POST", { outcome: "request_changes", reason: "Add the build timeline.", version: 1 }), ctx(p.id)))).body["status"]).toBe("changes_requested");
    expect(mem.history.map(h => h.toStatus)).toEqual(["pending_review", "changes_requested"]);
  });

  it("only verified owners may post; unknown and payment fields are refused", async () => {
    as(wholesale);
    expect((await projectsRoute.POST(req("POST", project()))).status).toBe(403);
    as(owner);
    for (const extra of ["depositCents", "paymentReference", "commitmentCents", "allocationUnits", "bankAccount"]) {
      const r = await json(await projectsRoute.POST(req("POST", project({ [extra]: 1 }))));
      expect(r.status).toBe(400);
      expect(r.body["fields"][extra]).toBe("Unknown field.");
    }
  });

  it("refuses HTML or script in text fields (XSS) and missing issuer confirmation", async () => {
    as(owner);
    for (const [k, v] of [["title", "<script>alert(1)</script>"], ["summary", "Nice project <img src=x onerror=alert(1)> with a view"], ["risks", "click javascript:alert(1) for the full risk list"]] as const) {
      const r = await json(await projectsRoute.POST(req("POST", project({ [k]: v }))));
      expect(r.status).toBe(400);
      expect(r.body["fields"][k]).toMatch(/Plain text/);
    }
    expect(validateProject(project({ issuerAuthorisedConfirmed: false }))).toMatchObject({ ok: false });
    expect(validateProject(project({ minimumTicketCents: 999_999_999_999 }))).toMatchObject({ ok: false });
    expect(validateProject(project())).toMatchObject({ ok: true, value: { visibleTo: "wholesale_only" } });
  });

  it("rate limits fail closed: an unreadable or throwing counter blocks posting, interest and messages", async () => {
    const { interestId } = await interested();
    const open = await approved({ title: "Open to all verified", visibleTo: "all_verified" });
    for (const h of [async () => undefined, async () => { throw new Error("down"); }, async () => 999]) {
      hits = h as () => Promise<number | undefined>;
      as(owner);
      expect((await projectsRoute.POST(req("POST", project()))).status).toBe(429);
      expect((await threadRoute.POST(req("POST", { body: "Hello" }), ctx(interestId))).status).toBe(429);
      as(retail);
      expect((await interestRoute.POST(req("POST", { message: "Hi", amountMinCents: 100, amountMaxCents: 200 }), ctx(open.id))).status).toBe(429);
    }
  });
});

describe("investors", () => {
  it("unverified and undeclared investors are refused with the next step", async () => {
    await approved();
    as(unverified);
    const r = await json(await projectsRoute.GET(req("GET")));
    expect(r.status).toBe(403);
    expect(r.body["step"]).toBe("verify_phone");
    as({ userId: U(6), userType: "buyer" });
    expect((await json(await projectsRoute.GET(req("GET")))).body["step"]).toBe("declare");
    as(owner);
    expect((await json(await projectsRoute.GET(req("GET")))).body["step"]).toBe("investor_account");
  });

  it("declarations need every acknowledgement and the current risk warning version", async () => {
    as({ userId: U(7), userType: "buyer" });
    const acks = { notAdvice: true, notAnOffer: true, noFundsHeld: true, offPlatformContracts: true };
    expect((await declRoute.POST(req("POST", { category: "wholesale", acknowledgements: { ...acks, noFundsHeld: false }, disclosureVersion: INVESTMENT_DISCLOSURE.version }))).status).toBe(400);
    expect((await declRoute.POST(req("POST", { category: "wholesale", acknowledgements: acks, disclosureVersion: "old" }))).status).toBe(400);
    expect((await declRoute.POST(req("POST", { category: "wholesale", acknowledgements: acks, disclosureVersion: INVESTMENT_DISCLOSURE.version }))).status).toBe(201);
    as(unverified);
    expect((await declRoute.POST(req("POST", { category: "wholesale", acknowledgements: acks, disclosureVersion: INVESTMENT_DISCLOSURE.version }))).status).toBe(403);
  });

  it("retail investors cannot see wholesale-only projects (default) but can see all-verified ones", async () => {
    const w = await approved();
    const all = await approved({ title: "Open to all verified", visibleTo: "all_verified" });
    as(retail);
    expect((await json(await projectsRoute.GET(req("GET")))).body["items"].map((x: { id: string }) => x.id)).toEqual([all.id]);
    expect((await projectRoute.GET(req("GET"), ctx(w.id))).status).toBe(404);
    expect((await interestRoute.POST(req("POST", { message: "Hi", amountMinCents: 100, amountMaxCents: 200 }), ctx(w.id))).status).toBe(404);
    as(wholesale);
    expect((await json(await projectsRoute.GET(req("GET")))).body["items"]).toHaveLength(2);
  });

  it("interest is non-binding: unknown fields such as a deposit are refused", async () => {
    const p = await approved();
    as(wholesale);
    expect((await interestRoute.POST(req("POST", { message: "Hi", amountMinCents: 100, amountMaxCents: 200, depositCents: 100 }), ctx(p.id))).status).toBe(400);
    expect((await interestRoute.POST(req("POST", { message: "Hi", amountMinCents: 300, amountMaxCents: 200 }), ctx(p.id))).status).toBe(400);
  });

  it("the migration has no payment, deposit, commitment or allocation columns", () => {
    const sql = readFileSync("db/20261025150000_investments.sql", "utf8").toLowerCase().replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\b\w*(deposit|payment|commitment|allocation|card_|bsb|account_number|shares?_)\w*\s+(text|bigint|integer|boolean|numeric|uuid)/);
  });
});

describe("posting model", () => {
  it("each project records the model it was posted under; later settings changes do not touch it, edits keep it", async () => {
    settings = { ...DEFAULT_POSTING, model: "upfront_fee", upfrontFeeCents: 49_900, model2Disclosure: "after_fee" };
    const a = await posted();
    settings = { ...DEFAULT_POSTING, commissionType: "fixed", commissionFixedCents: 150_000 };
    const b = await posted({ title: "Second project here" });
    as(owner);
    await projectRoute.PUT(req("PUT", project({ title: "Edited first project" })), ctx(a.id));
    expect((await mem.repo.getProject(a.id))!.terms).toEqual({ model: "upfront_fee", commissionType: "fixed", commissionBps: 0, commissionFixedCents: 0, upfrontFeeCents: 49_900, upfrontFeeStatus: "unpaid" });
    expect((await mem.repo.getProject(b.id))!.terms).toMatchObject({ model: "commission_on_contract", commissionType: "fixed", commissionFixedCents: 150_000, upfrontFeeStatus: "not_required" });
  });

  it("validates settings and shows the poster text", () => {
    expect(validatePostingSettings({ ...DEFAULT_POSTING, commissionBps: 2001 })).toMatchObject({ ok: false });
    expect(validatePostingSettings({ ...DEFAULT_POSTING, model: "other" })).toMatchObject({ ok: false });
    expect(validatePostingSettings({ ...DEFAULT_POSTING, extra: 1 })).toMatchObject({ ok: false });
    expect(validatePostingSettings({ ...DEFAULT_POSTING, commissionBps: 250 })).toMatchObject({ ok: true });
    expect(posterText({ ...DEFAULT_POSTING, commissionBps: 250 })).toMatch(/2\.5% of the amount in the signed contract.*never taken from investor money/);
    expect(posterText({ ...DEFAULT_POSTING, model: "upfront_fee", upfrontFeeCents: 49_900 })).toMatch(/\$499/);
  });

  it("model 2 upfront fee fails closed while payments are not connected", async () => {
    settings = { ...DEFAULT_POSTING, model: "upfront_fee", upfrontFeeCents: 49_900 };
    const p = await posted();
    as(owner);
    expect((await upfrontRoute.POST(req("POST", undefined, { origin: "http://test" }), ctx(p.id))).status).toBe(503);
    as(other);
    expect((await upfrontRoute.POST(req("POST", undefined, { origin: "http://test" }), ctx(p.id))).status).toBe(404);
  });
});

describe("contact masking and no cross-party leakage", () => {
  it("masks emails, phone numbers and links", () => {
    for (const t of ["mail me at jo@example.com", "jo (at) example (dot) com", "call 0412 345 678", "ring +61 7 3123 4567", "see www.example.com", "https://x.io/a", "visit riverside.com.au"]) {
      const m = maskContacts(t);
      expect(m.masked, t).toBe(true);
      expect(m.text).toContain("[hidden]");
    }
    expect(maskContacts("Target is $2,500,000 over 18 months, 6 units")).toEqual({ text: "Target is $2,500,000 over 18 months, 6 units", masked: false });
  });

  it("model 1: message bodies are masked before they are stored and the sender is told", async () => {
    const { interestId } = await interested();
    as(wholesale);
    const r = await json(await threadRoute.POST(req("POST", { body: "Email me on jo@example.com or 0412 345 678" }), ctx(interestId)));
    expect(r.status).toBe(201);
    expect(r.body["message"]).toMatchObject({ masked: true, body: "Email me on [hidden] or [hidden]" });
    expect(r.body["message"]["notice"]).toMatch(/not allowed/);
    expect(mem.messages.at(-1)!.body).toBe("Email me on [hidden] or [hidden]");
    expect(notices.some(x => x.startsWith(`investment_message:${owner.userId}:`) && !x.includes("jo@example.com"))).toBe(true);
  });

  it("API responses never carry the other party's id, name or email", async () => {
    const { p, interestId } = await interested();
    const leaks = (s: string, who: Actor) => [who.userId, `Name ${who.userId}`, `${who.userId}@example.test`].filter(x => s.includes(x));
    as(wholesale);
    for (const r of [await threadRoute.GET(req("GET"), ctx(interestId)), await threadsRoute.GET(req("GET")), await projectRoute.GET(req("GET"), ctx(p.id)), await projectsRoute.GET(req("GET"))]) {
      expect(leaks(await r.text(), owner)).toEqual([]);
    }
    as(owner);
    for (const r of [await threadRoute.GET(req("GET"), ctx(interestId)), await threadsRoute.GET(req("GET"))]) {
      expect(leaks(await r.text(), wholesale)).toEqual([]);
    }
    const t = await json(await threadRoute.GET(req("GET"), ctx(interestId)));
    expect(t.body["contactsHidden"]).toBe(true);
    expect(t.body["messages"][0]).toMatchObject({ from: "Investor", mine: false });
    as(other);
    expect((await threadRoute.GET(req("GET"), ctx(interestId))).status).toBe(404);
    expect((await threadRoute.POST(req("POST", { body: "hi" }), ctx(interestId))).status).toBe(404);
  });

  it("model 2 shows contact details only after the fee is paid and the admin setting allows it", async () => {
    const t = { ...termsFrom({ ...DEFAULT_POSTING, model: "upfront_fee", upfrontFeeCents: 100 }) };
    expect(contactsDisclosed(t, "after_fee", "none")).toBe(false);
    const paid = { ...t, upfrontFeeStatus: "paid" as const };
    expect(contactsDisclosed(paid, "off", "returned")).toBe(false);
    expect(contactsDisclosed(paid, "after_fee", "none")).toBe(true);
    expect(contactsDisclosed(paid, "after_contract", "submitted")).toBe(false);
    expect(contactsDisclosed(paid, "after_contract", "returned")).toBe(true);
    expect(contactsDisclosed({ ...termsFrom(DEFAULT_POSTING) }, "after_fee", "returned")).toBe(false);
  });

  it("chat has no edit or delete methods", () => {
    expect(Object.keys(threadRoute).sort()).toEqual(["GET", "POST"]);
    expect(Object.keys(contractRoute)).toEqual(["POST"]);
  });
});

describe("signed contract and platform fee", () => {
  it("state machine: none/rejected -> submitted -> returned or rejected; returned is final", () => {
    expect(contractTransition("none", "submit")).toBe("submitted");
    expect(contractTransition("rejected", "submit")).toBe("submitted");
    expect(contractTransition("submitted", "submit")).toBeNull();
    expect(contractTransition("returned", "submit")).toBeNull();
    expect(contractTransition("submitted", "confirm")).toBe("returned");
    expect(contractTransition("submitted", "reject")).toBe("rejected");
    expect(contractTransition("none", "confirm")).toBeNull();
    expect(contractTransition("returned", "reject")).toBeNull();
  });

  it("upload: investor only, PDF only, fails closed without storage, then staff confirm makes the model 1 fee due", async () => {
    const { interestId } = await interested();
    const up = (b: BodyInit) => contractRoute.POST(new Request("http://test/x", { method: "POST", headers: { origin: "http://test", "content-type": "application/pdf" }, body: b }), ctx(interestId));
    as(owner);
    expect((await up(PDF)).status).toBe(403);
    as(wholesale);
    files.configured = false;
    expect((await up(PDF)).status).toBe(503);
    files.configured = true;
    expect((await up("<html>not a pdf</html>")).status).toBe(400);
    files.verdict = "infected";
    expect((await up(PDF)).status).toBe(400);
    files.verdict = "clean";
    expect((await json(await up(PDF))).body["contractStatus"]).toBe("submitted");
    expect(files.stored[0]).toMatch(/^investments\/[0-9a-f]{32}\/[0-9a-f]{32}$/);
    expect((await up(PDF)).status).toBe(409);

    state.staff = support;
    expect((await staffContractRoute.POST(req("POST", { action: "confirm", reason: "Signed by both parties." }), ctx(interestId))).status).toBe(403);
    state.staff = compliance;
    expect((await staffContractRoute.POST(req("POST", { action: "confirm", reason: "Signed by both parties." }), ctx(interestId))).status).toBe(400);
    const r = await json(await staffContractRoute.POST(req("POST", { action: "confirm", reason: "Signed by both parties.", contractAmountCents: 15_000_000 }), ctx(interestId)));
    expect(r.body["status"]).toBe("returned");
    const fee = (await mem.repo.listFees({}))[0]!;
    expect(fee).toMatchObject({ amountCents: 300_000, status: "due", ownerUserId: owner.userId });
    expect(notices.some(x => x.startsWith(`investment_fee_notice:${owner.userId}:`))).toBe(true);
    expect(mem.contractHistory.map(h => h.toStatus)).toEqual(["submitted", "returned"]);
    expect((await staffContractRoute.POST(req("POST", { action: "reject", reason: "Changed my mind here." }), ctx(interestId))).status).toBe(409);
  });

  it("a sent-back contract can be uploaded again", async () => {
    const { interestId } = await interested();
    await mem.repo.changeContract({ id: U(300), interestId, fromStatus: "none", toStatus: "submitted", actorType: "investor", actorId: wholesale.userId, reason: null, at: "2026-10-25T00:00:00.000Z" });
    state.staff = compliance;
    expect((await json(await staffContractRoute.POST(req("POST", { action: "reject", reason: "Investor did not sign page 2." }), ctx(interestId)))).body["status"]).toBe("rejected");
    as(wholesale);
    expect((await contractRoute.POST(new Request("http://test/x", { method: "POST", headers: { origin: "http://test", "content-type": "application/pdf" }, body: PDF }), ctx(interestId))).status).toBe(201);
  });

  it("fee status: due -> paid or waived by investment.manage only, with a reason; settled fees are final", async () => {
    expect(feeAmount(termsFrom({ ...DEFAULT_POSTING, commissionBps: 250 }), 1_000_000)).toBe(25_000);
    expect(feeAmount(termsFrom({ ...DEFAULT_POSTING, commissionType: "fixed", commissionFixedCents: 99_00 }), 1)).toBe(99_00);
    expect(feeTransition(compliance, "due", "paid", "Received by bank transfer.")).toMatchObject({ ok: false, status: 403 });
    expect(feeTransition(admin, "due", "refunded", "Received by bank transfer.")).toMatchObject({ ok: false, status: 400 });
    expect(feeTransition(admin, "due", "paid", "short")).toMatchObject({ ok: false, status: 400 });
    expect(feeTransition(admin, "paid", "waived", "Received by bank transfer.")).toMatchObject({ ok: false, status: 409 });

    const { interestId } = await interested();
    await mem.repo.changeContract({ id: U(301), interestId, fromStatus: "none", toStatus: "submitted", actorType: "investor", actorId: wholesale.userId, reason: null, at: "2026-10-25T00:00:00.000Z" });
    state.staff = compliance;
    await staffContractRoute.POST(req("POST", { action: "confirm", reason: "Signed by both parties.", contractAmountCents: 1_000_000 }), ctx(interestId));
    const fee = (await mem.repo.listFees({}))[0]!;
    state.staff = compliance;
    expect((await feeRoute.POST(req("POST", { status: "paid", reason: "Received by bank transfer." }), ctx(fee.id))).status).toBe(403);
    state.staff = admin;
    expect((await json(await feeRoute.POST(req("POST", { status: "paid", reason: "Received by bank transfer." }), ctx(fee.id)))).body["status"]).toBe("paid");
    expect((await feeRoute.POST(req("POST", { status: "waived", reason: "Goodwill gesture here." }), ctx(fee.id))).status).toBe(409);
    expect(mem.feeHistory.map(h => h.toStatus)).toEqual(["due", "paid"]);
  });

  it("the agreement template download is a DRAFT plain-text file with nobody's details", async () => {
    as(wholesale);
    const r = await templateRoute.GET(req("GET"));
    expect(r.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(r.headers.get("content-disposition")).toMatch(/DRAFT/);
    expect(await r.text()).toMatch(/^DRAFT - NOT FOR USE - NEEDS COUNSEL REVIEW/);
  });
});

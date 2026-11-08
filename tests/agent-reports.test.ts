import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentNote, fitAttachments } from "../src/domain/report-attachments";
import {
  buildReport, deleteReport, emailText, listReports, nextRunAt, parseDefinition, reportInsights, reportTable, resolvePeriod, runDueReports, runReport,
  saveReport, savedReport, templateDefinition, updateReport, MAX_REPORTS, type DueReport, type ReportDeps, type ReportFacts, type ReportDefinition, type RunSnapshot, type SavedReport
} from "../src/domain/agent-reports";
import { crc32, toPdf, toXlsx } from "../src/domain/report-export";
import type { AgentLicence } from "../src/domain/licence";
import type { Actor } from "../src/domain/listing-service";

const NOW = new Date("2026-11-05T01:00:00Z"); // 11am Thursday in Brisbane
const TODAY = "2026-11-05";
const licence: AgentLicence = { userId: "a1", jurisdiction: "QLD", status: "verified" };
const agent: Actor = { userId: "a1", userType: "agent" };

const facts: ReportFacts = {
  leads: [
    { enquiryId: "e1", listingId: "l1", listingTitle: "Queenslander", buyerId: "b1", buyerName: "Sam Secret", enquiredAt: "2026-10-20T02:00:00Z", buyerMessages: 2, agentMessages: 1, firstAgentAt: "2026-10-20T04:00:00Z", lastBuyerAt: "2026-11-04T00:00:00Z", notes: 0 },
    { enquiryId: "e2", listingId: "l1", listingTitle: "Queenslander", buyerId: "b2", buyerName: "Pat Private", enquiredAt: "2026-10-25T02:00:00Z", buyerMessages: 1, agentMessages: 0, notes: 0 },
    { enquiryId: "e3", listingId: "l2", listingTitle: "=Beach house", buyerId: "b3", buyerName: "Kim", enquiredAt: "2026-09-10T02:00:00Z", buyerMessages: 0, agentMessages: 0, notes: 0 },
    { enquiryId: "e4", listingId: "l2", listingTitle: "=Beach house", buyerId: "b4", buyerName: "Old", enquiredAt: "2026-07-01T02:00:00Z", buyerMessages: 0, agentMessages: 0, notes: 0 }
  ],
  offers: [
    { listingId: "l1", listingTitle: "Queenslander", status: "accepted", priceCents: 90_000_000, submittedAt: "2026-10-22T00:00:00Z" },
    { listingId: "l1", listingTitle: "Queenslander", status: "rejected", priceCents: 80_000_000, submittedAt: "2026-10-23T00:00:00Z" },
    { listingId: "l2", listingTitle: "=Beach house", status: "submitted", priceCents: 70_000_000, submittedAt: "2026-09-12T00:00:00Z" },
    { listingId: "l2", listingTitle: "=Beach house", status: "accepted", priceCents: 60_000_000, submittedAt: "2026-07-02T00:00:00Z" }
  ]
};
const def = (o: Partial<ReportDefinition> = {}): ReportDefinition => ({ ...templateDefinition("sales"), ...o });

describe("report definitions", () => {
  it("builds each template and refuses anything outside the catalogue", () => {
    for (const t of ["sales", "pipeline", "performance", "leads"] as const) expect(parseDefinition({ template: t })).toMatchObject({ ok: true });
    expect(parseDefinition({ template: "nope" })).toMatchObject({ ok: false });
    expect(parseDefinition({ template: "custom" })).toMatchObject({ ok: false }); // no metrics
    expect(parseDefinition({ metrics: ["offers", "password"] })).toMatchObject({ ok: false, message: expect.stringContaining("Unknown metric") });
    expect(parseDefinition({ metrics: ["offers"], groupBy: "buyer" })).toMatchObject({ ok: false });
    expect(parseDefinition({ metrics: ["offers"], period: { days: 45 } })).toMatchObject({ ok: false });
    expect(parseDefinition({ metrics: ["offers"], period: { from: "2026-02-30", to: "2026-03-01" } })).toMatchObject({ ok: false });
    expect(parseDefinition({ metrics: ["offers"], period: { from: "2026-03-02", to: "2026-03-01" } })).toMatchObject({ ok: false });
    expect(parseDefinition({ metrics: ["offers"], period: { from: "2020-01-01", to: "2026-03-01" } })).toMatchObject({ ok: false });
  });
  it("keeps metrics in catalogue order without duplicates", () => {
    const r = parseDefinition({ metrics: ["accepted", "offers", "offers"], groupBy: "month", period: { days: 30 } });
    expect(r.ok && r.value.metrics).toEqual(["offers", "accepted"]);
  });
  it("resolves the period and the equal-length period before it", () => {
    expect(resolvePeriod({ days: 30 }, TODAY)).toEqual({ from: "2026-10-07", to: TODAY, prevFrom: "2026-09-07", prevTo: "2026-10-06" });
    expect(resolvePeriod({ from: "2026-10-01", to: "2026-10-31" }, TODAY)).toMatchObject({ prevFrom: "2026-08-31", prevTo: "2026-09-30" });
  });
});

describe("building a report", () => {
  it("groups by listing, totals the period and compares with the previous one", () => {
    const r = buildReport(def({ period: { days: 30 } }), facts, TODAY, NOW);
    expect(r.rows.map(x => x.label)).toEqual(["Queenslander"]);
    expect(r.rows[0]!.values).toMatchObject({ offers: 2, accepted: 1, rejected: 1, acceptance_rate: 50, accepted_cents: 90_000_000 });
    expect(r.totals.offers).toBe(2);
    expect(r.previousTotals.offers).toBe(1); // the 12 Sep offer, in the 30 days before
    expect(r.comparison.find(c => c.key === "offers")).toMatchObject({ current: 2, previous: 1, change: 100 });
  });
  it("counts enquiries, hot leads, unanswered buyers and median reply time", () => {
    const r = buildReport(def({ ...templateDefinition("leads"), period: { days: 30 } }), facts, TODAY, NOW);
    expect(r.totals).toMatchObject({ enquiries: 2, awaiting_reply: 1, median_reply_minutes: 120 });
  });
  it("fills empty months so a trend has no gaps", () => {
    const r = buildReport(def({ groupBy: "month", period: { from: "2026-07-01", to: TODAY } }), facts, TODAY, NOW);
    expect(r.rows.map(x => x.key)).toEqual(["2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(r.rows.find(x => x.key === "2026-08")!.values.offers).toBe(0);
    expect(r.rows.find(x => x.key === "2026-07")!.values.accepted).toBe(1);
  });
  it("leaves a rate empty when nothing was decided, and never carries buyer names", () => {
    const r = buildReport(def({ groupBy: "none", period: { days: 7 } }), facts, TODAY, NOW);
    expect(r.rows).toEqual([]);
    expect(r.totals.acceptance_rate).toBeUndefined();
    expect(JSON.stringify(buildReport(def(), facts, TODAY, NOW))).not.toMatch(/Secret|Private/);
  });
  it("exports one table whose numbers match the screen, with money in dollars", () => {
    const t = reportTable(buildReport(def({ period: { days: 30 } }), facts, TODAY, NOW));
    expect(t.head).toEqual(["Listing", "Offers", "Accepted offers", "Rejected offers", "Acceptance (%)", "Accepted value (AUD)"]);
    expect(t.rows[0]).toEqual(["Queenslander", 2, 1, 1, 50, 900000]);
    expect(t.rows.at(-1)![0]).toBe("Total");
  });
});

describe("Elena's insights", () => {
  it("names the biggest movement and flags unanswered buyers", () => {
    const r = buildReport(def({ ...templateDefinition("leads"), period: { days: 30 } }), facts, TODAY, NOW);
    const i = reportInsights(r);
    expect(i.points.join(" ")).toContain("still waiting for a first reply");
    expect(i.points.join(" ")).toContain("Queenslander is the busiest listing");
  });
  it("says so when there is nothing, and warns about thin acceptance data", () => {
    expect(reportInsights(buildReport(def({ period: { days: 7 } }), { leads: [], offers: [] }, TODAY, NOW)).headline).toContain("No activity");
    expect(reportInsights(buildReport(def({ period: { days: 30 } }), facts, TODAY, NOW)).points.join(" ")).toContain("fewer than 3 decided offers");
  });
});

describe("schedule times (08:00 Brisbane, UTC+10)", () => {
  it("daily: later today if 8am has not passed, else tomorrow", () => {
    expect(nextRunAt("daily", new Date("2026-11-04T20:00:00Z"))).toBe("2026-11-04T22:00:00.000Z"); // 6am Thu -> 8am Thu
    expect(nextRunAt("daily", NOW)).toBe("2026-11-05T22:00:00.000Z");
    expect(nextRunAt("daily", new Date("2026-11-04T22:00:00Z"))).toBe("2026-11-05T22:00:00.000Z"); // strictly after
  });
  it("weekly lands on a Monday, monthly on the 1st", () => {
    expect(nextRunAt("weekly", NOW)).toBe("2026-11-08T22:00:00.000Z"); // Mon 9 Nov 8am
    expect(nextRunAt("weekly", new Date("2026-11-08T21:00:00Z"))).toBe("2026-11-08T22:00:00.000Z"); // Mon 7am -> same day
    expect(nextRunAt("weekly", new Date("2026-11-08T23:00:00Z"))).toBe("2026-11-15T22:00:00.000Z");
    expect(nextRunAt("monthly", NOW)).toBe("2026-11-30T22:00:00.000Z"); // Tue 1 Dec 8am
    expect(nextRunAt("monthly", new Date("2026-12-31T20:00:00Z"))).toBe("2026-12-31T22:00:00.000Z"); // 6am on 1 Jan in Brisbane -> 8am the same day
    expect(nextRunAt("monthly", new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-31T22:00:00.000Z"); // 9am on 1 Jan -> 1 Feb
  });
});

describe("export files", () => {
  const head = ["Listing", "Offers"], rows = [["=SUM(A1)", 3], ["Total", 3]];
  it("writes a valid zip: stored entries with correct sizes and checksums, and text that cannot become a formula", () => {
    const z = Buffer.from(toXlsx(head, rows));
    expect(z.subarray(0, 4).toString("hex")).toBe("504b0304");
    let off = 0; const names: string[] = [];
    while (z.readUInt32LE(off) === 0x04034b50) {
      const crc = z.readUInt32LE(off + 14), size = z.readUInt32LE(off + 18), n = z.readUInt16LE(off + 26);
      const name = z.subarray(off + 30, off + 30 + n).toString(); names.push(name);
      const data = z.subarray(off + 30 + n, off + 30 + n + size);
      expect(crc32(data)).toBe(crc);
      if (name.endsWith("sheet1.xml")) { const s = data.toString(); expect(s).toContain('t="inlineStr"'); expect(s).not.toContain("<f>"); expect(s).toContain("<v>3</v>"); }
      off += 30 + n + size;
    }
    expect(names).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]);
    expect(z.readUInt32LE(z.length - 22)).toBe(0x06054b50);
  });
  it("escapes XML in titles and drops control characters", () => {
    const s = Buffer.from(toXlsx(["A"], [["<b>&\u0001x"]])).toString("latin1");
    expect(s).toContain("&lt;b&gt;&amp;x");
  });
  it("writes a PDF with a matching xref, pages for long tables and escaped text", () => {
    const many = Array.from({ length: 80 }, (_, i) => [`Home (${i}) \\ é “q”`, i]);
    const s = Buffer.from(toPdf("Sales (report)", "2026-08-01 to 2026-10-30", head, many, ["Note"])).toString("latin1");
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    const pages = (s.match(/\/Type \/Page /g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
    expect(s).toContain(`/Count ${pages}`);
    expect(s).toContain("Sales \\(report\\)");
    const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(xref, xref + 4)).toBe("xref");
    const first = Number(/xref\n0 \d+\n0000000000 65535 f \n(\d{10})/.exec(s)![1]);
    expect(s.slice(first, first + 7)).toBe("1 0 obj");
  });
});

/* ---------- service with an in-memory store ---------- */

function store(o: Partial<ReportDeps> = {}, over: { licences?: AgentLicence[]; emails?: Record<string, string> } = {}) {
  const saved = new Map<string, SavedReport & { agent: string }>();
  const sched = new Map<string, { frequency: "daily" | "weekly" | "monthly"; next: string; status?: string }>();
  const runs: { id: string; trigger: string; totals: unknown }[] = [];
  const sent: { to: string; subject: string; text: string; attachments?: unknown }[] = [];
  let n = 0;
  const view = (r: SavedReport & { agent: string }): SavedReport => {
    const s = sched.get(r.id);
    return { id: r.id, name: r.name, definition: r.definition, createdAt: r.createdAt, ...(s ? { schedule: { frequency: s.frequency, nextRunAt: s.next, ...(s.status ? { lastStatus: s.status } : {}) } } : {}) };
  };
  const d: ReportDeps = {
    licences: async () => over.licences ?? [licence], today: () => TODAY, now: () => NOW, facts: async () => facts,
    list: async a => [...saved.values()].filter(r => r.agent === a).map(view),
    get: async (a, id) => { const r = saved.get(id); return r && r.agent === a ? view(r) : undefined; },
    create: async (a, name, definition) => { const id = `r${++n}`; saved.set(id, { id, name, definition, createdAt: NOW.toISOString(), agent: a }); return id; },
    update: async (a, id, name, definition) => { const r = saved.get(id); if (r && r.agent === a) Object.assign(r, { name, definition }); },
    remove: async (a, id) => { if (saved.get(id)?.agent === a) { saved.delete(id); sched.delete(id); } },
    setSchedule: async (id, frequency, next) => { frequency ? sched.set(id, { frequency, next }) : sched.delete(id); },
    addRun: async (id, trigger, _f, _t, totals) => { runs.push({ id, trigger, totals }); },
    runs: async id => runs.filter(r => r.id === id).map((r, i): RunSnapshot => ({ id: String(i), trigger: r.trigger as "manual", periodFrom: "", periodTo: "", totals: r.totals as RunSnapshot["totals"], createdAt: NOW.toISOString() })),
    due: async at => [...sched].filter(([, s]) => s.next <= at).map(([id, s]): DueReport => {
      const r = saved.get(id)!; const email = over.emails?.[r.agent] ?? "agent@example.test";
      return { reportId: id, agentId: r.agent, name: r.name, definition: r.definition, frequency: s.frequency, nextRunAt: s.next, email };
    }),
    claim: async (id, now, next) => { const s = sched.get(id); if (!s || s.next > now) return false; s.next = next; return true; },
    finish: async (id, status) => { const s = sched.get(id); if (s) s.status = status; },
    send: async (_a, to, subject, text, attachments) => { sent.push({ to, subject, text, attachments }); return true; },
    ...o
  };
  return { d, saved, sched, runs, sent };
}

describe("saving, scheduling and running", () => {
  it("saves a report with a schedule and books the first run", async () => {
    const s = store();
    const r = await saveReport(s.d, agent, { name: " Monthly   sales ", definition: { template: "sales" }, schedule: { frequency: "monthly" } });
    expect(r).toMatchObject({ ok: true });
    const id = r.ok ? r.value.id : "";
    expect(s.saved.get(id)!.name).toBe("Monthly sales");
    expect(s.sched.get(id)).toMatchObject({ frequency: "monthly", next: "2026-11-30T22:00:00.000Z" });
    const l = await listReports(s.d, agent);
    expect(l.ok && l.value.reports[0]!.schedule?.frequency).toBe("monthly");
  });
  it("refuses fixed dates on a schedule, bad names, bad frequencies, and more than the limit", async () => {
    const s = store();
    const fixed = { name: "x", definition: { metrics: ["offers"], period: { from: "2026-01-01", to: "2026-02-01" } } };
    expect(await saveReport(s.d, agent, { ...fixed, schedule: { frequency: "daily" } })).toMatchObject({ ok: false, message: expect.stringContaining("rolling period") });
    expect(await saveReport(s.d, agent, fixed)).toMatchObject({ ok: true }); // fixed dates are fine unscheduled
    expect(await saveReport(s.d, agent, { name: "", definition: { template: "sales" } })).toMatchObject({ ok: false });
    expect(await saveReport(s.d, agent, { name: "x".repeat(81), definition: { template: "sales" } })).toMatchObject({ ok: false });
    expect(await saveReport(s.d, agent, { name: "x", definition: { template: "sales" }, schedule: { frequency: "hourly" } })).toMatchObject({ ok: false });
    for (let i = 0; i < MAX_REPORTS; i++) await saveReport(s.d, agent, { name: `r${i}`, definition: { template: "sales" } });
    expect(await saveReport(s.d, agent, { name: "one more", definition: { template: "sales" } })).toMatchObject({ ok: false, message: expect.stringContaining("up to 20") });
  });
  it("lets only the owner open, change or delete a report, and stops emails when the schedule is cleared", async () => {
    const s = store();
    const id = (await saveReport(s.d, agent, { name: "A", definition: { template: "pipeline" }, schedule: { frequency: "daily" } })) as { ok: true; value: { id: string } };
    const other: Actor = { userId: "a2", userType: "agent" };
    const s2 = { ...s.d, licences: async () => [licence, { ...licence, userId: "a2" }] };
    expect(await savedReport(s2, other, id.value.id, false)).toMatchObject({ ok: false, code: "not_found" });
    expect(await updateReport(s2, other, id.value.id, { name: "B", definition: { template: "pipeline" } })).toMatchObject({ ok: false, code: "not_found" });
    expect(await deleteReport(s2, other, id.value.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await updateReport(s.d, agent, id.value.id, { name: "A2", definition: { template: "pipeline" }, schedule: null })).toMatchObject({ ok: true });
    expect(s.sched.has(id.value.id)).toBe(false);
    expect(s.saved.get(id.value.id)!.name).toBe("A2");
    expect(await deleteReport(s.d, agent, id.value.id)).toMatchObject({ ok: true });
    expect(s.saved.size).toBe(0);
  });
  it("stores a snapshot only when asked, and returns the history", async () => {
    const s = store();
    const id = ((await saveReport(s.d, agent, { name: "A", definition: { template: "sales" } })) as { value: { id: string } }).value.id;
    expect((await savedReport(s.d, agent, id, false) as { value: { history: unknown[] } }).value.history).toHaveLength(0);
    expect((await savedReport(s.d, agent, id, true) as { value: { history: unknown[] } }).value.history).toHaveLength(1);
  });
  it("only licensed agents can use reports", async () => {
    const s = store({}, { licences: [] });
    expect(await runReport(s.d, agent, def())).toMatchObject({ ok: false, code: "forbidden" });
    expect(await listReports(s.d, { userId: "b", userType: "buyer" })).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("the due-report run", () => {
  let s: ReturnType<typeof store>;
  beforeEach(async () => {
    s = store();
    await saveReport(s.d, agent, { name: "Weekly leads", definition: { template: "leads" }, schedule: { frequency: "weekly" } });
    s.sched.get("r1")!.next = "2026-11-05T00:00:00.000Z"; // due
  });
  it("emails due reports once, books the next run and stores a snapshot", async () => {
    expect(await runDueReports(s.d, "https://own.example/")).toEqual({ due: 1, sent: 1, notSent: 0, skipped: 0 });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.to).toBe("agent@example.test");
    expect(s.sent[0]!.text).toContain("https://own.example/agent/reports");
    expect(s.sent[0]!.text).not.toMatch(/Secret|Private/);
    expect(s.sched.get("r1")).toMatchObject({ next: "2026-11-08T22:00:00.000Z", status: "sent" });
    expect(s.runs).toMatchObject([{ id: "r1", trigger: "scheduled" }]);
    expect(await runDueReports(s.d, undefined)).toMatchObject({ due: 0 }); // nothing left until next week
    expect(s.sent).toHaveLength(1);
  });
  it("does not send when another tick already claimed it", async () => {
    const racing = { ...s.d, claim: async () => false };
    expect(await runDueReports(racing, undefined)).toMatchObject({ due: 0, sent: 0 });
    expect(s.sent).toHaveLength(0);
  });
  it("skips, but still reschedules, an agent who lost their licence or has no email", async () => {
    const lapsed = store({}, { licences: [] });
    await saveReport({ ...lapsed.d, licences: async () => [licence] }, agent, { name: "R", definition: { template: "sales" }, schedule: { frequency: "daily" } });
    lapsed.sched.get("r1")!.next = "2026-11-05T00:00:00.000Z";
    expect(await runDueReports(lapsed.d, undefined)).toMatchObject({ skipped: 1, sent: 0 });
    expect(lapsed.sched.get("r1")).toMatchObject({ status: "skipped", next: "2026-11-05T22:00:00.000Z" });
    expect(lapsed.sent).toHaveLength(0);
  });
  it("records not_sent when email is not configured, and survives a failing report", async () => {
    const down = { ...s.d, send: async () => false };
    expect(await runDueReports(down, undefined)).toMatchObject({ notSent: 1, sent: 0 });
    expect(s.sched.get("r1")!.status).toBe("not_sent");
    s.sched.get("r1")!.next = "2026-11-05T00:00:00.000Z";
    const broken = { ...s.d, facts: async () => { throw new Error("db down"); } };
    expect(await runDueReports(broken, undefined)).toMatchObject({ notSent: 1 });
  });
  it("attaches the PDF and Excel file to a scheduled email and says so", async () => {
    const s2 = store();
    await saveReport(s2.d, agent, { name: "Weekly sales", definition: { template: "sales" }, schedule: { frequency: "daily" } });
    s2.sched.forEach(v => { v.next = "2026-11-05T00:00:00.000Z"; });
    await runDueReports(s2.d, "https://own.example");
    const m = s2.sent[0] as { text: string; attachments: { filename: string; contentType: string; content: Buffer }[] };
    expect(m.attachments.map(a => a.filename)).toEqual([expect.stringMatching(/^report-weekly-sales-\d{4}-\d\d-\d\d-to-\d{4}-\d\d-\d\d-2026-11-05\.pdf$/), expect.stringMatching(/\.xlsx$/)]);
    expect(m.attachments[0]!.content.subarray(0, 4).toString()).toBe("%PDF");
    expect(m.text).toContain("Attached: report-weekly-sales-");
    expect(m.text).toContain("https://own.example/agent/reports");
  });
  it("skips attachments over 25 MB and points at the link", () => {
    const big = { filename: "a.pdf", content: Buffer.alloc(26 * 1024 * 1024), contentType: "application/pdf" };
    const small = { filename: "b.xlsx", content: Buffer.alloc(10), contentType: "x" };
    const fit = fitAttachments([big, small]);
    expect(fit.attachments).toEqual([small]); expect(fit.skipped).toBe(1);
    expect(attachmentNote(fit.attachments, fit.skipped)).toContain("too large to attach");
    expect(attachmentNote([], 0)).toBe("");
  });
  it("builds a plain-text email with the summary, table and link", () => {
    const r = buildReport(def({ period: { days: 30 } }), facts, TODAY, NOW, "Sales");
    const m = emailText(r, reportInsights(r), "https://x/agent/reports");
    expect(m.subject).toBe("Sales: 2026-10-07 to 2026-11-05");
    expect(m.text).toContain("Queenslander");
    expect(m.text).toContain("Elena");
  });
});

/* ---------- routes ---------- */

const state = vi.hoisted(() => ({ actor: null as Actor | null, deps: null as ReportDeps | null }));
vi.mock("../src/server/context", () => ({ getActor: () => state.actor, getDb: () => ({}) }));
vi.mock("../src/server/agent-reports-db", () => ({ getReportDeps: () => state.deps }));

describe("report routes", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const json = (method: string, b: unknown) => new Request("http://t/x", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  it("requires sign-in and a licence, validates input, and serves JSON, CSV, Excel and PDF", async () => {
    const root = await import("../app/api/agent/reports/route");
    const run = await import("../app/api/agent/reports/run/route");
    const one = await import("../app/api/agent/reports/[id]/route");
    state.deps = store().d; state.actor = null;
    expect((await root.GET(new Request("http://t/api/agent/reports"))).status).toBe(401);
    expect((await run.GET(new Request("http://t/api/agent/reports/run"))).status).toBe(401);
    state.actor = { userId: "b", userType: "buyer" };
    expect((await root.GET(new Request("http://t/api/agent/reports"))).status).toBe(403);

    state.actor = agent;
    const cat = await (await root.GET(new Request("http://t/api/agent/reports"))).json();
    expect(cat.templates.map((t: { key: string }) => t.key)).toEqual(["sales", "pipeline", "performance", "leads"]);
    expect(cat.metrics.length).toBeGreaterThan(5);

    const q = "http://t/api/agent/reports/run?template=sales&days=30";
    const j = await run.GET(new Request(q));
    expect(j.status).toBe(200);
    expect((await j.json()).report.totals.offers).toBe(2);
    const csv = await run.GET(new Request(`${q}&format=csv`));
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toMatch(/sales-report-2026-10-07-to-2026-11-05\.csv/);
    const text = await csv.text();
    expect(text).toContain("Queenslander,2,1,1,50,900000");
    const wide = await (await run.GET(new Request("http://t/api/agent/reports/run?template=sales&days=90&format=csv"))).text();
    expect(wide).toContain("'=Beach house"); // a title that looks like a formula is neutralised in CSV
    const xlsx = await run.GET(new Request(`${q}&format=xlsx`));
    expect(xlsx.headers.get("content-type")).toContain("spreadsheetml.sheet");
    expect(Buffer.from(await xlsx.arrayBuffer()).subarray(0, 2).toString()).toBe("PK");
    const pdf = await run.GET(new Request(`${q}&format=pdf`));
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await run.GET(new Request(`${q}&format=docx`))).status).toBe(400);
    expect((await run.GET(new Request("http://t/api/agent/reports/run?template=bogus"))).status).toBe(400);
    expect((await run.GET(new Request("http://t/api/agent/reports/run?metrics=offers&days=45"))).status).toBe(400);

    const created = await root.POST(json("POST", { name: "Weekly", definition: { template: "leads" }, schedule: { frequency: "weekly" } }));
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect((await root.POST(json("POST", { name: "", definition: { template: "leads" } }))).status).toBe(400);
    const got = await (await one.GET(new Request("http://t/x?snapshot=1"), ctx(id))).json();
    expect(got.saved.schedule.frequency).toBe("weekly");
    expect(got.history).toHaveLength(1);
    expect((await one.GET(new Request("http://t/x?format=pdf"), ctx(id))).headers.get("content-type")).toBe("application/pdf");
    expect((await one.GET(new Request("http://t/x"), ctx("nope"))).status).toBe(404);
    expect((await one.PUT(json("PUT", { name: "Weekly 2", definition: { template: "leads" }, schedule: null }), ctx(id))).status).toBe(200);
    expect((await one.DELETE(new Request("http://t/x", { method: "DELETE" }), ctx(id))).status).toBe(200);
    expect((await one.DELETE(new Request("http://t/x", { method: "DELETE" }), ctx(id))).status).toBe(404);
  });
});
